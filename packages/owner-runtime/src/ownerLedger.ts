import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { DatabaseSync as SqliteDatabase } from "node:sqlite";
import { z } from "zod";
import { FrozenActionSchema, OwnerError, ReceiptSchema, digest, parse } from "./types.js";
import type { FrozenAction, OwnerReceipt } from "./types.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const RecordSchema = z.object({
  action: FrozenActionSchema,
  state: z.enum(["pending", "claimed", "settled", "cancelled", "abandoned"]),
  receipt: ReceiptSchema,
  responseDigest: digest.nullable(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type ActionRecord = z.infer<typeof RecordSchema>;

function processBirth(pid: number): string | null {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", timeout: 250, maxBuffer: 256,
      env: { LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { return null; }
}

export class OwnerLedger {
  private readonly db: SqliteDatabase;
  private readonly writerId = randomUUID();
  private closed = false;

  constructor(path: string, private readonly now: () => number) {
    parse(z.string().refine(isAbsolute), path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS owner_actions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS owner_action_intents ON owner_actions(json_extract(data,'$.action.targetId'));
        CREATE INDEX IF NOT EXISTS owner_action_states ON owner_actions(json_extract(data,'$.state'));
        CREATE TABLE IF NOT EXISTS owner_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS owner_writer(id INTEGER PRIMARY KEY CHECK(id=1), writerId TEXT NOT NULL, pid INTEGER NOT NULL, birth TEXT);`);
      if (!this.db.prepare("PRAGMA table_info(owner_writer)").all().some(row => row.name === "birth")) this.db.exec("ALTER TABLE owner_writer ADD COLUMN birth TEXT");
      const birth = processBirth(process.pid);
      if (birth === null) throw new OwnerError("writer_identity_unavailable");
      this.transaction(() => {
        const row = this.db.prepare("SELECT writerId,pid,birth FROM owner_writer WHERE id=1").get();
        if (row) {
          const prior = parse(z.object({ writerId: z.string().uuid(), pid: z.number().int().positive(), birth: z.string().nullable() }), row, "corrupt_state");
          let alive = true;
          try { process.kill(prior.pid, 0); } catch (error) {
            alive = !(error instanceof Error && "code" in error && error.code === "ESRCH");
          }
          const currentBirth = alive && prior.birth !== null ? processBirth(prior.pid) : null;
          if (alive && (currentBirth === null || currentBirth === prior.birth)) throw new OwnerError("writer_exists");
        }
        this.recover();
        this.db.prepare("INSERT OR REPLACE INTO owner_writer VALUES(1,?,?,?)").run(this.writerId, process.pid, birth);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.db.prepare("DELETE FROM owner_writer WHERE writerId=?").run(this.writerId);
    this.db.close();
    this.closed = true;
  }

  private transaction<T>(body: () => T): T {
    if (this.closed) throw new OwnerError("closed");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private decode(row: unknown): ActionRecord {
    const data = parse(z.object({ data: z.string() }), row, "corrupt_state");
    let value: unknown;
    try { value = JSON.parse(data.data); } catch { throw new OwnerError("corrupt_state"); }
    const record = parse(RecordSchema, value, "corrupt_state");
    if (record.action.id !== record.receipt.actionId) throw new OwnerError("corrupt_state");
    return record;
  }

  get(id: string): ActionRecord {
    if (this.closed) throw new OwnerError("closed");
    const row = this.db.prepare("SELECT data FROM owner_actions WHERE id=?").get(id);
    if (!row) throw new OwnerError("not_found");
    const record = this.decode(row);
    if (record.action.id !== id) throw new OwnerError("corrupt_state");
    return record;
  }

  history(scope: Pick<FrozenAction, "organizationId" | "ownerId" | "userId" | "principalId">, page: { limit: number; offset: number }): { records: ActionRecord[]; total: number } {
    if (this.closed) throw new OwnerError("closed");
    const parameters = [scope.organizationId, scope.ownerId, scope.userId, scope.principalId];
    const where = "json_extract(data,'$.action.organizationId')=? AND json_extract(data,'$.action.ownerId')=? AND json_extract(data,'$.action.userId')=? AND json_extract(data,'$.action.principalId')=?";
    const total = parse(z.object({ total: z.number().int().nonnegative() }), this.db.prepare(`SELECT COUNT(*) AS total FROM owner_actions WHERE ${where}`).get(...parameters), "corrupt_state").total;
    const records = this.db.prepare(`SELECT data FROM owner_actions WHERE ${where} ORDER BY json_extract(data,'$.updatedAt') DESC,id LIMIT ? OFFSET ?`).all(...parameters, page.limit, page.offset).map(row => this.decode(row));
    return { records, total };
  }

  open(): ActionRecord[] {
    if (this.closed) throw new OwnerError("closed");
    return this.db.prepare("SELECT data FROM owner_actions WHERE json_extract(data,'$.state') IN ('pending','claimed') ORDER BY rowid LIMIT 1001").all().map(row => this.decode(row));
  }

  abandoned(): ActionRecord[] {
    return this.db.prepare("SELECT data FROM owner_actions WHERE json_extract(data,'$.state')='abandoned'").all().map(row => this.decode(row));
  }

  private write(record: ActionRecord): void {
    const parsed = parse(RecordSchema, record);
    const result = this.db.prepare("UPDATE owner_actions SET data=? WHERE id=?").run(JSON.stringify(parsed), record.action.id);
    if (result.changes !== 1) throw new OwnerError("corrupt_state");
  }

  create(action: FrozenAction): ActionRecord {
    return this.transaction(() => {
      if (this.open().length >= 1000) throw new OwnerError("conflict");
      const receipt: OwnerReceipt = {
        actionId: action.id, status: "pending", execution: { kind: "pending" },
        standingRule: action.kind === "native_review" && action.ruleKey !== null ? "available" : "unchanged",
        evidenceRef: null, reason: null,
      };
      const record = parse(RecordSchema, { action, state: "pending", receipt, responseDigest: null, updatedAt: this.now() });
      this.db.prepare("INSERT INTO owner_actions VALUES(?,?)").run(action.id, JSON.stringify(record));
      return record;
    });
  }

  claim(id: string, responseDigest: string, evidenceRef: string): { kind: "claimed" | "replay"; record: ActionRecord } {
    return this.transaction(() => {
      const record = this.get(id);
      if (record.responseDigest !== null) {
        if (record.responseDigest !== responseDigest) throw new OwnerError("conflict");
        return { kind: "replay", record };
      }
      if (record.state === "cancelled" || record.state === "abandoned") throw new OwnerError("cancelled");
      if (record.state !== "pending") throw new OwnerError("conflict");
      const claimed: ActionRecord = {
        ...record, state: "claimed", responseDigest, updatedAt: this.now(),
        receipt: { ...record.receipt, evidenceRef, status: "recording" },
      };
      this.write(claimed);
      return { kind: "claimed", record: claimed };
    });
  }

  update(id: string, body: (record: ActionRecord) => ActionRecord): ActionRecord {
    return this.transaction(() => {
      const record = body(this.get(id));
      this.write({ ...record, updatedAt: this.now() });
      return record;
    });
  }

  policyRevision(fingerprint: string): number {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM owner_metadata WHERE key='policy'").get();
      let next = 1;
      if (row) {
        const stored = parse(z.object({ value: z.string() }), row, "corrupt_state");
        let value: unknown;
        try { value = JSON.parse(stored.value); } catch { throw new OwnerError("corrupt_state"); }
        const previous = parse(z.object({ fingerprint: digest, revision: z.number().int().positive() }).strict(), value, "corrupt_state");
        if (previous.fingerprint === fingerprint) return previous.revision;
        next = previous.revision + 1;
      }
      this.db.prepare("INSERT OR REPLACE INTO owner_metadata VALUES('policy',?)").run(JSON.stringify({ fingerprint, revision: next }));
      return next;
    });
  }

  private recover(): void {
    for (const record of this.open()) {
      this.write({
        ...record, state: "abandoned", updatedAt: this.now(),
        receipt: {
          ...record.receipt, status: "abandoned", reason: "restart",
          execution: record.receipt.execution.kind === "decided" ? record.receipt.execution : { kind: "outcome_unknown" },
          standingRule: record.receipt.standingRule === "stored" ? "stored" : "cancelled",
        },
      });
    }
  }
}
