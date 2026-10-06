import { mkdirSync, chmodSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { DeviceAgent, ApprovalStore, plowFolderPath } from "@domo/device-core";
import type { ResolvedBrowserRuntime, Minter, StagedPlugin, HostProbes } from "@domo/device-core";
import { HubStore, PrincipalSchema } from "@domo/integration-hub";
import type { Principal } from "@domo/integration-hub";
import { OwnerController } from "@domo/owner-runtime";
import { PRODUCTION_API_BASE_URL } from "@domo/owner-core";
import type { DecideDeps, CredentialCodec } from "@domo/owner-core";
import { OwnerServices, StrictSettingsStore } from "@domo/owner-services";
import type { OwnerServicesOptions } from "@domo/owner-services";
import type { OwnerHost } from "./ownerGateway.js";

export interface RuntimeOptions {
  home: string;
  ownerHome: string;
  name?: string;
  principal?: Principal;
  host?: OwnerHost;
  apiBaseUrl?: string;
  review?: DecideDeps["review"];
  browser?: ResolvedBrowserRuntime;
  minter?: Minter;
  plugins?: readonly StagedPlugin[];
  probes?: HostProbes;
  approvalTtlMs?: number;
  settings?: StrictSettingsStore;
  credentialCodec?: CredentialCodec;
  ownerServices?: Omit<OwnerServicesOptions, "home" | "owner" | "settings" | "device" | "audit" | "approvals">;
}

export interface HeadlessRuntime {
  readonly device: DeviceAgent;
  readonly owner: OwnerController;
  readonly approvals: ApprovalStore;
  readonly store: HubStore;
  readonly principal: Principal;
  readonly host: OwnerHost | null;
  readonly settings: StrictSettingsStore;
  readonly services: OwnerServices;
  close(): Promise<void>;
}

export async function openRuntime(options: RuntimeOptions, adapter: ConstructorParameters<typeof OwnerController>[0]["nativeAdapter"]): Promise<HeadlessRuntime> {
  const home = z.string().refine(isAbsolute).parse(options.home);
  const ownerHome = z.string().refine(isAbsolute).parse(options.ownerHome);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const settingsPort = options.settings ?? new StrictSettingsStore({ home, codec: options.credentialCodec });
  const owner = new OwnerController({ home, nativeAdapter: adapter, saveSettings: (_home, settings) => settingsPort.save(settings) });
  let device: DeviceAgent | null = null;
  let store: HubStore | null = null;
  let services: OwnerServices | null = null;
  try {
    const settings = settingsPort.load();
    const policy = owner.nativePolicy({
      apiBaseUrl: options.apiBaseUrl ?? PRODUCTION_API_BASE_URL, plowRoot: plowFolderPath(ownerHome),
      settings: () => settingsPort.load(),
      record: (event, fields) => { device?.audit.record(event, fields); },
      review: options.review,
    });
    const approvals = new ApprovalStore(join(home, "device/approvals"), policy, options.approvalTtlMs);
    device = new DeviceAgent(home, options.name ?? "Latch Plugin", approvals, options.browser ?? null, ownerHome, options.minter ?? null, options.plugins ?? [], null, options.probes ?? null);
    device.setDisabledPlugins(settings.disabledPlugins ?? []);
    const activeDevice = device;
    approvals.onAbandoned = record => activeDevice.audit.record("approval_abandoned", { intentId: record.intentId });
    approvals.onUnrecorded = record => activeDevice.audit.record("intent_decision", { intentId: record.intentId, decision: record.decision ?? "deny", source: record.source ?? "prompt" });
    owner.observeNative(activeDevice, approvals);
    await approvals.ready;
    store = new HubStore({ path: join(home, "device/hub/hub.sqlite") });
    const activeStore = store;
    const principal = PrincipalSchema.parse(options.principal ?? { id: `device:${activeDevice.identity.deviceId}`, kind: "local_device", organizationId: `installation:${activeDevice.identity.deviceId}`, scopes: [] });
    services = new OwnerServices({ ...options.ownerServices, home, settings: settingsPort, owner: { organizationId: principal.organizationId, ownerId: principal.ownerId ?? principal.id }, device: activeDevice, audit: activeDevice.audit, approvals });
    const activeServices = services;
    let closing: Promise<void> | null = null;
    return {
      device: activeDevice, owner, approvals, store: activeStore, principal, host: options.host ?? null, settings: settingsPort, services: activeServices,
      close: () => closing ??= (async () => {
        const failures: unknown[] = [];
        try { await activeServices.close(); } catch (error) { failures.push(error); }
        try { await activeDevice.shutdown(); } catch (error) { failures.push(error); }
        try { await owner.close(); } catch (error) { failures.push(error); }
        try { activeStore.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "headless_shutdown_failed");
      })(),
    };
  } catch (error) {
    const failures: unknown[] = [error];
    try { await services?.close(); } catch (failure) { failures.push(failure); }
    try { await device?.shutdown(); } catch (failure) { failures.push(failure); }
    try { await owner.close(); } catch (failure) { failures.push(failure); }
    try { store?.close(); } catch (failure) { failures.push(failure); }
    throw new AggregateError(failures, "headless_startup_failed");
  }
}
