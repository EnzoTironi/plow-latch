import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { HubStore, type Principal } from "../src/index.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const alice: Principal = { id: "alice", organizationId: "org-a", kind: "member", scopes: [] };
const bob: Principal = { id: "bob", organizationId: "org-a", kind: "agent", ownerId: "alice", scopes: [] };
const elsewhere: Principal = { ...alice, organizationId: "org-b" };
const roots: string[] = [], stores: HubStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function database(): string { const root = mkdtempSync(join(tmpdir(), "domo-hub-")); roots.push(root); return join(root, "hub.sqlite"); }
function open(path = database()): HubStore { const store = new HubStore({ path }); stores.push(store); return store; }
const connectionInput = { namespace: "mail", configuration: { kind: "api", configurationRef: "config:mail" }, credentialRef: "broker:mail-account", status: "ready" };
function setup(store: HubStore, principal = alice) { const connection = store.addConnection(principal, connectionInput); store.setBudget(principal, 10); return connection; }
function request(connectionId: string, idempotencyKey = "first") { return { connectionId, operation: "send", intentId: "intent-one", arguments: { recipient: "private@example.test", text: "private call content" }, idempotencyKey, upperBoundMicros: 7 }; }
const storeUrl = new URL("../src/store.ts", import.meta.url).href;
const childPrelude = `import { HubStore } from ${JSON.stringify(storeUrl)};
const store = new HubStore({path:process.env.HUB_TEST_DB});
const principal = {id:'alice',organizationId:'org-a',kind:'member',scopes:[]};`;

describe("private memory and durable records", () => {
  it("persists private memory, provenance, timestamps, and connection references through restart", () => {
    const store = open(), memory = store.remember(alice, { text: "Lunch is at noon", sourceRefs: ["note:one"] });
    const connection = setup(store); store.close(); const reopened = open(store.path);
    expect(reopened.get(alice, memory.id)).toEqual(memory);
    expect(reopened.getConnection(alice, connection.id)).toEqual(connection);
    expect(memory).toMatchObject({ scope: "private", version: 1, principalId: "alice", organizationId: "org-a", sourceRefs: ["note:one"] });
    expect(Date.parse(memory.createdAt)).toBeLessThanOrEqual(Date.now());
    expect(reopened.search(alice, { query: "NOON" }).map(record => record.text)).toEqual(["Lunch is at noon"]);
    expect(reopened.list(alice).map(record => record.text)).toEqual(["Lunch is at noon"]);
  });
  it("hides reads from another principal or organization and denies foreign mutations", () => {
    const store = open(), memory = store.remember(alice, { text: "Private lunch" }), connection = setup(store);
    for (const principal of [bob, elsewhere]) {
      expect(() => store.get(principal, memory.id)).toThrow("not_found");
      expect(() => store.getConnection(principal, connection.id)).toThrow("not_found");
      expect(store.search(principal, { query: "lunch" })).toEqual([]);
      expect(store.list(principal)).toEqual([]);
      expect(store.memoryCount(principal)).toBe(0);
      expect(store.summary(principal)).toEqual({ memories: 0, connections: 0, readyConnections: 0, jobs: 0 });
      expect(() => store.correct(principal, { id: memory.id, expectedVersion: 1, text: "stolen" })).toThrow("denied");
      expect(() => store.delete(principal, memory.id)).toThrow("denied");
      expect(() => store.revokeConnection(principal, connection.id)).toThrow("denied");
    }
    expect(store.get(alice, memory.id).text).toBe("Private lunch");
    expect(store.getConnection(alice, connection.id).status).toBe("ready");
  });
  it("counts all scoped records beyond one page and folds Unicode search", () => {
    const store = open();
    for (let index = 0; index < 55; index++) store.remember(alice, { text: `São Paulo ${index}` });
    store.remember(bob, { text: "São Paulo privado" });
    setup(store);
    expect(store.search(alice, { query: "SÃO PAULO", limit: 50 })).toHaveLength(50);
    expect(store.memoryCount(alice, "SÃO PAULO")).toBe(55);
    expect(store.summary(alice)).toEqual({ memories: 55, connections: 1, readyConnections: 1, jobs: 0 });
    expect(store.memoryCount(bob, "São Paulo")).toBe(1);
    expect(store.memoryCount(elsewhere, "São Paulo")).toBe(0);
  });
  it("rejects a stale correction from another writer and removes corrected or deleted text from search", () => {
    const store = open(), other = open(store.path), record = store.remember(alice, { text: "Original lunch", sourceRefs: ["note:one"] });
    const corrected = other.correct(alice, { id: record.id, expectedVersion: 1, text: "Dinner at six", sourceRefs: ["note:two"] });
    expect(corrected).toMatchObject({ text: "Dinner at six", version: 2, sourceRefs: ["note:two"] });
    expect(() => store.correct(alice, { id: record.id, expectedVersion: 1, text: "Lost update" })).toThrow("conflict");
    expect(store.search(alice, { query: "Original" })).toEqual([]);
    expect(store.search(alice, { query: "Dinner" }).map(value => value.version)).toEqual([2]);
    expect(store.correct(alice, { id: record.id, expectedVersion: 2, text: "Dinner at seven" }).sourceRefs).toEqual(["note:two"]);
    store.delete(alice, record.id);
    expect(() => other.get(alice, record.id)).toThrow("not_found");
    expect(other.search(alice, { query: "Dinner" })).toEqual([]);
    expect(store.listAudit(alice).map(value => value.event)).toEqual(["memory_remembered", "memory_corrected", "memory_corrected", "memory_deleted"]);
  });
  it("parses configuration and persisted data and never accepts inline credentials or principal claims", () => {
    const store = open();
    for (const name of ["secret", "token", "key", "headers", "env"]) {
      expect(() => store.addConnection(alice, { ...connectionInput, configuration: { ...connectionInput.configuration, [name]: "should-never-be-logged" } })).toThrow("invalid_input");
    }
    expect(() => store.addConnection(alice, { ...connectionInput, credentialRef: "Bearer raw-credential" })).toThrow("invalid_input");
    expect(() => store.remember(alice, { text: "claim", principalId: "bob" })).toThrow("invalid_input");
    const record = store.remember(alice, { text: "Valid memory" });
    const raw = new DatabaseSync(store.path);
    raw.prepare("UPDATE memories SET data=? WHERE id=?").run(JSON.stringify({ ...record, principalId: "bob" }), record.id);
    expect(() => store.list(alice)).toThrow("not_found");
    raw.prepare("UPDATE memories SET data=? WHERE id=?").run('{"text":"invalid stored shape"}', record.id); raw.close();
    expect(() => store.get(alice, record.id)).toThrow("corrupt_state");
    expect(store.listAudit(alice).map(value => value.event)).toEqual(["memory_remembered"]);
  });
  it("tightens filesystem permissions and uses the supplied DOMO_HOME for its default root", () => {
    const path = database(); chmodSync(join(path, ".."), 0o755);
    const store = open(path); expect(statSync(path).mode & 0o777).toBe(0o600); expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    const prior = process.env.DOMO_HOME; process.env.DOMO_HOME = join(path, "..", "home");
    try { const defaultStore = new HubStore(); stores.push(defaultStore); expect(defaultStore.path).toBe(join(path, "..", "home/device/hub/hub.sqlite")); }
    finally { if (prior === undefined) delete process.env.DOMO_HOME; else process.env.DOMO_HOME = prior; }
    store.close(); store.close(); expect(() => store.get(alice, "00000000-0000-4000-8000-000000000001")).toThrow("closed");
  });
});

describe("durable operation jobs and strict budgets", () => {
  it("returns one job for canonical retries and rejects any changed binding or arguments", () => {
    const store = open(), connection = setup(store), input = request(connection.id), first = store.createJob(alice, input);
    expect(store.createJob(alice, { ...input, arguments: { text: "private call content", recipient: "private@example.test" } })).toEqual(first);
    for (const changed of [{ arguments: { text: "changed" } }, { upperBoundMicros: 6 }, { intentId: "intent-two" }, { operation: "delete" }]) expect(() => store.createJob(alice, { ...input, ...changed })).toThrow("conflict");
    const own = setup(store, bob); expect(store.createJob(bob, request(own.id)).principalId).toBe("bob");
    expect(() => store.getJob(bob, first.id)).toThrow("not_found");
    expect(() => store.startJob(bob, first.id)).toThrow("denied");
    store.close(); const restarted = open(store.path);
    expect(restarted.createJob(alice, input)).toEqual(first);
    expect(restarted.getBudget(alice)).toMatchObject({ limitMicros: 10, spentMicros: 0, reservedMicros: 7 });
  });
  it("reserves once and settles once across two writers, including failure and mismatched settlement", () => {
    const store = open(), connection = setup(store), job = store.createJob(alice, request(connection.id)), other = open(store.path);
    expect(() => other.createJob(alice, request(connection.id, "second"))).toThrow("budget_exceeded");
    expect(() => store.setBudget(alice, 6)).toThrow("budget_exceeded");
    expect(store.startJob(alice, job.id).outcome.kind).toBe("running");
    expect(() => other.startJob(alice, job.id)).toThrow("conflict");
    expect(() => store.settleJob(alice, { id: job.id, kind: "completed", actualMicros: 8 })).toThrow("budget_exceeded");
    const settlement = { id: job.id, kind: "failed", actualMicros: 3, receiptRef: "receipt:one" };
    const settled = store.settleJob(alice, settlement); expect(settled.outcome).toEqual({ kind: "failed", actualMicros: 3, receiptRef: "receipt:one" });
    expect(other.settleJob(alice, settlement)).toEqual(settled);
    expect(() => other.settleJob(alice, { ...settlement, actualMicros: 2 })).toThrow("conflict");
    expect(other.getBudget(alice)).toMatchObject({ limitMicros: 10, spentMicros: 3, reservedMicros: 0 });
    expect(store.listAudit(alice).filter(value => value.event === "job_settled")).toHaveLength(1);
  });
  it("rejects missing, fractional, negative, and unbounded cost reservations", () => {
    const store = open(), connection = setup(store), input = request(connection.id);
    for (const upperBoundMicros of [undefined, 0.5, -1, Number.MAX_SAFE_INTEGER, Infinity]) expect(() => store.createJob(alice, { ...input, upperBoundMicros })).toThrow("invalid_input");
    expect(() => store.setBudget(alice, 0.5)).toThrow("invalid_input");
    expect(store.getBudget(alice)).toMatchObject({ limitMicros: 10, spentMicros: 0, reservedMicros: 0 });
    expect(store.createJob(alice, { ...input, upperBoundMicros: 0 }).reservedMicros).toBe(0);
  });
  it("disabling or revoking cancels waiting jobs, releases reservations, and forbids new or resumed work", () => {
    const store = open(), connection = setup(store), waiting = store.createJob(alice, request(connection.id));
    expect(store.setConnectionStatus(alice, { id: connection.id, status: "disabled" }).status).toBe("disabled");
    expect(store.getJob(alice, waiting.id).outcome.kind).toBe("cancelled");
    expect(store.getBudget(alice).reservedMicros).toBe(0);
    expect(() => store.startJob(alice, waiting.id)).toThrow("conflict");
    expect(() => store.createJob(alice, request(connection.id, "new"))).toThrow("connection_unavailable");
    store.setConnectionStatus(alice, { id: connection.id, status: "ready" });
    const running = store.createJob(alice, request(connection.id, "running")); store.startJob(alice, running.id);
    const revoked = store.revokeConnection(alice, connection.id); expect(revoked.credentialRef).toBeNull();
    expect(store.revokeConnection(alice, connection.id)).toEqual(revoked);
    expect(() => store.setConnectionStatus(alice, { id: connection.id, status: "ready" })).toThrow("connection_unavailable");
    expect(store.getJob(alice, running.id).outcome.kind).toBe("running");
    expect(store.settleJob(alice, { id: running.id, kind: "completed", actualMicros: 2 }).outcome.kind).toBe("completed");
    expect(store.getBudget(alice)).toMatchObject({ spentMicros: 2, reservedMicros: 0 });
  });
  it("keeps live runners intact and turns interrupted jobs into outcome_unknown without replay or release", () => {
    const store = open(), connection = setup(store), job = store.createJob(alice, request(connection.id)); store.startJob(alice, job.id);
    const other = open(store.path); expect(other.getJob(alice, job.id).outcome.kind).toBe("running");
    store.close(); const restarted = open(store.path);
    expect(restarted.getJob(alice, job.id).outcome.kind).toBe("outcome_unknown");
    expect(restarted.createJob(alice, request(connection.id)).id).toBe(job.id);
    expect(() => restarted.startJob(alice, job.id)).toThrow("conflict");
    expect(restarted.getBudget(alice).reservedMicros).toBe(7);
    restarted.settleJob(alice, { id: job.id, kind: "completed", actualMicros: 5, receiptRef: "receipt:reconciled" });
    expect(other.getBudget(alice)).toMatchObject({ spentMicros: 5, reservedMicros: 0 });
  });
  it("recovers a hard-crashed process and retains the exact uncertain job", () => {
    const path = database();
    const script = `${childPrelude}
const connection=store.addConnection(principal,${JSON.stringify(connectionInput)}); store.setBudget(principal,10);
const job=store.createJob(principal,{connectionId:connection.id,operation:'send',intentId:'one',arguments:{text:'private'},idempotencyKey:'crash',upperBoundMicros:7});
store.startJob(principal,job.id); process.stdout.write(job.id); process.kill(process.pid,'SIGKILL');`;
    const child = spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script], { env: { ...process.env, HUB_TEST_DB: path }, encoding: "utf8", timeout: 10_000 });
    expect(child.signal).toBe("SIGKILL"); const restarted = open(path), job = restarted.getJob(alice, child.stdout);
    expect(job.outcome.kind).toBe("outcome_unknown"); expect(job.idempotencyKey).toBe("crash");
    expect(() => restarted.startJob(alice, job.id)).toThrow("conflict");
    expect(restarted.getBudget(alice)).toMatchObject({ limitMicros: 10, spentMicros: 0, reservedMicros: 7 });
    expect(restarted.listAudit(alice).map(value => value.event)).toEqual(["connection_added", "budget_changed", "job_created", "job_started", "job_outcome_unknown"]);
  });
  it("allows only one competing process to reserve seven micros against a ten-micro ceiling", async () => {
    const store = open(), connection = setup(store);
    const competitors = ["a", "b"].map(key => {
      const script = `${childPrelude}
process.stdout.write('ready\\n'); process.stdin.once('data',()=>{try{store.createJob(principal,${JSON.stringify(request(connection.id, key))});process.stdout.write('reserved');}catch(error){process.stdout.write(error.code);}finally{store.close();process.stdin.destroy();}});`;
      const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script], { env: { ...process.env, HUB_TEST_DB: store.path }, stdio: ["pipe", "pipe", "pipe"] });
      const ready = new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", code => { if (code !== 0) reject(new Error("competitor failed")); }); });
      let output = ""; child.stdout.on("data", value => { output += value.toString(); });
      const done = new Promise<string>((resolve, reject) => { child.once("close", code => code === 0 ? resolve(output.replace("ready\n", "")) : reject(new Error("competitor failed"))); child.once("error", reject); });
      return { child, ready, done };
    });
    try { await Promise.all(competitors.map(value => value.ready)); for (const value of competitors) value.child.stdin.write("go");
      expect((await Promise.all(competitors.map(value => value.done))).sort()).toEqual(["budget_exceeded", "reserved"]);
      expect(store.getBudget(alice)).toMatchObject({ limitMicros: 10, spentMicros: 0, reservedMicros: 7 });
      expect(store.listAudit(alice).filter(value => value.event === "job_created")).toHaveLength(1);
    } finally { for (const value of competitors) value.child.kill(); }
  });
  it("keeps audit rows append-only, scoped, and free of memory text, call arguments, and broker references", () => {
    const store = open(), connection = setup(store); store.remember(alice, { text: "private memory text", sourceRefs: ["note:private"] });
    const job = store.createJob(alice, request(connection.id)); store.startJob(alice, job.id); store.settleJob(alice, { id: job.id, kind: "completed", actualMicros: 1 });
    const entries = store.listAudit(alice), encoded = JSON.stringify(entries);
    expect(entries.map(value => value.event)).toEqual(["connection_added", "budget_changed", "memory_remembered", "job_created", "job_started", "job_settled"]);
    for (const secret of ["private memory text", "private call content", "private@example.test", "broker:mail-account", "config:mail", "note:private"]) expect(encoded).not.toContain(secret);
    expect(store.listAudit(bob)).toEqual([]);
    const raw = new DatabaseSync(store.path);
    expect(() => raw.exec("UPDATE audit SET data='{}'")).toThrow("append_only"); expect(() => raw.exec("DELETE FROM audit")).toThrow("append_only"); raw.close();
    const persisted = readFileSync(store.path); expect(persisted.subarray(0, 15).toString()).toBe("SQLite format 3");
  });
  it("bounds cancellation work and preserves retry identity when pending capacity is full", () => {
    const store = open(), connection = setup(store);
    let firstId = "";
    for (let index = 0; index < 100; index++) {
      const job = store.createJob(alice, { ...request(connection.id, `job-${index}`), upperBoundMicros: 0 });
      if (index === 0) firstId = job.id;
    }
    expect(() => store.createJob(alice, { ...request(connection.id, "overflow"), upperBoundMicros: 0 })).toThrow("capacity");
    expect(store.createJob(alice, { ...request(connection.id, "job-0"), upperBoundMicros: 0 }).id).toBe(firstId);
    store.revokeConnection(alice, connection.id);
    expect(store.getJob(alice, firstId).outcome.kind).toBe("cancelled");
    const next = store.addConnection(alice, { ...connectionInput, namespace: "another-mail" });
    expect(store.createJob(alice, { ...request(next.id, "after-cancel"), upperBoundMicros: 0 }).outcome.kind).toBe("waiting");
  });
  it("keeps one principal's active-job quota independent of other users and organizations", () => {
    const store = open(), connection = setup(store);
    for (let index = 0; index < 100; index++) store.createJob(alice, { ...request(connection.id, `own-${index}`), upperBoundMicros: 0 });
    for (const principal of [bob, elsewhere]) {
      const own = setup(store, principal);
      expect(store.createJob(principal, request(own.id)).outcome.kind).toBe("waiting");
    }
    expect(() => store.createJob(alice, { ...request(connection.id, "overflow"), upperBoundMicros: 0 })).toThrow("capacity");
  });
  it("does not confuse a reused live PID with a crashed runner's process birth", () => {
    const path = database();
    const script = `${childPrelude}
const connection=store.addConnection(principal,${JSON.stringify(connectionInput)});store.setBudget(principal,10);
const job=store.createJob(principal,{connectionId:connection.id,operation:'send',intentId:'one',arguments:{},idempotencyKey:'reuse',upperBoundMicros:7});
store.startJob(principal,job.id);process.stdout.write(job.id);process.kill(process.pid,'SIGKILL');`;
    const child = spawnSync(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script], { env: { ...process.env, HUB_TEST_DB: path }, encoding: "utf8", timeout: 10_000 });
    expect(child.signal).toBe("SIGKILL");
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE runners SET pid=?,birth=?").run(process.pid, "previous-process-birth"); raw.close();
    const restarted = open(path);
    expect(restarted.getJob(alice, child.stdout).outcome.kind).toBe("outcome_unknown");
    expect(restarted.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 7 });
    expect(() => restarted.startJob(alice, child.stdout)).toThrow("conflict");
  });
});
