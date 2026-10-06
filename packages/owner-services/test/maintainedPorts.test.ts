import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PlowApi } from "@domo/owner-core/plowApi";
import { providerFor } from "@domo/device-core";
import { Onboarding, type OnboardingDeps } from "../src/maintained/onboarding.js";
import { ConnectClient } from "../src/maintained/connectClient.js";
import { Connectors } from "../src/maintained/connectors.js";
import { PendingRevokeRetrier } from "../src/maintained/settingsActions.js";
import { buildMinter } from "../src/maintained/providerWiring.js";
import { OwnerServices, StrictSettingsStore } from "../src/index.js";
import type { JSONValue } from "@domo/protocol";
import { disposeAfterTest, encryptedFixtureCodec, ownerBinding, temporaryHome } from "./fixtures.js";

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string;
  body: JSONValue;
}

async function injectedApiFixture(handler: (request: RecordedRequest) => unknown | Promise<unknown>) {
  const requests: RecordedRequest[] = [];
  const origin = "https://owner-services-fixture.invalid";
  const api = new PlowApi(origin, async (url, init) => {
    const request = new Request(url, init);
    const endpoint = new URL(request.url);
    const encoded = await request.text();
    const recorded = {
      method: request.method, url: endpoint.pathname + endpoint.search,
      authorization: request.headers.get("authorization") ?? "",
      body: encoded ? JSON.parse(encoded) : null,
    };
    requests.push(recorded);
    const result = await handler(recorded);
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { api, origin, requests };
}

function onboardingIn(home: string, settings: StrictSettingsStore, api: PlowApi, extra: Partial<OnboardingDeps> = {}) {
  const onboarding = new Onboarding({ api, home, settings, deviceName: "isolated-owner-fixture", accessNeeded: async () => false, startRelay: async () => {}, wakePendingRevokes: () => {}, ...extra });
  disposeAfterTest(() => onboarding.stop());
  return onboarding;
}

describe("maintained controllers using strict settings", () => {
  it("runs the setup checkpoints and persists owner choices through the protected port", async () => {
    const home = temporaryHome();
    const settings = new StrictSettingsStore({ home, codec: encryptedFixtureCodec() });
    settings.save({ ...settings.load(), relayCredential: "plow_setup_fixture_secret", onboardingResumeStep: "privacy" });
    const api = new PlowApi("http://127.0.0.1:1", async () => { throw new Error("presentational setup must not make a network call"); });
    const onboarding = onboardingIn(home, settings, api);
    expect(onboarding.state().step).toBe("privacy");
    expect((await onboarding.advance()).step).toBe("gatekeeper");
    expect((await onboarding.advance("  Organize invoices  ")).step).toBe("plugins");
    onboarding.setTelemetryEnabled(false);
    expect((await onboarding.advance()).step).toBe("availability");
    expect(onboardingIn(home, settings, api).state().step).toBe("availability");
    expect((await onboarding.advance()).step).toBe("done");
    expect(settings.load()).toMatchObject({ agentPurpose: "Organize invoices", telemetryEnabled: false, setupComplete: true });
    expect(onboardingIn(home, settings, api).state().step).toBe("done");
    expect(fs.readFileSync(path.join(home, "app/settings.json"), "utf8")).not.toContain("plow_setup_fixture_secret");
  });

  it("persists an injected activation response through the client and controller", async () => {
    const token = "plow_verified_fixture_secret";
    const backend = await injectedApiFixture(({ url }) => {
      if (url === "/v1/auth/activate") return { display_code: "FIXTURE-CODE", activation_secret: "fixture-activation-private", send_to: "+15550001111" };
      if (url === "/v1/auth/activate/redeem") return { status: "verified", token };
      if (url === "/v1/relay/info") return { uid: "account-fixture" };
      throw new Error("unrecognized fixture route");
    });
    const home = temporaryHome();
    const settings = new StrictSettingsStore({ home, codec: encryptedFixtureCodec() });
    let releaseWait: (() => void) | undefined;
    let started = 0;
    const onboarding = onboardingIn(home, settings, backend.api, { wait: (_ms, signal) => new Promise<void>((resolve) => { releaseWait = resolve; signal?.addEventListener("abort", () => resolve(), { once: true }); }), startRelay: async () => { started += 1; } });
    const state = await onboarding.advance();
    expect(state).toMatchObject({ step: "activate", activation: { displayCode: "FIXTURE-CODE" } });
    expect(JSON.stringify(state)).not.toContain("fixture-activation-private");
    releaseWait?.();
    await vi.waitFor(() => expect(onboarding.state().step).toBe("privacy"));
    expect(started).toBe(1);
    expect(settings.load()).toMatchObject({ relayCredential: token, accountUid: "account-fixture", onboardingResumeStep: "privacy" });
    const file = fs.readFileSync(path.join(home, "app/settings.json"), "utf8");
    expect(file).not.toContain(token);
    expect(file).not.toContain("FIXTURE-CODE");
    expect(backend.requests.map((request) => request.url)).toEqual(["/v1/auth/activate", "/v1/auth/activate/redeem", "/v1/relay/info"]);
    expect(backend.requests[2]?.authorization).toBe(`Bearer ${token}`);
  });

  it.each(["reset", "stop"] as const)("does not start polling when an activation mint lands after %s", async (action) => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let entered: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => { entered = resolve; });
    const backend = await injectedApiFixture(async () => { entered?.(); await pending; return { display_code: "LATE-CODE", activation_secret: "late-fixture-secret", send_to: "+15550001111" }; });
    const home = temporaryHome();
    const settings = new StrictSettingsStore({ home, codec: encryptedFixtureCodec() });
    let waits = 0;
    const onboarding = onboardingIn(home, settings, backend.api, { wait: async () => { waits += 1; } });
    const flight = onboarding.advance();
    await requested;
    onboarding[action]();
    release?.();
    await flight;
    expect(onboarding.state().activation).toBeNull();
    expect(waits).toBe(0);
    expect(backend.requests.map((request) => request.url)).toEqual(["/v1/auth/activate"]);
    expect(settings.load().relayCredential).toBe("");
  });

  it("aborts its owned wait during shutdown", async () => {
    const backend = await injectedApiFixture(() => ({ display_code: "STOP-CODE", activation_secret: "stop-fixture-secret", send_to: "+15550001111" }));
    const home = temporaryHome();
    const settings = new StrictSettingsStore({ home, codec: encryptedFixtureCodec() });
    let waitSignal: AbortSignal | undefined;
    let completed = false;
    const onboarding = onboardingIn(home, settings, backend.api, { wait: (_ms, signal) => new Promise<void>((resolve) => { waitSignal = signal; signal?.addEventListener("abort", () => { completed = true; resolve(); }, { once: true }); }) });
    await onboarding.advance();
    expect(waitSignal?.aborted).toBe(false);
    onboarding.stop();
    await Promise.resolve();
    expect(waitSignal?.aborted).toBe(true);
    expect(completed).toBe(true);
    expect(backend.requests).toHaveLength(1);
    expect(onboarding.state().activation).toBeNull();
  });

  it("does not persist a late access probe or accept further setup actions after stop", async () => {
    const home = temporaryHome();
    const settings = new StrictSettingsStore({ home, codec: encryptedFixtureCodec() });
    settings.save({ ...settings.load(), relayCredential: "plow_shutdown_fixture", onboardingResumeStep: "plugins" });
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const api = new PlowApi("http://127.0.0.1:1", async () => { throw new Error("fixture must remain offline"); });
    const onboarding = onboardingIn(home, settings, api, { accessNeeded: async () => { await pending; return false; } });
    onboarding.setTelemetryEnabled(false);
    const before = fs.readFileSync(path.join(home, "app/settings.json"), "utf8");
    const flight = onboarding.advance();
    onboarding.stop();
    release?.();
    await flight;
    expect(onboarding.state().step).toBe("plugins");
    await onboarding.advance();
    await onboarding.back();
    onboarding.setTelemetryEnabled(true);
    expect(onboarding.state()).toMatchObject({ step: "plugins", telemetryEnabled: false });
    expect(fs.readFileSync(path.join(home, "app/settings.json"), "utf8")).toBe(before);
  });

  it("mints a scoped MCP client config with strict settings and keeps it off disk", async () => {
    const backend = await injectedApiFixture(({ method, url }) => {
      if (url === "/v1/api-keys" && method === "POST") return { id: 41, token: "plow_client_fixture_secret", name: "Owner client", scopes: ["relay:call"], chat_uids: [] };
      if (url === "/v1/api-keys") return [{ id: 41, key_prefix: "abcdef", is_active: true, name: "Owner client", created_at: "2026-10-06T10:00:00Z", last_seen_at: null, scopes: ["relay:call"], chat_uids: [], agent_uid: null, device: { uid: "device-fixture", name: "Test Mac" }, relay_resource_uid: "device-fixture" }];
      throw new Error("unrecognized fixture route");
    });
    const home = temporaryHome();
    const settings = new StrictSettingsStore({ home, codec: encryptedFixtureCodec() });
    settings.save({ ...settings.load(), relayCredential: "plow_SESSIONowner_fixture", mcpUrl: `${backend.origin}/v1/relay/devices/device-fixture/mcp` });
    const client = new ConnectClient({ api: backend.api, home, settings, isConnected: () => true, deviceUid: () => "device-fixture" });
    const created = await client.createCredential("Owner client");
    expect(created.credential?.config).toContain("plow_client_fixture_secret");
    expect(created.hasCredential).toBe(true);
    expect(backend.requests[0]).toMatchObject({ method: "POST", url: "/v1/api-keys", authorization: "Bearer plow_SESSIONowner_fixture", body: { name: "Owner client", scopes: ["relay:call"], chat_uids: [], relay_resource_uid: "device-fixture" } });
    expect((await client.refreshRoster()).roster).toMatchObject([{ id: 41, name: "Owner client", chatAccess: "none", deviceLabel: "this Mac", permissions: { canReadAndReply: false, canSpendInference: false } }]);
    expect(fs.readFileSync(path.join(home, "app/settings.json"), "utf8")).not.toContain("plow_client_fixture_secret");
    expect(client.dismissCredential().credential).toBeNull();
  });

  it("runs connector state changes through the maintained client without publishing OAuth codes", async () => {
    let reads = 0;
    let connected = true;
    const backend = await injectedApiFixture(({ method, url }) => {
      if (url === "/v1/connectors") { reads += 1; return { gmail: { accounts: connected && reads > 1 ? [{ account: "owner@fixture.invalid", is_default: true, capabilities: { mail_read: true, mail_write: false, calendar_read: true, calendar_write: false } }] : [] } }; }
      if (url === "/v1/connectors/gmail/connect-code") return { code: "fixture-private-oauth-code" };
      if (method === "POST" && url.startsWith("/v1/connectors/gmail/disconnect?")) { connected = false; return { status: "disconnected" }; }
      throw new Error("unrecognized fixture route");
    });
    const events: { event: string; fields: unknown }[] = [];
    const links: string[] = [];
    const connectors = new Connectors({ api: backend.api, credential: () => "plow_connector_fixture_secret", openExternal: async (url) => { links.push(url); }, wait: async () => {}, recordAudit: (event, fields) => { events.push({ event, fields }); } });
    disposeAfterTest(() => { connectors.signedOut(); });
    const state = await connectors.connect();
    expect(state.google.accounts).toEqual([{ email: "owner@fixture.invalid", isDefault: true, capabilities: { mail_read: true, mail_write: false, calendar_read: true, calendar_write: false } }]);
    expect(links).toEqual([`${backend.origin}/v1/connectors/gmail/connect?code=fixture-private-oauth-code`]);
    expect(events).toContainEqual({ event: "connector_connected", fields: { provider: "google", account: "owner@fixture.invalid" } });
    expect(JSON.stringify([state, events])).not.toContain("fixture-private-oauth-code");
    expect(JSON.stringify([state, events])).not.toContain("plow_connector_fixture_secret");
    expect((await connectors.disconnect("owner@fixture.invalid")).google.accounts).toEqual([]);
    expect(events).toContainEqual({ event: "connector_disconnected", fields: { provider: "google", account: "owner@fixture.invalid" } });
  });

  it("reads a fresh protected credential for every provider mint", async () => {
    const backend = await injectedApiFixture(() => ({ data: { accounts: [{ account: "owner@fixture.invalid", access_token: "provider_fixture_ephemeral", is_default: true, capabilities: { mail_read: true, calendar_read: true } }], degraded: [] } }));
    const home = temporaryHome();
    const settings = new StrictSettingsStore({ home, codec: encryptedFixtureCodec() });
    settings.save({ ...settings.load(), relayCredential: "plow_minter_fixture_one" });
    const minter = buildMinter({ api: backend.api, home, settings });
    const provider = providerFor(["plow-gog"]);
    if (!provider) throw new Error("fixture provider missing from maintained registry");
    expect(await minter.mintAll(provider)).toEqual({ accounts: [{ account: "owner@fixture.invalid", token: "provider_fixture_ephemeral", isDefault: true, capabilities: { mail_read: true, calendar_read: true } }], degraded: [] });
    settings.save({ ...settings.load(), relayCredential: "plow_minter_fixture_two" });
    await minter.mintAll(provider);
    expect(backend.requests.map((request) => request.authorization)).toEqual(["Bearer plow_minter_fixture_one", "Bearer plow_minter_fixture_two"]);
    settings.signOut();
    await expect(minter.mintAll(provider)).rejects.toThrow();
    expect(backend.requests).toHaveLength(2);
  });

  it("removes successfully retired encrypted credentials and retains failures after restart", async () => {
    const home = temporaryHome();
    const codec = encryptedFixtureCodec();
    const settings = new StrictSettingsStore({ home, codec });
    settings.save({ ...settings.load(), pendingRevokeCredentials: ["retire-fixture-one", "retire-fixture-two"] });
    const called: string[] = [];
    const retrier = new PendingRevokeRetrier(home, async (credential) => { called.push(credential); if (credential === "retire-fixture-two") throw new Error("fixture transport failure"); }, settings);
    await retrier.start();
    expect(called).toEqual(["retire-fixture-one", "retire-fixture-two"]);
    expect(new StrictSettingsStore({ home, codec }).load().pendingRevokeCredentials).toEqual(["retire-fixture-two"]);
    expect(fs.readFileSync(path.join(home, "app/settings.json"), "utf8")).not.toContain("retire-fixture-two");
  });

  it("keeps a backend adapter gated when its secret codec is missing", async () => {
    const backend = await injectedApiFixture(() => { throw new Error("locked adapter must not send requests"); });
    const home = temporaryHome();
    const settings = new StrictSettingsStore({ home });
    const services = new OwnerServices({ home, settings, owner: { ownerId: "owner-fixture", organizationId: "org-fixture" }, account: { api: backend.api, apiBaseUrl: backend.origin, deviceName: "isolated-fixture", isConnected: () => false, deviceUid: () => null, startRelay: async () => {}, stopRelay: async () => {}, wakePendingRevokes: () => {}, agentIndex: async () => ({}) } });
    disposeAfterTest(() => services.close());
    const { binding } = ownerBinding();
    expect(await services.query(binding, { channel: "cloud:agents" })).toEqual({ kind: "unavailable", channel: "cloud:agents", reason: "protected_secret_codec_required" });
    expect(services.registry(binding).find((entry) => entry.channel === "onboarding:advance")?.availability).toEqual({ kind: "unavailable", reason: "protected_secret_codec_required" });
    expect(backend.requests).toEqual([]);
  });

  it("projects the real cloud roster and delivers minted configuration only through the private adapter", async () => {
    const backend = await injectedApiFixture(({ method, url }) => {
      if (url === "/v1/agents") return [{ uid: "agent-fixture", provider: "exe:life", name: "Fixture agent", status: "ready", line: { uid: "line-fixture", provider_key: "+15550002222", display_name: "Fixture line" }, credential: { connected: true, session_id: "private-cloud-credential-fixture" }, url: "https://private-cloud-endpoint.invalid/", created_at: "2026-10-06T12:00:00Z" }];
      if (url === "/v1/chats") return { data: [] };
      if (url === "/v1/lines") return { data: [{ uid: "line-fixture", provider_key: "+15550002222", display_name: "Fixture line", agent_uid: "agent-fixture" }] };
      if (url === "/v1/signup") return { managed_phone: "+15550001111", providers: [{ id: "exe:life", name: "Life", phrases: ["Start Life"] }] };
      if (url === "/v1/api-keys" && method === "POST") return { id: 41, token: "plow_MCPconfig_fixture", name: "Owner connection", scopes: ["relay:call"], chat_uids: [] };
      if (url === "/v1/api-keys") return [];
      throw new Error("unrecognized fixture route");
    });
    const home = temporaryHome();
    const settings = new StrictSettingsStore({ home, codec: encryptedFixtureCodec() });
    settings.save({ ...settings.load(), relayCredential: "plow_OWNERregistry_fixture", mcpUrl: `${backend.origin}/v1/relay/devices/device-fixture/mcp` });
    const deliveries: JSONValue[] = [];
    const { binding } = ownerBinding();
    const services = new OwnerServices({
      home, settings, owner: { ownerId: "owner-fixture", organizationId: "org-fixture" },
      account: { api: backend.api, apiBaseUrl: backend.origin, deviceName: "isolated-fixture", isConnected: () => true, deviceUid: () => "device-fixture", startRelay: async () => {}, stopRelay: async () => {}, wakePendingRevokes: () => {}, agentIndex: async () => ({ "exe:life": { blurb: "Fixture catalog description", builder: "Fixture builder", users: 3, successRate: 90, verified: true, rank: 0, logo: null } }) },
      protectedSurface: { show: async (owner, payload) => { expect(owner).toBe(binding); deliveries.push(payload); return { deliveryRef: "private-configuration-fixture" }; } },
    });
    disposeAfterTest(() => services.close());
    const roster = await services.query(binding, { channel: "cloud:refresh" });
    expect(roster).toMatchObject({ kind: "value", value: { cloudAgents: [{ agentId: "agent-fixture", name: "Fixture agent", provider: "exe:life", line: { uid: "line-fixture", label: "Fixture line · +1 555-000-2222" }, connected: true }], cloudAgentIndex: { "exe:life": { blurb: "Fixture catalog description" } }, cloudProviders: [{ id: "exe:life", name: "Life", phrase: "Start Life" }] } });
    expect(JSON.stringify(roster)).not.toContain("private-cloud-credential-fixture");
    expect(JSON.stringify(roster)).not.toContain("private-cloud-endpoint.invalid");
    const command = services.command({ channel: "connect:create", input: { name: "Owner connection" } }, 1);
    if (command.kind !== "native_control") throw new Error("fixture command kind");
    const result = await services.nativeAdapter(binding).perform(command, binding.transport.signal);
    expect(result).toEqual({ kind: "applied" });
    expect(JSON.stringify(deliveries)).toContain("plow_MCPconfig_fixture");
    expect(JSON.stringify(result)).not.toContain("plow_MCPconfig_fixture");
    const publicState = await services.query(binding, { channel: "connect:get" });
    expect(publicState).toMatchObject({ kind: "value", value: { credential: null, credentialAvailable: true, connected: true } });
    expect(JSON.stringify(publicState)).not.toContain("plow_MCPconfig_fixture");
    expect(fs.readFileSync(path.join(home, "app/settings.json"), "utf8")).not.toContain("plow_MCPconfig_fixture");
  });

  it("closes every controller and waits for a late mint even when settings become invalid", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let entered: (() => void) | undefined;
    const requested = new Promise<void>((resolve) => { entered = resolve; });
    const backend = await injectedApiFixture(async () => { entered?.(); await pending; return { display_code: "LATE-CLOSE-CODE", activation_secret: "late-close-private-fixture", send_to: "+15550001111" }; });
    const home = temporaryHome();
    const settings = new StrictSettingsStore({ home, codec: encryptedFixtureCodec() });
    settings.save(settings.load());
    const deliveries: JSONValue[] = [];
    let nativeClosed = false;
    const services = new OwnerServices({
      home, settings, owner: { ownerId: "owner-fixture", organizationId: "org-fixture" },
      account: { api: backend.api, apiBaseUrl: backend.origin, deviceName: "isolated-fixture", isConnected: () => false, deviceUid: () => null, startRelay: async () => {}, stopRelay: async () => {}, wakePendingRevokes: () => {}, agentIndex: async () => ({}) },
      protectedSurface: { show: async (_owner, payload) => { deliveries.push(payload); return { deliveryRef: "private-late-fixture" }; } },
      native: { availability: () => ({ kind: "unavailable", reason: "isolated_fixture" }), call: async (channel) => ({ kind: "unavailable", channel, reason: "isolated_fixture" }), close: async () => { nativeClosed = true; } },
    });
    disposeAfterTest(async () => { await services.close().catch(() => {}); });
    const { binding } = ownerBinding();
    const command = services.command({ channel: "onboarding:advance" }, 1);
    if (command.kind !== "native_control") throw new Error("fixture command kind");
    const flight = services.nativeAdapter(binding).perform(command, binding.transport.signal);
    await requested;
    fs.writeFileSync(path.join(home, "app/settings.json"), "invalid fixture settings");
    let completed = false;
    const close = services.close();
    const rejected = expect(close).rejects.toThrow("close_failed");
    void close.then(() => { completed = true; }, () => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    release?.();
    expect(await flight).toEqual({ kind: "outcome_unknown" });
    await rejected;
    expect(nativeClosed).toBe(true);
    expect(deliveries).toEqual([]);
    expect(backend.requests).toHaveLength(1);
    expect(fs.readFileSync(path.join(home, "app/settings.json"), "utf8")).toBe("invalid fixture settings");
  });
});
