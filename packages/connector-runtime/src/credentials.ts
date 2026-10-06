import { z } from "zod";
import type { Principal } from "@domo/integration-hub";
import { ConnectorError, JsonSchema, ReferenceSchema, canonical, parse, type Json } from "./model.js";

const httpsIdentity = z.string().url().max(2048).refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; });
export const GrantBindingSchema = z.object({
  grantId: ReferenceSchema, connectionId: z.string().uuid(), organizationId: ReferenceSchema, ownerPrincipalId: ReferenceSchema,
  issuer: httpsIdentity, resource: z.string().min(1).max(4096), accountId: ReferenceSchema, scopes: z.array(ReferenceSchema).max(100),
  delivery: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("bearer") }).strict(),
    z.object({ kind: z.literal("header"), name: z.string().regex(/^[A-Za-z0-9-]{1,80}$/).refine(value => !["host", "cookie", "content-length", "connection"].includes(value.toLowerCase())) }).strict(),
    z.object({ kind: z.literal("environment"), name: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).refine(value => !["PATH", "HOME", "SHELL", "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(value)) }).strict(),
  ]),
}).strict();
export type GrantBinding = z.infer<typeof GrantBindingSchema>;
export const ProtectedGrantSchema = z.object({
  binding: GrantBindingSchema, revision: z.number().int().positive(), accessToken: z.string().min(1).max(16_384),
  refreshToken: z.string().min(1).max(16_384).nullable(), clientSecret: z.string().min(1).max(16_384).nullable(), expiresAt: z.number().int().positive(),
}).strict();
export type ProtectedGrant = z.infer<typeof ProtectedGrantSchema>;
/** Production supplies native secret storage or a protected backend. This package has no file secret store. */
export interface SecretStore {
  read(grantId: string): Promise<unknown>;
  replace(input: { grantId: string; expectedRevision: number; record: ProtectedGrant }): Promise<void>;
  delete(grantId: string): Promise<void>;
}
export type CredentialHooks = {
  refresh?: (record: ProtectedGrant, signal: AbortSignal) => Promise<unknown>;
  revoke?: (record: ProtectedGrant) => Promise<"confirmed" | "failed" | "unavailable">;
};
export interface TransportAuthorization {
  headers(resource: string): Headers;
  environment(resource: string): Record<string, string>;
  redact(value: Json): Json;
}
export class GrantRefreshError extends Error {
  constructor(readonly code: "invalid_grant" | "unavailable") { super(code); this.name = "GrantRefreshError"; }
}
const bindingMatches = (left: GrantBinding, right: GrantBinding) => canonical(left) === canonical(right);
function redactor(values: readonly string[]): (value: Json) => Json {
  const secrets = [...new Set(values.flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString("base64")]))].sort((a, b) => b.length - a.length);
  const text = (value: string) => secrets.reduce((result, secret) => result.split(secret).join("[redacted]"), value);
  const redact = (value: Json): Json => {
    if (typeof value === "string") return text(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), /^(authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|cookie)$/i.test(key) ? "[redacted]" : redact(item)]));
    return value;
  };
  return redact;
}
const anonymous: TransportAuthorization = { headers: () => new Headers(), environment: () => ({}), redact: redactor([]) };

export class CredentialBroker {
  private readonly refreshes = new Map<string, Promise<ProtectedGrant>>();
  private readonly rotationRevocations = new Map<string, Promise<"confirmed" | "failed" | "unavailable">>();
  private readonly disabled = new Set<string>();
  constructor(private readonly options: { secretStore?: SecretStore; hooks?: CredentialHooks; now?: () => number } = {}) {}
  private assertActive(binding: GrantBinding): void { if (this.disabled.has(binding.grantId)) throw new ConnectorError("grant_unavailable"); }
  private async load(binding: GrantBinding, signal: AbortSignal): Promise<ProtectedGrant> {
    this.assertActive(binding);
    const store = this.options.secretStore;
    if (!store) throw new ConnectorError("credentials_locked");
    let record: ProtectedGrant;
    try { record = parse(ProtectedGrantSchema, await store.read(binding.grantId), "grant_unavailable"); }
    catch (error) { if (error instanceof ConnectorError) throw error; throw new ConnectorError("credentials_locked"); }
    if (!bindingMatches(binding, record.binding)) throw new ConnectorError("grant_mismatch");
    this.assertActive(binding);
    if (record.expiresAt > (this.options.now?.() ?? Date.now()) + 5_000) return record;
    const existing = this.refreshes.get(binding.grantId);
    if (existing) return existing;
    const refresh = this.refresh(record, signal);
    this.refreshes.set(binding.grantId, refresh);
    try { return await refresh; } finally { if (this.refreshes.get(binding.grantId) === refresh) this.refreshes.delete(binding.grantId); }
  }
  private async refresh(record: ProtectedGrant, signal: AbortSignal): Promise<ProtectedGrant> {
    const store = this.options.secretStore, refresh = this.options.hooks?.refresh;
    if (!store || !refresh || !record.refreshToken) throw new ConnectorError("needs_reauth");
    try {
      const rotated = parse(ProtectedGrantSchema, await refresh(record, signal), "needs_reauth");
      if (!bindingMatches(record.binding, rotated.binding) || rotated.revision !== record.revision + 1 || rotated.expiresAt <= (this.options.now?.() ?? Date.now()) + 5_000) throw new ConnectorError("grant_mismatch");
      if (this.disabled.has(record.binding.grantId)) {
        const revokeRotation = this.upstreamRevoke(rotated);
        this.rotationRevocations.set(record.binding.grantId, revokeRotation);
        await revokeRotation;
        throw new ConnectorError("grant_unavailable");
      }
      this.assertActive(record.binding);
      await store.replace({ grantId: record.binding.grantId, expectedRevision: record.revision, record: rotated });
      if (this.disabled.has(record.binding.grantId)) { await store.delete(record.binding.grantId); throw new ConnectorError("grant_unavailable"); }
      return rotated;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(error instanceof GrantRefreshError && error.code === "invalid_grant" ? "needs_reauth" : "grant_unavailable");
    }
  }
  private async upstreamRevoke(record: ProtectedGrant): Promise<"confirmed" | "failed" | "unavailable"> {
    try { return await this.options.hooks?.revoke?.(record) ?? "unavailable"; } catch { return "failed"; }
  }
  async use<T>(input: { principal: Principal; connectionId: string; binding: GrantBinding | null; resource: string; requiredScopes: readonly string[]; signal: AbortSignal }, body: (authorization: TransportAuthorization) => Promise<T>): Promise<T> {
    const { principal, binding, resource, signal } = input;
    if (binding === null) return body(anonymous);
    if (binding.connectionId !== input.connectionId || binding.organizationId !== principal.organizationId || binding.ownerPrincipalId !== (principal.ownerId ?? principal.id) || binding.resource !== resource || input.requiredScopes.some(scope => !binding.scopes.includes(scope))) throw new ConnectorError("grant_mismatch");
    const record = await this.load(binding, signal);
    this.assertActive(binding);
    signal.throwIfAborted();
    const ensure = (destination: string) => { this.assertActive(binding); signal.throwIfAborted(); if (destination !== binding.resource) throw new ConnectorError("grant_mismatch"); };
    const redact = redactor([record.accessToken, ...[record.refreshToken, record.clientSecret].filter(value => value !== null)]);
    return body({
      headers: destination => { ensure(destination); const headers = new Headers(); if (binding.delivery.kind === "bearer") headers.set("authorization", `Bearer ${record.accessToken}`); if (binding.delivery.kind === "header") headers.set(binding.delivery.name, record.accessToken); return headers; },
      environment: destination => { ensure(destination); return binding.delivery.kind === "environment" ? { [binding.delivery.name]: record.accessToken } : {}; },
      redact: value => parse(JsonSchema, redact(value)),
    });
  }
  async revoke(input: { principal: Principal; binding: GrantBinding; disableLocal: () => void }): Promise<{ upstream: "confirmed" | "failed" | "unavailable"; removed: boolean }> {
    const binding = parse(GrantBindingSchema, input.binding);
    if (binding.organizationId !== input.principal.organizationId || binding.ownerPrincipalId !== input.principal.id) throw new ConnectorError("grant_mismatch");
    input.disableLocal();
    this.disabled.add(binding.grantId);
    const pendingRefresh = this.refreshes.get(binding.grantId);
    const store = this.options.secretStore;
    if (!store) return { upstream: "unavailable", removed: false };
    let upstream: "confirmed" | "failed" | "unavailable" = "unavailable";
    let removed = false, mayDelete = false;
    try {
      const raw = await store.read(binding.grantId);
      mayDelete = raw === null || raw === undefined;
      if (raw !== null && raw !== undefined) {
        const record = parse(ProtectedGrantSchema, raw, "grant_unavailable");
        if (!bindingMatches(record.binding, binding)) throw new ConnectorError("grant_mismatch");
        mayDelete = true;
        upstream = await this.upstreamRevoke(record);
      }
      if (pendingRefresh) {
        await pendingRefresh.catch(() => undefined);
        const rotation = this.rotationRevocations.get(binding.grantId);
        const rotatedStatus = rotation ? await rotation : "unavailable";
        if (upstream === "failed" || rotatedStatus === "failed") upstream = "failed";
        else if (upstream !== "confirmed" || rotatedStatus !== "confirmed") upstream = "unavailable";
      }
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "grant_mismatch") throw error;
      upstream = "failed";
    } finally {
      this.rotationRevocations.delete(binding.grantId);
      if (mayDelete) { try { await store.delete(binding.grantId); removed = true; } catch { removed = false; } }
    }
    return { upstream, removed };
  }
}
