import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CredentialBroker, type FrozenPlan } from "../src/index.js";
import { alice, bob, cli, echoSchema, grant, httpFixture, operation, removeRoot, reviewGate, runtime, secret, stdio, temporaryRoot, TestSecretStore } from "./transportFixtures.js";

const roots: string[] = [], closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); for (const root of roots.splice(0)) await removeRoot(root); });
async function root() { const value = await temporaryRoot(); roots.push(value); return value; }
function track<T extends { close: () => Promise<void> }>(value: T): T { closers.push(value.close); return value; }

describe("connector transport fixtures, not provider or human proof", () => {
  it("pins the input schema emitted by the real MCP fixture", async () => {
    const fixture = track(await httpFixture({ mcp: true })), client = new Client({ name: "discovery-test", version: "1" });
    try { await client.connect(new StreamableHTTPClientTransport(new URL(`${fixture.origin}/mcp`))); expect((await client.listTools()).tools[0]?.inputSchema).toEqual(echoSchema); }
    finally { await client.close(); }
  });
  it("executes a reviewed API echo and stores a private receipt with one budget charge", async () => {
    const fixture = track(await httpFixture()), subject = track(await runtime(await root(), { transport: fixture.transport }));
    const job = await subject.call("API hello"), terminal = await subject.dispatcher.wait(alice, job.id), result = subject.dispatcher.result(alice, job.id);
    expect(terminal.outcome).toMatchObject({ kind: "completed", actualMicros: 3 });
    expect(result?.value).toMatchObject({ output: { echo: "API hello", chargeMicros: 3 }, authorizationEvidenceRef: "fixture:transport-review" });
    expect(result?.receiptRef).toMatch(/^receipt:/);
    expect(fixture.effects()).toBe(1);
    expect(subject.store.getBudget(alice)).toMatchObject({ spentMicros: 3, reservedMicros: 0 });
    expect(subject.dispatcher.list(alice).map(value => value.id)).toEqual([job.id]);
  });
  it("runs an absolute reviewed CLI without a shell or inherited user and cloud tokens", async () => {
    const directory = await root(), program = await cli(directory);
    const subject = track(await runtime(directory, { kind: "cli", destination: { kind: "cli", ...program }, operation: operation({ buildArguments: input => [String(input.text)] }) }));
    const priorCloud = process.env.AWS_SECRET_ACCESS_KEY, priorUser = process.env.USER_TOKEN;
    process.env.AWS_SECRET_ACCESS_KEY = "fixture-cloud-token"; process.env.USER_TOKEN = "fixture-user-token";
    try {
      const job = await subject.call("$(echo unwanted); & literal"), terminal = await subject.dispatcher.wait(alice, job.id);
      expect(terminal.outcome.kind).toBe("completed");
      const result = subject.dispatcher.result(alice, job.id), value = result?.value;
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("CLI result missing");
      const output = value.output;
      if (output === null || typeof output !== "object" || Array.isArray(output) || typeof output.stdout !== "string") throw new Error("CLI stdout missing");
      const echoed = JSON.parse(output.stdout);
      expect(echoed).toMatchObject({ text: "$(echo unwanted); & literal", cloud: null, user: null, cwd: directory });
      expect(echoed.home).not.toBe(process.env.HOME);
      await expect(readFile(join(echoed.home, "anything"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { if (priorCloud === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = priorCloud; if (priorUser === undefined) delete process.env.USER_TOKEN; else process.env.USER_TOKEN = priorUser; }
  });
  it("calls an actual SDK 2 stdio MCP fixture after schema discovery", async () => {
    const directory = await root(), program = await stdio(directory), subject = track(await runtime(directory, { kind: "mcp_stdio", destination: { kind: "mcp_stdio", ...program }, operation: operation() }));
    const job = await subject.call("STDIO hello"), terminal = await subject.dispatcher.wait(alice, job.id);
    expect(terminal.outcome.kind, JSON.stringify(subject.dispatcher.result(alice, job.id)?.value)).toBe("completed");
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { content: [{ type: "text", text: "STDIO hello" }], structuredContent: { echo: "STDIO hello", cloud: null, user: null } } });
    expect(await readFile(join(directory, "mcp-effects.txt"), "utf8")).toBe("effect\n");
  });
  it("calls an actual SDK 2 HTTP MCP fixture through an explicitly injected loopback transport", async () => {
    const fixture = track(await httpFixture({ mcp: true })), subject = track(await runtime(await root(), { kind: "mcp_http", operation: operation(), transport: fixture.transport }));
    const job = await subject.call("HTTP MCP hello"), terminal = await subject.dispatcher.wait(alice, job.id);
    expect(terminal.outcome.kind, JSON.stringify(subject.dispatcher.result(alice, job.id)?.value)).toBe("completed");
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { content: [{ type: "text", text: "HTTP MCP hello" }], structuredContent: { echo: "HTTP MCP hello" } } });
    expect(fixture.effects()).toBe(1);
  });
  it("rejects upstream MCP schema drift before any tool effect and ignores its read-only annotation", async () => {
    const fixture = track(await httpFixture({ mcp: true, changedSchema: true })), seenPlans: FrozenPlan[] = [];
    const subject = track(await runtime(await root(), { kind: "mcp_http", operation: operation(), transport: fixture.transport, authorizer: { review: async ({ plan }) => { seenPlans.push(plan); return { kind: "approved", planDigest: plan.planDigest, ownerPrincipalId: "alice", evidenceRef: "fixture:review", expiresAt: plan.expiresAt }; } } }));
    const job = await subject.call("refuse drift"), terminal = await subject.dispatcher.wait(alice, job.id);
    expect(terminal.outcome).toEqual({ kind: "outcome_unknown" });
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { errorCode: "schema_drift" } });
    expect(seenPlans[0]?.effects).toEqual([{ kind: "write", resource: "fixture:echo" }]);
    expect(fixture.effects()).toBe(0);
    expect(subject.store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 7 });
  });
  it("redacts active grant values even when the API echoes its authorization header", async () => {
    const fixture = track(await httpFixture()), secrets = new TestSecretStore();
    const subject = track(await runtime(await root(), { transport: fixture.transport, broker: new CredentialBroker({ secretStore: secrets }), binding: connectionId => { const binding = grant(connectionId); secrets.records.set(binding.grantId, secret(binding)); return binding; } }));
    const job = await subject.call("bound credentials"); await subject.dispatcher.wait(alice, job.id);
    const result = subject.dispatcher.result(alice, job.id);
    expect(result?.value).toMatchObject({ output: { echo: "bound credentials", credentialEcho: "Bearer [redacted]" } });
    expect(fixture.seen[0]?.authorization).toBe("Bearer fixture-access-secret-123456");
    expect(JSON.stringify(result)).not.toContain("fixture-access-secret-123456");
    subject.store.close();
    const persisted = await readFile(subject.store.path);
    expect(persisted.toString("utf8")).not.toContain("fixture-access-secret-123456");
    expect(persisted.toString("utf8")).not.toContain("fixture-refresh-secret-123456");
  });
  it("shares one execution promise across duplicate calls and keeps status and result polling read only", async () => {
    const fixture = track(await httpFixture()), gate = reviewGate(), subject = track(await runtime(await root(), { transport: fixture.transport, authorizer: gate.authorizer }));
    const [first, second] = await Promise.all([subject.call("once"), subject.call("once")]); await gate.received;
    expect(first.id).toBe(second.id);
    for (let index = 0; index < 5; index++) { expect(subject.dispatcher.status(alice, first.id).outcome.kind).toBe("waiting"); expect(subject.dispatcher.result(alice, first.id)).toBeNull(); }
    expect(fixture.effects()).toBe(0); gate.release(); await subject.dispatcher.wait(alice, first.id);
    expect((await subject.call("once")).id).toBe(first.id);
    expect(fixture.effects()).toBe(1);
    expect(subject.store.listAudit(alice).filter(value => value.event === "job_started")).toHaveLength(1);
    expect(subject.store.listAudit(alice).filter(value => value.event === "job_settled")).toHaveLength(1);
    expect(() => subject.call("changed")).toThrow("invalid_input");
    subject.store.revokeConnection(alice, subject.connection.id);
    expect((await subject.call("once")).id).toBe(first.id);
    expect(fixture.effects()).toBe(1);
  });
  it("hides job results and receipt handles from another principal and organization", async () => {
    const fixture = track(await httpFixture()), subject = track(await runtime(await root(), { transport: fixture.transport }));
    const job = await subject.call("private result"); await subject.dispatcher.wait(alice, job.id);
    for (const principal of [bob, { ...alice, organizationId: "other-org" }]) {
      expect(() => subject.dispatcher.status(principal, job.id)).toThrow("not_found");
      expect(() => subject.dispatcher.result(principal, job.id)).toThrow("not_found");
      expect(subject.dispatcher.list(principal)).toEqual([]);
    }
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { echo: "private result" } });
  });
  it("freezes the exact request and refuses a model-supplied approval or owner", async () => {
    const fixture = track(await httpFixture()), gate = reviewGate(), subject = track(await runtime(await root(), { transport: fixture.transport, authorizer: gate.authorizer }));
    const raw = { connectionId: subject.connection.id, operation: "echo", arguments: { text: "frozen" }, idempotencyKey: "first" };
    for (const extra of [{ approve: true }, { ownerPrincipalId: "alice" }, { principal: alice }]) expect(() => subject.dispatcher.call(alice, { ...raw, ...extra })).toThrow("invalid_input");
    const job = await subject.dispatcher.call(alice, raw), plan = await gate.received; raw.arguments.text = "mutated model arguments";
    expect(Object.isFrozen(plan)).toBe(true); expect(Object.isFrozen(plan.arguments)).toBe(true); expect(Object.isFrozen(plan.request)).toBe(true);
    expect(plan.request).toEqual({ kind: "api", url: "https://fixture.test/echo", method: "POST", body: { text: "frozen" } });
    gate.release(); await subject.dispatcher.wait(alice, job.id);
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { echo: "frozen" } });
  });
});
