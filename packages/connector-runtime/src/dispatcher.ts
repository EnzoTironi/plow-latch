import { randomUUID } from "node:crypto";
import { PrincipalSchema, type Job, type Principal } from "@domo/integration-hub";
import { ReviewedCatalog, actualCost, type ReviewedConnection, type ReviewedOperation } from "./catalog.js";
import { CredentialBroker } from "./credentials.js";
import { CallInputSchema, ConnectorError, JsonObjectSchema, ReferenceSchema, assertConnection, digest, freeze, parse, type Authorizer, type ConnectorStore, type FrozenPlan, type JobResult, type Json, type JsonObject } from "./model.js";
import { execute, prepare, resource, type TransportDependencies } from "./transports.js";

type Execution = { principal: Principal; controller: AbortController; promise: Promise<void> };
type DispatcherOptions = {
  store: ConnectorStore; catalog: ReviewedCatalog; authorizer: Authorizer; broker: CredentialBroker;
  /** Resolve current scopes from trusted installation state at every effect boundary. */
  resolvePrincipal: (original: Principal) => Principal;
  reviewTimeoutMs?: number; transport?: TransportDependencies; now?: () => number;
};
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ConnectorError("cancelled"));
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new ConnectorError("cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

export class ConnectorDispatcher {
  private readonly executions = new Map<string, Execution>();
  private closed = false;
  private readonly reviewTimeoutMs: number;
  constructor(private readonly options: DispatcherOptions) {
    this.reviewTimeoutMs = options.reviewTimeoutMs ?? 60_000;
    if (!Number.isInteger(this.reviewTimeoutMs) || this.reviewTimeoutMs < 1 || this.reviewTimeoutMs > 300_000) throw new ConnectorError("invalid_catalog");
  }
  private current(original: Principal): Principal {
    const principal = parse(PrincipalSchema, this.options.resolvePrincipal(original), "scope_denied");
    if (principal.id !== original.id || principal.organizationId !== original.organizationId || principal.kind !== original.kind || principal.ownerId !== original.ownerId) throw new ConnectorError("scope_denied");
    return principal;
  }
  call(context: Principal, rawInput: unknown): Promise<Job> {
    if (this.closed) throw new ConnectorError("closed");
    const principal = this.current(parse(PrincipalSchema, context)), input = parse(CallInputSchema, rawInput);
    const intentId = `connector:${digest(input)}`;
    const existing = this.options.store.getJobByIdempotencyKey(principal, input.idempotencyKey);
    if (existing !== null) {
      if (existing.intentId !== intentId || existing.connectionId !== input.connectionId || existing.operation !== input.operation) throw new ConnectorError("invalid_input");
      return Promise.resolve(existing);
    }
    const connection = this.options.store.getConnection(principal, input.connectionId);
    assertConnection(connection, connection.revision);
    const { configuration, operation } = this.options.catalog.resolve(principal, connection, input.operation);
    if (!operation.validateInput(input.arguments)) throw new ConnectorError("invalid_input");
    const request = prepare(configuration, operation, input.arguments);
    const envelope = { arguments: input.arguments, request, schemaDigest: operation.schemaDigest, catalogDigest: configuration.catalogDigest, connectionRevision: connection.revision };
    const job = this.options.store.createJob(principal, { connectionId: connection.id, operation: operation.name, intentId, arguments: envelope, idempotencyKey: input.idempotencyKey, upperBoundMicros: operation.cost.upperBoundMicros });
    if (this.executions.has(job.id)) return Promise.resolve(job);
    const planFields = {
      jobId: job.id, organizationId: principal.organizationId, requesterPrincipalId: principal.id, ownerPrincipalId: principal.ownerId ?? principal.id,
      connectionId: connection.id, connectionRevision: connection.revision, catalogRevision: configuration.revision, catalogDigest: configuration.catalogDigest,
      operation: operation.name, upstreamOperation: operation.upstreamOperation, arguments: input.arguments, request,
      argumentsDigest: digest(input.arguments), schemaDigest: operation.schemaDigest, effects: operation.effects, requiredScopes: operation.requiredScopes,
      upperBoundMicros: operation.cost.upperBoundMicros, expiresAt: Date.parse(job.createdAt) + this.reviewTimeoutMs,
    };
    const plan: FrozenPlan = freeze({ ...planFields, planDigest: digest(parse(JsonObjectSchema, planFields)) });
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.run(principal, job, configuration, operation, plan, controller)).finally(() => this.executions.delete(job.id));
    this.executions.set(job.id, { principal, controller, promise });
    return Promise.resolve(job);
  }
  status(context: Principal, jobId: string): Job { return this.options.store.getJob(parse(PrincipalSchema, context), jobId); }
  result(context: Principal, jobId: string): JobResult | null { return this.options.store.getJobResult(parse(PrincipalSchema, context), jobId); }
  list(context: Principal, page: { limit?: number; offset?: number } = {}): Job[] { return this.options.store.listJobs(parse(PrincipalSchema, context), page); }
  async wait(context: Principal, jobId: string): Promise<Job> {
    this.status(context, jobId);
    await this.executions.get(jobId)?.promise;
    return this.status(context, jobId);
  }
  cancel(context: Principal, jobId: string): Job {
    const principal = parse(PrincipalSchema, context), job = this.options.store.getJob(principal, jobId);
    const execution = this.executions.get(job.id);
    execution?.controller.abort();
    if (job.outcome.kind === "waiting") return this.options.store.cancelJob(principal, job.id);
    if (job.outcome.kind === "running") return this.options.store.markJobOutcomeUnknown(principal, job.id);
    return job;
  }
  private async run(principal: Principal, job: Job, configuration: ReviewedConnection, operation: ReviewedOperation, plan: FrozenPlan, controller: AbortController): Promise<void> {
    let effectStarted = false, evidenceRef: string | null = null;
    const now = () => this.options.now?.() ?? Date.now();
    let timeout = setTimeout(() => controller.abort(new ConnectorError("timeout")), Math.max(1, plan.expiresAt - now()));
    const resultValue = (value: Json): JsonObject => ({ output: value, planDigest: plan.planDigest, schemaDigest: plan.schemaDigest, catalogDigest: plan.catalogDigest, argumentsDigest: plan.argumentsDigest, authorizationEvidenceRef: evidenceRef });
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      const current = this.current(principal), connection = this.options.store.getConnection(principal, plan.connectionId);
      assertConnection(connection, plan.connectionRevision);
      this.options.catalog.resolve(current, connection, plan.operation);
    };
    try {
      const authorization = await abortable(this.options.authorizer.review({ principal, plan, signal: controller.signal }), controller.signal);
      if (authorization.kind !== "approved") throw new ConnectorError(authorization.kind === "denied" ? "approval_denied" : authorization.kind === "expired" ? "approval_expired" : "approval_unavailable");
      if (authorization.planDigest !== plan.planDigest || authorization.ownerPrincipalId !== plan.ownerPrincipalId || authorization.expiresAt <= now() || plan.expiresAt <= now()) throw new ConnectorError("approval_expired");
      evidenceRef = parse(ReferenceSchema, authorization.evidenceRef);
      assertCurrent();
      clearTimeout(timeout); timeout = setTimeout(() => controller.abort(new ConnectorError("timeout")), operation.timeoutMs);
      await this.options.broker.use({ principal, connectionId: plan.connectionId, binding: configuration.grant, resource: resource(configuration.destination), requiredScopes: operation.requiredScopes, signal: controller.signal }, async grant => {
        assertCurrent();
        this.options.store.startJob(principal, job.id, { expectedConnectionRevision: plan.connectionRevision });
        const value = await execute({ configuration, operation, request: plan.request, authorization: grant, signal: controller.signal, dependencies: this.options.transport ?? {}, principalPartition: `${principal.organizationId}:${principal.id}`, beforeEffect: () => { assertCurrent(); if (authorization.expiresAt <= now() || plan.expiresAt <= now()) throw new ConnectorError("approval_expired"); effectStarted = true; } });
        const outputValue = (configuration.destination.kind === "mcp_http" || configuration.destination.kind === "mcp_stdio") && value !== null && typeof value === "object" && !Array.isArray(value) ? value.structuredContent : value;
        if (operation.validateOutput && !operation.validateOutput(outputValue)) throw new ConnectorError("schema_drift");
        const actualMicros = actualCost(operation.cost, value);
        const failed = value !== null && typeof value === "object" && !Array.isArray(value) && (value.isError === true || (typeof value.exitCode === "number" && value.exitCode !== 0));
        this.options.store.recordJobResult(principal, { jobId: job.id, value: grant.redact(resultValue(value)), receiptRef: `receipt:${randomUUID()}`, outcome: actualMicros === null || operation.effects.some(effect => effect.kind === "unknown") ? { kind: "outcome_unknown" } : { kind: failed ? "failed" : "completed", actualMicros } });
      });
    } catch (error) {
      const stored = this.options.store.getJob(principal, job.id);
      if (["completed", "failed", "cancelled"].includes(stored.outcome.kind)) return;
      const code = controller.signal.aborted && controller.signal.reason instanceof ConnectorError ? controller.signal.reason.code : error instanceof ConnectorError ? error.code : controller.signal.aborted ? "cancelled" : "transport_failed";
      if (code === "needs_reauth" && this.options.store.getConnection(principal, plan.connectionId).status === "ready") this.options.store.setConnectionStatus(principal, { id: plan.connectionId, status: "needs_reauth" });
      const updated = this.options.store.getJob(principal, job.id);
      if (updated.outcome.kind === "cancelled") return;
      this.options.store.recordJobResult(principal, { jobId: job.id, value: resultValue({ errorCode: code }), receiptRef: null, outcome: effectStarted || updated.outcome.kind === "outcome_unknown" ? { kind: "outcome_unknown" } : { kind: "failed", actualMicros: 0 } });
    } finally { clearTimeout(timeout); }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const executions = [...this.executions.entries()];
    for (const [id, execution] of executions) this.cancel(execution.principal, id);
    await Promise.all(executions.map(([, execution]) => execution.promise));
  }
}
