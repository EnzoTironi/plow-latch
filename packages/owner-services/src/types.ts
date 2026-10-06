import type { ApprovalStore, AuditLog, DeviceAgent, LocalVault, ParsedImport, PluginManifest } from "@domo/device-core";
import type { PlowApi } from "@domo/owner-core/plowApi";
import type { HostBinding, NativeAvailability } from "@domo/owner-runtime";
import type { JSONValue } from "@domo/protocol";
import type { ReviewArgs } from "@domo/owner-core/adversarialAgent";
import type { PreviewResult } from "./maintained/gatekeeperPreview.js";
import type { AgentIndex } from "./maintained/agentIndex.js";
import type { OwnerChannel, OwnerEventChannel } from "./channels.js";
import type { StrictSettingsStore } from "./strictSettingsStore.js";

export type OwnerServiceReply =
  | { kind: "value"; channel: OwnerChannel; value: JSONValue }
  | { kind: "unavailable"; channel: OwnerChannel; reason: string }
  | { kind: "failed"; channel: OwnerChannel; reason: string }
  | { kind: "outcome_unknown"; channel: OwnerChannel };

export interface SourceParityEntry {
  channel: OwnerChannel;
  family: string;
  access: "query" | "command" | "owner_runtime" | "host_presentation";
  data: "owner" | "protected_owner";
  implementation: "maintained_controller" | "device_core" | "local_settings" | "injected_adapter" | "owner_runtime" | "unavailable";
  availability: NativeAvailability;
}

export interface OwnerServiceEvent {
  channel: OwnerEventChannel;
  revision: number;
  ids?: readonly string[];
}

export interface AccountAdapter {
  api: PlowApi;
  apiBaseUrl: string;
  deviceName: string;
  isConnected(): boolean;
  deviceUid(): string | null;
  startRelay(): Promise<void>;
  stopRelay(): Promise<void>;
  wakePendingRevokes(): void;
  availability?(): NativeAvailability;
  agentIndex?(): Promise<AgentIndex>;
}

export interface ProtectedOwnerSurface {
  show(binding: HostBinding, payload: JSONValue, signal: AbortSignal): Promise<{ deliveryRef: string }>;
}

export type ProtectedInputChannel = "vault:saveItem" | "vault:importInspect" | "vault:totp";

export interface ProtectedOwnerInput {
  availability(channel: ProtectedInputChannel): NativeAvailability;
  consume(binding: HostBinding, channel: ProtectedInputChannel, ticket: string, signal: AbortSignal): Promise<JSONValue>;
}

export type NativeHostChannel =
  | "capabilities:act" | "requirements:act" | "grant:state"
  | "app:relaunch" | "fullDisk:dragInfo" | "fullDisk:tileImage" | "fullDisk:dragStart"
  | "fullDisk:panelHold" | "fullDisk:panelHeight" | "fullDisk:dismiss"
  | "launch:get" | "launch:set" | "power:getKeepAwake" | "power:setKeepAwake"
  | "updates:get" | "updates:check" | "updates:restart" | "updates:dismiss"
  | "updates:setAutoCheck" | "updates:setAutoInstall";

export interface NativeHostAdapter {
  availability(channel: NativeHostChannel): NativeAvailability;
  call(channel: NativeHostChannel, input: JSONValue, signal: AbortSignal): Promise<OwnerServiceReply>;
  close?(): Promise<void>;
  subscribe?(listener: (channel: "updates:changed" | "fullDisk:dragEnd") => void): () => void;
}

export type OwnerPresentationChannel = "onboarding:open" | "onboarding:finish" | "ui:confirmLeaveReply";
export type OwnerPresentationEvent = "ui:showCapabilities" | "ui:showAuditBlocked" | "ui:showGatekeeperRecovery" | "ui:showSettings" | "ui:confirmLeave";

export interface OwnerPresentationAdapter {
  availability(channel: OwnerPresentationChannel): NativeAvailability;
  call(channel: OwnerPresentationChannel, input: JSONValue, signal: AbortSignal): Promise<OwnerServiceReply>;
  subscribe?(listener: (channel: OwnerPresentationEvent) => void): () => void;
}

export interface VaultOwnerAdapter {
  client: LocalVault;
  availability(): NativeAvailability;
  importFile?(signal: AbortSignal): Promise<ParsedImport | null>;
  importSources?(): Promise<JSONValue>;
}

export interface OwnerServicesOptions {
  home: string;
  owner: { organizationId: string; ownerId: string };
  settings: StrictSettingsStore;
  device?: DeviceAgent;
  audit?: AuditLog;
  approvals?: ApprovalStore;
  account?: AccountAdapter;
  protectedSurface?: ProtectedOwnerSurface;
  protectedInput?: ProtectedOwnerInput;
  openExternal?(url: string, signal: AbortSignal): Promise<void>;
  native?: NativeHostAdapter;
  presentation?: OwnerPresentationAdapter;
  vault?: VaultOwnerAdapter;
  stagedPlugins?: readonly { manifest: PluginManifest; description?: string | null }[];
  safariJavaScriptEnabled?(): Promise<boolean>;
  review?(args: ReviewArgs): Promise<PreviewResult>;
  now?: () => number;
}
