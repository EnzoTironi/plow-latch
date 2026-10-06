import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFile, access } from "node:fs/promises";
import { z } from "zod";
import { fixture } from "./fixture.js";

const opened: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => { for (const host of opened.splice(0)) await host.close(); });
async function setup(options: Parameters<typeof fixture>[0] = {}) { const host = await fixture(options); opened.push(host); return host; }
function data(result: unknown) { return z.object({ structuredContent: z.record(z.string(), z.unknown()), isError: z.boolean().optional() }).passthrough().parse(result); }
async function overview(host: Awaited<ReturnType<typeof fixture>>) {
  return z.object({ revision: z.number(), mode: z.string(), pending: z.array(z.object({ intentId: z.string() }).passthrough()), enrollment: z.object({ status: z.string() }) }).passthrough().parse(data(await host.call("latch_hub_query", {})).structuredContent.hub);
}
async function reviewNative(host: Awaited<ReturnType<typeof fixture>>, intentId: string) {
  let result: ReturnType<typeof data> | undefined;
  await expect.poll(async () => {
    result = data(await host.call("latch_review_intent", { intentId }));
    return result.structuredContent.receipt !== undefined || result.isError === true;
  }, { timeout: 5_000 }).toBe(true);
  return result!;
}
function captureContinuation(host: Awaited<ReturnType<typeof fixture>>, name: string) {
  const original = host.server.fetch;
  let captured: { body: Record<string, unknown>; headers: Headers } | undefined;
  host.server.fetch = async (request, auth) => {
    if (request.method === "POST") {
      const body = z.record(z.string(), z.unknown()).parse(await request.clone().json());
      const params = z.object({ name: z.string(), inputResponses: z.unknown() }).passthrough().safeParse(body.params);
      if (body.method === "tools/call" && params.success && params.data.name === name && params.data.inputResponses !== undefined) captured = { body, headers: new Headers(request.headers) };
    }
    return original(request, auth);
  };
  return async () => {
    if (!captured) throw new Error("continuation_not_captured");
    const response = await original(new Request("http://127.0.0.1/mcp", { method: "POST", headers: captured.headers, body: JSON.stringify({ ...captured.body, id: 999 }) }), { agent_id: host.runtime.principal.id, agent_name: "Fixture owner" });
    const result = z.object({ result: z.unknown() }).parse(await response.json());
    return data(result.result);
  };
}
describe("headless MCP Apps and real owner/runtime integration", () => {
  it("returns the built MCP Apps resource and source tools while refusing a fabricated owner context", async () => {
    const host = await setup({ enrolled: false });
    const names = (await host.client.listTools()).tools.map(tool => tool.name);
    expect(names).toHaveLength(25);
    expect(names).toContain("plow_write_file"); expect(names).toContain("latch_open_hub");
    expect(await host.html()).toContain("Memória do Latch");
    expect((await overview(host)).enrollment.status).toBe("unverified");
    const result = data(await host.client.callTool({ name: "latch_owner_propose", arguments: { command: { kind: "set_mode", mode: "approve" }, expectedRevision: 1 }, _meta: { owner: true, confirmed: true } }));
    expect(result.isError).toBe(true); expect(result.structuredContent.error).toBe("owner_not_enrolled");
    const target = join(host.runtime.device.ownerHome, "must-not-exist.txt");
    const denied = await host.call("plow_write_file", { path: target, content: "forbidden", goal: "fixture outside Plow" });
    expect(denied).toMatchObject({ isError: true }); await expect(access(target)).rejects.toThrow();
  });
  it("binds a real native file review to the request and records the actual decision before executing once", async () => {
    const host = await setup({ choose: async () => "allow_once" });
    const target = join(host.runtime.device.ownerHome, "reviewed.txt");
    await host.call("plow_write_file", { path: target, content: "reviewed native file", goal: "local behavioral verification" });
    const pending = (await overview(host)).pending;
    expect(pending).toHaveLength(1);
    const review = await reviewNative(host, pending[0].intentId);
    expect(review.structuredContent.receipt).toMatchObject({ execution: { kind: "decided", decision: "allow_once", source: "ask" } });
    await expect.poll(async () => readFile(target, "utf8")).toBe("reviewed native file");
    expect(host.runtime.device.audit.entries().filter(entry => entry !== null && typeof entry === "object" && "event" in entry && entry.event === "intent_decision")).toHaveLength(1);
  });
  it("applies settings only after a host proof, respects denial and updates the policy revision", async () => {
    let choice: "deny" | "allow_once" = "deny";
    const host = await setup({ choose: async () => choice });
    const before = await overview(host);
    expect(data(await host.call("latch_owner_propose", { command: { kind: "set_mode", mode: "deny" }, expectedRevision: before.revision })).structuredContent.receipt).toMatchObject({ execution: { kind: "rejected" } });
    expect((await overview(host)).mode).toBe("ask");
    choice = "allow_once";
    expect(data(await host.call("latch_owner_propose", { command: { kind: "set_mode", mode: "deny" }, expectedRevision: before.revision })).structuredContent.receipt).toMatchObject({ execution: { kind: "applied" } });
    const after = await overview(host); expect(after.mode).toBe("deny"); expect(after.revision).toBeGreaterThan(before.revision);
  });
  it("returns the original durable setting receipt when a completed modern continuation is replayed", async () => {
    const host = await setup({ choose: async () => "allow_once" });
    const replay = captureContinuation(host, "latch_owner_propose");
    const before = await overview(host);
    const applied = data(await host.call("latch_owner_propose", { command: { kind: "set_mode", mode: "deny" }, expectedRevision: before.revision }));
    expect(applied.structuredContent.receipt).toMatchObject({ status: "settled", execution: { kind: "applied" } });
    expect((await replay()).structuredContent.receipt).toEqual(applied.structuredContent.receipt);
    expect((await overview(host)).revision).toBe(before.revision + 1);
  });
  it("returns the native decision receipt after its pending intent index has been released", async () => {
    const host = await setup({ choose: async () => "allow_once" });
    const replay = captureContinuation(host, "latch_review_intent");
    const target = join(host.runtime.device.ownerHome, "native-replay.txt");
    await host.call("plow_write_file", { path: target, content: "one confirmed native effect", goal: "verify a completed continuation" });
    const pending = (await overview(host)).pending;
    const initial = await reviewNative(host, pending[0].intentId);
    expect(initial.structuredContent.receipt).toMatchObject({ status: "settled", execution: { kind: "decided", decision: "allow_once" } });
    await expect.poll(async () => readFile(target, "utf8")).toBe("one confirmed native effect");
    expect((await replay()).structuredContent.receipt).toEqual(initial.structuredContent.receipt);
    expect(host.runtime.device.audit.entries().filter(entry => entry !== null && typeof entry === "object" && "event" in entry && entry.event === "intent_decision")).toHaveLength(1);
  });
  it.each([
    { configurationRef: "config:fixture-echo", status: "ready" },
    { configurationRef: "config:unreviewed", status: "disabled" },
  ])("adds a confirmed anonymous connection with state $status and no fabricated credential", async ({ configurationRef, status }) => {
    const host = await setup({ choose: async () => "allow_once" });
    const before = await overview(host);
    const result = data(await host.call("latch_owner_propose", { command: { kind: "add_connection", namespace: "new-connection", configuration: { kind: "cli", configurationRef } }, expectedRevision: before.revision }));
    expect(result.structuredContent.receipt).toMatchObject({ execution: { kind: "applied" } });
    const connections = host.runtime.store.listConnections(host.runtime.principal);
    expect(connections).toHaveLength(2);
    expect(connections.find(connection => connection.namespace === "new-connection")).toMatchObject({ status, credentialRef: null });
  });
  it("searches scoped Unicode memory beyond the first UI page, preserves provenance and refuses a stale correction", async () => {
    const host = await setup();
    for (let i = 0; i < 55; i++) await host.call("latch_memory", { action: "remember", text: `registro ${i}` });
    const remembered = data(await host.call("latch_memory", { action: "remember", text: "Preferência em São Paulo", sourceRefs: ["fixture:source"] }));
    const found = data(await host.call("latch_memory", { action: "search", query: "SÃO PAULO" }));
    expect(found.structuredContent.memories).toMatchObject([{ text: "Preferência em São Paulo", sourceRefs: ["fixture:source"], version: 1 }]);
    const memory = z.object({ id: z.string(), version: z.number() }).passthrough().parse(remembered.structuredContent.memory);
    expect(data(await host.call("latch_memory", { action: "correct", id: memory.id, expectedVersion: memory.version, text: "Porto Alegre" })).isError).not.toBe(true);
    expect(data(await host.call("latch_memory", { action: "correct", id: memory.id, expectedVersion: memory.version, text: "stale" })).structuredContent.error).toBe("conflict");
    expect(host.runtime.store.list({ ...host.runtime.principal, id: "another-user" })).toEqual([]);
  });
  it("executes a real reviewed CLI only after owner confirmation and reuses the stored job on duplicate calls", async () => {
    const host = await setup({ choose: async () => "allow_once" });
    const replay = captureContinuation(host, "latch_review_connection");
    const input = { connectionId: host.connection.id, operation: "echo", arguments: { text: "proof through owner review" }, idempotencyKey: "fixture:one" };
    const started = data(await host.call("latch_call_connection", input));
    const job = z.object({ id: z.string() }).passthrough().parse(started.structuredContent.job);
    const confirmed = data(await host.call("latch_review_connection", { jobId: job.id }));
    await expect.poll(() => host.runtime.store.getJob(host.runtime.principal, job.id).outcome.kind, { timeout: 5_000 }).toBe("completed");
    expect(data(await host.call("latch_call_connection", input)).structuredContent.job).toMatchObject({ id: job.id, outcome: { kind: "completed" } });
    expect(await readFile(join(host.root, "echo-effects.txt"), "utf8")).toBe("effect\n");
    expect(host.runtime.store.getBudget(host.runtime.principal)).toMatchObject({ spentMicros: 10_000, reservedMicros: 0 });
    expect(data(await host.call("latch_job_status", { jobId: job.id })).structuredContent.result).toMatchObject({ outcome: { kind: "completed", actualMicros: 10_000 } });
    expect((await replay()).structuredContent.receipt).toEqual(confirmed.structuredContent.receipt);
  });
  it("cancels a host form without applying a setting", async () => {
    const host = await setup({ choose: async () => "cancel" });
    const before = await overview(host);
    expect(data(await host.call("latch_owner_propose", { command: { kind: "set_mode", mode: "approve" }, expectedRevision: before.revision })).structuredContent.receipt).toMatchObject({ status: "cancelled" });
    expect((await overview(host)).mode).toBe("ask");
  });
  it("reads the maintained owner services and changes a persisted preference only through host confirmation", async () => {
    let choice: "deny" | "allow_once" = "deny";
    const host = await setup({ choose: async () => choice });
    const initial = data(await host.call("latch_owner_query", { channel: "telemetry:get" }));
    expect(initial.structuredContent.service).toEqual({ kind: "value", channel: "telemetry:get", value: { enabled: true } });
    const before = await overview(host);
    expect(data(await host.call("latch_owner_command", { channel: "telemetry:set", input: { on: false }, expectedRevision: before.revision })).structuredContent.receipt).toMatchObject({ execution: { kind: "rejected" } });
    expect(host.runtime.settings.load().telemetryEnabled).toBe(true);
    choice = "allow_once";
    const replay = captureContinuation(host, "latch_owner_command");
    const applied = data(await host.call("latch_owner_command", { channel: "telemetry:set", input: { on: false }, expectedRevision: before.revision }));
    expect(applied.structuredContent.receipt).toMatchObject({ execution: { kind: "applied" } });
    expect(host.runtime.settings.load().telemetryEnabled).toBe(false);
    expect((await replay()).structuredContent.receipt).toEqual(applied.structuredContent.receipt);
    const state = data(await host.call("latch_hub_query", {})).structuredContent.hub;
    const services = z.object({ ownerServices: z.object({ registry: z.array(z.object({ channel: z.string(), availability: z.object({ kind: z.string() }).passthrough() }).passthrough()), subscriptions: z.array(z.unknown()), preferences: z.object({ telemetryEnabled: z.boolean() }) }) }).passthrough().parse(state).ownerServices;
    expect(services.registry).toHaveLength(92);
    expect(services.subscriptions).toHaveLength(17);
    expect(services.preferences.telemetryEnabled).toBe(false);
    expect(services.registry.find(entry => entry.channel === "launch:set")).toMatchObject({ availability: { kind: "unavailable", reason: "signed_native_host_adapter_required" } });
  });
  it("refuses owner reads from a fabricated enrollment and raw vault secrets from the common MCP channel", async () => {
    const closed = await setup({ enrolled: false });
    expect(data(await closed.client.callTool({ name: "latch_owner_query", arguments: { channel: "settings:getRelay" }, _meta: { owner: true, confirmed: true } })).structuredContent.error).toBe("owner_not_enrolled");
    let presented = 0;
    const host = await setup({ choose: async () => { presented++; return "allow_once"; } });
    const before = await overview(host);
    const refused = data(await host.call("latch_owner_command", { channel: "vault:saveItem", input: { type: "login", password: "synthetic-secret-must-stay-out-of-owner-ledger" }, expectedRevision: before.revision }));
    expect(refused.structuredContent.error).toBe("invalid_input");
    expect(presented).toBe(0);
    expect(data(await host.call("latch_owner_query", { channel: "vault:items" })).structuredContent.service).toEqual({ kind: "unavailable", channel: "vault:items", reason: "protected_owner_surface_required" });
  });
});
