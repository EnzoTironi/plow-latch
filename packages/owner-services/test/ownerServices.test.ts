import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { AuditLog } from "@domo/device-core";
import type { HostBinding } from "@domo/owner-runtime";
import { OWNER_CHANNELS, OWNER_EVENTS, OwnerServices, StrictSettingsStore } from "../src/index.js";
import type { OwnerServiceEvent, OwnerServicesOptions } from "../src/index.js";
import { disposeAfterTest, encryptedFixtureCodec, ownerBinding, temporaryHome } from "./fixtures.js";

function servicesIn(home: string, extra: Partial<OwnerServicesOptions> = {}) {
  const settings = new StrictSettingsStore({ home });
  const services = new OwnerServices({ home, settings, owner: { ownerId: "owner-fixture", organizationId: "org-fixture" }, ...extra });
  disposeAfterTest(() => services.close());
  return { services, settings };
}

async function perform(services: OwnerServices, binding: HostBinding, channel: string, input: unknown = {}, signal = binding.transport.signal) {
  const command = services.command({ channel, input }, 1);
  if (command.kind !== "native_control") throw new Error("fixture requires a native control command");
  return services.nativeAdapter(binding).perform(command, signal);
}

function literalChannels(file: string, receiver: string, methods: readonly string[]): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const channels = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === receiver && methods.includes(node.expression.name.text)) {
      const channel = node.arguments[0];
      if (channel && ts.isStringLiteral(channel)) channels.add(channel.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...channels].sort();
}

describe("headless owner services", () => {
  it("recognizes precisely the source owner channels and event vocabulary", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const channels = literalChannels(path.join(root, "apps/desktop/src/main.ts"), "ipcMain", ["handle", "handleOnce", "on"]);
    const events = literalChannels(path.join(root, "apps/desktop/src/preload.cts"), "ipcRenderer", ["on"]);
    expect([...OWNER_CHANNELS].sort()).toEqual(channels);
    expect([...OWNER_EVENTS].sort()).toEqual(events);
    expect(channels).toHaveLength(92);
    expect(events).toHaveLength(17);
  });

  it("requires the bootstrap binding and the enrolled organization and owner", async () => {
    const { services } = servicesIn(temporaryHome());
    const { binding } = ownerBinding();
    expect(services.registry(binding)).toHaveLength(92);
    expect(() => services.registry(ownerBinding("different-owner").binding)).toThrow("wrong_owner");
    expect(() => services.registry(ownerBinding("owner-fixture", "different-org").binding)).toThrow("wrong_owner");
    const forged = JSON.parse(JSON.stringify(binding));
    expect(() => services.registry(forged)).toThrow("owner_not_enrolled");
    expect(() => services.query(binding, { channel: "unknown:channel" })).toThrow("unknown_channel");
    expect(services.nativeAdapter(binding).availability("unknown:channel")).toEqual({ kind: "unavailable", reason: "unknown_channel" });
  });

  it("keeps ordinary reads free of mutations and persists approved adapter mutations", async () => {
    const home = temporaryHome();
    const { services, settings } = servicesIn(home);
    const { binding } = ownerBinding();
    expect(await services.query(binding, { channel: "telemetry:get" })).toEqual({ kind: "value", channel: "telemetry:get", value: { enabled: true } });
    expect(() => services.query(binding, { channel: "telemetry:set", input: { on: false } })).toThrow("owner_approval_required");
    expect(settings.load().telemetryEnabled).toBe(true);
    expect(await perform(services, binding, "telemetry:set", { on: false })).toEqual({ kind: "applied" });
    expect(await perform(services, binding, "ui:setTab", { tab: "audit" })).toEqual({ kind: "applied" });
    expect(await perform(services, binding, "updates:setAutoInstall", { on: false })).toEqual({ kind: "applied" });
    expect(await perform(services, binding, "capabilities:dismiss", { key: "files_documents" })).toEqual({ kind: "applied" });
    expect(new StrictSettingsStore({ home }).load()).toMatchObject({ telemetryEnabled: false, selectedTab: "audit", autoInstallUpdates: false, capabilityDismissals: { files_documents: expect.any(String) } });
    expect(await perform(services, binding, "telemetry:set", { on: "false" })).toEqual({ kind: "unavailable", reason: "invalid_input" });
    expect(settings.load().telemetryEnabled).toBe(false);
  });

  it("routes policy changes only through dedicated owner controller commands", async () => {
    const { services, settings } = servicesIn(temporaryHome());
    const { binding } = ownerBinding();
    expect(services.command({ channel: "settings:setApprovalMode", input: { mode: "ask" } }, 4)).toEqual({ kind: "set_mode", mode: "ask", expectedRevision: 4 });
    expect(services.command({ channel: "settings:setAgentPurpose", input: { purpose: "Archive invoices" } }, 4)).toEqual({ kind: "set_purpose", purpose: "Archive invoices", expectedRevision: 4 });
    expect(services.command({ channel: "rules:remove", input: { key: "a".repeat(64) } }, 4)).toEqual({ kind: "revoke_rule", ruleKey: "a".repeat(64), expectedRevision: 4 });
    expect(await services.nativeAdapter(binding).perform({ kind: "native_control", operation: "settings:setApprovalMode", input: { mode: "approve" }, expectedRevision: 1 }, binding.transport.signal)).toEqual({ kind: "unavailable", reason: "owner_controller_command_required" });
    expect(settings.load().approvalMode).toBe("adversarial");
    expect(() => services.command({ channel: "settings:setApprovalMode", input: { mode: "bad" } }, 1)).toThrow("invalid_input");
  });

  it("indexes real recorded audit events, filters them, and survives restart", async () => {
    const home = temporaryHome();
    const audit = new AuditLog(path.join(home, "audit.ndjson"));
    const { services } = servicesIn(home, { audit });
    const { binding } = ownerBinding();
    const events: OwnerServiceEvent[] = [];
    const unsubscribe = services.subscribe(binding, (event) => { events.push(event); });
    audit.record("intent_received", { intentId: "denied-fixture", agent: "agent-fixture", request: "delete invoice", capabilities: ["Delete invoice"] });
    audit.record("intent_decision", { intentId: "denied-fixture", decision: "deny", source: "adversarial" });
    audit.record("intent_received", { intentId: "allowed-fixture", agent: "agent-fixture", request: "read invoice", capabilities: ["Read invoice"] });
    audit.record("intent_decision", { intentId: "allowed-fixture", decision: "allow_once", source: "prompt" });
    audit.record("exec_end", { intentId: "allowed-fixture", exit_code: 0 });
    const page = await services.query(binding, { channel: "audit:page", input: { decision: "denied", search: "invoice" } });
    expect(page).toMatchObject({ kind: "value", value: { total: 1, size: 2, rows: [{ id: "intent:denied-fixture", title: "delete invoice", decisionKind: "denied", decisionSource: "adversarial" }] } });
    expect(await services.query(binding, { channel: "audit:activity", input: { id: "intent:allowed-fixture" } })).toMatchObject({ kind: "value", value: { intentId: "allowed-fixture", title: "read invoice", statusKind: "completed" } });
    expect(await services.query(binding, { channel: "gatekeeperRecovery:get" })).toEqual({ kind: "value", channel: "gatekeeperRecovery:get", value: { intentId: "denied-fixture", request: "delete invoice" } });
    expect(events).toContainEqual({ channel: "audit:changed", revision: expect.any(Number), ids: ["intent:denied-fixture"] });
    unsubscribe();
    await services.close();
    const restarted = servicesIn(home, { audit: new AuditLog(audit.file) }).services;
    expect(await restarted.query(binding, { channel: "audit:page", input: { status: "completed" } })).toMatchObject({ kind: "value", value: { total: 1, size: 2, rows: [{ id: "intent:allowed-fixture" }] } });
    expect(await perform(restarted, binding, "audit:clear")).toEqual({ kind: "applied" });
    expect(audit.entries()).toEqual([]);
    expect(await restarted.query(binding, { channel: "audit:page" })).toEqual({ kind: "value", channel: "audit:page", value: { rows: [], total: 0, size: 0 } });
  });

  it("removes revoked and closed subscriptions and contains observer failures", async () => {
    const home = temporaryHome();
    const audit = new AuditLog(path.join(home, "audit.ndjson"));
    const { services } = servicesIn(home, { audit });
    const { binding, transport } = ownerBinding();
    const events: OwnerServiceEvent[] = [];
    services.subscribe(binding, (event) => { events.push(event); });
    services.subscribe(binding, async () => { throw new Error("fixture observer failure"); });
    audit.record("intent_received", { intentId: "fixture-1", request: "read document" });
    await Promise.resolve();
    expect(events.map((event) => event.channel)).toEqual(["audit:changed", "capabilities:changed"]);
    transport.abort();
    audit.record("intent_received", { intentId: "fixture-2", request: "read second document" });
    expect(events).toHaveLength(2);
    expect(() => services.query(binding, { channel: "audit:page" })).toThrow("owner_not_enrolled");
    await services.close();
    expect(audit.events.listenerCount("recorded")).toBe(0);
    expect(() => services.registry(ownerBinding().binding)).toThrow("closed");
  });

  it("reports missing genuine adapters per channel without returning fake success", async () => {
    const { services } = servicesIn(temporaryHome());
    const { binding } = ownerBinding();
    const entries = services.registry(binding);
    expect(entries.find((entry) => entry.channel === "cloud:agents")?.availability).toEqual({ kind: "unavailable", reason: "plow_backend_adapter_required" });
    expect(entries.find((entry) => entry.channel === "power:setKeepAwake")?.availability).toEqual({ kind: "unavailable", reason: "signed_native_host_adapter_required" });
    expect(entries.find((entry) => entry.channel === "vault:saveItem")?.availability).toEqual({ kind: "unavailable", reason: "protected_native_vault_adapter_required" });
    expect(entries.find((entry) => entry.channel === "viewer:state")?.availability).toEqual({ kind: "unavailable", reason: "staged_browser_runtime_required" });
    expect(entries.find((entry) => entry.channel === "approval:decide")?.availability).toEqual({ kind: "unavailable", reason: "owner_controller_command_required" });
    expect(await services.query(binding, { channel: "cloud:agents" })).toEqual({ kind: "unavailable", channel: "cloud:agents", reason: "plow_backend_adapter_required" });
    expect(await perform(services, binding, "launch:set", { on: true })).toEqual({ kind: "unavailable", reason: "signed_native_host_adapter_required" });
    expect(entries.filter((entry) => entry.family === "vault").every((entry) => entry.data === "protected_owner")).toBe(true);
    expect(services.subscriptions(binding).find((entry) => entry.channel === "vault:exchange")?.availability).toEqual({ kind: "unavailable", reason: "protected_credential_exchange_adapter_required" });
    expect(services.subscriptions(binding).find((entry) => entry.channel === "audit:changed")?.availability).toEqual({ kind: "unavailable", reason: "audit_log_required" });
  });

  it("validates native inputs and rejects mismatched adapter responses", async () => {
    const calls: string[] = [];
    const { services } = servicesIn(temporaryHome(), { native: {
      availability: () => ({ kind: "ready" }),
      call: async (channel) => { calls.push(channel); return { kind: "value", channel: "launch:get", value: true }; },
    } });
    const { binding } = ownerBinding();
    expect(await perform(services, binding, "launch:set", { on: "yes" })).toEqual({ kind: "unavailable", reason: "invalid_input" });
    expect(calls).toEqual([]);
    expect(await perform(services, binding, "launch:set", { on: true })).toEqual({ kind: "unavailable", reason: "native_response_mismatch" });
    expect(calls).toEqual(["launch:set"]);
  });

  it("keeps throwing native availability checks closed and hides foreign errors", async () => {
    let called = false;
    const { services } = servicesIn(temporaryHome(), { native: {
      availability: () => { throw new Error("foreign_secret_fixture"); },
      call: async (channel) => { called = true; return { kind: "value", channel, value: true }; },
    } });
    const { binding } = ownerBinding();
    expect(services.registry(binding).find((entry) => entry.channel === "launch:set")?.availability).toEqual({ kind: "unavailable", reason: "adapter_availability_failed" });
    const result = await perform(services, binding, "launch:set", { on: true });
    expect(result).toEqual({ kind: "unavailable", reason: "adapter_availability_failed" });
    expect(JSON.stringify(result)).not.toContain("foreign_secret_fixture");
    expect(called).toBe(false);
  });

  it("does not report an interrupted native action as applied", async () => {
    const action = new AbortController();
    let entered: (() => void) | undefined;
    const called = new Promise<void>((resolve) => { entered = resolve; });
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const { services } = servicesIn(temporaryHome(), { native: {
      availability: () => ({ kind: "ready" }),
      call: async (channel) => { entered?.(); await pending; return { kind: "value", channel, value: true }; },
    } });
    const { binding } = ownerBinding();
    const flight = perform(services, binding, "launch:set", { on: true }, action.signal);
    await called;
    action.abort();
    finish?.();
    expect(await flight).toEqual({ kind: "outcome_unknown" });
  });

  it("delegates owner navigation and host events only to explicit presentation adapters", async () => {
    const events: OwnerServiceEvent[] = [];
    const calls: { channel: string; input: unknown }[] = [];
    let hostChanged: ((channel: "ui:showSettings") => void) | undefined;
    let removed = false;
    const { services } = servicesIn(temporaryHome(), { presentation: {
      availability: () => ({ kind: "ready" }),
      call: async (channel, input) => { calls.push({ channel, input }); return { kind: "value", channel, value: true }; },
      subscribe: (listener) => { hostChanged = listener; return () => { removed = true; }; },
    } });
    const { binding } = ownerBinding();
    services.subscribe(binding, (event) => { events.push(event); });
    expect(await perform(services, binding, "ui:confirmLeaveReply", { leave: "yes" })).toEqual({ kind: "unavailable", reason: "invalid_input" });
    expect(calls).toEqual([]);
    expect(await perform(services, binding, "ui:confirmLeaveReply", { leave: false })).toEqual({ kind: "applied" });
    expect(calls).toEqual([{ channel: "ui:confirmLeaveReply", input: { leave: false } }]);
    hostChanged?.("ui:showSettings");
    expect(events).toEqual([{ channel: "ui:showSettings", revision: expect.any(Number) }]);
    expect(services.subscriptions(binding).find((entry) => entry.channel === "ui:showSettings")?.availability).toEqual({ kind: "ready" });
    await services.close();
    expect(removed).toBe(true);
  });

  it("does not expose persisted relay credentials in owner query results", async () => {
    const home = temporaryHome();
    const settings = new StrictSettingsStore({ home, codec: encryptedFixtureCodec() });
    settings.save({ ...settings.load(), relayCredential: "plow_owner_query_fixture_secret", accountUid: "account-fixture" });
    const { services } = servicesIn(home, { settings });
    const { binding } = ownerBinding();
    const response = await services.query(binding, { channel: "settings:getRelay" });
    expect(response).toMatchObject({ kind: "value", value: { hasCredential: true, accountUid: "account-fixture", connected: false } });
    expect(JSON.stringify(response)).not.toContain("plow_owner_query_fixture_secret");
    expect(JSON.stringify(response)).not.toContain("relayCredentialEnc");
  });
});
