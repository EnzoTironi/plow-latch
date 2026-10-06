import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { ServerContext, ProtocolEra, CallToolResult } from "@modelcontextprotocol/server";
import type { McpServerExtension, IntentInteraction, AgentIdentity } from "@domo/mcp-server";
import { SERVER_INSTRUCTIONS } from "@domo/mcp-server";
import { auditActivities } from "@domo/device-core";
import { OwnerServiceError, OWNER_CHANNELS } from "@domo/owner-services";
import { OwnerError } from "@domo/owner-runtime";
import type { NativeOwnerAdapter, OwnerCommand, OwnerChallenge, HostBinding, OwnerReceipt } from "@domo/owner-runtime";
import { ConnectorDispatcher, CredentialBroker, ReviewedCatalog, CallInputSchema, ConnectorError } from "@domo/connector-runtime";
import type { Authorizer, Authorization, ConnectionReview, FrozenPlan } from "@domo/connector-runtime";
import { HubError, ConfigurationSchema } from "@domo/integration-hub";
import type { JSONValue } from "@domo/protocol";
import { OwnerGateway } from "./ownerGateway.js";
import type { HeadlessRuntime } from "./runtime.js";

export const HUB_URI = "ui://latch/hub.html";
const ref = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const page = { limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(100_000).default(0) };
const querySchema = z.object({ view: z.literal("overview").default("overview"), ...page }).strict();
const memorySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("remember"), text: z.string().min(1).max(16_384), sourceRefs: z.array(ref).max(32).default([]) }).strict(),
  z.object({ action: z.literal("search"), query: z.string().max(256), ...page }).strict(),
  z.object({ action: z.literal("list"), ...page }).strict(),
  z.object({ action: z.literal("get"), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal("correct"), id: z.string().uuid(), expectedVersion: z.number().int().positive(), text: z.string().min(1).max(16_384), sourceRefs: z.array(ref).max(32).optional() }).strict(),
  z.object({ action: z.literal("delete"), id: z.string().uuid() }).strict(),
]);
const uiCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_mode"), mode: z.enum(["approve", "adversarial", "ask", "deny"]) }).strict(),
  z.object({ kind: z.literal("set_purpose"), text: z.string().max(16_384) }).strict(),
  z.object({ kind: z.literal("revoke_rule"), ruleKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("set_budget"), limitMicros: z.number().int().min(0).max(1_000_000_000_000) }).strict(),
  z.object({ kind: z.literal("add_connection"), namespace: ref, configuration: ConfigurationSchema }).strict(),
  z.object({ kind: z.literal("connection_status"), connectionId: z.string().uuid(), status: z.enum(["ready", "disabled", "revoked"]) }).strict(),
  z.object({ kind: z.literal("cancel_job"), jobId: z.string().uuid() }).strict(),
]);
const proposeSchema = z.object({ command: uiCommand, expectedRevision: z.number().int().positive() }).strict();
const ownerQuerySchema = z.object({ channel: z.enum(OWNER_CHANNELS), input: z.json().optional() }).strict();
const ownerCommandSchema = ownerQuerySchema.extend({ expectedRevision: z.number().int().positive() });
const reviewSchema = z.object({ intentId: ref }).strict();
const jobSchema = z.object({ jobId: z.string().uuid() }).strict();
const familySchema = z.object({ title: z.string(), family: z.string(), status: z.string(), reason: z.string(), operations: z.array(z.object({ channel: z.string() })) });
type Review = { binding: HostBinding; challenge: OwnerChallenge; resolve: (authorization: Authorization) => void; plan: FrozenPlan };
type CurrentCall = { context: ServerContext; era: ProtocolEra };

function reply(value: unknown): CallToolResult {
  const json = z.record(z.string(), z.json()).parse(value);
  return { content: [{ type: "text", text: JSON.stringify(json) }], structuredContent: json };
}
function failure(error: unknown): CallToolResult {
  const code = error instanceof HubError || error instanceof OwnerError || error instanceof ConnectorError || error instanceof OwnerServiceError ? error.code : error instanceof z.ZodError ? "invalid_input" : "operation_failed";
  return { ...reply({ error: code }), isError: true };
}

export class HeadlessHub {
  private runtime: HeadlessRuntime | null = null;
  private gateway: OwnerGateway | null = null;
  private dispatcher: ConnectorDispatcher | null = null;
  private readonly current = new AsyncLocalStorage<CurrentCall>();
  private readonly challenges = new Map<string, OwnerChallenge>();
  private readonly reviews = new Map<string, Review>();
  private readonly reviewsConfig: readonly ConnectionReview[];
  private readonly broker: CredentialBroker;
  constructor(options: { connections?: readonly ConnectionReview[]; broker?: CredentialBroker } = {}) {
    this.reviewsConfig = options.connections ?? [];
    this.broker = options.broker ?? new CredentialBroker();
  }
  readonly adapter: NativeOwnerAdapter = {
    availability: operation => {
      if (["hub:set_budget", "hub:add_connection", "hub:connection_status", "hub:cancel_job", "hub:authorize_connection"].includes(operation)) return { kind: "ready" };
      return this.ownerServiceAdapter()?.availability(operation) ?? { kind: "unavailable", reason: "owner_host_context_required" };
    },
    perform: async (command, signal) => {
      signal.throwIfAborted();
      const runtime = this.requireRuntime();
      const { store, principal } = runtime;
      switch (command.operation) {
        case "hub:set_budget": store.setBudget(principal, z.object({ limitMicros: z.number().int().min(0).max(1_000_000_000_000) }).strict().parse(command.input).limitMicros); break;
        case "hub:add_connection": {
          const input = z.object({ namespace: ref, configuration: ConfigurationSchema }).strict().parse(command.input);
          const reviewed = this.reviewsConfig.find(configuration => configuration.configurationRef === input.configuration.configurationRef && configuration.destination.kind === input.configuration.kind && configuration.organizationId === principal.organizationId && configuration.principalId === principal.id);
          store.addConnection(principal, { ...input, status: reviewed?.grant ? "needs_auth" : reviewed ? "ready" : "disabled", ...(reviewed?.grant ? { credentialRef: `broker:${reviewed.grant.grantId}` } : {}) });
          break;
        }
        case "hub:connection_status": {
          const input = z.object({ connectionId: z.string().uuid(), status: z.enum(["ready", "disabled", "revoked"]) }).strict().parse(command.input);
          if (input.status === "ready") {
            const connection = store.getConnection(principal, input.connectionId);
            const reviewed = this.reviewsConfig.find(configuration => configuration.configurationRef === connection.configuration.configurationRef && configuration.organizationId === principal.organizationId && configuration.principalId === principal.id && configuration.destination.kind === connection.configuration.kind);
            if (!reviewed) return { kind: "unavailable", reason: "configuration_not_reviewed" };
          }
          if (input.status === "revoked") {
            const connection = store.getConnection(principal, input.connectionId);
            const configuration = this.reviewsConfig.find(value => value.configurationRef === connection.configuration.configurationRef);
            if (configuration?.grant) {
              const revoked = await this.broker.revoke({ principal, binding: configuration.grant, disableLocal: () => { store.revokeConnection(principal, connection.id); } });
              if (revoked.upstream !== "confirmed" || !revoked.removed) return { kind: "unavailable", reason: "upstream_revocation_unverified" };
            } else store.revokeConnection(principal, connection.id);
          } else store.setConnectionStatus(principal, { id: input.connectionId, status: input.status });
          break;
        }
        case "hub:cancel_job": this.requireDispatcher().cancel(principal, jobSchema.parse(command.input).jobId); break;
        case "hub:authorize_connection": {
          const input = z.object({ jobId: z.string().uuid(), planDigest: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number().int().positive() }).passthrough().parse(command.input);
          const review = this.reviews.get(input.jobId);
          if (!review || review.plan.planDigest !== input.planDigest || input.expiresAt <= Date.now()) return { kind: "unavailable", reason: "review_expired" };
          break;
        }
        default: return this.ownerServiceAdapter()?.perform(command, signal) ?? { kind: "unavailable", reason: "owner_host_context_required" };
      }
      return { kind: "applied" };
    },
  };
  attach(runtime: HeadlessRuntime): void {
    if (this.runtime) throw new Error("runtime_already_attached");
    this.runtime = runtime;
    this.gateway = new OwnerGateway(runtime.owner, runtime.host);
    const authorizer: Authorizer = { review: input => this.authorize(input) };
    this.dispatcher = new ConnectorDispatcher({ store: runtime.store, catalog: new ReviewedCatalog(this.reviewsConfig), broker: this.broker, authorizer, resolvePrincipal: original => {
      if (original.id !== runtime.principal.id || original.organizationId !== runtime.principal.organizationId) throw new HubError("denied");
      return runtime.principal;
    } });
  }
  private requireRuntime(): HeadlessRuntime {
    if (!this.runtime) throw new Error("runtime_unavailable");
    return this.runtime;
  }
  private requireGateway(): OwnerGateway {
    if (!this.gateway) throw new Error("runtime_unavailable");
    return this.gateway;
  }
  private requireDispatcher(): ConnectorDispatcher {
    if (!this.dispatcher) throw new Error("runtime_unavailable");
    return this.dispatcher;
  }
  private ownerServiceAdapter(): NativeOwnerAdapter | null {
    const current = this.current.getStore();
    if (!current) return null;
    return this.requireRuntime().services.nativeAdapter(this.requireGateway().requireBinding(current.context));
  }
  private async presentCommand(context: ServerContext, era: ProtocolEra, tool: string, input: unknown, command: () => OwnerCommand) {
    const gateway = this.requireGateway();
    const binding = gateway.requireBinding(context);
    const resumed = gateway.resumed(context, tool, input);
    let challenge = resumed ? this.challenges.get(resumed) : undefined;
    if (resumed && !challenge) return reply({ receipt: gateway.controller.receipt(binding, resumed) });
    if (!challenge) {
      for (const [id, pending] of this.challenges) if (pending.action.executionDeadline < Date.now()) this.challenges.delete(id);
      if (this.challenges.size >= 100) throw new HubError("capacity");
      challenge = gateway.controller.propose(binding, command()); this.challenges.set(challenge.action.id, challenge);
    }
    return gateway.present(context, era, tool, input, challenge, async receipt => {
      if (receipt.status !== "pending" && receipt.status !== "recording") this.challenges.delete(receipt.actionId);
      return reply({ receipt });
    });
  }
  private async authorize(input: Parameters<Authorizer["review"]>[0]): Promise<Authorization> {
    const current = this.current.getStore();
    if (!current) return { kind: "unavailable" };
    const gateway = this.requireGateway();
    let binding: HostBinding;
    try { binding = gateway.requireBinding(current.context); } catch { return { kind: "unavailable" }; }
    if (binding.enrollment.principalId !== input.plan.ownerPrincipalId || binding.enrollment.organizationId !== input.plan.organizationId) return { kind: "unavailable" };
    const command: OwnerCommand = { kind: "native_control", operation: "hub:authorize_connection", input: z.json().parse(input.plan), expectedRevision: gateway.controller.snapshot(binding).policyRevision };
    const challenge = gateway.controller.propose(binding, command);
    return new Promise(resolve => {
      const finish = (authorization: Authorization) => { input.signal.removeEventListener("abort", abort); this.reviews.delete(input.plan.jobId); resolve(authorization); };
      const abort = () => {
        try { gateway.controller.cancelAction(binding, challenge.action.id, "evidence_expired"); }
        catch (error) { if (!(error instanceof OwnerError)) this.requireRuntime().device.audit.record("connector_review_cancel_failed", { jobId: input.plan.jobId }); }
        finally { finish({ kind: "expired" }); }
      };
      this.reviews.set(input.plan.jobId, { binding, challenge, plan: input.plan, resolve: finish });
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
    });
  }
  async snapshot(context: ServerContext, limit = 50, offset = 0): Promise<CallToolResult> {
    const runtime = this.requireRuntime();
    const { store, principal, device, owner, approvals } = runtime;
    let binding: HostBinding | null = null;
    try { binding = this.requireGateway().requireBinding(context); } catch (error) { if (!(error instanceof OwnerError)) throw error; }
    const settings = runtime.settings.load();
    const own = binding ? owner.snapshot(binding) : null;
    const pending = (await approvals.pending()).filter(record => record.agentId === principal.id);
    const registry = binding ? runtime.services.registry(binding).map(entry => {
      const routed = ["settings:setApprovalMode", "settings:setAgentPurpose", "rules:remove", "approval:get", "approval:ready", "approval:decide"].includes(entry.channel);
      return routed ? { ...entry, availability: { kind: "ready" as const }, route: entry.channel.startsWith("approval:") ? "latch_review_intent" : "latch_owner_command" } : entry;
    }) : [];
    const capabilities = familySchema.array().parse(JSON.parse(readFileSync(new URL("./capabilities.json", import.meta.url), "utf8"))).map(family => {
      const operations = family.operations.map(operation => registry.find(entry => entry.channel === operation.channel) ?? { ...operation, availability: { kind: "unavailable" as const, reason: "owner_not_enrolled" } });
      const ready = operations.filter(operation => operation.availability.kind === "ready").length;
      return { ...family, status: ready === operations.length ? "ready" : ready > 0 ? "partial" : "unavailable", reason: `${ready} de ${operations.length} controles disponíveis neste ambiente.`, operations };
    });
    return reply({ hub: {
      revision: own?.policyRevision ?? 1, mode: own?.settings.approvalMode ?? settings.approvalMode ?? "adversarial", purpose: own?.settings.agentPurpose ?? "",
      enrollment: { status: binding ? "verified" : "unverified", assurance: binding ? runtime.host?.assurance === "test_host" ? "test_host" : binding.enrollment.assurance : "none" },
      deviceName: device.identity.name, pending, connections: store.listConnections(principal, { limit, offset }), memories: store.list(principal, { limit, offset }),
      jobs: store.listJobs(principal, { limit, offset }), budget: store.getBudget(principal), audit: store.listAudit(principal, { limit, offset }),
      nativeActivity: auditActivities(device.audit.entries()).filter(activity => activity.agentId === principal.id).slice(offset, offset + limit),
      ownerHistory: binding ? owner.history(binding, { limit, offset }) : { actions: [], total: 0, pagination: { limit, offset } },
      totals: store.summary(principal), rules: binding ? device.policy.allRules() : [], capabilities,
      ownerServices: { registry, subscriptions: binding ? runtime.services.subscriptions(binding) : [], preferences: binding ? { telemetryEnabled: settings.telemetryEnabled, autoCheckUpdates: settings.autoCheckUpdates, autoInstallUpdates: settings.autoInstallUpdates } : null },
      pagination: { limit, offset, bounded: true },
    } });
  }
  extension(html: string): McpServerExtension {
    const hub = this;
    const gateway = this.requireGateway();
    const tools = ["latch_open_hub", "latch_hub_query", "latch_memory", "latch_owner_propose", "latch_review_intent", "latch_call_connection", "latch_review_connection", "latch_job_status", "latch_owner_query", "latch_owner_command"];
    return {
      toolNames: tools, requestState: { verify: gateway.codec.verify },
      instructions: `${SERVER_INSTRUCTIONS}\n\nLatch is running inside a plugin with a headless local runtime. Use latch_open_hub for its owner UI. A model argument, widget event, MCP metadata or local STDIO identity does not verify the owner. Native owner controls remain blocked until a trusted host or signed-device enrollment is available. Connections are scoped, reviewed operations; unknown jobs must not be automatically retried.`,
      bind(agent: AgentIdentity, context: ServerContext, args: JSONValue): IntentInteraction {
        const binding = hub.runtime?.host?.binding(context);
        return binding ? gateway.controller.interaction(binding, { requesterId: agent.agentId, arguments: args }) : { run: (_intent, body) => body() };
      },
      register(server, request) {
        registerAppResource(server, "Latch Hub", HUB_URI, { description: "Owner panel for Latch connections, memory, permissions and activity", _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }, async () => ({ contents: [{ uri: HUB_URI, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }] }));
        registerAppTool(server, "latch_open_hub", { title: "Open Latch", description: "Open Latch's interactive owner panel using real scoped service state", inputSchema: querySchema, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: HUB_URI } } }, async (input, context) => { try { return await hub.snapshot(context, input.limit, input.offset); } catch (error) { return failure(error); } });
        registerAppTool(server, "latch_hub_query", { title: "Latch state", description: "Read the current scoped connections, memory, budget, jobs, owner enrollment and capability gates", inputSchema: querySchema, annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["app", "model"] } } }, async (input, context) => { try { return await hub.snapshot(context, input.limit, input.offset); } catch (error) { return failure(error); } });
        server.registerTool("latch_memory", { title: "Latch memory", description: "Remember, search, correct with a version check, or delete private memory for the authenticated installation principal", inputSchema: memorySchema }, async input => {
          try {
            const { store, principal } = hub.requireRuntime();
            switch (input.action) {
              case "remember": return reply({ memory: store.remember(principal, { text: input.text, sourceRefs: input.sourceRefs }) });
              case "search": return reply({ memories: store.search(principal, { query: input.query, limit: input.limit, offset: input.offset }), pagination: { limit: input.limit, offset: input.offset, total: store.memoryCount(principal, input.query) } });
              case "list": return reply({ memories: store.list(principal, { limit: input.limit, offset: input.offset }), pagination: { limit: input.limit, offset: input.offset, total: store.memoryCount(principal) } });
              case "get": return reply({ memory: store.get(principal, input.id) });
              case "correct": return reply({ memory: store.correct(principal, { id: input.id, expectedVersion: input.expectedVersion, text: input.text, ...(input.sourceRefs ? { sourceRefs: input.sourceRefs } : {}) }) });
              case "delete": store.delete(principal, input.id); return reply({ deleted: input.id });
            }
          } catch (error) { return failure(error); }
        });
        registerAppTool(server, "latch_owner_propose", { title: "Propose owner change", description: "Propose an owner setting or connection control. Authorization comes from a separate verified host response", inputSchema: proposeSchema, _meta: { ui: { visibility: ["app"] } } }, async (input, context) => {
          try {
            return await hub.presentCommand(context, request.era, "latch_owner_propose", input, () => {
              let command: OwnerCommand;
              switch (input.command.kind) {
                case "set_mode": command = { ...input.command, expectedRevision: input.expectedRevision }; break;
                case "set_purpose": command = { kind: "set_purpose", purpose: input.command.text, expectedRevision: input.expectedRevision }; break;
                case "revoke_rule": command = { ...input.command, expectedRevision: input.expectedRevision }; break;
                default: {
                  const { kind, ...fields } = input.command;
                  command = { kind: "native_control", operation: `hub:${kind}`, input: fields, expectedRevision: input.expectedRevision };
                }
              }
              return command;
            });
          } catch (error) { return failure(error); }
        });
        registerAppTool(server, "latch_owner_query", { title: "Read a Latch owner control", description: "Read a maintained Latch controller with a verified owner binding. Protected owner data requires a separate private surface", inputSchema: ownerQuerySchema, annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["app"] } } }, async (input, context) => {
          try { return reply({ service: await hub.requireRuntime().services.query(gateway.requireBinding(context), input) }); } catch (error) { return failure(error); }
        });
        registerAppTool(server, "latch_owner_command", { title: "Review a Latch owner control", description: "Propose a maintained Latch owner operation for separate host confirmation. Vault input uses a private owner ticket and never raw credentials", inputSchema: ownerCommandSchema, _meta: { ui: { visibility: ["app"] } } }, async (input, context) => {
          try { return await hub.current.run({ context, era: request.era }, () => hub.presentCommand(context, request.era, "latch_owner_command", input, () => hub.requireRuntime().services.command(input, input.expectedRevision))); } catch (error) { return failure(error); }
        });
        registerAppTool(server, "latch_review_intent", { title: "Review native access", description: "Review an exact pending native intent through the verified owner host", inputSchema: reviewSchema, _meta: { ui: { visibility: ["app"] } } }, async (input, context) => {
          try {
            const binding = gateway.requireBinding(context);
            const resumed = gateway.resumed(context, "latch_review_intent", input);
            if (resumed) {
              const receipt = gateway.controller.receipt(binding, resumed);
              if (receipt.status !== "pending") return reply({ receipt });
            }
            const review = gateway.controller.review(binding, input);
            if (review.kind === "receipt") return reply({ receipt: review.receipt });
            if (review.kind !== "challenge") return reply({ status: review.kind });
            if (resumed && resumed !== review.challenge.action.id) throw new OwnerError("conflict");
            return await gateway.present(context, request.era, "latch_review_intent", input, review.challenge, async receipt => reply({ receipt }));
          } catch (error) { return failure(error); }
        });
        server.registerTool("latch_call_connection", { title: "Call a Latch connection", description: "Start one reviewed MCP, API or CLI operation with owner review, bounded cost, a durable job and an idempotency key", inputSchema: CallInputSchema }, async (input, context) => {
          try { return await hub.current.run({ context, era: request.era }, async () => reply({ job: await hub.requireDispatcher().call(hub.requireRuntime().principal, input) })); } catch (error) { return failure(error); }
        });
        registerAppTool(server, "latch_review_connection", { title: "Review a connection operation", description: "Review a frozen connection plan with destination, effects, arguments and cost bound", inputSchema: jobSchema, _meta: { ui: { visibility: ["app"] } } }, async (input, context) => {
          try {
            const binding = gateway.requireBinding(context);
            const resumed = gateway.resumed(context, "latch_review_connection", input);
            const review = hub.reviews.get(input.jobId);
            if (!review) return reply({ ...(resumed ? { receipt: gateway.controller.receipt(binding, resumed) } : {}), job: hub.requireDispatcher().status(hub.requireRuntime().principal, input.jobId), status: "not_pending" });
            gateway.controller.receipt(binding, review.challenge.action.id);
            if (resumed && resumed !== review.challenge.action.id) throw new OwnerError("conflict");
            return await gateway.present(context, request.era, "latch_review_connection", input, review.challenge, async receipt => {
              if (receipt.execution.kind === "applied" && receipt.evidenceRef !== null && Date.now() < review.plan.expiresAt) review.resolve({ kind: "approved", planDigest: review.plan.planDigest, ownerPrincipalId: review.plan.ownerPrincipalId, evidenceRef: receipt.evidenceRef, expiresAt: review.plan.expiresAt });
              else review.resolve({ kind: "denied" });
              return reply({ receipt, job: hub.requireDispatcher().status(hub.requireRuntime().principal, input.jobId) });
            });
          } catch (error) { return failure(error); }
        });
        server.registerTool("latch_job_status", { title: "Latch job result", description: "Read one scoped job and its durable result. Unknown outcomes keep their reservation and must not be replayed", inputSchema: jobSchema, annotations: { readOnlyHint: true } }, async input => { try { const principal = hub.requireRuntime().principal, dispatcher = hub.requireDispatcher(); return reply({ job: dispatcher.status(principal, input.jobId), result: dispatcher.result(principal, input.jobId) }); } catch (error) { return failure(error); } });
      },
    };
  }
  async close(): Promise<void> { await this.dispatcher?.close(); }
  waitForJob(principal: HeadlessRuntime["principal"], jobId: string) { return this.requireDispatcher().wait(principal, jobId); }
}
