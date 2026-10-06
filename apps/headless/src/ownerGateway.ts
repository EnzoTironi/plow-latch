import { randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { createRequestStateCodec, inputRequired, acceptedContent } from "@modelcontextprotocol/server";
import type { ServerContext, ProtocolEra, CallToolResult, InputRequiredResult } from "@modelcontextprotocol/server";
import { OwnerController, OwnerError } from "@domo/owner-runtime";
import type { HostBinding, HostResponse, OwnerChallenge, OwnerReceipt } from "@domo/owner-runtime";
import { canonicalJSON } from "@domo/protocol";
import { ownerPrompt } from "./ownerPrompt.js";

export interface OwnerHost {
  readonly assurance: "verified" | "test_host";
  binding(context: ServerContext): HostBinding | null;
  confirm(binding: HostBinding, challenge: OwnerChallenge, response: unknown, context: ServerContext): Promise<HostResponse | null>;
}

const continuation = z.object({ actionId: z.string().uuid(), argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/), tool: z.string(), enrollmentRevision: z.number().int().positive() }).strict();
type Continuation = z.infer<typeof continuation>;
type Reply = CallToolResult | InputRequiredResult;
const digest = (value: unknown) => createHash("sha256").update(canonicalJSON(z.json().parse(value))).digest("hex");

export class OwnerGateway {
  readonly codec;
  constructor(readonly controller: OwnerController, readonly host: OwnerHost | null) {
    this.codec = createRequestStateCodec<Continuation>({
      key: randomBytes(32), ttlSeconds: 900,
      bind: context => {
        const binding = this.requireBinding(context);
        const enrollment = binding.enrollment;
        return canonicalJSON({ method: context.mcpReq.method, organizationId: enrollment.organizationId, principalId: enrollment.principalId, ownerId: enrollment.ownerId, userId: enrollment.userId, connectionId: enrollment.connectionId, enrollmentRevision: enrollment.enrollmentRevision });
      },
    });
  }
  requireBinding(context: ServerContext): HostBinding {
    const binding = this.host?.binding(context);
    if (!binding) throw new OwnerError("owner_not_enrolled");
    this.controller.snapshot(binding);
    return binding;
  }
  resumed(context: ServerContext, tool: string, args: unknown): string | null {
    const raw = context.mcpReq.requestState<unknown>();
    if (raw === undefined) return null;
    const state = continuation.parse(raw);
    const binding = this.requireBinding(context);
    if (state.tool !== tool || state.argumentsDigest !== digest(args) || state.enrollmentRevision !== binding.enrollment.enrollmentRevision) throw new OwnerError("conflict");
    return state.actionId;
  }
  async present(context: ServerContext, era: ProtocolEra, tool: string, args: unknown, challenge: OwnerChallenge, result: (receipt: OwnerReceipt) => Promise<CallToolResult>): Promise<Reply> {
    const binding = this.requireBinding(context);
    const schema = z.object({ choice: z.enum([...challenge.form.requestedSchema.properties.choice.enum]) }).strict();
    const form = {
      mode: "form" as const,
      message: ownerPrompt(challenge),
      requestedSchema: { type: "object" as const, properties: { choice: { type: "string" as const, enum: [...challenge.form.requestedSchema.properties.choice.enum] } }, required: ["choice"] },
      _meta: { "latch/ownerAction": challenge.action },
    };
    let response: unknown;
    if (era === "legacy") {
      response = await context.mcpReq.elicitInput(form, { signal: binding.transport.signal, timeout: Math.max(1, (challenge.action.standingRuleDeadline || challenge.action.executionDeadline) - Date.now()) });
      if (response !== null && typeof response === "object" && "action" in response && (response.action === "decline" || response.action === "cancel")) {
        this.controller.cancelAction(binding, challenge.action.id, "policy_resolved");
        return result(this.controller.receipt(binding, challenge.action.id));
      }
    } else {
      const content = acceptedContent(context.mcpReq.inputResponses, "ownerDecision", schema);
      if (!content) {
        if (context.mcpReq.inputResponses?.ownerDecision !== undefined) {
          this.controller.cancelAction(binding, challenge.action.id, "policy_resolved");
          return result(this.controller.receipt(binding, challenge.action.id));
        }
        return inputRequired({
          inputRequests: { ownerDecision: inputRequired.elicit(form) },
          requestState: await this.codec.mint({ actionId: challenge.action.id, argumentsDigest: digest(args), tool, enrollmentRevision: binding.enrollment.enrollmentRevision }, context),
        });
      }
      response = context.mcpReq.inputResponses?.ownerDecision;
    }
    const verified = await this.host?.confirm(binding, challenge, response, context);
    if (!verified) throw new OwnerError("owner_not_enrolled");
    return result(await this.controller.respond(binding, verified));
  }
}
