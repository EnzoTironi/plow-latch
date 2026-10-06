import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StrictSettingsStore } from "../src/strictSettingsStore.js";
import { PendingRevokeRetrier } from "../src/maintained/settingsActions.js";
import { encryptedFixtureCodec, temporaryHome } from "./fixtures.js";

const credential = "plow_isolated_fixture_secret";
const pending = "plow_isolated_pending_secret";
const fileFor = (home: string) => path.join(home, "app", "settings.json");

describe("strict headless settings", () => {
  it("persists preferences without requiring a secret codec", () => {
    const home = temporaryHome();
    const store = new StrictSettingsStore({ home });
    expect(store.load()).toMatchObject({ approvalMode: "adversarial", relayCredential: "", selectedTab: "agents" });
    store.save({ ...store.load(), telemetryEnabled: false, selectedTab: "audit" });
    expect(new StrictSettingsStore({ home }).load()).toMatchObject({ telemetryEnabled: false, selectedTab: "audit", relayCredential: "" });
    expect(store.secretAvailability()).toEqual({ kind: "unavailable", reason: "protected_secret_codec_required" });
    expect(fs.statSync(fileFor(home)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(home, "app")).mode & 0o777).toBe(0o700);
  });

  it("refuses new secrets without a codec and preserves the existing file", () => {
    const home = temporaryHome();
    const store = new StrictSettingsStore({ home });
    store.save(store.load());
    const before = fs.readFileSync(fileFor(home), "utf8");
    expect(() => store.save({ ...store.load(), relayCredential: credential })).toThrow("secret_store_locked");
    expect(() => store.save({ ...store.load(), pendingRevokeCredentials: [pending] })).toThrow("secret_store_locked");
    expect(fs.readFileSync(fileFor(home), "utf8")).toBe(before);
  });

  it.each(["active", "pending"] as const)("refuses legacy plaintext %s credentials without migration", (kind) => {
    const home = temporaryHome();
    const defaults = new StrictSettingsStore({ home }).load();
    fs.mkdirSync(path.join(home, "app"));
    const body = JSON.stringify(kind === "active" ? { relayCredential: credential } : { pendingRevokeCredentials: [pending] });
    fs.writeFileSync(fileFor(home), body);
    const store = new StrictSettingsStore({ home, codec: encryptedFixtureCodec() });
    expect(() => store.load()).toThrow("plaintext_credentials_present");
    expect(() => store.save(defaults)).toThrow("plaintext_credentials_present");
    expect(fs.readFileSync(fileFor(home), "utf8")).toBe(body);
  });

  it("encrypts active and retirement credentials and opens them after restart", () => {
    const home = temporaryHome();
    const codec = encryptedFixtureCodec();
    const store = new StrictSettingsStore({ home, codec });
    store.save({ ...store.load(), relayCredential: credential, pendingRevokeCredentials: [pending], accountUid: "account-fixture" });
    const encoded = fs.readFileSync(fileFor(home), "utf8");
    expect(encoded).not.toContain(credential);
    expect(encoded).not.toContain(pending);
    expect(new StrictSettingsStore({ home, codec }).load()).toMatchObject({ relayCredential: credential, pendingRevokeCredentials: [pending], accountUid: "account-fixture" });
  });

  it("keeps opaque ciphertext unchanged during preference writes with no codec", () => {
    const home = temporaryHome();
    const codec = encryptedFixtureCodec();
    const store = new StrictSettingsStore({ home, codec });
    store.save({ ...store.load(), relayCredential: credential, pendingRevokeCredentials: [pending] });
    const locked = new StrictSettingsStore({ home });
    const state = locked.load();
    expect(state.relayCredential).toBe("");
    expect(state.pendingRevokeCredentials).toEqual([]);
    expect(state.relayCredentialEnc).toBeTruthy();
    locked.save({ ...state, selectedTab: "settings", telemetryEnabled: false });
    const after = locked.load();
    expect(after.relayCredentialEnc).toBe(state.relayCredentialEnc);
    expect(after.pendingRevokeCredentialsEnc).toEqual(state.pendingRevokeCredentialsEnc);
    expect(new StrictSettingsStore({ home, codec }).load()).toMatchObject({ relayCredential: credential, pendingRevokeCredentials: [pending], selectedTab: "settings", telemetryEnabled: false });
  });

  it("preserves locked ciphertext even when a caller writes a fresh preference snapshot", () => {
    const home = temporaryHome();
    const codec = encryptedFixtureCodec();
    const store = new StrictSettingsStore({ home, codec });
    const defaults = store.load();
    store.save({ ...defaults, relayCredential: credential, pendingRevokeCredentials: [pending] });
    const locked = new StrictSettingsStore({ home });
    const before = locked.load();
    locked.save({ ...defaults, telemetryEnabled: false });
    expect(locked.load()).toMatchObject({ relayCredentialEnc: before.relayCredentialEnc, pendingRevokeCredentialsEnc: before.pendingRevokeCredentialsEnc, telemetryEnabled: false });
    expect(new StrictSettingsStore({ home, codec }).load()).toMatchObject({ relayCredential: credential, pendingRevokeCredentials: [pending] });
  });

  it.each(["unavailable", "throws", "identity"] as const)("never falls back to plaintext when encryption %s", (kind) => {
    const home = temporaryHome();
    const store = new StrictSettingsStore({ home, codec: {
      available: () => kind !== "unavailable",
      encrypt: (text) => { if (kind === "throws") throw new Error(credential); return text; },
      decrypt: () => { throw new Error("unexpected fixture decrypt"); },
    } });
    store.save(store.load());
    const before = fs.readFileSync(fileFor(home), "utf8");
    expect(() => store.save({ ...store.load(), relayCredential: credential })).toThrow("secret_store_locked");
    expect(fs.readFileSync(fileFor(home), "utf8")).toBe(before);
  });

  it("keeps a corrupt ciphertext intact and blocks new secret writes", () => {
    const home = temporaryHome();
    const withoutCodec = new StrictSettingsStore({ home });
    withoutCodec.save({ ...withoutCodec.load(), relayCredentialEnc: "unreadable-ciphertext" });
    const store = new StrictSettingsStore({ home, codec: encryptedFixtureCodec() });
    expect(store.load()).toMatchObject({ relayCredential: "", relayCredentialEnc: "unreadable-ciphertext" });
    expect(store.secretAvailability()).toEqual({ kind: "unavailable", reason: "secret_store_locked" });
    store.save({ ...store.load(), telemetryEnabled: false });
    expect(store.load().relayCredentialEnc).toBe("unreadable-ciphertext");
    expect(() => store.save({ ...store.load(), relayCredential: credential })).toThrow("secret_store_locked");
  });

  it("signs out durably and retains only encrypted retirement credentials", () => {
    const home = temporaryHome();
    const codec = encryptedFixtureCodec();
    const store = new StrictSettingsStore({ home, codec });
    store.save({ ...store.load(), relayCredential: credential, pendingRevokeCredentials: [pending], accountUid: "account-fixture", mcpUrl: "https://fixture.invalid/mcp", setupComplete: true, approvalMode: "deny" });
    store.signOut();
    const restarted = new StrictSettingsStore({ home, codec }).load();
    expect(restarted).toMatchObject({ relayCredential: "", accountUid: "", mcpUrl: "", setupComplete: false, approvalMode: "deny", pendingRevokeCredentials: [pending, credential] });
    expect(fs.readFileSync(fileFor(home), "utf8")).not.toContain(credential);
  });

  it("preserves readable seals when an unreadable retirement seal blocks new secrets", () => {
    const home = temporaryHome();
    const store = new StrictSettingsStore({ home, codec: encryptedFixtureCodec() });
    store.save({ ...store.load(), relayCredential: credential, accountUid: "account-fixture", setupComplete: true });
    const encoded = JSON.parse(fs.readFileSync(fileFor(home), "utf8"));
    const activeSeal = encoded.relayCredentialEnc;
    encoded.pendingRevokeCredentialsEnc = ["unreadable-retirement-ciphertext"];
    fs.writeFileSync(fileFor(home), JSON.stringify(encoded));
    expect(store.load().relayCredential).toBe(credential);
    store.save({ ...store.load(), telemetryEnabled: false });
    expect(store.load().telemetryEnabled).toBe(false);
    expect(JSON.parse(fs.readFileSync(fileFor(home), "utf8")).relayCredentialEnc).toBe(activeSeal);
    expect(() => store.save({ ...store.load(), relayCredential: pending })).toThrow("secret_store_locked");
    store.signOut();
    expect(store.load()).toMatchObject({ relayCredential: "", accountUid: "", setupComplete: false, telemetryEnabled: false });
    const stored = JSON.parse(fs.readFileSync(fileFor(home), "utf8"));
    expect(stored.relayCredentialEnc).toBeUndefined();
    expect(stored.pendingRevokeCredentialsEnc).toEqual(["unreadable-retirement-ciphertext", activeSeal]);
    expect(fs.readFileSync(fileFor(home), "utf8")).not.toContain(credential);
  });

  it("can sign out while locked without discarding opaque credentials", () => {
    const home = temporaryHome();
    const codec = encryptedFixtureCodec();
    const store = new StrictSettingsStore({ home, codec });
    store.save({ ...store.load(), relayCredential: credential, pendingRevokeCredentials: [pending], accountUid: "account-fixture" });
    const locked = new StrictSettingsStore({ home });
    const originalSeal = locked.load().relayCredentialEnc;
    locked.signOut();
    expect(locked.load()).toMatchObject({ relayCredential: "", accountUid: "" });
    expect(locked.load().pendingRevokeCredentialsEnc).toContain(originalSeal);
    expect(new StrictSettingsStore({ home, codec }).load().pendingRevokeCredentials).toEqual([pending, credential]);
  });

  it("retires a readable credential once while retaining an unreadable retirement seal", async () => {
    const home = temporaryHome();
    const store = new StrictSettingsStore({ home, codec: encryptedFixtureCodec() });
    store.save({ ...store.load(), pendingRevokeCredentials: [pending] });
    const encoded = JSON.parse(fs.readFileSync(fileFor(home), "utf8"));
    encoded.pendingRevokeCredentialsEnc.push("unreadable-retirement-ciphertext");
    fs.writeFileSync(fileFor(home), JSON.stringify(encoded));
    const revoked: string[] = [];
    const retrier = new PendingRevokeRetrier(home, async (credential) => { revoked.push(credential); }, store);
    await retrier.start();
    await retrier.start();
    expect(revoked).toEqual([pending]);
    expect(store.load().pendingRevokeCredentials).toEqual([]);
    expect(store.load().pendingRevokeCredentialsEnc).toEqual(["unreadable-retirement-ciphertext"]);
    expect(JSON.parse(fs.readFileSync(fileFor(home), "utf8")).pendingRevokeCredentialsEnc).toEqual(["unreadable-retirement-ciphertext"]);
  });

  it("refuses symlinked settings files without touching their target", () => {
    const home = temporaryHome();
    fs.mkdirSync(path.join(home, "app"));
    const outside = path.join(home, "outside.json");
    fs.writeFileSync(outside, '{"telemetryEnabled":false}');
    fs.symlinkSync(outside, fileFor(home));
    expect(() => new StrictSettingsStore({ home })).toThrow("unsafe_settings_path");
    expect(fs.readFileSync(outside, "utf8")).toBe('{"telemetryEnabled":false}');
  });

  it("reports invalid settings without returning hostile field contents", () => {
    const home = temporaryHome();
    fs.mkdirSync(path.join(home, "app"));
    fs.writeFileSync(fileFor(home), JSON.stringify({ approvalMode: credential }));
    expect(() => new StrictSettingsStore({ home }).load()).toThrow(/^invalid_settings$/);
  });
});
