import { z } from "zod";
import {
  AUTOMATION_APPS, BROWSER_PLUGIN, BROWSING_SKILL, importLogins, importPreview,
  markAgainstVault, parsePasswordExport, totpCode,
} from "@domo/device-core";
import { inferenceStatus } from "@domo/owner-core/reviewPolicy";
import { CommandSchema, requireBinding, type HostBinding, type NativeAvailability, type NativeOwnerAdapter, type OwnerCommand } from "@domo/owner-runtime";
import { jv, type JSONValue } from "@domo/protocol";
import { OWNER_CHANNELS, OWNER_EVENTS, SOURCE_FAMILIES, ownerChannelSchema, type OwnerChannel, type OwnerEventChannel } from "./channels.js";
import { OwnerServiceError } from "./errors.js";
import { AuditIndex } from "./maintained/auditIndex.js";
import { fetchAgentIndex } from "./maintained/agentIndex.js";
import { CloudAgentState, CloudChatsClient, CloudLinesClient } from "./maintained/cloudAgentState.js";
import { CloudAgentsClient } from "./maintained/cloudAgents.js";
import { ConnectClient } from "./maintained/connectClient.js";
import { Connectors } from "./maintained/connectors.js";
import { capabilitiesView, FullDiskWatch, fullDiskLanded } from "./maintained/capabilitiesModel.js";
import { gatekeeperPresets, previewRow } from "./maintained/gatekeeperPreview.js";
import { dismissGatekeeperAttention, suggestGatekeeperRevision, type GatekeeperRecoveryView } from "./maintained/gatekeeperRecovery.js";
import { ImportStaging } from "./maintained/importStaging.js";
import { Onboarding } from "./maintained/onboarding.js";
import { browserPluginRow, grantList, pluginExamples, pluginRows } from "./maintained/pluginsModel.js";
import type { NativeHostChannel, OwnerServiceEvent, OwnerServiceReply, OwnerServicesOptions, ProtectedInputChannel, SourceParityEntry } from "./types.js";

const empty = z.object({}).strict();
const text = z.string().min(1).max(1_024);
const optionalDraft = z.object({ draft: z.string().max(16_384).optional() }).strict();
const boolean = z.object({ on: z.boolean() }).strict();
const auditQuery = z.object({
  limit: z.number().int().min(1).max(200).default(50), search: z.string().max(1_024).optional(),
  decision: z.enum(["any", "unanswered", "allowed", "denied", "none"]).optional(),
  status: z.enum(["any", "running", "completed", "failed", "blocked", "none"]).optional(),
  cutoffMs: z.number().nonnegative().nullable().optional(), cutoffKey: z.enum(["ts", "blocked"]).optional(),
  keepId: z.string().max(160).nullable().optional(),
}).strict();
const vaultItem = z.object({
  itemId: text.optional(), revision: z.string().max(160).optional(),
  type: z.enum(["login", "card", "identity", "note"]).optional(), name: z.string().max(8_192).optional(),
  notes: z.string().max(131_072).optional(), urls: z.array(z.string().max(8_192)).max(100).optional(),
}).catchall(z.union([z.string().max(131_072), z.array(z.string().max(8_192)).max(100)]));
const ticket = z.number().int().positive().optional();
const protectedTicket = z.object({ protectedInputTicket: z.string().min(16).max(200).regex(/^[A-Za-z0-9_.:-]+$/) }).strict();
const presentationSchemas = {
  "onboarding:open": empty,
  "onboarding:finish": empty,
  "ui:confirmLeaveReply": z.object({ leave: z.boolean() }).strict(),
};
function needsProtectedInput(channel: OwnerChannel): channel is ProtectedInputChannel {
  return channel === "vault:saveItem" || channel === "vault:importInspect" || channel === "vault:totp";
}
const nativeSchemas = {
  "capabilities:act": z.object({ key: text }).strict(),
  "requirements:act": z.object({ id: text }).strict(),
  "grant:state": empty,
  "app:relaunch": empty,
  "fullDisk:dragInfo": empty,
  "fullDisk:tileImage": z.object({ dataUrl: z.string().max(1_048_576).startsWith("data:image/"), scale: z.number().positive().max(8) }).strict(),
  "fullDisk:dragStart": empty,
  "fullDisk:panelHold": boolean,
  "fullDisk:panelHeight": z.object({ height: z.number().positive().max(4_096) }).strict(),
  "fullDisk:dismiss": empty,
  "launch:get": empty,
  "launch:set": boolean,
  "power:getKeepAwake": empty,
  "power:setKeepAwake": boolean,
  "updates:get": empty,
  "updates:check": empty,
  "updates:restart": empty,
  "updates:dismiss": empty,
  "updates:setAutoCheck": boolean,
  "updates:setAutoInstall": boolean,
} satisfies Record<NativeHostChannel, z.ZodType<JSONValue>>;

interface Operation {
  access: SourceParityEntry["access"];
  data: SourceParityEntry["data"];
  implementation: SourceParityEntry["implementation"];
  availability(): NativeAvailability;
  run(input: unknown, binding: HostBinding, signal: AbortSignal): Promise<OwnerServiceReply>;
}

export class OwnerServices {
  private readonly operations = new Map<OwnerChannel, Operation>();
  private readonly listeners = new Set<{ binding: HostBinding; listener(event: OwnerServiceEvent): void | Promise<void>; remove(): void }>();
  private readonly disposers: (() => void)[] = [];
  private readonly active = new Set<Promise<OwnerServiceReply>>();
  private readonly lifecycle = new AbortController();
  private readonly auditIndex = new AuditIndex();
  private readonly staging = new ImportStaging();
  private fullDisk: FullDiskWatch | null = null;
  private readonly onboarding: Onboarding | null;
  private readonly connect: ConnectClient | null;
  private readonly cloud: CloudAgentState | null;
  private readonly connectors: Connectors | null;
  private attention: GatekeeperRecoveryView | null = null;
  private revision = 1;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly options: OwnerServicesOptions) {
    const account = options.account;
    this.onboarding = account ? new Onboarding({
      api: account.api, home: options.home, settings: options.settings, deviceName: account.deviceName,
      startRelay: () => account.startRelay(), wakePendingRevokes: () => account.wakePendingRevokes(),
      accessNeeded: async () => (await this.plugins()).grants.some((grant) => grant.status !== "met"),
      onChange: () => this.publish("onboarding:changed"), now: options.now,
    }) : null;
    this.connect = account ? new ConnectClient({
      api: account.api, home: options.home, settings: options.settings,
      isConnected: () => account.isConnected(), deviceUid: () => account.deviceUid(),
      onChange: () => this.publish("connect:changed"),
    }) : null;
    this.cloud = account ? new CloudAgentState({
      agents: new CloudAgentsClient(account.api), chats: new CloudChatsClient(account.api), providers: account.api,
      lines: new CloudLinesClient(account.api), home: options.home, settings: options.settings,
      agentIndex: account.agentIndex ?? fetchAgentIndex,
      onChange: () => this.publish("connect:changed"),
    }) : null;
    this.connectors = account ? new Connectors({
      api: account.api, credential: () => options.settings.load().relayCredential,
      openExternal: async (url) => {
        if (!options.openExternal || this.closed) throw new OwnerServiceError("cancelled");
        await options.openExternal(url, this.lifecycle.signal);
      },
      recordAudit: (event, fields) => this.audit?.record(event, fields),
      onChange: () => this.publish("connectors:changed"),
    }) : null;
    this.observeAudit();
    this.installLocal();
    this.installAccount();
    this.installDevice();
    this.installVault();
    this.installNative();
    this.installPresentation();
    if (options.native?.subscribe) this.disposers.push(options.native.subscribe((channel) => this.publish(channel)));
    if (options.presentation?.subscribe) this.disposers.push(options.presentation.subscribe((channel) => this.publish(channel)));
  }

  registry(binding: HostBinding): SourceParityEntry[] {
    this.requireOwner(binding);
    return OWNER_CHANNELS.map((channel) => {
      const operation = this.operations.get(channel);
      return {
        channel, family: SOURCE_FAMILIES[channel], access: operation?.access ?? this.unhandledAccess(channel),
        data: operation?.data ?? (SOURCE_FAMILIES[channel] === "vault" ? "protected_owner" : "owner"),
        implementation: operation?.implementation ?? (this.unhandledAccess(channel) === "owner_runtime" ? "owner_runtime" : "unavailable"),
        availability: operation?.availability() ?? this.unhandledAvailability(channel),
      };
    });
  }

  subscriptions(binding: HostBinding): { channel: OwnerEventChannel; availability: NativeAvailability }[] {
    this.requireOwner(binding);
    const availability = (channel: OwnerEventChannel): NativeAvailability => {
      if (channel === "audit:changed") return this.audit ? this.ready() : this.unavailable("audit_log_required");
      if (channel === "capabilities:changed" || channel === "gatekeeperRecovery:changed") return this.ready();
      if (channel === "rules:changed") return this.deviceReady();
      if (["status:changed", "onboarding:changed", "connect:changed", "connectors:changed"].includes(channel)) return this.options.account ? this.ready() : this.unavailable("plow_backend_adapter_required");
      if (channel === "vault:exchange") return this.unavailable("protected_credential_exchange_adapter_required");
      if (channel === "updates:changed" || channel === "fullDisk:dragEnd") return this.options.native?.subscribe ? this.ready() : this.unavailable("signed_native_host_events_required");
      if (["ui:showCapabilities", "ui:showAuditBlocked", "ui:showGatekeeperRecovery", "ui:showSettings", "ui:confirmLeave"].includes(channel)) return this.options.presentation?.subscribe ? this.ready() : this.unavailable("host_presentation_events_required");
      return this.unavailable("host_presentation_adapter_required");
    };
    return OWNER_EVENTS.map((channel) => ({
      channel,
      availability: availability(channel),
    }));
  }

  subscribe(binding: HostBinding, listener: (event: OwnerServiceEvent) => void | Promise<void>): () => void {
    this.requireOwner(binding);
    const remove = () => {
      binding.transport.signal.removeEventListener("abort", remove);
      this.listeners.delete(subscription);
    };
    const subscription = { binding, listener, remove };
    this.listeners.add(subscription);
    binding.transport.signal.addEventListener("abort", remove, { once: true });
    return remove;
  }

  query(binding: HostBinding, request: { channel: string; input?: unknown }, signal?: AbortSignal): Promise<OwnerServiceReply> {
    this.requireOwner(binding);
    const channel = this.parseChannel(request.channel);
    const operation = this.operations.get(channel);
    if (operation?.access !== "query") throw new OwnerServiceError("owner_approval_required");
    if (operation.data === "protected_owner") return Promise.resolve({ kind: "unavailable", channel, reason: "protected_owner_surface_required" });
    return this.dispatch(binding, channel, request.input ?? {}, signal ?? binding.transport.signal);
  }

  command(request: { channel: string; input?: unknown }, expectedRevision: number): OwnerCommand {
    const channel = this.parseChannel(request.channel);
    const input = request.input ?? {};
    if (channel === "settings:setApprovalMode") {
      const parsed = this.parse(z.object({ mode: z.enum(["approve", "adversarial", "ask", "deny"]) }).strict(), input);
      return CommandSchema.parse({ kind: "set_mode", mode: parsed.mode, expectedRevision });
    }
    if (channel === "settings:setAgentPurpose") {
      const parsed = this.parse(z.object({ purpose: z.string().max(16_384) }).strict(), input);
      return CommandSchema.parse({ kind: "set_purpose", purpose: parsed.purpose, expectedRevision });
    }
    if (channel === "rules:remove") {
      const parsed = this.parse(z.object({ key: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), input);
      return CommandSchema.parse({ kind: "revoke_rule", ruleKey: parsed.key, expectedRevision });
    }
    if (this.operations.get(channel)?.access !== "command" && this.operations.get(channel)?.data !== "protected_owner") throw new OwnerServiceError("owner_approval_required");
    if (needsProtectedInput(channel)) this.parse(protectedTicket, input);
    return CommandSchema.parse({ kind: "native_control", operation: channel, input, expectedRevision });
  }

  nativeAdapter(binding: HostBinding): NativeOwnerAdapter {
    this.requireOwner(binding);
    return {
      availability: (raw) => {
        try {
          this.requireOwner(binding);
          const channel = this.parseChannel(raw);
          const operation = this.operations.get(channel);
          return operation?.access === "command" || operation?.data === "protected_owner" ? operation.availability() : this.unhandledAvailability(channel);
        } catch (error) {
          return { kind: "unavailable", reason: error instanceof OwnerServiceError ? error.code : "owner_not_enrolled" };
        }
      },
      perform: async (command, signal) => {
        this.requireOwner(binding);
        const channel = this.parseChannel(command.operation);
        const operation = this.operations.get(channel);
        if (operation?.access !== "command" && operation?.data !== "protected_owner") return { kind: "unavailable", reason: "owner_controller_command_required" };
        const result = await this.dispatch(binding, channel, command.input, signal);
        if (result.kind === "value") return { kind: "applied" };
        if (result.kind === "outcome_unknown") return { kind: "outcome_unknown" };
        return { kind: "unavailable", reason: result.reason };
      },
    };
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.lifecycle.abort();
    const shuttingDown = [
      () => this.onboarding?.stop(),
      () => this.cloud?.signedOut(),
      () => this.connectors?.signedOut(),
      () => this.staging.cancel(null),
      () => this.connect?.signedOut(),
      ...this.disposers,
    ].map(async (dispose) => { await dispose(); });
    for (const subscription of this.listeners) subscription.remove();
    this.closing = (async () => {
      const results = await Promise.allSettled([...shuttingDown, ...this.active]);
      let failed = results.some((result) => result.status === "rejected");
      try { await this.options.native?.close?.(); }
      catch { failed = true; }
      if (failed) throw new OwnerServiceError("close_failed");
    })();
    return this.closing;
  }

  private get audit() { return this.options.audit ?? this.options.device?.audit; }

  private requireOwner(binding: HostBinding): void {
    if (this.closed) throw new OwnerServiceError("closed");
    const owner = requireBinding(binding, this.now());
    if (owner.enrollment.organizationId !== this.options.owner.organizationId || owner.enrollment.ownerId !== this.options.owner.ownerId) {
      throw new OwnerServiceError("wrong_owner");
    }
  }

  private parseChannel(raw: unknown): OwnerChannel {
    const result = ownerChannelSchema.safeParse(raw);
    if (!result.success) throw new OwnerServiceError("unknown_channel");
    return result.data;
  }

  private parse<T>(schema: z.ZodType<T>, raw: unknown): T {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new OwnerServiceError("invalid_input");
    return parsed.data;
  }

  private register<T>(channel: OwnerChannel, schema: z.ZodType<T>, access: Operation["access"], implementation: Operation["implementation"], availability: () => NativeAvailability, handler: (input: T, binding: HostBinding, signal: AbortSignal) => Promise<OwnerServiceReply> | OwnerServiceReply, data: Operation["data"] = SOURCE_FAMILIES[channel] === "vault" ? "protected_owner" : "owner"): void {
    this.operations.set(channel, {
      access, implementation, data,
      availability: () => {
        try { return availability(); }
        catch (error) { return this.unavailable(error instanceof OwnerServiceError ? error.code : "adapter_availability_failed"); }
      },
      run: async (input, binding, signal) => {
        if (needsProtectedInput(channel)) {
          const envelope = this.parse(protectedTicket, input);
          if (!this.options.protectedInput) throw new OwnerServiceError("invalid_input");
          input = await this.options.protectedInput.consume(binding, channel, envelope.protectedInputTicket, signal);
          this.requireOwner(binding);
          if (signal.aborted) throw new OwnerServiceError("cancelled");
        }
        return handler(this.parse(schema, input), binding, signal);
      },
    });
  }

  private dispatch(binding: HostBinding, channel: OwnerChannel, input: unknown, signal: AbortSignal): Promise<OwnerServiceReply> {
    const operation = this.operations.get(channel);
    if (!operation) return Promise.resolve({ kind: "unavailable", channel, reason: "adapter_required" });
    const flight = (async (): Promise<OwnerServiceReply> => {
      this.requireOwner(binding);
      if (signal.aborted) throw new OwnerServiceError("cancelled");
      const availability = operation.availability();
      if (availability.kind === "unavailable") return { kind: "unavailable", channel, reason: availability.reason };
      try {
        const result = await operation.run(input, binding, AbortSignal.any([signal, binding.transport.signal, this.lifecycle.signal]));
        if (signal.aborted || binding.transport.signal.aborted || this.closed) return { kind: "outcome_unknown", channel };
        this.requireOwner(binding);
        return result;
      } catch (error) {
        if (signal.aborted || binding.transport.signal.aborted || this.closed) return { kind: "outcome_unknown", channel };
        if (error instanceof OwnerServiceError) return { kind: "failed", channel, reason: error.code };
        return operation.access === "command" ? { kind: "outcome_unknown", channel } : { kind: "failed", channel, reason: "service_read_failed" };
      }
    })();
    this.active.add(flight);
    void flight.then(() => this.active.delete(flight), () => this.active.delete(flight));
    return flight;
  }

  private value(channel: OwnerChannel, raw: unknown): OwnerServiceReply {
    const encoded = JSON.stringify(raw ?? null);
    if (Buffer.byteLength(encoded) > 1_048_576) return { kind: "failed", channel, reason: "owner_result_too_large" };
    return { kind: "value", channel, value: z.json().parse(JSON.parse(encoded)) };
  }

  private ready(): NativeAvailability { return { kind: "ready" }; }
  private unavailable(reason: string): NativeAvailability { return { kind: "unavailable", reason }; }

  private accountReady(credential = true): NativeAvailability {
    if (!this.options.account) return this.unavailable("plow_backend_adapter_required");
    const availability = this.options.account.availability?.() ?? this.ready();
    if (availability.kind === "unavailable") return availability;
    const secret = this.options.settings.secretAvailability();
    if (secret.kind === "unavailable") return secret;
    if (credential && !this.options.settings.load().relayCredential.trim()) return this.unavailable("plow_sign_in_required");
    return this.ready();
  }

  private deviceReady(): NativeAvailability { return this.options.device ? this.ready() : this.unavailable("local_device_runtime_required"); }

  private withPort(base: NativeAvailability, present: boolean, reason: string): NativeAvailability {
    return base.kind === "unavailable" ? base : present ? this.ready() : this.unavailable(reason);
  }

  private accountAction(controller: "onboarding" | "connect" | "connectors", credential = true): NativeAvailability {
    const ready = this.accountReady(credential);
    if (ready.kind === "unavailable") return ready;
    const busy = controller === "onboarding" ? this.onboarding?.state().busy : controller === "connect" ? this.connect?.state().busy : this.connectors?.state().busy;
    return busy ? this.unavailable("owner_action_in_progress") : this.ready();
  }
  private vaultReady(protectedSurface = false, inputChannel?: ProtectedInputChannel): NativeAvailability {
    if (!this.options.vault) return this.unavailable("protected_native_vault_adapter_required");
    const availability = this.options.vault.availability();
    if (availability.kind === "unavailable") return availability;
    if (protectedSurface && !this.options.protectedSurface) return this.unavailable("protected_owner_surface_required");
    if (inputChannel) return this.options.protectedInput?.availability(inputChannel) ?? this.unavailable("protected_owner_input_required");
    return this.ready();
  }

  private unhandledAccess(channel: OwnerChannel): SourceParityEntry["access"] {
    if (SOURCE_FAMILIES[channel] === "policy" || ["settings:setApprovalMode", "settings:setAgentPurpose"].includes(channel)) return "owner_runtime";
    return "host_presentation";
  }

  private unhandledAvailability(channel: OwnerChannel): NativeAvailability {
    return this.unavailable(this.unhandledAccess(channel) === "owner_runtime" ? "owner_controller_command_required" : "host_presentation_adapter_required");
  }

  private publish(channel: OwnerEventChannel, ids?: readonly string[]): void {
    if (this.closed) return;
    const event: OwnerServiceEvent = { channel, revision: ++this.revision, ...(ids ? { ids: [...ids] } : {}) };
    for (const subscription of this.listeners) {
      try {
        this.requireOwner(subscription.binding);
        void Promise.resolve(subscription.listener(event)).catch(() => {});
      } catch {
        subscription.remove();
      }
    }
  }

  private observeAudit(): void {
    if (!this.audit) return;
    this.auditIndex.reset(this.audit.entries());
    const recorded = (raw: unknown) => {
      const parsed = z.object({ entry: z.json() }).passthrough().safeParse(raw);
      if (!parsed.success) return;
      const ids = this.auditIndex.add(parsed.data.entry);
      const entry = jv(parsed.data.entry);
      if (entry.get("event").str === "intent_decision" && entry.get("decision").str === "deny" && entry.get("source").str === "adversarial") {
        const activity = this.auditIndex.activities().find((row) => row.intentId === entry.get("intentId").str);
        if (activity?.intentId) {
          this.attention = { intentId: activity.intentId, request: activity.title };
          this.publish("gatekeeperRecovery:changed");
        }
      }
      this.publish("audit:changed", ids);
      this.publish("capabilities:changed");
    };
    const reset = () => { this.auditIndex.reset(this.audit?.entries() ?? []); this.publish("audit:changed", []); };
    this.audit.events.on("recorded", recorded);
    this.audit.events.on("reset", reset);
    this.disposers.push(() => { this.audit?.events.off("recorded", recorded); this.audit?.events.off("reset", reset); });
    if (this.options.device) {
      const changed = () => this.publish("rules:changed");
      this.options.device.policy.events.on("stored", changed);
      this.options.device.policy.events.on("revoked", changed);
      this.disposers.push(() => { this.options.device?.policy.events.off("stored", changed); this.options.device?.policy.events.off("revoked", changed); });
    }
  }

  private installLocal(): void {
    this.register("audit:page", auditQuery, "query", "maintained_controller", () => this.audit ? this.ready() : this.unavailable("audit_log_required"), (input) => this.value("audit:page", this.auditIndex.page(input)));
    this.register("audit:activity", z.object({ id: text }).strict(), "query", "maintained_controller", () => this.audit ? this.ready() : this.unavailable("audit_log_required"), ({ id }) => this.value("audit:activity", this.auditIndex.get(id)));
    this.register("audit:clear", empty, "command", "device_core", () => this.audit ? this.ready() : this.unavailable("audit_log_required"), () => {
      this.audit?.clear(); this.attention = null; this.publish("gatekeeperRecovery:changed");
      return this.value("audit:clear", true);
    });
    this.register("gatekeeperRecovery:get", empty, "query", "maintained_controller", () => this.ready(), () => this.value("gatekeeperRecovery:get", this.attention));
    this.register("gatekeeperRecovery:dismiss", z.object({ intentId: text }).strict(), "command", "maintained_controller", () => this.ready(), ({ intentId }) => {
      this.attention = dismissGatekeeperAttention(this.attention, intentId); this.publish("gatekeeperRecovery:changed");
      return this.value("gatekeeperRecovery:dismiss", this.attention);
    });
    this.register("settings:getAgentPurpose", empty, "query", "local_settings", () => this.ready(), () => this.value("settings:getAgentPurpose", this.options.settings.load().agentPurpose));
    this.register("settings:getInference", empty, "query", "maintained_controller", () => this.ready(), () => this.value("settings:getInference", inferenceStatus(this.options.settings.load())));
    this.register("settings:getRelay", empty, "query", "local_settings", () => this.ready(), () => {
      const settings = this.options.settings.load();
      return this.value("settings:getRelay", { apiBaseUrl: this.options.account?.apiBaseUrl ?? null, accountUid: settings.accountUid, mcpUrl: settings.mcpUrl, hasCredential: !!settings.relayCredential.trim(), secretStore: this.options.settings.secretAvailability(), connected: this.options.account?.isConnected() ?? false });
    });
    this.register("ui:getTab", empty, "query", "local_settings", () => this.ready(), () => {
      const stored = this.options.settings.load().selectedTab;
      return this.value("ui:getTab", stored === "connect" ? "agents" : stored === "capabilities" ? "plugins" : stored === "rules" ? "audit" : stored);
    });
    this.register("ui:setTab", z.object({ tab: z.enum(["agents", "plugins", "audit", "vault", "settings"]) }).strict(), "command", "local_settings", () => this.ready(), ({ tab }) => {
      this.options.settings.save({ ...this.options.settings.load(), selectedTab: tab });
      return this.value("ui:setTab", tab);
    });
    this.register("onboarding:gatekeeperPresets", empty, "query", "maintained_controller", () => this.ready(), () => this.value("onboarding:gatekeeperPresets", gatekeeperPresets()));
    this.register("telemetry:get", empty, "query", "local_settings", () => this.ready(), () => this.value("telemetry:get", { enabled: this.options.settings.load().telemetryEnabled }));
    this.register("telemetry:set", boolean, "command", "local_settings", () => this.ready(), ({ on }) => {
      this.options.settings.save({ ...this.options.settings.load(), telemetryEnabled: on });
      return this.value("telemetry:set", { enabled: this.options.settings.load().telemetryEnabled });
    });
    for (const channel of ["updates:setAutoCheck", "updates:setAutoInstall"] as const) {
      this.register(channel, boolean, "command", "local_settings", () => this.ready(), ({ on }) => {
        const settings = this.options.settings.load();
        if (channel === "updates:setAutoCheck") settings.autoCheckUpdates = on;
        else settings.autoInstallUpdates = on;
        this.options.settings.save(settings);
        return this.value(channel, { autoCheck: settings.autoCheckUpdates, autoInstall: settings.autoInstallUpdates });
      });
    }
  }

  private installAccount(): void {
    this.register("onboarding:get", empty, "query", "maintained_controller", () => this.withPort(this.onboarding ? this.ready() : this.unavailable("plow_backend_adapter_required"), !!this.options.protectedSurface, "protected_owner_surface_required"), (_input, binding, signal) => this.showProtected("onboarding:get", binding, signal, this.onboarding?.state()), "protected_owner");
    for (const channel of ["onboarding:begin", "onboarding:newCode"] as const) {
      this.register(channel, empty, "command", "maintained_controller", () => this.withPort(this.accountAction("onboarding", false), !!this.options.protectedSurface, "protected_owner_surface_required"), async (_input, binding, signal) => {
        const state = channel === "onboarding:begin" ? await this.onboarding?.begin() : await this.onboarding?.newActivationCode();
        return state?.message && state.noteKind === "error" ? { kind: "failed", channel, reason: "onboarding_action_failed" } : this.showProtected(channel, binding, signal, state);
      }, "protected_owner");
    }
    for (const channel of ["onboarding:advance", "onboarding:back"] as const) {
      this.register(channel, optionalDraft, "command", "maintained_controller", () => this.withPort(this.accountAction("onboarding", false), !!this.options.protectedSurface, "protected_owner_surface_required"), async ({ draft }, binding, signal) => {
        const state = channel === "onboarding:advance" ? await this.onboarding?.advance(draft) : await this.onboarding?.back(draft);
        return state?.message && state.noteKind === "error" ? { kind: "failed", channel, reason: "onboarding_action_failed" } : this.showProtected(channel, binding, signal, state);
      }, "protected_owner");
    }
    this.register("onboarding:setTelemetry", boolean, "command", "maintained_controller", () => this.onboarding ? this.ready() : this.unavailable("plow_backend_adapter_required"), ({ on }) => this.value("onboarding:setTelemetry", { telemetryEnabled: this.onboarding?.setTelemetryEnabled(on).telemetryEnabled }));
    this.register("onboarding:openMessages", empty, "command", "maintained_controller", () => this.withPort(this.accountAction("onboarding", false), !!this.options.openExternal, "native_link_opener_required"), async (_input, _binding, signal) => {
      const url = this.onboarding?.state().activation?.smsUrl;
      if (!url?.startsWith("sms:")) return { kind: "failed", channel: "onboarding:openMessages", reason: "activation_not_pending" };
      await this.options.openExternal?.(url, signal);
      this.onboarding?.messagesOpened();
      return this.value("onboarding:openMessages", true);
    }, "protected_owner");
    this.register("onboarding:gatekeeperPreview", z.object({ preset: z.enum(["home", "work"]), index: z.number().int().min(0).max(4), draft: z.string().max(16_384) }).strict(), "query", "maintained_controller", () => this.withPort(this.accountReady(), !!this.options.review, "plow_reviewer_adapter_required"), async ({ preset, index, draft }) => {
      if (!this.options.review || !this.options.account) return { kind: "unavailable", channel: "onboarding:gatekeeperPreview", reason: "plow_reviewer_adapter_required" };
      return this.value("onboarding:gatekeeperPreview", await previewRow(preset, index, draft, { review: this.options.review, settings: this.options.settings.load(), apiBaseUrl: this.options.account.apiBaseUrl }));
    });
    this.register("gatekeeperRecovery:suggest", z.object({ activityId: text }).strict(), "query", "maintained_controller", () => this.accountReady(), async ({ activityId }) => {
      const activity = this.auditIndex.get(activityId);
      if (!activity || activity.decisionKind !== "denied" || activity.decisionSource !== "adversarial" || !this.options.account) return { kind: "failed", channel: "gatekeeperRecovery:suggest", reason: "denied_activity_unavailable" };
      const settings = this.options.settings.load();
      return this.value("gatekeeperRecovery:suggest", await suggestGatekeeperRevision({ currentPurpose: settings.agentPurpose, deniedRequest: activity.title, capabilities: activity.capabilities, plowCredential: settings.relayCredential, apiBaseUrl: this.options.account.apiBaseUrl }));
    });
    this.register("connect:get", empty, "query", "maintained_controller", () => this.connect ? this.ready() : this.unavailable("plow_backend_adapter_required"), () => this.value("connect:get", this.agentsState()));
    for (const channel of ["cloud:refresh", "cloud:agents"] as const) {
      this.register(channel, empty, "query", "maintained_controller", () => this.accountReady(), async () => {
        await this.cloud?.refresh();
        return this.value(channel, channel === "cloud:agents" ? { cloudAgents: this.cloud?.state().cloudAgents, cloudAgentsError: this.cloud?.state().cloudAgentsError } : this.agentsState());
      });
    }
    this.register("connect:create", z.object({ name: text }).strict(), "command", "maintained_controller", () => this.withPort(this.accountAction("connect"), !!this.options.protectedSurface, "protected_owner_surface_required"), async ({ name }, binding, signal) => {
      const state = await this.connect?.createCredential(name);
      if (!state?.credential || !this.options.protectedSurface) return { kind: "failed", channel: "connect:create", reason: "client_credential_not_created" };
      const delivered = await this.showProtected("connect:create", binding, signal, { kind: "client_credential", credential: state.credential });
      if (delivered.kind !== "value") return delivered;
      await this.connect?.refreshRoster();
      return this.value("connect:create", this.agentsState());
    }, "protected_owner");
    this.register("connect:dismiss", empty, "command", "maintained_controller", () => this.connect ? this.ready() : this.unavailable("plow_backend_adapter_required"), () => { this.connect?.dismissCredential(); return this.value("connect:dismiss", this.agentsState()); });
    this.register("roster:remove", z.object({ id: z.number().int().positive() }).strict(), "command", "maintained_controller", () => this.accountAction("connect"), async ({ id }) => {
      const state = await this.connect?.removeRosterRow(id);
      return state?.actionError ? { kind: "outcome_unknown", channel: "roster:remove" } : this.value("roster:remove", this.agentsState());
    });
    this.register("cloud:remove", z.object({ agentId: text }).strict(), "command", "maintained_controller", () => this.accountReady(), async ({ agentId }) => {
      await this.cloud?.remove(agentId);
      return this.cloud?.state().cloudActionError ? { kind: "outcome_unknown", channel: "cloud:remove" } : this.value("cloud:remove", this.agentsState());
    });
    this.register("cloud:changeLine", z.object({ agentId: text, lineUid: text }).strict(), "command", "maintained_controller", () => this.accountReady(), async (input) => {
      const result = await this.cloud?.changeLine(input);
      await this.cloud?.refresh();
      return result ? this.value("cloud:changeLine", this.agentsState()) : { kind: "outcome_unknown", channel: "cloud:changeLine" };
    });
    this.register("cloud:awaitNewAgent", z.object({ providerId: text }).strict(), "query", "maintained_controller", () => this.accountReady(), async ({ providerId }) => this.value("cloud:awaitNewAgent", await this.cloud?.awaitNewAgent(providerId)));
    this.register("cloud:newAgentMessages", z.object({ providerId: text }).strict(), "command", "maintained_controller", () => this.withPort(this.accountReady(), !!this.options.openExternal, "native_link_opener_required"), async ({ providerId }, _binding, signal) => this.openSms("cloud:newAgentMessages", this.cloud?.newAgentSmsUrl(providerId), signal));
    this.register("cloud:openMessages", z.object({ agentId: text, draft: z.string().max(16_384).optional() }).strict(), "command", "maintained_controller", () => this.withPort(this.accountReady(), !!this.options.openExternal, "native_link_opener_required"), async ({ agentId, draft }, _binding, signal) => this.openSms("cloud:openMessages", this.cloud?.agentSmsUrl(agentId, draft), signal));
    this.register("external:open", z.object({ key: z.enum(["account", "claude", "discord", "website"]) }).strict(), "command", "injected_adapter", () => this.options.openExternal ? this.ready() : this.unavailable("native_link_opener_required"), async ({ key }, _binding, signal) => {
      const urls = { account: this.options.account ? `${this.options.account.apiBaseUrl}/app/` : null, claude: "https://claude.ai/new?modal=add-custom-connector#settings/customize-connectors", discord: "https://watchmepivot.com/discord", website: "https://watchmepivot.com/" };
      const url = urls[key];
      if (!url) return { kind: "unavailable", channel: "external:open", reason: "plow_backend_adapter_required" };
      await this.options.openExternal?.(url, signal);
      return this.value("external:open", true);
    });
    this.register("settings:signOut", empty, "command", "maintained_controller", () => this.ready(), async () => {
      this.options.settings.signOut(); this.resetAccountViews();
      this.options.account?.wakePendingRevokes(); await this.options.account?.stopRelay(); this.publish("status:changed");
      return this.value("settings:signOut", true);
    });
    this.register("connectors:refresh", empty, "query", "maintained_controller", () => this.accountReady(), async () => this.value("connectors:refresh", await this.connectors?.refresh()));
    this.register("connectors:connect", empty, "command", "maintained_controller", () => this.withPort(this.accountAction("connectors"), !!this.options.openExternal, "native_link_opener_required"), async () => this.connectorOutcome("connectors:connect", await this.connectors?.connect()));
    for (const channel of ["connectors:disconnect", "connectors:setDefault"] as const) {
      this.register(channel, z.object({ account: text }).strict(), "command", "maintained_controller", () => this.accountAction("connectors"), async ({ account }) => this.connectorOutcome(channel, channel === "connectors:disconnect" ? await this.connectors?.disconnect(account) : await this.connectors?.setDefault(account)));
    }
  }

  private installDevice(): void {
    this.register("status:get", empty, "query", "device_core", () => this.deviceReady(), () => this.value("status:get", { deviceId: this.options.device?.identity.deviceId, name: this.options.device?.identity.name, connected: this.options.account?.isConnected() ?? false }));
    this.register("approvals:pending", empty, "query", "device_core", () => this.options.approvals ? this.ready() : this.unavailable("approval_runtime_required"), async () => this.value("approvals:pending", await this.options.approvals?.pending()));
    this.register("rules:list", empty, "query", "device_core", () => this.deviceReady(), () => this.value("rules:list", this.options.device?.policy.allRules()));
    this.register("viewer:state", empty, "query", "device_core", () => this.options.device?.browserSessions ? this.ready() : this.unavailable("staged_browser_runtime_required"), async () => {
      const session = this.options.device?.browserSessions?.current() ?? null;
      const frame = session ? await this.options.device?.browserViewFrame() : null;
      return this.value("viewer:state", { active: session !== null, origins: session?.origins ?? [], inScope: session?.inScope ?? true, url: frame?.url ?? session?.lastUrl ?? "", frame: frame ? { dataB64: frame.dataB64, mime: frame.mime } : null });
    });
    this.register("capabilities:get", empty, "query", "maintained_controller", () => this.deviceReady(), async () => this.value("capabilities:get", await this.capabilities()));
    this.register("capabilities:dismiss", z.object({ key: text }).strict(), "command", "local_settings", () => this.ready(), async ({ key }) => {
      const settings = this.options.settings.load();
      this.options.settings.save({ ...settings, capabilityDismissals: { ...(settings.capabilityDismissals ?? {}), [key]: new Date(this.now()).toISOString() } });
      this.publish("capabilities:changed"); return this.value("capabilities:dismiss", true);
    });
    this.register("capabilities:bannerSeen", empty, "command", "local_settings", () => this.ready(), () => {
      this.options.settings.save({ ...this.options.settings.load(), blockedBannerSeenAt: new Date(this.now()).toISOString() });
      this.publish("capabilities:changed"); return this.value("capabilities:bannerSeen", true);
    });
    this.register("plugins:get", empty, "query", "maintained_controller", () => this.deviceReady(), async () => this.value("plugins:get", await this.plugins()));
    this.register("plugins:acknowledge", empty, "command", "local_settings", () => this.deviceReady(), async () => {
      const { fullDisk } = await this.capabilities();
      this.options.settings.save({ ...this.options.settings.load(), fullDiskGrantedSeen: fullDisk === "granted" });
      return this.value("plugins:acknowledge", true);
    });
    this.register("plugins:setEnabled", z.object({ name: text, on: z.boolean() }).strict(), "command", "device_core", () => this.deviceReady(), async ({ name, on }) => {
      if (name !== BROWSER_PLUGIN && !this.options.stagedPlugins?.some((plugin) => plugin.manifest.name === name)) return { kind: "failed", channel: "plugins:setEnabled", reason: "plugin_not_staged" };
      const settings = this.options.settings.load(); const disabled = new Set(settings.disabledPlugins ?? []);
      if (on) disabled.delete(name); else disabled.add(name);
      this.options.settings.save({ ...settings, disabledPlugins: [...disabled] });
      await this.options.device?.setDisabledPlugins([...disabled]);
      this.publish("capabilities:changed"); return this.value("plugins:setEnabled", { disabledPlugins: [...disabled] });
    });
  }

  private installVault(): void {
    this.register("vault:items", empty, "query", "device_core", () => this.vaultReady(true), async (_input, binding, signal) => this.showProtected("vault:items", binding, signal, await this.options.vault?.client.list()), "protected_owner");
    this.register("vault:exchangePending", empty, "query", "unavailable", () => this.unavailable("protected_credential_exchange_adapter_required"), () => ({ kind: "unavailable", channel: "vault:exchangePending", reason: "protected_credential_exchange_adapter_required" }), "protected_owner");
    this.register("vault:search", z.object({ query: z.string().max(8_192) }).strict(), "query", "device_core", () => this.vaultReady(true), async ({ query }, binding, signal) => this.showProtected("vault:search", binding, signal, await this.options.vault?.client.search(query)), "protected_owner");
    this.register("vault:item", z.object({ itemId: text }).strict(), "query", "device_core", () => this.vaultReady(true), async ({ itemId }, binding, signal) => this.showProtected("vault:item", binding, signal, await this.options.vault?.client.read(itemId)), "protected_owner");
    this.register("vault:reveal", z.object({ itemId: text, field: text }).strict(), "command", "device_core", () => this.vaultReady(true), async ({ itemId, field }, binding, signal) => this.showProtected("vault:reveal", binding, signal, { itemId, field, value: await this.options.vault?.client.reveal(itemId, field) }));
    this.register("vault:totp", z.object({ itemId: text.nullable(), key: z.string().max(8_192).optional() }).strict(), "command", "device_core", () => this.vaultReady(true, "vault:totp"), async ({ itemId, key }, binding, signal) => {
      const code = key?.trim() ? totpCode(key) : itemId ? await this.options.vault?.client.totp(itemId) : null;
      if (!code) return { kind: "failed", channel: "vault:totp", reason: "vault_item_required" };
      return this.showProtected("vault:totp", binding, signal, code);
    });
    this.register("vault:deleteItem", z.object({ itemId: text }).strict(), "command", "device_core", () => this.vaultReady(), async ({ itemId }) => { await this.options.vault?.client.remove(itemId); return this.value("vault:deleteItem", true); });
    this.register("vault:saveItem", vaultItem, "command", "device_core", () => this.vaultReady(false, "vault:saveItem"), async (input) => this.value("vault:saveItem", await this.options.vault?.client.save(input)));
    this.register("vault:importInspect", z.object({ text: z.string().max(1_048_576) }).strict(), "command", "maintained_controller", () => this.vaultReady(true, "vault:importInspect"), async ({ text }, binding, signal) => {
      const epoch = this.staging.epoch; const parsed = parsePasswordExport(text);
      if (this.options.vault && importPreview(parsed).vaults.length <= 1) await markAgainstVault(this.options.vault.client, parsed.logins);
      return this.showProtected("vault:importInspect", binding, signal, this.staging.stageSheet(epoch, parsed));
    });
    this.register("vault:importFile", empty, "command", "maintained_controller", () => this.withPort(this.vaultReady(true), !!this.options.vault?.importFile, "native_file_picker_required"), async (_input, binding, signal) => {
      const epoch = this.staging.epoch; const parsed = await this.options.vault?.importFile?.(signal);
      if (!parsed) return this.value("vault:importFile", null);
      if (this.options.vault && importPreview(parsed).vaults.length <= 1) await markAgainstVault(this.options.vault.client, parsed.logins);
      return this.showProtected("vault:importFile", binding, signal, this.staging.stageSheet(epoch, parsed));
    });
    this.register("vault:importPick", z.object({ vaultIds: z.array(text).max(1_000), ticket }).strict(), "command", "maintained_controller", () => this.vaultReady(true), async ({ vaultIds, ticket }, binding, signal) => {
      const parsed = this.staging.take(ticket); const epoch = this.staging.epoch;
      const subset = { source: parsed.source, logins: parsed.logins.filter((row) => row.vault && vaultIds.includes(row.vault.id)), skipped: parsed.skipped.filter((row) => row.vault && vaultIds.includes(row.vault.id)) };
      if (this.options.vault) await markAgainstVault(this.options.vault.client, subset.logins);
      return this.showProtected("vault:importPick", binding, signal, this.staging.stageSheet(epoch, subset));
    });
    this.register("vault:importCommit", z.object({ selected: z.array(z.number().int().nonnegative()).max(10_000).optional(), ticket }).strict(), "command", "maintained_controller", () => this.vaultReady(), async ({ selected, ticket }) => {
      const parsed = this.staging.take(ticket);
      if (!this.options.vault) return { kind: "unavailable", channel: "vault:importCommit", reason: "protected_native_vault_adapter_required" };
      return this.value("vault:importCommit", await importLogins(this.options.vault.client, parsed.logins.filter((_row, index) => selected === undefined || selected.includes(index))));
    });
    this.register("vault:importCancel", z.object({ ticket: z.number().int().positive().nullable().optional() }).strict(), "command", "maintained_controller", () => this.ready(), ({ ticket }) => { this.staging.cancel(ticket ?? null); return this.value("vault:importCancel", true); });
    this.register("vault:importSources", empty, "query", "injected_adapter", () => this.options.vault?.importSources ? this.ready() : this.unavailable("native_import_sources_adapter_required"), async () => this.value("vault:importSources", await this.options.vault?.importSources?.()));
  }

  private installNative(): void {
    const queries: readonly NativeHostChannel[] = ["grant:state", "fullDisk:dragInfo", "launch:get", "power:getKeepAwake", "updates:get"];
    const commands: readonly NativeHostChannel[] = ["capabilities:act", "requirements:act", "app:relaunch", "fullDisk:tileImage", "fullDisk:dragStart", "fullDisk:panelHold", "fullDisk:panelHeight", "fullDisk:dismiss", "launch:set", "power:setKeepAwake", "updates:check", "updates:restart", "updates:dismiss"];
    for (const channel of [...queries, ...commands]) {
      this.register<JSONValue>(channel, nativeSchemas[channel], queries.includes(channel) ? "query" : "command", "injected_adapter", () => this.options.native?.availability(channel) ?? this.unavailable("signed_native_host_adapter_required"), async (input, _binding, signal) => {
        if (!this.options.native) return { kind: "unavailable", channel, reason: "signed_native_host_adapter_required" };
        const result = await this.options.native.call(channel, input, signal);
        if (result.channel !== channel) return { kind: "failed", channel, reason: "native_response_mismatch" };
        return result.kind === "value" ? this.value(channel, result.value) : result;
      });
    }
  }

  private installPresentation(): void {
    for (const channel of ["onboarding:open", "onboarding:finish", "ui:confirmLeaveReply"] as const) {
      this.register<JSONValue>(channel, presentationSchemas[channel], "command", "injected_adapter", () => this.options.presentation?.availability(channel) ?? this.unavailable("host_presentation_adapter_required"), async (input, _binding, signal) => {
        if (!this.options.presentation) return { kind: "unavailable", channel, reason: "host_presentation_adapter_required" };
        const result = await this.options.presentation.call(channel, input, signal);
        if (result.channel !== channel) return { kind: "failed", channel, reason: "presentation_response_mismatch" };
        return result.kind === "value" ? this.value(channel, result.value) : result;
      }, channel.startsWith("onboarding:") ? "protected_owner" : "owner");
    }
  }

  private async capabilities() {
    const inventory = await this.options.device?.hostInventory() ?? null;
    const settings = this.options.settings.load();
    if (inventory && !this.fullDisk) this.fullDisk = new FullDiskWatch(inventory.full_disk_access.granted);
    const fullDisk = inventory ? this.fullDisk?.observe(inventory.full_disk_access.granted, inventory.child_attribution.status === "ok") : undefined;
    const view = capabilitiesView({
      inventory, fullDisk, events: this.auditIndex.events(), dismissals: settings.capabilityDismissals ?? {},
      bannerSeenAt: settings.blockedBannerSeenAt ?? null,
      folders: { files_desktop: settings.folderConsent?.files_desktop, files_documents: settings.folderConsent?.files_documents, files_downloads: settings.folderConsent?.files_downloads },
      foldersAt: { files_desktop: settings.folderConsentAt?.files_desktop, files_documents: settings.folderConsentAt?.files_documents, files_downloads: settings.folderConsentAt?.files_downloads },
      automation: AUTOMATION_APPS.map((app) => ({ app, status: inventory?.automation.find((row) => row.target === app.name)?.status ?? "unknown" })),
      canRequestInProcess: this.options.device?.hostProbes.canRequestInProcess() ?? false,
    });
    return { inventory, view, fullDisk, fullDiskAccess: inventory?.full_disk_access.granted ?? null, icons: {} };
  }

  private async plugins() {
    const disabled = new Set(this.options.settings.load().disabledPlugins ?? []);
    const { inventory, view, fullDisk } = await this.capabilities();
    const grantedPermissions = view.sections.flatMap((section) => section.rows).filter((row) => row.status === "granted").map((row) => row.key);
    const relaunchPending = fullDisk === "relaunch" ? ["full_disk_access"] : [];
    const connectorState = this.connectors?.state();
    const rows = pluginRows({
      plugins: (this.options.stagedPlugins ?? []).map(({ manifest, description }) => ({ manifest, description, enabled: !disabled.has(manifest.name) })),
      connectedAccounts: connectorState?.google.accounts.length ? ["google"] : [],
      accountNotices: connectorState?.message ? { google: { message: connectorState.message, noteKind: connectorState.noteKind } } : {},
      grantedPermissions, relaunchPending,
    });
    rows.push(browserPluginRow({ enabled: !disabled.has(BROWSER_PLUGIN), runtimePresent: this.options.device?.browserSessions !== null && this.options.device?.browserSessions !== undefined, safariJavaScript: await this.options.safariJavaScriptEnabled?.() ?? false, fullDiskAccess: grantedPermissions.includes("full_disk_access"), relaunchPending, description: this.options.device?.skills.skill(BROWSING_SKILL.name)?.description ?? BROWSING_SKILL.description }));
    return { rows, grants: grantList(rows), examples: pluginExamples(rows), landed: fullDiskLanded(fullDisk, this.options.settings.load().fullDiskGrantedSeen) ? ["full_disk_access"] : [], inventory };
  }

  private agentsState() {
    const state = this.connect?.state();
    return state ? { ...state, credential: null, credentialAvailable: state.credential !== null, ...this.cloud?.state() } : null;
  }

  private connectorOutcome(channel: OwnerChannel, state: ReturnType<Connectors["state"]> | undefined): OwnerServiceReply {
    return state?.noteKind === "error" && state.message ? { kind: "outcome_unknown", channel } : this.value(channel, state);
  }

  private resetAccountViews(): void { this.onboarding?.reset(); this.connect?.signedOut(); this.cloud?.signedOut(); this.connectors?.signedOut(); this.staging.cancel(null); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private json(value: unknown): JSONValue { return z.json().parse(JSON.parse(JSON.stringify(value))); }

  private async openSms(channel: OwnerChannel, url: string | null | undefined, signal: AbortSignal): Promise<OwnerServiceReply> {
    if (!url?.startsWith("sms:") || !this.options.openExternal) return { kind: "failed", channel, reason: "messages_target_unavailable" };
    await this.options.openExternal(url, signal); return this.value(channel, true);
  }

  private async showProtected(channel: OwnerChannel, binding: HostBinding, signal: AbortSignal, payload: unknown): Promise<OwnerServiceReply> {
    if (!this.options.protectedSurface) return { kind: "unavailable", channel, reason: "protected_owner_surface_required" };
    this.requireOwner(binding);
    if (signal.aborted) throw new OwnerServiceError("cancelled");
    const delivery = await this.options.protectedSurface.show(binding, this.json(payload), signal);
    if (signal.aborted || binding.transport.signal.aborted || this.closed) return { kind: "outcome_unknown", channel };
    this.requireOwner(binding);
    const parsed = z.object({ deliveryRef: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/) }).strict().safeParse(delivery);
    return parsed.success ? this.value(channel, parsed.data) : { kind: "outcome_unknown", channel };
  }
}
