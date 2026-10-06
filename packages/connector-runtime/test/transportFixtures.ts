import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import { HubStore, type Principal } from "@domo/integration-hub";
import { CredentialBroker, ConnectorDispatcher, DigestSchema, GrantBindingSchema, JsonObjectSchema, ReviewedCatalog, schemaDigest, type Authorizer, type ConnectionReview, type FrozenPlan, type GrantBinding, type JsonObject, type OperationReview, type ProtectedGrant, type SecretStore, type TransportDependencies } from "../src/index.js";

export const alice: Principal = { id: "alice", organizationId: "org-a", kind: "member", scopes: ["echo"] };
export const bob: Principal = { id: "bob", organizationId: "org-a", kind: "agent", ownerId: "alice", scopes: ["echo"] };
export const echoSchema = JsonObjectSchema.parse({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 2048 } }, required: ["text"], additionalProperties: false });
export function operation(overrides: Partial<OperationReview> = {}): OperationReview {
  return { name: "echo", upstreamOperation: "echo", inputSchema: echoSchema, schemaDigest: schemaDigest(echoSchema), requiredScopes: ["echo"], effects: [{ kind: "write", resource: "fixture:echo" }], cost: { upperBoundMicros: 7, settlement: { kind: "fixed", actualMicros: 3 } }, timeoutMs: 3_000, maxOutputBytes: 8_192, ...overrides };
}
export const approve: Authorizer = { review: async ({ plan }) => ({ kind: "approved", planDigest: plan.planDigest, ownerPrincipalId: plan.ownerPrincipalId, evidenceRef: "fixture:transport-review", expiresAt: plan.expiresAt }) };
export class TestSecretStore implements SecretStore {
  readonly records = new Map<string, ProtectedGrant>();
  reads = 0;
  constructor(record?: ProtectedGrant) { if (record) this.records.set(record.binding.grantId, structuredClone(record)); }
  async read(id: string) { this.reads++; return structuredClone(this.records.get(id) ?? null); }
  async replace(input: { grantId: string; expectedRevision: number; record: ProtectedGrant }) {
    if (this.records.get(input.grantId)?.revision !== input.expectedRevision) throw new Error("secret revision conflict");
    this.records.set(input.grantId, structuredClone(input.record));
  }
  async delete(id: string) { this.records.delete(id); }
}
export function grant(connectionId: string, resource = "https://fixture.test"): GrantBinding {
  return GrantBindingSchema.parse({ grantId: "fixture-grant", connectionId, organizationId: "org-a", ownerPrincipalId: "alice", issuer: "https://issuer.fixture.test", resource, accountId: "account-one", scopes: ["echo"], delivery: { kind: "bearer" } });
}
export function secret(binding: GrantBinding, overrides: Partial<ProtectedGrant> = {}): ProtectedGrant {
  return { binding, revision: 1, accessToken: "fixture-access-secret-123456", refreshToken: "fixture-refresh-secret-123456", clientSecret: "fixture-client-secret-123456", expiresAt: Date.now() + 120_000, ...overrides };
}
export async function temporaryRoot(): Promise<string> { return realpath(await mkdtemp(join(tmpdir(), "latch-transport-test-"))); }
export async function executable(root: string, name: string, source: string) {
  const path = join(root, name);
  await writeFile(path, `#!${process.execPath}\n${source}`, { mode: 0o700 }); await chmod(path, 0o700);
  const digest = DigestSchema.parse(createHash("sha256").update(await readFile(path)).digest("hex"));
  return { executable: path, executableDigest: digest, cwd: root };
}
export async function cli(root: string, source?: string) {
  return executable(root, "echo-cli.mjs", source ?? `process.stdout.write(JSON.stringify({text:process.argv[2],cloud:process.env.AWS_SECRET_ACCESS_KEY??null,user:process.env.USER_TOKEN??null,home:process.env.HOME,cwd:process.cwd()}));`);
}
export async function stdio(root: string, options: { changedSchema?: boolean; source?: string; startupSource?: string; hangTool?: boolean } = {}) {
  const require = createRequire(import.meta.url);
  const source = options.source ?? `
import serverSdk from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/server")).href)};
import stdioSdk from ${JSON.stringify(pathToFileURL(require.resolve("@modelcontextprotocol/server/stdio")).href)};
import zod from ${JSON.stringify(pathToFileURL(require.resolve("zod")).href)};
const {McpServer}=serverSdk, {StdioServerTransport}=stdioSdk, {z}=zod;
import {appendFileSync} from 'node:fs';
${options.startupSource ?? ""}
const server=new McpServer({name:'transport-test',version:'1'});
server.registerTool('echo',{inputSchema:z.object({text:z.string().min(1).max(${options.changedSchema ? 1024 : 2048})}).strict(),annotations:{readOnlyHint:true}},async({text})=>{appendFileSync(${JSON.stringify(join(root, "mcp-effects.txt"))},'effect\\n'); ${options.hangTool ? "return await new Promise(()=>{});" : "return {content:[{type:'text',text}],structuredContent:{echo:text,cloud:process.env.AWS_SECRET_ACCESS_KEY??null,user:process.env.USER_TOKEN??null}};"}});
await server.connect(new StdioServerTransport());`;
  return { ...await executable(root, "echo-mcp.mjs", source), arguments: [] };
}
async function body(req: IncomingMessage): Promise<Buffer> { const buffers: Buffer[] = []; for await (const value of req) buffers.push(Buffer.from(value)); return Buffer.concat(buffers); }
async function reply(res: ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) { res.end(); return; }
  const reader = response.body.getReader();
  res.once("close", () => { void reader.cancel(); });
  while (!res.destroyed) { const chunk = await reader.read(); if (chunk.done) break; res.write(chunk.value); }
  res.end();
}
export async function httpFixture(options: { mcp?: boolean; changedSchema?: boolean; delayMs?: number; handler?: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void } = {}) {
  let effects = 0;
  const seen: { path: string; method: string; authorization: string | undefined }[] = [];
  const sessions = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; server: McpServer }>();
  const http = createServer(async (req, res) => {
    try {
      const requestBody = await body(req);
      seen.push({ path: req.url ?? "", method: req.method ?? "", authorization: req.headers.authorization });
      if (options.handler) { options.handler(req, res, requestBody); return; }
      if (!options.mcp) {
        if (req.url === "/redirect") { res.writeHead(302, { location: "https://elsewhere.fixture.test/stolen" }); res.end(); return; }
        const input = JSON.parse(requestBody.toString("utf8")); effects++;
        if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ echo: input.text, credentialEcho: req.headers.authorization ?? null, chargeMicros: 3 })); return;
      }
      const sessionId = req.headers["mcp-session-id"];
      let session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!session) {
        const server = new McpServer({ name: "transport-fixture", version: "1" });
        server.registerTool("echo", { inputSchema: z.object({ text: z.string().min(1).max(options.changedSchema ? 1024 : 2048) }).strict(), annotations: { readOnlyHint: true } }, ({ text }) => { effects++; return { content: [{ type: "text", text }], structuredContent: { echo: text } }; });
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true, onsessioninitialized: id => { sessions.set(id, { server, transport }); } });
        await server.connect(transport); session = { server, transport };
      }
      const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: requestBody.length ? requestBody : undefined });
      await reply(res, await session.transport.handleRequest(request));
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const address = http.address(); if (address === null || typeof address === "string") throw new Error("fixture address missing");
  const origin = `http://127.0.0.1:${address.port}`;
  const transport: TransportDependencies = { fixtureHttpTransport: { kind: "loopback_transport_fixture", fetch: async (input, init) => { const url = new URL(input instanceof Request ? input.url : input.toString()); if (url.origin !== "https://fixture.test") throw new Error("fixture destination mismatch"); return fetch(new URL(`${url.pathname}${url.search}`, origin), init); } } };
  return { origin, transport, seen, effects: () => effects, close: async () => { for (const session of sessions.values()) await session.server.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); } };
}
export async function runtime(root: string, options: { kind?: "api" | "cli" | "mcp_stdio" | "mcp_http"; principal?: Principal; destination?: ConnectionReview["destination"]; operation?: OperationReview; authorizer?: Authorizer; broker?: CredentialBroker; binding?: (connectionId: string) => GrantBinding | null; transport?: TransportDependencies; resolvePrincipal?: (value: Principal) => Principal; reviewTimeoutMs?: number } = {}) {
  const store = new HubStore({ path: join(root, "hub.sqlite") });
  const principal = options.principal ?? alice, kind = options.kind ?? "api";
  const connection = store.addConnection(principal, { namespace: "fixture", configuration: { kind, configurationRef: "config:fixture" }, status: "ready" }); store.setBudget(principal, 20);
  const destination = options.destination ?? (kind === "mcp_http" ? { kind, endpoint: "https://fixture.test/mcp" } : { kind: "api", origin: "https://fixture.test" });
  const review: ConnectionReview = { configurationRef: "config:fixture", revision: 1, organizationId: principal.organizationId, principalId: principal.id, ownerPrincipalId: principal.ownerId ?? principal.id, destination, grant: options.binding?.(connection.id) ?? null, operations: [options.operation ?? operation({ api: { method: "POST", path: "/echo" } })] };
  const dispatcher = new ConnectorDispatcher({ store, catalog: new ReviewedCatalog([review]), authorizer: options.authorizer ?? approve, broker: options.broker ?? new CredentialBroker(), resolvePrincipal: options.resolvePrincipal ?? (principal => principal), transport: options.transport, reviewTimeoutMs: options.reviewTimeoutMs });
  return { store, connection, review, dispatcher, call: (text = "hello", idempotencyKey = "first") => dispatcher.call(principal, { connectionId: connection.id, operation: "echo", arguments: { text }, idempotencyKey }), close: async () => { await dispatcher.close(); store.close(); } };
}
export function reviewGate() {
  let resolve: ((plan: FrozenPlan) => void) | undefined, plan: FrozenPlan | undefined;
  const received = new Promise<FrozenPlan>(value => { resolve = value; });
  let release: (() => void) | undefined;
  const gate = new Promise<void>(value => { release = value; });
  const authorizer: Authorizer = { review: async input => { plan = input.plan; resolve?.(plan); await gate; return approve.review(input); } };
  return { authorizer, received, release: () => release?.(), plan: () => plan };
}
export const removeRoot = (root: string) => rm(root, { recursive: true, force: true });
