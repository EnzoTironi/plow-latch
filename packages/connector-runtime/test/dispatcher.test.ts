import { afterEach, describe, expect, it } from "vitest";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { HubStore } from "@domo/integration-hub";
import { ConnectorDispatcher, CredentialBroker, ReviewedCatalog, digest, type Authorizer } from "../src/index.js";
import { alice, approve, cli, grant, httpFixture, operation, removeRoot, reviewGate, runtime, secret, temporaryRoot, TestSecretStore } from "./transportFixtures.js";

const roots: string[] = [], closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); for (const root of roots.splice(0)) await removeRoot(root); });
async function root() { const value = await temporaryRoot(); roots.push(value); return value; }
function track<T extends { close: () => Promise<void> }>(value: T): T { closers.push(value.close); return value; }
function bindingSecrets() {
  const secrets = new TestSecretStore();
  return { secrets, binding: (id: string) => { const binding = grant(id); secrets.records.set(binding.grantId, secret(binding)); return binding; } };
}

describe("reviewed dispatcher transport fixtures, not provider or human proof", () => {
  it.each(["denied", "unavailable", "expired"] as const)("fails closed for %s authorization before reading credentials or causing an effect", async kind => {
    const fixture = track(await httpFixture()), protectedState = bindingSecrets(), subject = track(await runtime(await root(), { transport: fixture.transport, ...protectedState, broker: new CredentialBroker({ secretStore: protectedState.secrets }), authorizer: { review: async () => ({ kind }) } }));
    const job = await subject.call(); await subject.dispatcher.wait(alice, job.id);
    expect(subject.store.getJob(alice, job.id).outcome).toEqual({ kind: "failed", actualMicros: 0, receiptRef: null });
    expect(subject.store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
    expect(protectedState.secrets.reads).toBe(0); expect(fixture.effects()).toBe(0);
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { errorCode: `approval_${kind}` } });
  });
  it.each(["digest", "owner", "deadline"])("refuses authorization with a changed %s binding", async changed => {
    const fixture = track(await httpFixture());
    const authorizer: Authorizer = { review: async ({ plan }) => ({ kind: "approved", planDigest: changed === "digest" ? "wrong" : plan.planDigest, ownerPrincipalId: changed === "owner" ? "bob" : plan.ownerPrincipalId, evidenceRef: "fixture:review", expiresAt: changed === "deadline" ? 1 : plan.expiresAt }) };
    const subject = track(await runtime(await root(), { transport: fixture.transport, authorizer })), job = await subject.call(); await subject.dispatcher.wait(alice, job.id);
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { errorCode: "approval_expired" } });
    expect(subject.store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 0 }); expect(fixture.effects()).toBe(0);
  });
  it("rechecks current principal scopes after a frozen review", async () => {
    const fixture = track(await httpFixture()), gate = reviewGate(); let current = alice;
    const subject = track(await runtime(await root(), { transport: fixture.transport, authorizer: gate.authorizer, resolvePrincipal: () => current }));
    const job = await subject.call(); await gate.received; current = { ...alice, scopes: [] }; gate.release(); await subject.dispatcher.wait(alice, job.id);
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { errorCode: "scope_denied" } });
    expect(subject.store.getBudget(alice).reservedMicros).toBe(0); expect(fixture.effects()).toBe(0);
  });
  it("rejects a connection revoked or revised while review is pending", async () => {
    const fixture = track(await httpFixture()), gate = reviewGate(), subject = track(await runtime(await root(), { transport: fixture.transport, authorizer: gate.authorizer }));
    const job = await subject.call(); await gate.received;
    subject.store.setConnectionStatus(alice, { id: subject.connection.id, status: "disabled" }); subject.store.setConnectionStatus(alice, { id: subject.connection.id, status: "ready" }); gate.release();
    expect((await subject.dispatcher.wait(alice, job.id)).outcome.kind).toBe("cancelled");
    expect(subject.store.getBudget(alice).reservedMicros).toBe(0); expect(fixture.effects()).toBe(0);
  });
  it("locks a credential-required operation when no protected secret adapter exists", async () => {
    const fixture = track(await httpFixture()), subject = track(await runtime(await root(), { transport: fixture.transport, binding: id => grant(id) }));
    const job = await subject.call(); await subject.dispatcher.wait(alice, job.id);
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { errorCode: "credentials_locked" } });
    expect(subject.store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 0 }); expect(fixture.effects()).toBe(0);
  });
  it("refuses a secret record bound to a different account", async () => {
    const fixture = track(await httpFixture()), protectedState = bindingSecrets();
    const subject = track(await runtime(await root(), { transport: fixture.transport, broker: new CredentialBroker({ secretStore: protectedState.secrets }), binding: id => { const binding = protectedState.binding(id); protectedState.secrets.records.set(binding.grantId, secret({ ...binding, accountId: "other-account" })); return binding; } }));
    const job = await subject.call(); await subject.dispatcher.wait(alice, job.id);
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { errorCode: "grant_mismatch" } });
    expect(subject.store.getBudget(alice).reservedMicros).toBe(0); expect(fixture.effects()).toBe(0);
  });
  it("disables locally before upstream revocation and removes the protected grant", async () => {
    const fixture = track(await httpFixture()), protectedState = bindingSecrets(), gate = reviewGate();
    let localStatus = "", releaseUpstream: (() => void) | undefined;
    const upstream = new Promise<void>(resolve => { releaseUpstream = resolve; });
    const broker = new CredentialBroker({ secretStore: protectedState.secrets, hooks: { revoke: async () => { localStatus = subject.store.getConnection(alice, subject.connection.id).status; await upstream; return "confirmed"; } } });
    const subject = track(await runtime(await root(), { transport: fixture.transport, broker, binding: protectedState.binding, authorizer: gate.authorizer }));
    const job = await subject.call(); await gate.received;
    const binding = subject.review.grant; if (!binding) throw new Error("fixture grant missing");
    const revocation = broker.revoke({ principal: alice, binding, disableLocal: () => { subject.store.revokeConnection(alice, subject.connection.id); } });
    expect(subject.store.getConnection(alice, subject.connection.id).status).toBe("revoked");
    expect(() => subject.call("blocked", "second")).toThrow("connection_unavailable");
    gate.release(); await subject.dispatcher.wait(alice, job.id); releaseUpstream?.();
    expect(await revocation).toEqual({ upstream: "confirmed", removed: true });
    expect(localStatus).toBe("revoked"); expect(protectedState.secrets.records.size).toBe(0); expect(fixture.effects()).toBe(0);
  });
  it("reserves a known upper bound before review and refuses a competing over-budget request", async () => {
    const fixture = track(await httpFixture()), gate = reviewGate(), subject = track(await runtime(await root(), { transport: fixture.transport, authorizer: gate.authorizer })); subject.store.setBudget(alice, 10);
    const job = await subject.call(); await gate.received;
    expect(subject.store.getBudget(alice)).toMatchObject({ limitMicros: 10, spentMicros: 0, reservedMicros: 7 });
    expect(() => subject.call("competing", "second")).toThrow("budget_exceeded");
    expect(fixture.effects()).toBe(0); gate.release(); await subject.dispatcher.wait(alice, job.id);
    expect(subject.store.getBudget(alice)).toMatchObject({ limitMicros: 10, spentMicros: 3, reservedMicros: 0 }); expect(fixture.effects()).toBe(1);
  });
  it.each(["effect", "cost"])("preserves an unknown %s and its reservation after a real operation", async unknown => {
    const fixture = track(await httpFixture());
    const reviewed = operation({ api: { method: "POST", path: "/echo" }, ...(unknown === "effect" ? { effects: [{ kind: "unknown", reason: "reviewed provider effect remains unknown" }] } : { cost: { upperBoundMicros: 7, settlement: { kind: "unknown" } } }) });
    const subject = track(await runtime(await root(), { transport: fixture.transport, operation: reviewed })), job = await subject.call("uncertain"); await subject.dispatcher.wait(alice, job.id);
    expect(subject.store.getJob(alice, job.id).outcome.kind).toBe("outcome_unknown");
    expect(subject.store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 7 });
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { echo: "uncertain" } });
    expect((await subject.call("uncertain")).id).toBe(job.id); expect(fixture.effects()).toBe(1);
  });
  it("retains the reserve when a provider charge exceeds its reviewed upper bound", async () => {
    const fixture = track(await httpFixture({ handler: (_req, res, _body) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"echo":"too costly","chargeMicros":99}'); } }));
    const subject = track(await runtime(await root(), { transport: fixture.transport, operation: operation({ api: { method: "POST", path: "/echo" }, cost: { upperBoundMicros: 7, settlement: { kind: "response", pointer: "/chargeMicros" } } }) }));
    const job = await subject.call(); await subject.dispatcher.wait(alice, job.id);
    expect(subject.store.getJob(alice, job.id).outcome.kind).toBe("outcome_unknown"); expect(subject.store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 7 });
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { chargeMicros: 99 } });
  });
  it("refuses redirects without sending credentials to the redirected destination", async () => {
    const fixture = track(await httpFixture()), protectedState = bindingSecrets();
    const subject = track(await runtime(await root(), { transport: fixture.transport, broker: new CredentialBroker({ secretStore: protectedState.secrets }), binding: protectedState.binding, operation: operation({ api: { method: "POST", path: "/redirect" } }) }));
    const job = await subject.call(); await subject.dispatcher.wait(alice, job.id);
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { errorCode: "redirect_refused" } });
    expect(fixture.seen.map(value => value.path)).toEqual(["/redirect"]); expect(subject.store.getBudget(alice).reservedMicros).toBe(7);
  });
  it("bounds streamed HTTP output and preserves an uncertain in-flight cost", async () => {
    const fixture = track(await httpFixture({ handler: (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ text: "x".repeat(50_000) })); } }));
    const subject = track(await runtime(await root(), { transport: fixture.transport, operation: operation({ api: { method: "POST", path: "/echo" }, maxOutputBytes: 1024 }) })), job = await subject.call(); await subject.dispatcher.wait(alice, job.id);
    expect(subject.store.getJob(alice, job.id).outcome.kind).toBe("outcome_unknown");
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { errorCode: "output_limit" } }); expect(subject.store.getBudget(alice).reservedMicros).toBe(7);
  });
  it("cancels a CLI process, cleans its temporary home and retains its unknown effect", async () => {
    const directory = await root(), marker = join(directory, "process.json");
    const program = await cli(directory, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,home:process.env.HOME})); setInterval(()=>{},1000);`);
    const subject = track(await runtime(directory, { kind: "cli", destination: { kind: "cli", ...program }, operation: operation({ buildArguments: () => [], timeoutMs: 5000 }) }));
    const job = await subject.call();
    let processState: { pid: number; home: string } | undefined;
    for (let index = 0; index < 500; index++) { try { processState = JSON.parse(await readFile(marker, "utf8")); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
    if (!processState) throw new Error(`fixture child did not launch ${JSON.stringify(subject.dispatcher.result(alice, job.id)?.value)}`);
    subject.dispatcher.cancel(alice, job.id); await subject.dispatcher.wait(alice, job.id);
    expect(subject.store.getJob(alice, job.id).outcome.kind).toBe("outcome_unknown");
    expect(() => process.kill(processState.pid, 0)).toThrow(); await expect(readFile(join(processState.home, "unused"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(subject.store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 7 });
  });
  it("refuses an executable that changed after owner review before it launches", async () => {
    const directory = await root(), program = await cli(directory), subject = track(await runtime(directory, { kind: "cli", destination: { kind: "cli", ...program }, operation: operation({ buildArguments: input => [String(input.text)] }) }));
    await writeFile(program.executable, `#!${process.execPath}\nthrow new Error('changed program');`);
    const job = await subject.call(); await subject.dispatcher.wait(alice, job.id);
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { errorCode: "schema_drift" } });
    expect(subject.store.getJob(alice, job.id).outcome.kind).toBe("failed"); expect(subject.store.getBudget(alice).reservedMicros).toBe(0);
  });
  it("does not launch an existing waiting job in a fresh dispatcher", async () => {
    const fixture = track(await httpFixture()), subject = track(await runtime(await root(), { transport: fixture.transport }));
    const input = { connectionId: subject.connection.id, operation: "echo", arguments: { text: "existing waiting" }, idempotencyKey: "existing" };
    const original = subject.store.createJob(alice, { connectionId: subject.connection.id, operation: "echo", intentId: `connector:${digest(input)}`, arguments: {}, idempotencyKey: "existing", upperBoundMicros: 7 });
    const retry = await subject.dispatcher.call(alice, input);
    expect(retry.id).toBe(original.id); expect((await subject.dispatcher.wait(alice, retry.id)).outcome.kind).toBe("waiting");
    expect(fixture.effects()).toBe(0); expect(subject.store.getBudget(alice).reservedMicros).toBe(7);
    expect(subject.dispatcher.cancel(alice, retry.id).outcome.kind).toBe("cancelled"); expect(subject.store.getBudget(alice).reservedMicros).toBe(0);
  });
  it("never replays an external effect after a hard-crashed executing process", async () => {
    let effectCount = 0, resolveEffect: (() => void) | undefined;
    const effect = new Promise<void>(resolve => { resolveEffect = resolve; });
    const fixture = track(await httpFixture({ handler: (_req, _res, _body) => { effectCount++; resolveEffect?.(); } })), directory = await root(), subject = track(await runtime(directory, { transport: fixture.transport }));
    const input = { connectionId: subject.connection.id, operation: "echo", arguments: { text: "crash once" }, idempotencyKey: "crash" };
    const script = `import {ConnectorDispatcher,CredentialBroker,ReviewedCatalog} from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
import {HubStore} from ${JSON.stringify(new URL("../../integration-hub/dist/index.js", import.meta.url).href)};
const principal=${JSON.stringify(alice)}, store=new HubStore({path:${JSON.stringify(subject.store.path)}});
const dispatcher=new ConnectorDispatcher({store,catalog:new ReviewedCatalog([${JSON.stringify(subject.review)}]),broker:new CredentialBroker(),resolvePrincipal:p=>p,authorizer:{review:async({plan})=>({kind:'approved',planDigest:plan.planDigest,ownerPrincipalId:plan.ownerPrincipalId,evidenceRef:'fixture:crash',expiresAt:plan.expiresAt})},transport:{fixtureHttpTransport:{kind:'loopback_transport_fixture',fetch:(input,init)=>{const url=new URL(input instanceof Request?input.url:input.toString());return fetch(new URL(url.pathname,${JSON.stringify(fixture.origin)}),init);}}}});
const job=await dispatcher.call(principal,${JSON.stringify(input)}); process.stdout.write(job.id+'\\n'); await dispatcher.wait(principal,job.id);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
    const output = await once(child.stdout, "data"), jobId = output[0].toString().trim();
    try {
      await Promise.race([effect, new Promise((_, reject) => setTimeout(() => reject(new Error("crash fixture effect missing")), 3000).unref())]);
      const stopped = once(child, "exit"); child.kill("SIGKILL"); await stopped;
      const reopened = new HubStore({ path: subject.store.path }); closers.push(async () => reopened.close());
      const restarted = new ConnectorDispatcher({ store: reopened, catalog: new ReviewedCatalog([subject.review]), broker: new CredentialBroker(), authorizer: approve, resolvePrincipal: principal => principal, transport: fixture.transport }); closers.push(() => restarted.close());
      expect(reopened.getJob(alice, jobId).outcome.kind).toBe("outcome_unknown");
      expect((await restarted.call(alice, input)).id).toBe(jobId); expect((await restarted.wait(alice, jobId)).outcome.kind).toBe("outcome_unknown");
      expect(reopened.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 7 }); expect(effectCount).toBe(1);
    } finally { child.kill("SIGKILL"); }
  });
});
