import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DEFAULT_APPROVAL_MODE, type CredentialCodec, type Settings } from "@domo/owner-core/settings";
import type { NativeAvailability } from "@domo/owner-runtime";
import { OwnerServiceError } from "./errors.js";
import type { SettingsPort } from "./settingsPort.js";

const consent = z.enum(["granted", "denied", "not_asked"]);
const strings = z.record(z.string(), z.string());
const seals = z.array(z.string().min(1).max(131_072)).max(1_000);
const settingsSchema: z.ZodType<Settings> = z.object({
  relayCredential: z.string().max(65_536).default(""),
  relayCredentialEnc: z.string().min(1).max(131_072).optional(),
  pendingRevokeCredentials: z.array(z.string().min(1).max(65_536)).max(1_000).default([]),
  pendingRevokeCredentialsEnc: seals.optional(),
  accountUid: z.string().max(1_024).default(""),
  mcpUrl: z.string().max(8_192).default(""),
  selectedTab: z.string().max(80).default("agents"),
  windowBounds: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive() }).optional(),
  approvalMode: z.enum(["approve", "adversarial", "ask", "deny"]).default(DEFAULT_APPROVAL_MODE),
  agentPurpose: z.string().max(16_384).default(""),
  autoCheckUpdates: z.boolean().default(true),
  autoInstallUpdates: z.boolean().default(true),
  updatesLastCheckedAt: z.string().max(80).optional(),
  automation: z.record(z.string(), consent).optional(),
  folderConsent: z.record(z.string(), consent).optional(),
  folderConsentAt: strings.optional(),
  disabledPlugins: z.array(z.string().max(160)).max(1_000).optional(),
  capabilityDismissals: strings.optional(),
  blockedBannerSeenAt: z.string().max(80).optional(),
  fullDiskGrantedSeen: z.boolean().optional(),
  keepAwakeWhileRunning: z.boolean().default(false),
  telemetryEnabled: z.boolean().default(true),
  setupComplete: z.boolean().default(false),
  onboardingResumeStep: z.enum(["privacy", "gatekeeper", "plugins", "access", "availability"]).optional(),
});

export interface StrictSettingsStoreOptions {
  home: string;
  codec?: CredentialCodec;
}

export class StrictSettingsStore implements SettingsPort {
  private readonly directory: string;
  private readonly file: string;
  private unreadable = false;

  constructor(private readonly options: StrictSettingsStoreOptions) {
    if (!path.isAbsolute(options.home)) throw new OwnerServiceError("unsafe_settings_path");
    this.directory = path.join(options.home, "app");
    this.file = path.join(this.directory, "settings.json");
    this.assertPath();
  }

  load(): Settings {
    const settings = this.readStored();
    this.unreadable = false;
    if (settings.relayCredentialEnc) {
      const credential = this.unseal(settings.relayCredentialEnc);
      if (credential !== null) {
        settings.relayCredential = credential;
        settings.relayCredentialEnc = undefined;
      }
    }
    const opaque: string[] = [];
    for (const seal of settings.pendingRevokeCredentialsEnc ?? []) {
      const credential = this.unseal(seal);
      if (credential === null) opaque.push(seal);
      else settings.pendingRevokeCredentials.push(credential);
    }
    settings.pendingRevokeCredentials = [...new Set(settings.pendingRevokeCredentials)];
    settings.pendingRevokeCredentialsEnc = opaque.length ? opaque : undefined;
    return settings;
  }

  save(input: Settings): void {
    const current = this.readStored();
    this.unreadable = false;
    const recoveredSeals = new Map<string, string>();
    const opaqueSeals = new Set<string>();
    for (const encrypted of [current.relayCredentialEnc, ...(current.pendingRevokeCredentialsEnc ?? [])]) {
      if (!encrypted) continue;
      const credential = this.unseal(encrypted);
      if (credential === null) opaqueSeals.add(encrypted);
      else recoveredSeals.set(credential, encrypted);
    }
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) throw new OwnerServiceError("invalid_settings");
    const settings = parsed.data;
    const stored = { ...settings, relayCredential: "", pendingRevokeCredentials: [] };
    const seal = (credential: string) => recoveredSeals.get(credential) ?? this.seal(credential);
    if (settings.relayCredential.trim()) stored.relayCredentialEnc = seal(settings.relayCredential.trim());
    const pending = [...new Set(settings.pendingRevokeCredentials)].map(seal);
    const allSeals = [...new Set([...(settings.pendingRevokeCredentialsEnc ?? []), ...pending])];
    if (this.secretAvailability().kind === "unavailable") {
      allSeals.push(...(current.pendingRevokeCredentialsEnc ?? []).filter((seal) => opaqueSeals.has(seal) && !allSeals.includes(seal)));
      if (current.relayCredentialEnc && !allSeals.includes(current.relayCredentialEnc)) stored.relayCredentialEnc = current.relayCredentialEnc;
    }
    stored.pendingRevokeCredentialsEnc = allSeals.length ? allSeals : undefined;
    fs.mkdirSync(this.options.home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.assertPath();
    fs.chmodSync(this.directory, 0o700);
    const temporary = path.join(this.directory, `.settings-${randomUUID()}.tmp`);
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(stored, null, 2) + "\n");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporary, this.file);
      const directory = fs.openSync(this.directory, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  }

  secretAvailability(): NativeAvailability {
    if (!this.options.codec) return { kind: "unavailable", reason: "protected_secret_codec_required" };
    try {
      if (!this.options.codec.available() || this.unreadable) return { kind: "unavailable", reason: "secret_store_locked" };
    } catch {
      return { kind: "unavailable", reason: "secret_store_locked" };
    }
    return { kind: "ready" };
  }

  signOut(): void {
    const settings = this.load();
    if (settings.relayCredential) settings.pendingRevokeCredentials.push(settings.relayCredential);
    if (settings.relayCredentialEnc) {
      settings.pendingRevokeCredentialsEnc = [...new Set([...(settings.pendingRevokeCredentialsEnc ?? []), settings.relayCredentialEnc])];
    }
    settings.relayCredential = "";
    settings.relayCredentialEnc = undefined;
    settings.accountUid = "";
    settings.mcpUrl = "";
    settings.setupComplete = false;
    this.save(settings);
  }

  private seal(credential: string): string {
    if (this.secretAvailability().kind !== "ready" || !this.options.codec) throw new OwnerServiceError("secret_store_locked");
    try {
      const encrypted = this.options.codec.encrypt(credential);
      if (!encrypted || encrypted === credential || encrypted.length > 131_072) throw new OwnerServiceError("secret_store_locked");
      return encrypted;
    } catch {
      throw new OwnerServiceError("secret_store_locked");
    }
  }

  private unseal(encrypted: string): string | null {
    if (!this.options.codec) return null;
    try {
      if (!this.options.codec.available()) return null;
      const credential = this.options.codec.decrypt(encrypted);
      if (!credential.trim() || credential.length > 65_536) throw new OwnerServiceError("secret_store_locked");
      return credential;
    } catch {
      this.unreadable = true;
      return null;
    }
  }

  private readStored(): Settings {
    this.assertPath();
    let raw: unknown = {};
    try {
      const bytes = fs.readFileSync(this.file);
      if (bytes.length > 1_048_576) throw new OwnerServiceError("invalid_settings");
      raw = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (!isMissing(error)) throw new OwnerServiceError("invalid_settings");
    }
    const parsed = settingsSchema.safeParse(raw);
    if (!parsed.success) throw new OwnerServiceError("invalid_settings");
    if (parsed.data.relayCredential.trim() || parsed.data.pendingRevokeCredentials.length > 0) {
      throw new OwnerServiceError("plaintext_credentials_present");
    }
    return parsed.data;
  }

  private assertPath(): void {
    for (const candidate of [this.options.home, this.directory, this.file]) {
      try {
        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink() || (candidate === this.file ? !stat.isFile() : !stat.isDirectory())) {
          throw new OwnerServiceError("unsafe_settings_path");
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
