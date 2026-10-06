import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubStore, type Principal } from "../src/index.js";

const alice: Principal = { id: "alice", organizationId: "org", kind: "member", scopes: [] }, bob: Principal = { ...alice, id: "bob" };
const stores: HubStore[] = [], roots: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "latch-result-test-")); roots.push(root);
  const store = new HubStore({ path: join(root, "hub.sqlite") }); stores.push(store);
  const connection = store.addConnection(alice, { namespace: "api", configuration: { kind: "api", configurationRef: "config:api" }, status: "ready" }); store.setBudget(alice, 10);
  const job = store.createJob(alice, { connectionId: connection.id, operation: "echo", intentId: "one", arguments: { text: "private" }, idempotencyKey: "first", upperBoundMicros: 7 });
  return { store, connection, job };
}
describe("atomic connector receipts and settlement", () => {
  it("commits the private result, receipt and budget once and returns the same stored receipt on retry", () => {
    const { store, job } = setup(); store.startJob(alice, job.id);
    const input = { jobId: job.id, value: { echo: "private value" }, receiptRef: "receipt:one", outcome: { kind: "completed", actualMicros: 3 } };
    const result = store.recordJobResult(alice, input);
    expect(result).toMatchObject({ ...input, organizationId: "org", principalId: "alice" });
    expect(store.recordJobResult(alice, input)).toEqual(result);
    expect(store.getJob(alice, job.id).outcome).toEqual({ kind: "completed", actualMicros: 3, receiptRef: "receipt:one" });
    expect(store.getBudget(alice)).toMatchObject({ spentMicros: 3, reservedMicros: 0 });
    expect(store.listAudit(alice).filter(value => value.event === "job_settled")).toHaveLength(1);
    expect(() => store.recordJobResult(alice, { ...input, value: { echo: "changed" } })).toThrow("conflict");
    expect(() => store.getJobResult(bob, job.id)).toThrow("not_found");
    expect(store.listJobs(bob)).toEqual([]);
    expect(store.getJobByIdempotencyKey(bob, "first")).toBeNull();
    expect(store.getJobByIdempotencyKey(alice, "first")?.id).toBe(job.id);
    store.close(); const reopened = new HubStore({ path: store.path }); stores.push(reopened);
    expect(reopened.getJobResult(alice, job.id)).toEqual(result);
    expect(reopened.getBudget(alice)).toMatchObject({ spentMicros: 3, reservedMicros: 0 });
  });
  it("retains unknown reservations and settles only after an explicit bounded reconciliation", () => {
    const { store, job } = setup(); store.startJob(alice, job.id);
    const input = { jobId: job.id, value: { providerJobId: "opaque:one" }, receiptRef: "receipt:uncertain", outcome: { kind: "outcome_unknown" } };
    const uncertain = store.recordJobResult(alice, input);
    expect(store.recordJobResult(alice, input)).toEqual(uncertain);
    expect(store.getJob(alice, job.id).outcome.kind).toBe("outcome_unknown");
    expect(store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 7 });
    expect(() => store.recordJobResult(alice, { ...input, outcome: { kind: "completed", actualMicros: 8 } })).toThrow("budget_exceeded");
    expect(store.getJobResult(alice, job.id)).toEqual(uncertain);
    const reconciled = store.recordJobResult(alice, { ...input, outcome: { kind: "completed", actualMicros: 5 } });
    expect(reconciled.outcome).toEqual({ kind: "completed", actualMicros: 5 });
    expect(store.getBudget(alice)).toMatchObject({ spentMicros: 5, reservedMicros: 0 });
  });
  it("bounds persisted UTF-8 output and rolls back a failed receipt without charging or releasing its job", () => {
    const { store, job } = setup(); store.startJob(alice, job.id);
    expect(() => store.recordJobResult(alice, { jobId: job.id, value: "á".repeat(40_000), receiptRef: null, outcome: { kind: "completed", actualMicros: 3 } })).toThrow("invalid_input");
    expect(store.getJobResult(alice, job.id)).toBeNull();
    expect(store.getJob(alice, job.id).outcome.kind).toBe("running");
    expect(store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 7 });
  });
  it("checks connection revision atomically and permits a zero-cost pre-effect failure while waiting", () => {
    const { store, connection, job } = setup();
    expect(() => store.startJob(alice, job.id, { expectedConnectionRevision: connection.revision + 1 })).toThrow("connection_unavailable");
    expect(store.getJob(alice, job.id).outcome.kind).toBe("waiting");
    expect(() => store.recordJobResult(alice, { jobId: job.id, value: {}, receiptRef: null, outcome: { kind: "completed", actualMicros: 0 } })).toThrow("conflict");
    const failed = store.recordJobResult(alice, { jobId: job.id, value: { errorCode: "approval_denied" }, receiptRef: null, outcome: { kind: "failed", actualMicros: 0 } });
    expect(failed.outcome).toEqual({ kind: "failed", actualMicros: 0 });
    expect(store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
  });
  it("cancels waiting jobs once and records running cancellation as unknown without releasing its reserve", () => {
    const { store, job } = setup(), cancelled = store.cancelJob(alice, job.id);
    expect(cancelled.outcome.kind).toBe("cancelled"); expect(store.cancelJob(alice, job.id)).toEqual(cancelled);
    expect(store.getBudget(alice).reservedMicros).toBe(0);
    const next = store.createJob(alice, { connectionId: job.connectionId, operation: "echo", intentId: "two", arguments: {}, idempotencyKey: "second", upperBoundMicros: 7 }); store.startJob(alice, next.id);
    const unknown = store.markJobOutcomeUnknown(alice, next.id);
    expect(unknown.outcome.kind).toBe("outcome_unknown"); expect(store.markJobOutcomeUnknown(alice, next.id)).toEqual(unknown);
    expect(store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 7 });
    expect(store.listJobs(alice, { limit: 100 }).map(value => value.id).sort()).toEqual([job.id, next.id].sort());
  });
});
