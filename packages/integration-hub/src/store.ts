import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, openSync, closeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { z } from "zod";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const ref = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const id = z.string().uuid();
const micros = z.number().int().min(0).max(1_000_000_000_000);
const timestamp = z.iso.datetime();
const scope = { organizationId: ref, principalId: ref };
export const PrincipalSchema = z.object({ id: ref, kind: z.enum(["member", "agent", "local_device"]), organizationId: ref, ownerId: ref.optional(), scopes: z.array(ref).max(100) }).strict();
export type Principal = z.infer<typeof PrincipalSchema>;
const configurationRef = z.string().regex(/^config:[A-Za-z0-9_.:-]{1,120}$/);
export const ConfigurationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mcp_stdio"), configurationRef }).strict(),
  z.object({ kind: z.literal("mcp_http"), configurationRef }).strict(),
  z.object({ kind: z.literal("api"), configurationRef }).strict(),
  z.object({ kind: z.literal("cli"), configurationRef }).strict(),
]);
const credentialRef = z.string().regex(/^broker:[A-Za-z0-9_.:-]{1,120}$/);
const status = z.enum(["ready", "needs_auth", "needs_reauth", "disabled", "revoked"]);
const metadata = { id, ...scope, createdAt: timestamp, updatedAt: timestamp };
export const ConnectionSchema = z.object({ ...metadata, namespace: ref, configuration: ConfigurationSchema, credentialRef: credentialRef.nullable(), status, revision: z.number().int().positive() }).strict();
export type Connection = z.infer<typeof ConnectionSchema>;
const memoryInput = z.object({ text: z.string().min(1).max(16_384), sourceRefs: z.array(ref).max(32).default([]) }).strict();
export const MemorySchema = memoryInput.extend({ ...metadata, sourceRefs: z.array(ref).max(32), scope: z.literal("private"), version: z.number().int().positive() });
export type Memory = z.infer<typeof MemorySchema>;
const jobInput = z.object({ connectionId: id, operation: ref, intentId: ref, arguments: z.json(), idempotencyKey: ref, upperBoundMicros: micros }).strict();
const receiptRef = ref.nullable();
const outcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("waiting") }).strict(),
  z.object({ kind: z.literal("running"), runnerId: id }).strict(),
  z.object({ kind: z.literal("completed"), actualMicros: micros, receiptRef }).strict(),
  z.object({ kind: z.literal("failed"), actualMicros: micros, receiptRef }).strict(),
  z.object({ kind: z.literal("cancelled") }).strict(),
  z.object({ kind: z.literal("outcome_unknown") }).strict(),
]);
export const JobSchema = z.object({ ...metadata, connectionId: id, operation: ref, intentId: ref, argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), requestDigest: z.string().regex(/^[a-f0-9]{64}$/), idempotencyKey: ref, reservedMicros: micros, outcome }).strict().refine(job => !("actualMicros" in job.outcome) || job.outcome.actualMicros <= job.reservedMicros);
export type Job = z.infer<typeof JobSchema>;
const resultOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["completed", "failed"]), actualMicros: micros }).strict(),
  z.object({ kind: z.literal("outcome_unknown") }).strict(),
]);
const resultInput = z.object({ jobId: id, value: z.json(), receiptRef, outcome: resultOutcome }).strict();
export const JobResultSchema = resultInput.extend({ ...scope, recordedAt: timestamp });
export type JobResult = z.infer<typeof JobResultSchema>;
export const BudgetSchema = z.object({ ...scope, limitMicros: micros, spentMicros: micros, reservedMicros: micros }).strict().refine(budget => budget.spentMicros + budget.reservedMicros <= budget.limitMicros);
export type Budget = z.infer<typeof BudgetSchema>;
const event = z.enum(["memory_remembered", "memory_corrected", "memory_deleted", "connection_added", "connection_changed", "budget_changed", "job_created", "job_started", "job_settled", "job_cancelled", "job_outcome_unknown"]);
export const AuditSchema = z.object({ ...scope, event, recordId: id.nullable(), at: timestamp }).strict();
export type Audit = z.infer<typeof AuditSchema>;
type Table = "memories" | "connections" | "jobs";
type ErrorCode = "invalid_input" | "corrupt_state" | "not_found" | "denied" | "conflict" | "budget_exceeded" | "connection_unavailable" | "capacity" | "closed" | "runner_identity_unavailable";
export class HubError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = "HubError"; }
}
function parse<T>(schema: z.ZodType<T>, value: unknown, code: ErrorCode = "invalid_input"): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HubError(code);
  return result.data;
}
function canonical(value: z.infer<ReturnType<typeof z.json>>): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const owner = (principal: Principal) => ({ organizationId: principal.organizationId, principalId: principal.id });
const now = () => new Date().toISOString();
const page = z.object({ limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).max(100_000).default(0) }).strict();
function processBirth(pid: number): string | null {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", timeout: 250, maxBuffer: 256, env: { LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { return null; }
}

export class HubStore {
  readonly path: string;
  private readonly db: SqliteDatabase;
  private readonly runnerId = randomUUID();
  private closed = false;
  constructor(options: { path?: string } = {}) {
    const config = parse(z.object({ path: z.string().refine(isAbsolute).optional() }).strict(), options);
    this.path = parse(z.string().refine(isAbsolute), config.path ?? join(process.env.DOMO_HOME ?? join(homedir(), "Library/Application Support/Plow-Latch"), "device/hub/hub.sqlite"));
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    closeSync(openSync(this.path, "a", 0o600));
    chmodSync(this.path, 0o600);
    this.db = new DatabaseSync(this.path);
    this.db.function("latch_lower", { deterministic: true }, value => typeof value === "string" ? value.toLocaleLowerCase("pt-BR") : "");
    try {
      this.db.exec(`PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, principalId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, principalId TEXT NOT NULL, namespace TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(organizationId,principalId,namespace));
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, principalId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobResults(id TEXT PRIMARY KEY, organizationId TEXT NOT NULL, principalId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS retry_keys ON jobs(organizationId,principalId,json_extract(data,'$.idempotencyKey'));
      CREATE INDEX IF NOT EXISTS job_state ON jobs(json_extract(data,'$.outcome.kind'));
      CREATE INDEX IF NOT EXISTS job_connection ON jobs(json_extract(data,'$.connectionId'));
      CREATE INDEX IF NOT EXISTS job_runner ON jobs(json_extract(data,'$.outcome.runnerId'));
      CREATE INDEX IF NOT EXISTS memory_scope ON memories(organizationId,principalId,id);
      CREATE TABLE IF NOT EXISTS budgets(organizationId TEXT NOT NULL, principalId TEXT NOT NULL, limitMicros INTEGER NOT NULL, spentMicros INTEGER NOT NULL, reservedMicros INTEGER NOT NULL, PRIMARY KEY(organizationId,principalId), CHECK(spentMicros>=0 AND reservedMicros>=0 AND spentMicros+reservedMicros<=limitMicros));
      CREATE TABLE IF NOT EXISTS runners(id TEXT PRIMARY KEY,pid INTEGER NOT NULL,birth TEXT);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY, organizationId TEXT NOT NULL,principalId TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'append_only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'append_only'); END;`);
      if (!this.db.prepare("PRAGMA table_info(runners)").all().some(row => row.name === "birth")) this.db.exec("ALTER TABLE runners ADD COLUMN birth TEXT");
      const birth = processBirth(process.pid);
      if (!birth) throw new HubError("runner_identity_unavailable");
      this.transaction(() => {
        const runners = this.db.prepare("SELECT id,pid,birth FROM runners LIMIT 17").all();
        if (runners.length > 16) throw new HubError("corrupt_state");
        for (const row of runners) {
          const runner = parse(z.object({ id, pid: z.number().int().positive(), birth: z.string().nullable() }), row, "corrupt_state");
          let alive = true;
          try { process.kill(runner.pid, 0); } catch (error) { alive = !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
          const currentBirth = alive && runner.birth ? processBirth(runner.pid) : null;
          if (!alive || (currentBirth !== null && currentBirth !== runner.birth)) this.recover(runner.id);
        }
        if (this.db.prepare("SELECT id FROM runners LIMIT 16").all().length === 16) throw new HubError("capacity");
        this.db.prepare("INSERT INTO runners VALUES(?,?,?)").run(this.runnerId, process.pid, birth);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void {
    if (this.closed) return;
    this.transaction(() => this.recover(this.runnerId));
    this.db.close();
    this.closed = true;
  }
  private transaction<T>(action: () => T): T {
    if (this.closed) throw new HubError("closed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private read<T extends { id: string }>(table: Table, recordId: string, schema: z.ZodType<T>): T | null {
    if (this.closed) throw new HubError("closed");
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(recordId);
    if (!row) return null;
    const record = this.decode(row, schema);
    if (record.id !== recordId) throw new HubError("corrupt_state");
    return record;
  }
  private decode<T>(row: unknown, schema: z.ZodType<T>): T {
    const { data } = parse(z.object({ data: z.string() }), row, "corrupt_state");
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw new HubError("corrupt_state"); }
    return parse(schema, value, "corrupt_state");
  }
  private owned<T extends { organizationId: string; principalId: string }>(principal: Principal, record: T | null, mutation = false): T {
    if (!record) throw new HubError("not_found");
    if (record.organizationId !== principal.organizationId || record.principalId !== principal.id) throw new HubError(mutation ? "denied" : "not_found");
    return record;
  }
  private update(table: Table, record: Memory | Connection | Job): void {
    const result = this.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(record), record.id);
    if (result.changes !== 1) throw new HubError("corrupt_state");
  }
  private audit(principal: Principal, kind: Audit["event"], recordId: string | null): void {
    const data: Audit = { ...owner(principal), event: kind, recordId, at: now() };
    this.db.prepare("INSERT INTO audit(organizationId,principalId,data) VALUES(?,?,?)").run(principal.organizationId, principal.id, JSON.stringify(data));
  }
  private recover(runnerId: string): void {
    for (const row of this.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.outcome.runnerId')=?").all(runnerId)) {
      const job = this.decode(row, JobSchema);
      this.update("jobs", { ...job, outcome: { kind: "outcome_unknown" }, updatedAt: now() });
      this.audit({ id: job.principalId, organizationId: job.organizationId, kind: "agent", scopes: [] }, "job_outcome_unknown", job.id);
    }
    this.db.prepare("DELETE FROM runners WHERE id=?").run(runnerId);
  }
  remember(context: Principal, input: unknown): Memory {
    const principal = parse(PrincipalSchema, context), value = parse(memoryInput, input);
    const at = now(), record: Memory = { ...value, ...owner(principal), id: randomUUID(), scope: "private", version: 1, createdAt: at, updatedAt: at };
    return this.transaction(() => {
      this.db.prepare("INSERT INTO memories VALUES(?,?,?,?)").run(record.id, principal.organizationId, principal.id, JSON.stringify(record));
      this.audit(principal, "memory_remembered", record.id);
      return record;
    });
  }
  get(context: Principal, recordId: string): Memory {
    return this.owned(parse(PrincipalSchema, context), this.read("memories", parse(id, recordId), MemorySchema));
  }
  list(context: Principal, input: unknown = {}): Memory[] {
    return this.search(context, { ...parse(page, input), query: "" });
  }
  search(context: Principal, input: unknown): Memory[] {
    const principal = parse(PrincipalSchema, context), query = parse(page.extend({ query: z.string().max(256) }), input);
    if (this.closed) throw new HubError("closed");
    return this.db.prepare("SELECT data FROM memories WHERE organizationId=? AND principalId=? AND instr(latch_lower(json_extract(data,'$.text')),latch_lower(?))>0 ORDER BY id LIMIT ? OFFSET ?").all(principal.organizationId, principal.id, query.query, query.limit, query.offset).map(row => this.owned(principal, this.decode(row, MemorySchema)));
  }
  memoryCount(context: Principal, query = ""): number {
    const principal = parse(PrincipalSchema, context), text = parse(z.string().max(256), query);
    if (this.closed) throw new HubError("closed");
    const row = this.db.prepare("SELECT count(*) AS count FROM memories WHERE organizationId=? AND principalId=? AND instr(latch_lower(json_extract(data,'$.text')),latch_lower(?))>0").get(principal.organizationId, principal.id, text);
    return parse(z.object({ count: z.number().int().nonnegative() }).strict(), row, "corrupt_state").count;
  }
  correct(context: Principal, input: unknown): Memory {
    const principal = parse(PrincipalSchema, context), value = parse(memoryInput.extend({ id, expectedVersion: z.number().int().positive(), sourceRefs: z.array(ref).max(32).optional() }), input);
    return this.transaction(() => {
      const prior = this.owned(principal, this.read("memories", value.id, MemorySchema), true);
      if (prior.version !== value.expectedVersion) throw new HubError("conflict");
      const record: Memory = { ...prior, text: value.text, sourceRefs: value.sourceRefs ?? prior.sourceRefs, version: prior.version + 1, updatedAt: now() };
      this.update("memories", record);
      this.audit(principal, "memory_corrected", record.id);
      return record;
    });
  }
  delete(context: Principal, recordId: string): void {
    const principal = parse(PrincipalSchema, context);
    this.transaction(() => {
      const record = this.owned(principal, this.read("memories", parse(id, recordId), MemorySchema), true);
      this.db.prepare("DELETE FROM memories WHERE id=?").run(record.id);
      this.audit(principal, "memory_deleted", record.id);
    });
  }
  addConnection(context: Principal, input: unknown): Connection {
    const principal = parse(PrincipalSchema, context), value = parse(z.object({ namespace: ref, configuration: ConfigurationSchema, credentialRef: credentialRef.optional(), status: status.exclude(["revoked"]).default("needs_auth") }).strict(), input);
    return this.transaction(() => {
      if (this.db.prepare("SELECT id FROM connections WHERE organizationId=? AND principalId=? AND namespace=?").get(principal.organizationId, principal.id, value.namespace)) throw new HubError("conflict");
      const at = now(), record: Connection = { ...value, credentialRef: value.credentialRef ?? null, ...owner(principal), id: randomUUID(), revision: 1, createdAt: at, updatedAt: at };
      this.db.prepare("INSERT INTO connections VALUES(?,?,?,?,?)").run(record.id, principal.organizationId, principal.id, record.namespace, JSON.stringify(record));
      this.audit(principal, "connection_added", record.id);
      return record;
    });
  }
  getConnection(context: Principal, recordId: string): Connection {
    return this.owned(parse(PrincipalSchema, context), this.read("connections", parse(id, recordId), ConnectionSchema));
  }
  listConnections(context: Principal, input: unknown = {}): Connection[] {
    const principal = parse(PrincipalSchema, context), query = parse(page, input);
    return this.db.prepare("SELECT data FROM connections WHERE organizationId=? AND principalId=? ORDER BY id LIMIT ? OFFSET ?").all(principal.organizationId, principal.id, query.limit, query.offset).map(row => this.owned(principal, this.decode(row, ConnectionSchema)));
  }
  setConnectionStatus(context: Principal, input: unknown): Connection {
    const principal = parse(PrincipalSchema, context), value = parse(z.object({ id, status }).strict(), input);
    return this.transaction(() => {
      const prior = this.owned(principal, this.read("connections", value.id, ConnectionSchema), true);
      if (prior.status === "revoked" && value.status !== "revoked") throw new HubError("connection_unavailable");
      if (prior.status === value.status) return prior;
      const record = { ...prior, status: value.status, credentialRef: value.status === "revoked" ? null : prior.credentialRef, revision: prior.revision + 1, updatedAt: now() };
      this.update("connections", record);
      if (record.status !== "ready") {
        for (const row of this.db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.connectionId')=? AND json_extract(data,'$.outcome.kind')='waiting'").all(record.id)) {
          const job = this.owned(principal, this.decode(row, JobSchema), true);
          this.release(principal, job.reservedMicros, 0);
          this.update("jobs", { ...job, outcome: { kind: "cancelled" }, updatedAt: now() });
          this.audit(principal, "job_cancelled", job.id);
        }
      }
      this.audit(principal, "connection_changed", record.id);
      return record;
    });
  }
  revokeConnection(context: Principal, recordId: string): Connection {
    return this.setConnectionStatus(context, { id: recordId, status: "revoked" });
  }
  getBudget(context: Principal): Budget {
    const principal = parse(PrincipalSchema, context);
    const row = this.db.prepare("SELECT * FROM budgets WHERE organizationId=? AND principalId=?").get(principal.organizationId, principal.id);
    return row ? parse(BudgetSchema, row, "corrupt_state") : { ...owner(principal), limitMicros: 0, spentMicros: 0, reservedMicros: 0 };
  }
  setBudget(context: Principal, limit: number): Budget {
    const principal = parse(PrincipalSchema, context), limitMicros = parse(micros, limit);
    return this.transaction(() => {
      const prior = this.getBudget(principal);
      if (limitMicros < prior.spentMicros + prior.reservedMicros) throw new HubError("budget_exceeded");
      this.db.prepare("INSERT INTO budgets VALUES(?,?,?,?,?) ON CONFLICT(organizationId,principalId) DO UPDATE SET limitMicros=excluded.limitMicros").run(principal.organizationId, principal.id, limitMicros, prior.spentMicros, prior.reservedMicros);
      this.audit(principal, "budget_changed", null);
      return this.getBudget(principal);
    });
  }
  createJob(context: Principal, input: unknown): Job {
    const principal = parse(PrincipalSchema, context), value = parse(jobInput, input), argumentsJson = canonical(value.arguments);
    if (argumentsJson.length > 32_768) throw new HubError("invalid_input");
    const argumentsDigest = digest(argumentsJson), requestDigest = digest(canonical({ ...value, arguments: argumentsDigest }));
    return this.transaction(() => {
      const retry = this.db.prepare("SELECT data FROM jobs WHERE organizationId=? AND principalId=? AND json_extract(data,'$.idempotencyKey')=?").get(principal.organizationId, principal.id, value.idempotencyKey);
      if (retry) {
        const job = this.owned(principal, this.decode(retry, JobSchema));
        if (job.requestDigest !== requestDigest) throw new HubError("conflict");
        return job;
      }
      if (this.db.prepare("SELECT id FROM jobs WHERE organizationId=? AND principalId=? AND json_extract(data,'$.outcome.kind') IN ('waiting','running','outcome_unknown') LIMIT 100").all(principal.organizationId, principal.id).length === 100) throw new HubError("capacity");
      const connection = this.owned(principal, this.read("connections", value.connectionId, ConnectionSchema), true);
      if (connection.status !== "ready") throw new HubError("connection_unavailable");
      const budget = this.getBudget(principal);
      if (value.upperBoundMicros > budget.limitMicros - budget.spentMicros - budget.reservedMicros) throw new HubError("budget_exceeded");
      if (!this.db.prepare("SELECT principalId FROM budgets WHERE organizationId=? AND principalId=?").get(principal.organizationId, principal.id)) this.db.prepare("INSERT INTO budgets VALUES(?,?,0,0,0)").run(principal.organizationId, principal.id);
      this.db.prepare("UPDATE budgets SET reservedMicros=reservedMicros+? WHERE organizationId=? AND principalId=?").run(value.upperBoundMicros, principal.organizationId, principal.id);
      const at = now(), job: Job = { ...owner(principal), id: randomUUID(), connectionId: value.connectionId, operation: value.operation, intentId: value.intentId, argumentsDigest, requestDigest, idempotencyKey: value.idempotencyKey, reservedMicros: value.upperBoundMicros, outcome: { kind: "waiting" }, createdAt: at, updatedAt: at };
      this.db.prepare("INSERT INTO jobs VALUES(?,?,?,?)").run(job.id, principal.organizationId, principal.id, JSON.stringify(job));
      this.audit(principal, "job_created", job.id);
      return job;
    });
  }
  getJob(context: Principal, recordId: string): Job {
    return this.owned(parse(PrincipalSchema, context), this.read("jobs", parse(id, recordId), JobSchema));
  }
  getJobByIdempotencyKey(context: Principal, key: string): Job | null {
    const principal = parse(PrincipalSchema, context), idempotencyKey = parse(ref, key);
    if (this.closed) throw new HubError("closed");
    const row = this.db.prepare("SELECT data FROM jobs WHERE organizationId=? AND principalId=? AND json_extract(data,'$.idempotencyKey')=?").get(principal.organizationId, principal.id, idempotencyKey);
    return row ? this.owned(principal, this.decode(row, JobSchema)) : null;
  }
  listJobs(context: Principal, input: unknown = {}): Job[] {
    const principal = parse(PrincipalSchema, context), query = parse(page, input);
    if (this.closed) throw new HubError("closed");
    return this.db.prepare("SELECT data FROM jobs WHERE organizationId=? AND principalId=? ORDER BY id LIMIT ? OFFSET ?").all(principal.organizationId, principal.id, query.limit, query.offset).map(row => this.owned(principal, this.decode(row, JobSchema)));
  }
  startJob(context: Principal, recordId: string, options: { expectedConnectionRevision?: number } = {}): Job {
    const principal = parse(PrincipalSchema, context), expected = parse(z.object({ expectedConnectionRevision: z.number().int().positive().optional() }).strict(), options);
    return this.transaction(() => {
      const job = this.owned(principal, this.read("jobs", parse(id, recordId), JobSchema), true);
      if (job.outcome.kind !== "waiting") throw new HubError("conflict");
      const connection = this.getConnection(principal, job.connectionId);
      if (connection.status !== "ready" || (expected.expectedConnectionRevision !== undefined && connection.revision !== expected.expectedConnectionRevision)) throw new HubError("connection_unavailable");
      const running: Job = { ...job, outcome: { kind: "running", runnerId: this.runnerId }, updatedAt: now() };
      this.update("jobs", running);
      this.audit(principal, "job_started", job.id);
      return running;
    });
  }
  cancelJob(context: Principal, recordId: string): Job {
    const principal = parse(PrincipalSchema, context);
    return this.transaction(() => {
      const job = this.owned(principal, this.read("jobs", parse(id, recordId), JobSchema), true);
      if (job.outcome.kind === "cancelled") return job;
      if (job.outcome.kind !== "waiting") throw new HubError("conflict");
      this.release(principal, job.reservedMicros, 0);
      const cancelled: Job = { ...job, outcome: { kind: "cancelled" }, updatedAt: now() };
      this.update("jobs", cancelled);
      this.audit(principal, "job_cancelled", job.id);
      return cancelled;
    });
  }
  markJobOutcomeUnknown(context: Principal, recordId: string): Job {
    const principal = parse(PrincipalSchema, context);
    return this.transaction(() => {
      const job = this.owned(principal, this.read("jobs", parse(id, recordId), JobSchema), true);
      if (job.outcome.kind === "outcome_unknown") return job;
      if (job.outcome.kind !== "running") throw new HubError("conflict");
      const unknown: Job = { ...job, outcome: { kind: "outcome_unknown" }, updatedAt: now() };
      this.update("jobs", unknown);
      this.audit(principal, "job_outcome_unknown", job.id);
      return unknown;
    });
  }
  getJobResult(context: Principal, recordId: string): JobResult | null {
    const principal = parse(PrincipalSchema, context), job = this.getJob(principal, recordId);
    const row = this.db.prepare("SELECT data FROM jobResults WHERE id=? AND organizationId=? AND principalId=?").get(job.id, principal.organizationId, principal.id);
    if (!row) return null;
    const result = this.owned(principal, this.decode(row, JobResultSchema));
    if (result.jobId !== job.id) throw new HubError("corrupt_state");
    return result;
  }
  recordJobResult(context: Principal, input: unknown): JobResult {
    const principal = parse(PrincipalSchema, context), value = parse(resultInput, input);
    if (Buffer.byteLength(canonical(value.value)) > 65_536) throw new HubError("invalid_input");
    return this.transaction(() => {
      const job = this.owned(principal, this.read("jobs", value.jobId, JobSchema), true), prior = this.getJobResult(principal, job.id);
      if (prior && canonical({ value: prior.value, receiptRef: prior.receiptRef, outcome: prior.outcome }) === canonical({ value: value.value, receiptRef: value.receiptRef, outcome: value.outcome })) return prior;
      if (job.outcome.kind === "completed" || job.outcome.kind === "failed" || job.outcome.kind === "cancelled") throw new HubError("conflict");
      let jobOutcome: Job["outcome"];
      if (value.outcome.kind === "outcome_unknown") {
        if (job.outcome.kind !== "running" && job.outcome.kind !== "outcome_unknown") throw new HubError("conflict");
        jobOutcome = { kind: "outcome_unknown" };
      } else {
        if (job.outcome.kind === "waiting" && (value.outcome.kind !== "failed" || value.outcome.actualMicros !== 0)) throw new HubError("conflict");
        if (value.outcome.actualMicros > job.reservedMicros) throw new HubError("budget_exceeded");
        this.release(principal, job.reservedMicros, value.outcome.actualMicros);
        jobOutcome = { ...value.outcome, receiptRef: value.receiptRef };
      }
      const record: JobResult = { ...value, ...owner(principal), recordedAt: now() };
      this.db.prepare("INSERT INTO jobResults VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(job.id, principal.organizationId, principal.id, JSON.stringify(record));
      this.update("jobs", { ...job, outcome: jobOutcome, updatedAt: record.recordedAt });
      this.audit(principal, value.outcome.kind === "outcome_unknown" ? "job_outcome_unknown" : "job_settled", job.id);
      return record;
    });
  }
  private release(principal: Principal, reservedMicros: number, actualMicros: number): void {
    const result = this.db.prepare("UPDATE budgets SET reservedMicros=reservedMicros-?,spentMicros=spentMicros+? WHERE organizationId=? AND principalId=?").run(reservedMicros, actualMicros, principal.organizationId, principal.id);
    if (result.changes !== 1) throw new HubError("corrupt_state");
  }
  settleJob(context: Principal, input: unknown): Job {
    const principal = parse(PrincipalSchema, context), value = parse(z.object({ id, kind: z.enum(["completed", "failed"]), actualMicros: micros, receiptRef: receiptRef.default(null) }).strict(), input);
    return this.transaction(() => {
      const job = this.owned(principal, this.read("jobs", value.id, JobSchema), true);
      if (job.outcome.kind === "completed" || job.outcome.kind === "failed") {
        if (job.outcome.kind !== value.kind || job.outcome.actualMicros !== value.actualMicros || job.outcome.receiptRef !== value.receiptRef) throw new HubError("conflict");
        return job;
      }
      if (job.outcome.kind !== "running" && job.outcome.kind !== "outcome_unknown") throw new HubError("conflict");
      if (value.actualMicros > job.reservedMicros) throw new HubError("budget_exceeded");
      this.release(principal, job.reservedMicros, value.actualMicros);
      const settled: Job = { ...job, outcome: { kind: value.kind, actualMicros: value.actualMicros, receiptRef: value.receiptRef }, updatedAt: now() };
      this.update("jobs", settled);
      this.audit(principal, "job_settled", job.id);
      return settled;
    });
  }
  listAudit(context: Principal, input: unknown = {}): Audit[] {
    const principal = parse(PrincipalSchema, context), query = parse(page, input);
    return this.db.prepare("SELECT data FROM audit WHERE organizationId=? AND principalId=? ORDER BY seq LIMIT ? OFFSET ?").all(principal.organizationId, principal.id, query.limit, query.offset).map(row => this.owned(principal, this.decode(row, AuditSchema)));
  }
  summary(context: Principal): { memories: number; connections: number; readyConnections: number; jobs: number } {
    const principal = parse(PrincipalSchema, context);
    if (this.closed) throw new HubError("closed");
    const row = this.db.prepare(`SELECT
      (SELECT count(*) FROM memories WHERE organizationId=? AND principalId=?) AS memories,
      (SELECT count(*) FROM connections WHERE organizationId=? AND principalId=?) AS connections,
      (SELECT count(*) FROM connections WHERE organizationId=? AND principalId=? AND json_extract(data,'$.status')='ready') AS readyConnections,
      (SELECT count(*) FROM jobs WHERE organizationId=? AND principalId=?) AS jobs`).get(...Array.from({ length: 4 }, () => [principal.organizationId, principal.id]).flat());
    const count = z.number().int().nonnegative();
    return parse(z.object({ memories: count, connections: count, readyConnections: count, jobs: count }).strict(), row, "corrupt_state");
  }
}
