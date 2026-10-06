import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { ApprovalSettlement, ApprovalStore, DeviceAgent, PolicyDelegate } from "@domo/device-core";
import { APPROVAL_SOURCE_EXPIRED } from "@domo/device-core";
import {
  ApprovalQueue, DEFAULT_APPROVAL_MODE, adversarialReview, approvalViewModel,
  decideIntent, loadSettings, saveSettings, storedRuleMayGrant,
} from "@domo/owner-core";
import type { ApprovalDecision, DecideDeps, ReviewHint, Settings } from "@domo/owner-core";
import { canonicalJSON, intentRuleKey } from "@domo/protocol";
import type { Intent, JSONValue } from "@domo/protocol";
import { HostBinding, requireBinding, verifyHostResponse } from "./hostBinding.js";
import { OwnerLedger } from "./ownerLedger.js";
import type { ActionRecord } from "./ownerLedger.js";
import {
  CommandSchema, HostResponseSchema, OwnerError, parse, reference,
} from "./types.js";
import type {
  CallInteraction, CancellationReason, FrozenAction, HostResponse, InteractionInput,
  NativeOwnerAdapter, OwnerChallenge, OwnerCommand, OwnerForm, OwnerReceipt, OwnerReview,
} from "./types.js";

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJSON(parse(z.json(), value))).digest("hex");
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

const unavailableAdapter: NativeOwnerAdapter = {
  availability: () => ({ kind: "unavailable", reason: "native_adapter_unavailable" }),
  perform: async () => ({ kind: "unavailable", reason: "native_adapter_unavailable" }),
};

export interface OwnerControllerOptions {
  home: string;
  path?: string;
  now?: () => number;
  standingRuleTtlMs?: number;
  ownerActionTtlMs?: number;
  receiptWaitMs?: number;
  nativeAdapter?: NativeOwnerAdapter;
  saveSettings?: (home: string, settings: Settings) => void;
}

export interface ProductionPolicyOptions {
  apiBaseUrl: string;
  plowRoot: string;
  record: DecideDeps["record"];
  review?: DecideDeps["review"];
  settings?: () => Settings;
  queue?: ApprovalQueue;
}

export interface OwnerSnapshot {
  policyRevision: number;
  settings: { approvalMode: Settings["approvalMode"]; agentPurpose: string };
  approvals: { intentId: string; actionId: string | null; state: "queued" | "reviewing" | "execution_expired" }[];
}

interface BoundInteraction {
  binding: HostBinding;
  requesterId: string;
  argumentsDigest: string;
  signal: AbortSignal;
}

interface LiveAction {
  challenge: OwnerChallenge;
  binding: HostBinding;
  signal: AbortController;
  dispose: () => void;
  timer: ReturnType<typeof setTimeout>;
  command: OwnerCommand | null;
  native: {
    intent: Intent;
    active: boolean;
    executionClosed: boolean;
    recorded: boolean;
    resolve: ((choice: ApprovalDecision) => void) | null;
    storeRule: () => void;
    ruleAttempted: boolean;
    cancelled: CancellationReason | null;
  } | null;
}

const auditDecision = z.object({
  event: z.literal("intent_decision"), intentId: reference,
  decision: z.enum(["allow_once", "always_allow", "deny"]), source: reference,
}).passthrough();
type AuditedDecision = z.infer<typeof auditDecision>;
const auditNotice = z.object({ event: z.string(), entry: z.unknown() }).passthrough();

export class OwnerController {
  private readonly ledger: OwnerLedger;
  private readonly now: () => number;
  private readonly standingRuleTtlMs: number;
  private readonly ownerActionTtlMs: number;
  private readonly receiptWaitMs: number;
  private readonly adapter: NativeOwnerAdapter;
  private readonly bindings = new Map<string, BoundInteraction>();
  private readonly live = new Map<string, LiveAction>();
  private readonly intents = new Map<string, string>();
  private readonly decisions = new Map<string, AuditedDecision>();
  private readonly receiptWaiters = new Map<string, Set<() => void>>();
  private device: DeviceAgent | null = null;
  private approvals: ApprovalStore | null = null;
  private policyOptions: ProductionPolicyOptions | null = null;
  private queue = new ApprovalQueue();
  private removeObserver: (() => void) | null = null;
  private closeTask: Promise<void> | null = null;
  private closing = false;
  private closed = false;

  constructor(private readonly options: OwnerControllerOptions) {
    parse(z.string().refine(isAbsolute), options.home);
    this.now = options.now ?? Date.now;
    this.standingRuleTtlMs = parse(z.number().int().min(1).max(3_600_000), options.standingRuleTtlMs ?? 900_000);
    this.ownerActionTtlMs = parse(z.number().int().min(1).max(900_000), options.ownerActionTtlMs ?? 300_000);
    this.receiptWaitMs = parse(z.number().int().min(1).max(10_000), options.receiptWaitMs ?? 5_000);
    this.adapter = options.nativeAdapter ?? unavailableAdapter;
    this.ledger = new OwnerLedger(options.path ?? join(options.home, "device/owner/actions.sqlite"), this.now);
  }

  interaction(binding: HostBinding, input: InteractionInput): CallInteraction {
    requireBinding(binding, this.now());
    const requesterId = parse(reference, input.requesterId);
    const argumentsDigest = fingerprint(input.arguments);
    const signal = input.signal ? AbortSignal.any([binding.transport.signal, input.signal]) : binding.transport.signal;
    return {
      run: async <T>(intent: Intent, body: () => Promise<T>): Promise<T> => {
        this.assertOpen();
        requireBinding(binding, this.now());
        if (signal.aborted || intent.agentId !== requesterId || this.bindings.has(intent.intentId)) throw new OwnerError("conflict");
        freeze(intent);
        this.bindings.set(intent.intentId, { binding, requesterId, argumentsDigest, signal });
        try { return await body(); } finally { this.bindings.delete(intent.intentId); }
      },
    };
  }

  nativePolicy(options: ProductionPolicyOptions): PolicyDelegate {
    this.assertOpen();
    if (this.policyOptions) throw new OwnerError("conflict");
    this.policyOptions = options;
    this.queue = options.queue ?? this.queue;
    return {
      mayGrantFromStoredRule: () => !this.closed && !this.closing && storedRuleMayGrant(this.settings()),
      decideIntent: async intent => {
        if (this.closed || this.closing) return { decision: "deny", source: "shutdown" };
        const bound = this.bindings.get(intent.intentId);
        let ticket: LiveAction | null = null;
        if (bound && this.bindingCurrent(bound.binding) && !bound.signal.aborted && this.device && this.approvals && this.settings().approvalMode === "ask") {
          ticket = this.createNativeAction(intent, bound);
        }
        const captured = ticket;
        const result = await decideIntent(intent, {
          settings: this.settings(), apiBaseUrl: options.apiBaseUrl, plowRoot: options.plowRoot,
          auditEntries: () => [], record: options.record, review: options.review ?? adversarialReview,
          queue: this.queue,
          ruleAnswers: async () => !this.closed && !this.closing && captured?.native?.cancelled === null &&
            !captured.native.executionClosed && !!(await this.device?.policy.ruleAnswers(intent, {
              decideIntent: async () => "deny", mayGrantFromStoredRule: () => storedRuleMayGrant(this.settings()),
            })),
          storeRule: () => {
            if (!captured) throw new OwnerError("owner_not_enrolled");
            this.storeNativeRule(captured);
          },
          openApproval: hint => captured ? this.openApproval(captured, hint) : Promise.resolve("deny"),
        });
        if (result.source !== "ask") return result;
        if (!captured) return { decision: "deny", source: "owner_unavailable" };
        if (captured.native?.cancelled) return { decision: "deny", source: "owner_cancelled" };
        return result;
      },
      decisionRecorded: async intentId => this.nativeRecorded(intentId),
      shutdown: () => {
        this.closing = true;
        for (const ticket of [...this.live.values()]) this.cancel(ticket, "shutdown");
      },
    };
  }

  observeNative(device: DeviceAgent, approvals: ApprovalStore): void {
    this.assertOpen();
    if (this.device) throw new OwnerError("conflict");
    this.device = device;
    this.approvals = approvals;
    const listener = (value: unknown) => {
      const notice = auditNotice.safeParse(value);
      if (!notice.success || notice.data.event !== "intent_decision") return;
      const parsed = auditDecision.safeParse(notice.data.entry);
      if (parsed.success && this.intents.has(parsed.data.intentId)) this.decisions.set(parsed.data.intentId, parsed.data);
    };
    device.audit.events.on("recorded", listener);
    const previous = approvals.onSettled;
    const settled = (notice: ApprovalSettlement) => {
      try { return previous?.(notice); } finally { this.nativeSettled(notice); }
    };
    approvals.onSettled = settled;
    this.removeObserver = () => {
      device.audit.events.off("recorded", listener);
      if (approvals.onSettled === settled) approvals.onSettled = previous;
    };
    this.reconcileAudit();
  }

  snapshot(binding: HostBinding): OwnerSnapshot {
    this.assertOwner(binding);
    const settings = this.settings();
    const approvals: OwnerSnapshot["approvals"] = [];
    for (const [intentId, bound] of this.bindings) {
      if (!this.sameOwner(binding, bound.binding.enrollment)) continue;
      const actionId = this.intents.get(intentId) ?? null;
      const ticket = actionId === null ? null : this.live.get(actionId);
      approvals.push({ intentId, actionId, state: ticket?.native?.executionClosed ? "execution_expired" : ticket?.native?.active ? "reviewing" : "queued" });
    }
    for (const [intentId, actionId] of this.intents) {
      if (this.bindings.has(intentId)) continue;
      const ticket = this.live.get(actionId);
      if (ticket && this.sameOwner(binding, ticket.binding.enrollment)) approvals.push({ intentId, actionId, state: "execution_expired" });
    }
    return { policyRevision: this.policyRevision(), settings: { approvalMode: settings.approvalMode ?? DEFAULT_APPROVAL_MODE, agentPurpose: settings.agentPurpose ?? "" }, approvals };
  }

  review(binding: HostBinding, input: unknown): OwnerReview {
    this.assertOwner(binding);
    const { intentId } = parse(z.object({ intentId: reference }).strict(), input);
    const id = this.intents.get(intentId);
    if (!id) {
      const bound = this.bindings.get(intentId);
      return bound && this.sameOwner(binding, bound.binding.enrollment) ? { kind: "waiting", intentId } : { kind: "unavailable", reason: "not_pending" };
    }
    const record = this.owned(binding, id);
    const ticket = this.live.get(id);
    if (!ticket || record.state !== "pending") return { kind: "receipt", receipt: record.receipt };
    if (!ticket.native?.active) return { kind: "waiting", intentId };
    this.checkActionCurrent(ticket, record.action);
    return { kind: "challenge", challenge: this.challenge(ticket) };
  }

  propose(binding: HostBinding, input: unknown): OwnerChallenge {
    this.assertOwner(binding);
    const command = parse(CommandSchema, input);
    if (command.expectedRevision !== this.policyRevision()) throw new OwnerError("conflict");
    const now = this.now();
    const targetId = command.kind === "revoke_rule" ? command.ruleKey : command.kind === "native_control" ? command.operation : "owner_settings";
    const action = this.freezeAction(binding, {
      requesterId: binding.enrollment.principalId, kind: command.kind, targetId,
      argumentsDigest: fingerprint(command), capabilityDigest: fingerprint({ kind: command.kind, targetId }),
      executionDeadline: Math.min(now + this.ownerActionTtlMs, binding.enrollment.expiresAt), standingRuleDeadline: 0, ruleKey: null,
    });
    const form = this.form({ kind: "owner_control", command }, ["allow_once", "deny"]);
    this.ledger.create(action);
    const ticket = this.keepLive(binding, { action, form }, command, null, binding.transport.signal);
    this.live.set(action.id, ticket);
    return this.challenge(ticket);
  }

  receipt(binding: HostBinding, actionId: string): OwnerReceipt {
    this.assertOwner(binding);
    return this.owned(binding, parse(z.string().uuid(), actionId)).receipt;
  }

  history(binding: HostBinding, input: unknown = {}) {
    this.assertOwner(binding);
    const page = parse(z.object({ limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(100_000).default(0) }).strict(), input);
    const history = this.ledger.history(binding.enrollment, page);
    return { total: history.total, pagination: page, actions: history.records.map(record => ({ actionId: record.action.id, kind: record.action.kind, targetId: record.action.targetId, requesterId: record.action.requesterId, createdAt: record.action.createdAt, updatedAt: record.updatedAt, receipt: record.receipt })) };
  }

  async respond(binding: HostBinding, input: unknown): Promise<OwnerReceipt> {
    this.assertOwner(binding);
    const response = parse(HostResponseSchema, input);
    const record = this.owned(binding, response.actionId);
    this.matchResponse(record.action, response);
    const responseDigest = fingerprint(response);
    if (record.responseDigest !== null) {
      if (record.responseDigest !== responseDigest) throw new OwnerError("conflict");
      return this.waitReceipt(record.action.id);
    }
    const ticket = this.live.get(record.action.id);
    if (!ticket || record.state !== "pending") throw new OwnerError("cancelled");
    this.checkActionCurrent(ticket, record.action);
    if (!ticket.challenge.form.requestedSchema.properties.choice.enum.includes(response.choice)) throw new OwnerError("invalid_input");
    if (ticket.native && !ticket.native.active) throw new OwnerError("conflict");
    const evidenceRef = await verifyHostResponse(binding, this.challenge(ticket), response, this.now);
    const verifiedRecord = this.ledger.get(record.action.id);
    if (verifiedRecord.responseDigest !== null) {
      if (verifiedRecord.responseDigest !== responseDigest) throw new OwnerError("conflict");
      return this.waitReceipt(record.action.id);
    }
    this.checkActionCurrent(ticket, record.action);
    const late = ticket.native !== null && (ticket.native.executionClosed || this.now() > record.action.executionDeadline);
    if (late && response.choice === "allow_once") throw new OwnerError("expired");
    const claim = this.ledger.claim(record.action.id, responseDigest, evidenceRef);
    if (claim.kind === "replay") return this.waitReceipt(record.action.id);
    if (ticket.native) {
      if (late) {
        if (response.choice === "always_allow") {
          try { ticket.native.storeRule(); await this.queue.sweep(); } catch {
            this.updateReceipt(record.action.id, receipt => ({ ...receipt, standingRule: "failed" }));
          }
        } else this.updateReceipt(record.action.id, receipt => ({ ...receipt, standingRule: "unchanged" }));
        this.finishIfRecorded(ticket);
      } else {
        this.updateReceipt(record.action.id, receipt => ({ ...receipt, execution: { kind: "recording" }, standingRule: response.choice === "always_allow" ? "storing" : "unchanged" }));
        ticket.native.resolve?.(response.choice);
        ticket.native.resolve = null;
      }
    } else await this.applyControl(ticket, response.choice);
    return this.waitReceipt(record.action.id);
  }

  cancelScope(scope: { organizationId: string; ownerId: string }, reason: CancellationReason): void {
    this.assertOpen();
    parse(z.object({ organizationId: reference, ownerId: reference }).strict(), scope);
    for (const ticket of [...this.live.values()]) {
      if (ticket.challenge.action.organizationId === scope.organizationId && ticket.challenge.action.ownerId === scope.ownerId) this.cancel(ticket, reason);
    }
  }

  cancelAction(binding: HostBinding, actionId: string, reason: CancellationReason): void {
    this.assertOwner(binding);
    const record = this.owned(binding, parse(z.string().uuid(), actionId));
    const ticket = this.live.get(record.action.id);
    if (ticket) this.cancel(ticket, reason);
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    if (this.closed) return Promise.resolve();
    this.closing = true;
    const ids = [...this.live.keys()];
    for (const ticket of [...this.live.values()]) this.cancel(ticket, "shutdown");
    this.closeTask = (async () => {
      await Promise.allSettled(ids.map(id => this.waitReceipt(id)));
      this.closed = true;
      this.removeObserver?.();
      this.removeObserver = null;
      for (const wake of this.receiptWaiters.values()) for (const callback of wake) callback();
      this.ledger.close();
    })();
    return this.closeTask;
  }

  private assertOpen(): void { if (this.closed || this.closing) throw new OwnerError("closed"); }
  private assertOwner(binding: HostBinding): void { this.assertOpen(); requireBinding(binding, this.now()); }
  private bindingCurrent(binding: HostBinding): boolean {
    try { requireBinding(binding, this.now()); return true; } catch { return false; }
  }
  private settings(): Settings { return this.policyOptions?.settings?.() ?? loadSettings(this.options.home); }
  private policyRevision(): number {
    const settings = this.settings();
    return this.ledger.policyRevision(fingerprint({ approvalMode: settings.approvalMode ?? DEFAULT_APPROVAL_MODE, agentPurpose: settings.agentPurpose ?? "", rules: this.device?.policy.allRules() ?? [] }));
  }
  private sameOwner(binding: HostBinding, action: Pick<FrozenAction, "organizationId" | "ownerId" | "userId" | "principalId" | "connectionId" | "enrollmentRevision">): boolean {
    const enrolled = binding.enrollment;
    return enrolled.organizationId === action.organizationId && enrolled.ownerId === action.ownerId && enrolled.userId === action.userId &&
      enrolled.principalId === action.principalId && enrolled.connectionId === action.connectionId && enrolled.enrollmentRevision === action.enrollmentRevision;
  }
  private owned(binding: HostBinding, id: string): ActionRecord {
    const record = this.ledger.get(id);
    if (!this.sameOwner(binding, record.action)) throw new OwnerError("wrong_owner");
    return record;
  }
  private freezeAction(binding: HostBinding, fields: Pick<FrozenAction, "requesterId" | "kind" | "targetId" | "argumentsDigest" | "capabilityDigest" | "executionDeadline" | "standingRuleDeadline" | "ruleKey">): FrozenAction {
    const enrolled = binding.enrollment;
    return freeze({
      id: randomUUID(), revision: 1, organizationId: enrolled.organizationId, ownerId: enrolled.ownerId,
      userId: enrolled.userId, principalId: enrolled.principalId, connectionId: enrolled.connectionId, enrollmentRevision: enrolled.enrollmentRevision,
      ...fields, nonce: randomUUID(), createdAt: this.now(), policyRevision: this.policyRevision(),
    });
  }
  private form(display: OwnerForm["display"], choices: OwnerForm["requestedSchema"]["properties"]["choice"]["enum"]): OwnerForm {
    return freeze({
      mode: "form", message: display.kind === "native_review" ? "Review the exact device access requested by this operation." : "Review this owner setting change.",
      requestedSchema: { type: "object", properties: { choice: { type: "string", enum: choices } }, required: ["choice"], additionalProperties: false }, display,
    });
  }
  private keepLive(binding: HostBinding, challenge: OwnerChallenge, command: OwnerCommand | null, native: LiveAction["native"], signal: AbortSignal): LiveAction {
    const lifetime = new AbortController();
    const cancel = () => this.cancel(ticket, "disconnected");
    const deadline = native ? challenge.action.standingRuleDeadline : challenge.action.executionDeadline;
    const timer = setTimeout(() => this.expireEvidence(ticket), Math.max(1, deadline - this.now()));
    timer.unref?.();
    const ticket: LiveAction = { challenge: freeze(challenge), binding, command, native, signal: lifetime, timer, dispose: () => signal.removeEventListener("abort", cancel) };
    signal.addEventListener("abort", cancel, { once: true });
    return ticket;
  }
  private createNativeAction(intent: Intent, bound: BoundInteraction): LiveAction {
    const now = this.now();
    const deadline = this.approvals?.deadline(intent.intentId);
    if (deadline === null || deadline === undefined) throw new OwnerError("conflict");
    const view = approvalViewModel(intent);
    const ruleKey = view.sendsAppleEvents ? null : intentRuleKey(intent);
    const action = this.freezeAction(bound.binding, {
      requesterId: bound.requesterId, kind: "native_review", targetId: intent.intentId,
      argumentsDigest: bound.argumentsDigest, capabilityDigest: fingerprint(intent.capabilities),
      executionDeadline: deadline, standingRuleDeadline: Math.min(Math.max(deadline, now) + this.standingRuleTtlMs, bound.binding.enrollment.expiresAt), ruleKey,
    });
    this.ledger.create(action);
    const native: NonNullable<LiveAction["native"]> = {
      intent, active: false, executionClosed: false, recorded: false, resolve: null,
      storeRule: () => this.storeNativeRule(ticket), ruleAttempted: false, cancelled: null,
    };
    const ticket = this.keepLive(bound.binding, { action, form: this.form({ kind: "native_review", approval: view, hint: null }, ruleKey ? ["allow_once", "always_allow", "deny"] : ["allow_once", "deny"]) }, null, native, bound.signal);
    this.live.set(action.id, ticket);
    this.intents.set(intent.intentId, action.id);
    return ticket;
  }
  private async openApproval(ticket: LiveAction, hint: Promise<ReviewHint> | null): Promise<ApprovalDecision> {
    const native = ticket.native;
    if (!native || native.executionClosed || native.cancelled || !this.bindingCurrent(ticket.binding)) return "deny";
    if (ticket.challenge.action.policyRevision !== this.policyRevision()) {
      this.cancel(ticket, "superseded");
      return "deny";
    }
    native.active = true;
    if (hint) void hint.then(value => {
      if (!this.live.has(ticket.challenge.action.id)) return;
      const display = ticket.challenge.form.display;
      if (display.kind === "native_review") ticket.challenge = freeze({ ...ticket.challenge, form: this.form({ ...display, hint: value }, ticket.challenge.form.requestedSchema.properties.choice.enum) });
    }).catch(() => {});
    return new Promise(resolve => {
      native.resolve = resolve;
      const request = ticket.binding.transport.requestForm;
      if (request) void request(this.challenge(ticket), ticket.signal.signal).then(response => this.respond(ticket.binding, response)).catch(() => {
        if (!this.closed && this.live.has(ticket.challenge.action.id) && !ticket.signal.signal.aborted) this.cancel(ticket, "disconnected");
      });
    });
  }
  private challenge(ticket: LiveAction): OwnerChallenge {
    const native = ticket.native;
    if (native?.executionClosed && ticket.challenge.action.ruleKey) {
      return freeze({ ...ticket.challenge, form: this.form(ticket.challenge.form.display, ["always_allow", "deny"]) });
    }
    return ticket.challenge;
  }
  private matchResponse(action: FrozenAction, response: HostResponse): void {
    if (action.id !== response.actionId || action.revision !== response.revision || action.nonce !== response.nonce ||
      action.argumentsDigest !== response.argumentsDigest || action.capabilityDigest !== response.capabilityDigest ||
      action.policyRevision !== response.policyRevision || action.enrollmentRevision !== response.enrollmentRevision) throw new OwnerError("conflict");
  }
  private checkActionCurrent(ticket: LiveAction, action: FrozenAction): void {
    this.assertOwner(ticket.binding);
    const state = this.ledger.get(action.id).state;
    if (state === "cancelled" || state === "abandoned") throw new OwnerError("cancelled");
    if (ticket.signal.signal.aborted) throw new OwnerError("cancelled");
    if (action.policyRevision !== this.policyRevision()) {
      this.cancel(ticket, "superseded");
      throw new OwnerError("conflict");
    }
    if (this.now() > (ticket.native ? action.standingRuleDeadline : action.executionDeadline)) {
      this.expireEvidence(ticket);
      throw new OwnerError("expired");
    }
  }
  private storeNativeRule(ticket: LiveAction): void {
    const native = ticket.native;
    if (!native || native.ruleAttempted) return;
    if (native.cancelled || ticket.signal.signal.aborted || !this.bindingCurrent(ticket.binding)) throw new OwnerError("cancelled");
    const action = ticket.challenge.action;
    if (this.now() > action.standingRuleDeadline || action.policyRevision !== this.policyRevision()) throw new OwnerError("expired");
    native.ruleAttempted = true;
    this.updateReceipt(action.id, receipt => ({ ...receipt, standingRule: "storing" }));
    try {
      if (!this.device) throw new OwnerError("closed");
      this.device.policy.storeRule(native.intent);
      const stored = action.ruleKey !== null && this.device.policy.allRules().some(rule => rule.ruleKey === action.ruleKey);
      this.updateReceipt(action.id, receipt => ({ ...receipt, standingRule: stored ? "stored" : "unchanged" }));
      this.supersedeOtherActions(action.id);
    } catch (error) {
      this.updateReceipt(action.id, receipt => ({ ...receipt, standingRule: "failed" }));
      throw error;
    }
  }
  private nativeSettled(notice: ApprovalSettlement): void {
    if (this.closed) return;
    const id = this.intents.get(notice.intentId);
    const ticket = id ? this.live.get(id) : null;
    if (!ticket?.native) return;
    ticket.native.executionClosed = true;
    this.updateReceipt(ticket.challenge.action.id, receipt => ({ ...receipt, execution: { kind: "recording" } }));
    ticket.native.resolve?.("deny");
    ticket.native.resolve = null;
    if (notice.source !== APPROVAL_SOURCE_EXPIRED && ticket.native.cancelled === null && this.ledger.get(ticket.challenge.action.id).responseDigest === null) {
      this.updateReceipt(ticket.challenge.action.id, receipt => ({ ...receipt, standingRule: "unchanged" }));
    }
  }
  private nativeRecorded(intentId: string): void {
    if (this.closed) return;
    const id = this.intents.get(intentId);
    const ticket = id ? this.live.get(id) : null;
    const actual = this.decisions.get(intentId) ?? this.readAuditDecision(intentId);
    if (!ticket?.native || !actual) return;
    ticket.native.recorded = true;
    this.decisions.delete(intentId);
    this.updateReceipt(ticket.challenge.action.id, receipt => ({ ...receipt, execution: { kind: "decided", decision: actual.decision, source: actual.source, auditRef: `${intentId}:intent_decision` } }));
    this.finishIfRecorded(ticket);
  }
  private finishIfRecorded(ticket: LiveAction): void {
    const record = this.ledger.get(ticket.challenge.action.id);
    if (ticket.native && !ticket.native.recorded) return;
    if (record.receipt.standingRule === "available" || record.receipt.standingRule === "storing") return;
    const cancelled = record.state === "cancelled";
    this.ledger.update(record.action.id, prior => ({ ...prior, state: cancelled ? "cancelled" : "settled", receipt: { ...prior.receipt, status: cancelled ? "cancelled" : "settled" } }));
    this.release(ticket);
    this.wake(record.action.id);
  }
  private async applyControl(ticket: LiveAction, choice: ApprovalDecision): Promise<void> {
    const command = ticket.command;
    if (!command) throw new OwnerError("corrupt_state");
    const id = ticket.challenge.action.id;
    if (choice === "deny") {
      this.updateReceipt(id, receipt => ({ ...receipt, execution: { kind: "rejected" } }));
      this.finishIfRecorded(ticket);
      return;
    }
    if (command.expectedRevision !== this.policyRevision()) throw new OwnerError("conflict");
    try {
      switch (command.kind) {
        case "set_mode":
        case "set_purpose": {
          const current = this.settings();
          const settings = { ...current };
          if (command.kind === "set_mode") settings.approvalMode = command.mode;
          else settings.agentPurpose = command.purpose;
          (this.options.saveSettings ?? saveSettings)(this.options.home, settings);
          current.approvalMode = settings.approvalMode;
          current.agentPurpose = settings.agentPurpose;
          const policyRevision = this.policyRevision();
          this.updateReceipt(id, receipt => ({ ...receipt, execution: { kind: "applied", policyRevision } }));
          this.supersedeOtherActions(id);
          break;
        }
        case "revoke_rule": {
          if (!this.device || !this.device.policy.allRules().some(rule => rule.ruleKey === command.ruleKey)) throw new OwnerError("not_found");
          this.device.policy.removeRule(command.ruleKey);
          const policyRevision = this.policyRevision();
          this.updateReceipt(id, receipt => ({ ...receipt, execution: { kind: "applied", policyRevision } }));
          this.supersedeOtherActions(id);
          break;
        }
        case "native_control": {
          const availability = this.adapter.availability(command.operation);
          if (availability.kind !== "ready") {
            this.updateReceipt(id, receipt => ({ ...receipt, execution: { kind: "unavailable", reason: "native_adapter_unavailable" } }));
            break;
          }
          this.updateReceipt(id, receipt => ({ ...receipt, execution: { kind: "recording" } }));
          const result = await this.adapter.perform(command, ticket.signal.signal);
          if (this.closed) return;
          if (ticket.signal.signal.aborted) {
            this.updateReceipt(id, receipt => ({ ...receipt, execution: { kind: "outcome_unknown" } }));
            return;
          }
          const policyRevision = this.policyRevision();
          this.updateReceipt(id, receipt => ({ ...receipt, execution: result.kind === "applied" ? { kind: "applied", policyRevision } : result.kind === "unavailable" ? { kind: "unavailable", reason: "native_adapter_unavailable" } : result }));
          break;
        }
        default: {
          const exhaustive: never = command;
          throw new OwnerError(exhaustive);
        }
      }
    } catch {
      if (this.closed) return;
      this.updateReceipt(id, receipt => ({ ...receipt, execution: { kind: "outcome_unknown" } }));
    }
    this.finishIfRecorded(ticket);
  }
  private supersedeOtherActions(currentId: string): void {
    const currentRevision = this.policyRevision();
    for (const ticket of [...this.live.values()]) {
      if (ticket.challenge.action.id !== currentId && ticket.challenge.action.policyRevision !== currentRevision) {
        if (ticket.native && !ticket.native.active) {
          this.updateReceipt(ticket.challenge.action.id, receipt => ({ ...receipt, standingRule: "cancelled" }));
        } else this.cancel(ticket, "superseded");
      }
    }
  }
  private updateReceipt(id: string, body: (receipt: OwnerReceipt) => OwnerReceipt): void {
    this.ledger.update(id, record => ({ ...record, receipt: body(record.receipt) }));
    this.wake(id);
  }
  private cancel(ticket: LiveAction, reason: CancellationReason): void {
    if (this.closed || !this.live.has(ticket.challenge.action.id)) return;
    const id = ticket.challenge.action.id;
    if (ticket.native) {
      ticket.native.cancelled = reason;
      ticket.native.resolve?.("deny");
      ticket.native.resolve = null;
    }
    ticket.signal.abort(reason);
    this.ledger.update(id, record => ({ ...record, state: "cancelled", receipt: { ...record.receipt, status: "cancelled", reason, standingRule: record.receipt.standingRule === "stored" ? "stored" : "cancelled", execution: ticket.native && !ticket.native.recorded ? { kind: "recording" } : record.receipt.execution.kind === "pending" ? { kind: "rejected" } : !ticket.native && record.receipt.execution.kind === "recording" ? { kind: "outcome_unknown" } : record.receipt.execution } }));
    clearTimeout(ticket.timer);
    ticket.dispose();
    if (!ticket.native || ticket.native.recorded) this.release(ticket);
    this.wake(id);
  }
  private expireEvidence(ticket: LiveAction): void {
    if (this.closed || !this.live.has(ticket.challenge.action.id)) return;
    if (!ticket.native) { this.cancel(ticket, "evidence_expired"); return; }
    ticket.native.cancelled = "evidence_expired";
    this.updateReceipt(ticket.challenge.action.id, receipt => ({ ...receipt, standingRule: "expired" }));
    ticket.signal.abort("evidence_expired");
    ticket.native.resolve?.("deny");
    ticket.native.resolve = null;
    this.finishIfRecorded(ticket);
  }
  private release(ticket: LiveAction): void {
    clearTimeout(ticket.timer);
    ticket.dispose();
    ticket.signal.abort("settled");
    this.live.delete(ticket.challenge.action.id);
    if (ticket.native) this.intents.delete(ticket.native.intent.intentId);
  }
  private wake(id: string): void { for (const callback of this.receiptWaiters.get(id) ?? []) callback(); }
  private async waitReceipt(id: string): Promise<OwnerReceipt> {
    const ready = () => {
      const receipt = this.ledger.get(id).receipt;
      return receipt.status !== "pending" && receipt.status !== "recording" && receipt.execution.kind !== "recording";
    };
    if (ready()) return this.ledger.get(id).receipt;
    await new Promise<void>(resolve => {
      const waiters = this.receiptWaiters.get(id) ?? new Set<() => void>();
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        if (!this.closed && !ready()) return;
        clearTimeout(timer);
        waiters.delete(done);
        if (waiters.size === 0) this.receiptWaiters.delete(id);
        resolve();
      };
      waiters.add(done);
      this.receiptWaiters.set(id, waiters);
      timer = setTimeout(() => {
        waiters.delete(done);
        if (waiters.size === 0) this.receiptWaiters.delete(id);
        resolve();
      }, this.receiptWaitMs);
      timer.unref?.();
      done();
    });
    if (this.closed) throw new OwnerError("closed");
    return this.ledger.get(id).receipt;
  }
  private reconcileAudit(): void {
    if (!this.device) return;
    const entries = this.device.audit.entries();
    for (const record of this.ledger.abandoned()) {
      if (record.action.kind !== "native_review") continue;
      const actual = entries.map(entry => auditDecision.safeParse(entry)).find(result => result.success && result.data.intentId === record.action.targetId);
      if (!actual?.success) continue;
      const ruleStored = record.action.ruleKey !== null && this.device.policy.allRules().some(rule => rule.ruleKey === record.action.ruleKey) && entries.some(entry => {
        const result = z.object({ event: z.literal("rule_stored"), intentId: reference }).passthrough().safeParse(entry);
        return result.success && result.data.intentId === record.action.targetId;
      });
      this.ledger.update(record.action.id, prior => ({ ...prior, state: "settled", receipt: { ...prior.receipt, status: "settled", reason: "restart_reconciled", execution: { kind: "decided", decision: actual.data.decision, source: actual.data.source, auditRef: `${record.action.targetId}:intent_decision` }, standingRule: ruleStored ? "stored" : "unchanged" } }));
    }
  }
  private readAuditDecision(intentId: string): AuditedDecision | undefined {
    for (const entry of this.device?.audit.entries() ?? []) {
      const parsed = auditDecision.safeParse(entry);
      if (parsed.success && parsed.data.intentId === intentId) return parsed.data;
    }
    return undefined;
  }
}
