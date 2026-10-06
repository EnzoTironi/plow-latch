import { createHash } from "node:crypto";
import { z } from "zod";
import type { Connection, HubStore, Job, Principal } from "@domo/integration-hub";

export const JsonSchema = z.json();
export const JsonObjectSchema = z.record(z.string(), JsonSchema);
export type Json = z.infer<typeof JsonSchema>;
export type JsonObject = z.infer<typeof JsonObjectSchema>;
export const ReferenceSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
export const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/).brand<"Digest">();
export const MicrosSchema = z.number().int().min(0).max(1_000_000_000_000);
export const EffectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["read", "write", "delete", "send", "publish"]), resource: ReferenceSchema }).strict(),
  z.object({ kind: z.literal("unknown"), reason: z.string().min(1).max(256) }).strict(),
]);
export type Effect = z.infer<typeof EffectSchema>;
export const CostSchema = z.object({
  upperBoundMicros: MicrosSchema,
  settlement: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("fixed"), actualMicros: MicrosSchema }).strict(),
    z.object({ kind: z.literal("response"), pointer: z.string().min(1).max(256).startsWith("/") }).strict(),
    z.object({ kind: z.literal("unknown") }).strict(),
  ]),
}).strict().refine(value => value.settlement.kind !== "fixed" || value.settlement.actualMicros <= value.upperBoundMicros);
export type ReviewedCost = z.infer<typeof CostSchema>;
export const CallInputSchema = z.object({ connectionId: z.string().uuid(), operation: ReferenceSchema, arguments: JsonObjectSchema, idempotencyKey: ReferenceSchema }).strict();
export type CallInput = z.infer<typeof CallInputSchema>;

export type FrozenPlan = Readonly<{
  jobId: string;
  organizationId: string;
  requesterPrincipalId: string;
  ownerPrincipalId: string;
  connectionId: string;
  connectionRevision: number;
  catalogRevision: number;
  catalogDigest: string;
  operation: string;
  upstreamOperation: string;
  arguments: JsonObject;
  request: JsonObject;
  argumentsDigest: string;
  schemaDigest: string;
  effects: readonly Effect[];
  requiredScopes: readonly string[];
  upperBoundMicros: number;
  planDigest: string;
  expiresAt: number;
}>;
export type Authorization =
  | { kind: "approved"; planDigest: string; ownerPrincipalId: string; evidenceRef: string; expiresAt: number }
  | { kind: "denied" | "unavailable" | "expired" };
/** This dependency receives trusted host evidence. It is never populated from tool arguments. */
export interface Authorizer {
  review(input: { principal: Principal; plan: FrozenPlan; signal: AbortSignal }): Promise<Authorization>;
}
export const JobResultSchema = z.object({
  jobId: z.string().uuid(), organizationId: ReferenceSchema, principalId: ReferenceSchema,
  value: JsonSchema, receiptRef: ReferenceSchema.nullable(), recordedAt: z.iso.datetime(),
  outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.enum(["completed", "failed"]), actualMicros: MicrosSchema }).strict(),
    z.object({ kind: z.literal("outcome_unknown") }).strict(),
  ]),
}).strict();
export type JobResult = z.infer<typeof JobResultSchema>;
export type ResultInput = Pick<JobResult, "jobId" | "value" | "receiptRef" | "outcome">;
/** The hub commits result, receipt, outcome and budget settlement in one transaction. */
export interface ConnectorStore extends Pick<HubStore, "getConnection" | "setConnectionStatus" | "revokeConnection" | "createJob" | "getJob" | "settleJob"> {
  getJobByIdempotencyKey(principal: Principal, key: string): Job | null;
  startJob(principal: Principal, id: string, options?: { expectedConnectionRevision?: number }): Job;
  cancelJob(principal: Principal, id: string): Job;
  markJobOutcomeUnknown(principal: Principal, id: string): Job;
  recordJobResult(principal: Principal, input: ResultInput): JobResult;
  getJobResult(principal: Principal, id: string): JobResult | null;
  listJobs(principal: Principal, page?: { limit?: number; offset?: number }): Job[];
}
export type ErrorCode = "invalid_input" | "invalid_catalog" | "unreviewed_operation" | "schema_drift" | "connection_unavailable" | "scope_denied" | "approval_denied" | "approval_unavailable" | "approval_expired" | "credentials_locked" | "grant_unavailable" | "grant_mismatch" | "needs_reauth" | "transport_failed" | "redirect_refused" | "output_limit" | "cancelled" | "timeout" | "closed";
export class ConnectorError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = "ConnectorError"; }
}
export function parse<T>(schema: z.ZodType<T>, value: unknown, code: ErrorCode = "invalid_input"): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ConnectorError(code);
  return result.data;
}
export function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function digest(value: Json): z.infer<typeof DigestSchema> { return DigestSchema.parse(createHash("sha256").update(canonical(value)).digest("hex")); }
export function freeze<T extends object>(value: T): Readonly<T> {
  for (const item of Object.values(value)) if (item !== null && typeof item === "object") freeze(item);
  return Object.freeze(value);
}
export function assertConnection(connection: Connection, revision: number): void {
  if (connection.status !== "ready" || connection.revision !== revision) throw new ConnectorError("connection_unavailable");
}
export function pointer(value: Json, path: string): Json | undefined {
  let current: Json | undefined = value;
  for (const part of path.slice(1).split("/").map(value => value.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current) ? current[Number(part)] : current[part];
  }
  return current;
}
