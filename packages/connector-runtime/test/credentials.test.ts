import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { CredentialBroker, GrantBindingSchema, GrantRefreshError } from "../src/index.js";
import { alice, cli, grant, httpFixture, operation, removeRoot, runtime, secret, temporaryRoot, TestSecretStore } from "./transportFixtures.js";

const roots: string[] = [], closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); for (const root of roots.splice(0)) await removeRoot(root); });
async function root() { const value = await temporaryRoot(); roots.push(value); return value; }
function track<T extends { close: () => Promise<void> }>(value: T): T { closers.push(value.close); return value; }

describe("protected broker transport fixtures, not deployed OAuth or provider proof", () => {
  it("refreshes once for concurrent jobs, atomically rotates the protected grant and redacts its new token", async () => {
    const fixture = track(await httpFixture()), secrets = new TestSecretStore();
    let refreshRequests = 0;
    const tokenFixture = track(await httpFixture({ handler: (_req, res, body) => { refreshRequests++; const input = JSON.parse(body.toString("utf8")); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ...input, revision: input.revision + 1, accessToken: "fixture-rotated-access", refreshToken: "fixture-rotated-refresh", expiresAt: Date.now() + 120_000 })); } }));
    const broker = new CredentialBroker({ secretStore: secrets, hooks: { refresh: async (record, signal) => { const response = await fetch(`${tokenFixture.origin}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(record), signal }); return response.json(); } } });
    const subject = track(await runtime(await root(), { broker, transport: fixture.transport, binding: id => { const binding = grant(id); secrets.records.set(binding.grantId, secret(binding, { expiresAt: 1 })); return binding; } }));
    const [first, second] = await Promise.all([subject.call("first", "first"), subject.call("second", "second")]);
    await Promise.all([subject.dispatcher.wait(alice, first.id), subject.dispatcher.wait(alice, second.id)]);
    expect(refreshRequests).toBe(1); expect(fixture.effects()).toBe(2);
    expect(secrets.records.get("fixture-grant")).toMatchObject({ revision: 2, accessToken: "fixture-rotated-access", refreshToken: "fixture-rotated-refresh" });
    expect(fixture.seen.map(value => value.authorization)).toEqual(["Bearer fixture-rotated-access", "Bearer fixture-rotated-access"]);
    expect(subject.dispatcher.result(alice, first.id)?.value).toMatchObject({ output: { echo: "first", credentialEcho: "Bearer [redacted]" } });
    expect(subject.dispatcher.result(alice, second.id)?.value).toMatchObject({ output: { echo: "second", credentialEcho: "Bearer [redacted]" } });
    expect(subject.store.getBudget(alice)).toMatchObject({ spentMicros: 6, reservedMicros: 0 });
  });
  it("requires reauthorization on invalid_grant without retrying the business operation", async () => {
    const fixture = track(await httpFixture()), secrets = new TestSecretStore();
    const broker = new CredentialBroker({ secretStore: secrets, hooks: { refresh: async () => { throw new GrantRefreshError("invalid_grant"); } } });
    const subject = track(await runtime(await root(), { broker, transport: fixture.transport, binding: id => { const binding = grant(id); secrets.records.set(binding.grantId, secret(binding, { expiresAt: 1 })); return binding; } }));
    const job = await subject.call(); await subject.dispatcher.wait(alice, job.id);
    expect(subject.store.getConnection(alice, subject.connection.id).status).toBe("needs_reauth");
    expect(subject.store.getJob(alice, job.id).outcome.kind).toBe("cancelled");
    expect(subject.store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 0 }); expect(fixture.effects()).toBe(0);
    expect(() => subject.call("retry", "another")).toThrow("connection_unavailable");
  });
  it.each(["issuer", "account", "revision"])("rejects a refreshed grant with a changed %s binding", async changed => {
    const fixture = track(await httpFixture()), secrets = new TestSecretStore();
    const broker = new CredentialBroker({ secretStore: secrets, hooks: { refresh: async record => ({ ...record, revision: changed === "revision" ? record.revision + 2 : record.revision + 1, binding: { ...record.binding, ...(changed === "issuer" ? { issuer: "https://other-issuer.fixture.test" } : changed === "account" ? { accountId: "other-account" } : {}) }, expiresAt: Date.now() + 120_000 }) } });
    const subject = track(await runtime(await root(), { broker, transport: fixture.transport, binding: id => { const binding = grant(id); secrets.records.set(binding.grantId, secret(binding, { expiresAt: 1 })); return binding; } }));
    const job = await subject.call(); await subject.dispatcher.wait(alice, job.id);
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { errorCode: "grant_mismatch" } });
    expect(secrets.records.get("fixture-grant")?.revision).toBe(1); expect(fixture.effects()).toBe(0);
  });
  it("revokes an in-flight refresh rotation before reporting upstream revocation confirmed", async () => {
    const fixture = track(await httpFixture()), secrets = new TestSecretStore();
    let releaseRefresh: (() => void) | undefined, signalRefresh: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { releaseRefresh = resolve; }), entered = new Promise<void>(resolve => { signalRefresh = resolve; });
    const revoked: string[] = [];
    const broker = new CredentialBroker({ secretStore: secrets, hooks: { refresh: async record => { signalRefresh?.(); await gate; return { ...record, revision: 2, accessToken: "fixture-late-access", refreshToken: "fixture-late-refresh", expiresAt: Date.now() + 120_000 }; }, revoke: async record => { revoked.push(record.accessToken); return "confirmed"; } } });
    const subject = track(await runtime(await root(), { broker, transport: fixture.transport, binding: id => { const binding = grant(id); secrets.records.set(binding.grantId, secret(binding, { expiresAt: 1 })); return binding; } }));
    const job = await subject.call(); await entered;
    const binding = subject.review.grant; if (!binding) throw new Error("fixture grant missing");
    const revocation = broker.revoke({ principal: alice, binding, disableLocal: () => { subject.dispatcher.cancel(alice, job.id); subject.store.revokeConnection(alice, subject.connection.id); } });
    expect(subject.store.getConnection(alice, subject.connection.id).status).toBe("revoked"); releaseRefresh?.();
    expect(await revocation).toEqual({ upstream: "confirmed", removed: true }); await subject.dispatcher.wait(alice, job.id);
    expect(revoked.sort()).toEqual(["fixture-access-secret-123456", "fixture-late-access"].sort());
    expect(secrets.records.size).toBe(0); expect(fixture.effects()).toBe(0);
  });
  it("keeps secret adapter errors out of runtime results and error text", async () => {
    const fixture = track(await httpFixture());
    class LockedTestSecretStore extends TestSecretStore { override async read() { throw new Error("fixture-access-secret-123456 private storage error"); } }
    const subject = track(await runtime(await root(), { broker: new CredentialBroker({ secretStore: new LockedTestSecretStore() }), transport: fixture.transport, binding: id => grant(id) }));
    const job = await subject.call(); await subject.dispatcher.wait(alice, job.id);
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { errorCode: "credentials_locked" } });
    expect(JSON.stringify(subject.dispatcher.result(alice, job.id))).not.toContain("fixture-access-secret-123456");
    expect(fixture.effects()).toBe(0);
  });
  it("injects a reviewed CLI grant without inheriting user tokens and redacts stdout and stderr", async () => {
    const directory = await root(), program = await cli(directory, `process.stdout.write(JSON.stringify({token:process.env.FIXTURE_PROVIDER_TOKEN,cloud:process.env.AWS_SECRET_ACCESS_KEY??null}));process.stderr.write(process.env.FIXTURE_PROVIDER_TOKEN);`), secrets = new TestSecretStore();
    const subject = track(await runtime(directory, { kind: "cli", destination: { kind: "cli", ...program }, operation: operation({ buildArguments: input => [String(input.text)] }), broker: new CredentialBroker({ secretStore: secrets }), binding: id => { const binding = GrantBindingSchema.parse({ ...grant(id, `executable:${program.executable}`), delivery: { kind: "environment", name: "FIXTURE_PROVIDER_TOKEN" } }); secrets.records.set(binding.grantId, secret(binding)); return binding; } }));
    const job = await subject.call("CLI grant"); await subject.dispatcher.wait(alice, job.id);
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { stdout: '{"token":"[redacted]","cloud":null}', stderr: "[redacted]", exitCode: 0 } });
    subject.store.close(); expect((await readFile(subject.store.path)).toString("utf8")).not.toContain("fixture-access-secret-123456");
  });
});
