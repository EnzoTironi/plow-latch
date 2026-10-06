import type { Intent, JSONValue } from "@domo/protocol";
import type { ApprovalViewModel, ReviewHint } from "@domo/owner-core";
import { z } from "zod";

export const reference = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
export const revision = z.number().int().positive();
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const decision = z.enum(["allow_once", "always_allow", "deny"]);
export const cancellationReason = z.enum(["disconnected", "revoked", "sign_out", "shutdown", "superseded", "policy_resolved", "evidence_expired"]);
export type CancellationReason = z.infer<typeof cancellationReason>;

export const EnrollmentSchema = z.object({
  organizationId: reference,
  ownerId: reference,
  userId: reference,
  principalId: reference,
  connectionId: reference,
  enrollmentRevision: revision,
  expiresAt: z.number().int().positive(),
  assurance: z.enum(["trusted_host_form", "verified_device_signature"]),
}).strict();
export type VerifiedHostEnrollment = z.infer<typeof EnrollmentSchema>;

export const CommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_mode"), mode: z.enum(["approve", "adversarial", "ask", "deny"]), expectedRevision: revision }).strict(),
  z.object({ kind: z.literal("set_purpose"), purpose: z.string().max(16_384), expectedRevision: revision }).strict(),
  z.object({ kind: z.literal("revoke_rule"), ruleKey: digest, expectedRevision: revision }).strict(),
  z.object({ kind: z.literal("native_control"), operation: reference, input: z.json(), expectedRevision: revision }).strict(),
]);
export type OwnerCommand = z.infer<typeof CommandSchema>;

export const FrozenActionSchema = z.object({
  id: z.string().uuid(),
  revision,
  organizationId: reference,
  ownerId: reference,
  userId: reference,
  principalId: reference,
  connectionId: reference,
  enrollmentRevision: revision,
  requesterId: reference,
  kind: z.enum(["native_review", "set_mode", "set_purpose", "revoke_rule", "native_control"]),
  targetId: reference,
  argumentsDigest: digest,
  capabilityDigest: digest,
  policyRevision: revision,
  nonce: z.string().uuid(),
  createdAt: z.number().int().nonnegative(),
  executionDeadline: z.number().int().nonnegative(),
  standingRuleDeadline: z.number().int().nonnegative(),
  ruleKey: digest.nullable(),
}).strict();
export type FrozenAction = z.infer<typeof FrozenActionSchema>;

const execution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }).strict(),
  z.object({ kind: z.literal("recording") }).strict(),
  z.object({ kind: z.literal("decided"), decision, source: reference, auditRef: reference }).strict(),
  z.object({ kind: z.literal("applied"), policyRevision: revision }).strict(),
  z.object({ kind: z.literal("rejected") }).strict(),
  z.object({ kind: z.literal("unavailable"), reason: reference }).strict(),
  z.object({ kind: z.literal("outcome_unknown") }).strict(),
]);
export const ReceiptSchema = z.object({
  actionId: z.string().uuid(),
  status: z.enum(["pending", "recording", "settled", "cancelled", "abandoned"]),
  execution,
  standingRule: z.enum(["available", "unchanged", "storing", "stored", "failed", "cancelled", "expired"]),
  evidenceRef: reference.nullable(),
  reason: reference.nullable(),
}).strict();
export type OwnerReceipt = z.infer<typeof ReceiptSchema>;

export const HostResponseSchema = z.object({
  actionId: z.string().uuid(),
  revision,
  nonce: z.string().uuid(),
  argumentsDigest: digest,
  capabilityDigest: digest,
  policyRevision: revision,
  enrollmentRevision: revision,
  choice: decision,
}).strict();
export type HostResponse = z.infer<typeof HostResponseSchema>;

export interface OwnerForm {
  mode: "form";
  message: string;
  requestedSchema: {
    type: "object";
    properties: { choice: { type: "string"; enum: readonly z.infer<typeof decision>[] } };
    required: readonly ["choice"];
    additionalProperties: false;
  };
  display:
    | { kind: "native_review"; approval: ApprovalViewModel; hint: ReviewHint | null }
    | { kind: "owner_control"; command: OwnerCommand };
}

export interface OwnerChallenge {
  action: FrozenAction;
  form: OwnerForm;
}

export type OwnerReview =
  | { kind: "challenge"; challenge: OwnerChallenge }
  | { kind: "waiting"; intentId: string }
  | { kind: "receipt"; receipt: OwnerReceipt }
  | { kind: "unavailable"; reason: "owner_not_enrolled" | "not_pending" | "native_unavailable" };

export interface CallInteraction {
  run<T>(intent: Intent, body: () => Promise<T>): Promise<T>;
}

export type NativeAvailability =
  | { kind: "ready" }
  | { kind: "unavailable"; reason: string };

export interface NativeOwnerAdapter {
  availability(operation: string): NativeAvailability;
  perform(command: Extract<OwnerCommand, { kind: "native_control" }>, signal: AbortSignal): Promise<{ kind: "applied" } | { kind: "unavailable"; reason: string } | { kind: "outcome_unknown" }>;
}

export interface InteractionInput {
  requesterId: string;
  arguments: JSONValue;
  signal?: AbortSignal;
}

export class OwnerError extends Error {
  constructor(readonly code: "invalid_input" | "owner_not_enrolled" | "wrong_owner" | "not_found" | "conflict" | "expired" | "cancelled" | "closed" | "corrupt_state" | "writer_exists" | "writer_identity_unavailable") {
    super(code);
    this.name = "OwnerError";
  }
}

export function parse<T>(schema: z.ZodType<T>, value: unknown, code: ConstructorParameters<typeof OwnerError>[0] = "invalid_input"): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new OwnerError(code);
  return result.data;
}
