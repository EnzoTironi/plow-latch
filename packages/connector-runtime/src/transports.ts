import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client, StreamableHTTPClientTransport, type JsonSchemaType } from "@modelcontextprotocol/client";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import type { ReviewedConnection, ReviewedDestination, ReviewedOperation } from "./catalog.js";
import { schemaDigest } from "./catalog.js";
import type { TransportAuthorization } from "./credentials.js";
import { ConnectorError, JsonObjectSchema, JsonSchema, parse, type Json, type JsonObject } from "./model.js";
import { ProcessGroupStdioTransport } from "./stdioTransport.js";

const argumentsSchema = z.array(z.string().max(4096).refine(value => !value.includes("\0"))).max(128);
export type TransportDependencies = { fixtureHttpTransport?: { kind: "loopback_transport_fixture"; fetch: typeof fetch } };
export function resource(destination: ReviewedDestination): string {
  switch (destination.kind) {
    case "api": return new URL(destination.origin).origin;
    case "mcp_http": return destination.endpoint;
    case "cli": return `executable:${destination.executable}`;
    case "mcp_stdio": return `stdio:${destination.executable}`;
  }
}
export function prepare(configuration: ReviewedConnection, operation: ReviewedOperation, input: JsonObject): JsonObject {
  const destination = configuration.destination;
  switch (destination.kind) {
    case "api": {
      const api = operation.api;
      if (!api) throw new ConnectorError("invalid_catalog");
      return { kind: "api", url: new URL(api.path, destination.origin).href, method: api.method, body: api.method === "GET" ? null : input };
    }
    case "cli": {
      if (!operation.buildArguments) throw new ConnectorError("invalid_catalog");
      return { kind: "cli", executable: destination.executable, cwd: destination.cwd, arguments: parse(argumentsSchema, operation.buildArguments(input)) };
    }
    case "mcp_http": return { kind: "mcp_http", endpoint: destination.endpoint, tool: operation.upstreamOperation, arguments: input };
    case "mcp_stdio": return { kind: "mcp_stdio", executable: destination.executable, cwd: destination.cwd, processArguments: destination.arguments, tool: operation.upstreamOperation, arguments: input };
  }
}
async function checkProgram(destination: Extract<ReviewedDestination, { kind: "cli" | "mcp_stdio" }>): Promise<void> {
  for (const artifact of [{ path: destination.executable, digest: destination.executableDigest }, ...destination.artifacts]) {
    const hash = createHash("sha256");
    try { for await (const chunk of createReadStream(artifact.path)) hash.update(chunk); }
    catch { throw new ConnectorError("connection_unavailable"); }
    if (hash.digest("hex") !== artifact.digest) throw new ConnectorError("schema_drift");
  }
}
const preparedArguments = (request: JsonObject, key: string) => parse(argumentsSchema, request[key]);
function output(value: unknown, maxBytes: number): Json {
  const parsed = parse(JsonSchema, value, "transport_failed");
  if (Buffer.byteLength(JSON.stringify(parsed)) > maxBytes) throw new ConnectorError("output_limit");
  return parsed;
}
function cleanEnvironment(destination: Extract<ReviewedDestination, { kind: "cli" | "mcp_stdio" }>, home: string, authorization: TransportAuthorization): Record<string, string> {
  return { ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(key => [key, ""])), PATH: "/usr/bin:/bin", LANG: "C.UTF-8", SHELL: "/bin/false", TERM: "dumb", ...destination.environment, HOME: home, TMPDIR: home, ...authorization.environment(resource(destination)) };
}
function requestUrl(input: Parameters<typeof fetch>[0]): string { return input instanceof Request ? input.url : input.toString(); }
function guardedFetch(destination: Extract<ReviewedDestination, { kind: "api" | "mcp_http" }>, authorization: TransportAuthorization, signal: AbortSignal, maxBytes: number, dependencies: TransportDependencies): typeof fetch {
  const implementation = dependencies.fixtureHttpTransport?.fetch ?? fetch;
  if (dependencies.fixtureHttpTransport && process.env.NODE_ENV !== "test") throw new ConnectorError("invalid_catalog");
  const target = destination.kind === "api" ? new URL(destination.origin).origin : destination.endpoint;
  return async (input, init) => {
    const url = new URL(requestUrl(input));
    if (url.protocol !== "https:" || url.username || url.password || url.hash || (destination.kind === "api" ? url.origin !== target : url.href !== target)) throw new ConnectorError("grant_mismatch");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [key, value] of authorization.headers(resource(destination))) headers.set(key, value);
    const response = await implementation(input, { ...init, headers, redirect: "manual", signal: AbortSignal.any([signal, ...[init?.signal].filter((value): value is AbortSignal => value !== null && value !== undefined)]) });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new ConnectorError("redirect_refused"); }
    if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw new ConnectorError("output_limit"); }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await reader.read();
          if (item.done) { controller.close(); return; }
          bytes += item.value.byteLength;
          if (bytes > maxBytes) { await reader.cancel(); controller.error(new ConnectorError("output_limit")); return; }
          controller.enqueue(item.value);
        } catch (error) { controller.error(error); }
      },
      cancel: reason => reader.cancel(reason),
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
async function runCli(input: { configuration: ReviewedConnection; operation: ReviewedOperation; request: JsonObject; authorization: TransportAuthorization; signal: AbortSignal; beforeEffect: () => void }): Promise<Json> {
  const destination = input.configuration.destination;
  if (destination.kind !== "cli") throw new ConnectorError("invalid_catalog");
  await checkProgram(destination);
  const home = await mkdtemp(join(tmpdir(), "latch-connector-"));
  try {
    const env = cleanEnvironment(destination, home, input.authorization);
    input.signal.throwIfAborted();
    input.beforeEffect();
    return await new Promise<Json>((resolve, reject) => {
      const child = spawn(destination.executable, preparedArguments(input.request, "arguments"), { cwd: destination.cwd, env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", bytes = 0, failure: ConnectorError | null = null;
      const kill = () => { if (child.pid) { try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch {} } };
      const abort = () => { failure = new ConnectorError("cancelled"); kill(); };
      const collect = (kind: "stdout" | "stderr", chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > input.operation.maxOutputBytes) { failure = new ConnectorError("output_limit"); kill(); return; }
        if (kind === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
      };
      child.stdout.on("data", chunk => collect("stdout", chunk)); child.stderr.on("data", chunk => collect("stderr", chunk));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      child.once("error", () => { failure = new ConnectorError("transport_failed"); });
      child.once("close", (code, signal) => { input.signal.removeEventListener("abort", abort); kill(); if (failure) reject(failure); else if (signal !== null || code === null) reject(new ConnectorError("transport_failed")); else resolve({ stdout, stderr, exitCode: code }); });
    });
  } finally { await rm(home, { recursive: true, force: true }); }
}
async function runMcp(input: { configuration: ReviewedConnection; operation: ReviewedOperation; request: JsonObject; authorization: TransportAuthorization; signal: AbortSignal; beforeEffect: () => void; dependencies: TransportDependencies; principalPartition: string }): Promise<Json> {
  const destination = input.configuration.destination;
  if (destination.kind !== "mcp_http" && destination.kind !== "mcp_stdio") throw new ConnectorError("invalid_catalog");
  const ajv = new Ajv2020({ strict: false });
  addFormats.default(ajv);
  const client = new Client({ name: "latch-reviewed-connector", version: "0.1.0" }, { listMaxPages: 4, cachePartition: input.principalPartition, jsonSchemaValidator: { getValidator<T>(schema: JsonSchemaType) { const validate = ajv.compile<T>(schema); return value => validate(value) ? { valid: true, data: value, errorMessage: undefined } : { valid: false, data: undefined, errorMessage: "invalid_output" }; } } });
  let home: string | null = null;
  try {
    let transport: ProcessGroupStdioTransport | StreamableHTTPClientTransport;
    if (destination.kind === "mcp_stdio") {
      await checkProgram(destination);
      home = await mkdtemp(join(tmpdir(), "latch-mcp-"));
      transport = new ProcessGroupStdioTransport({ command: destination.executable, arguments: destination.arguments, cwd: destination.cwd, environment: cleanEnvironment(destination, home, input.authorization), maxOutputBytes: input.operation.maxOutputBytes });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(destination.endpoint), { fetch: guardedFetch(destination, input.authorization, input.signal, input.operation.maxOutputBytes, input.dependencies), requestInit: { redirect: "manual" }, reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1, initialReconnectionDelay: 1, reconnectionDelayGrowFactor: 1 } });
    }
    const abort = () => { void transport.close().catch(() => undefined); };
    input.signal.addEventListener("abort", abort, { once: true });
    try {
      input.signal.throwIfAborted();
      const options = { signal: input.signal, timeout: input.operation.timeoutMs, maxTotalTimeout: input.operation.timeoutMs };
      input.beforeEffect();
      await client.connect(transport, options);
      const listing = await client.listTools(undefined, { ...options, cacheMode: "refresh" });
      if (listing.tools.length !== input.configuration.operations.size || listing.tools.length > 100 || new Set(listing.tools.map(tool => tool.name)).size !== listing.tools.length) throw new ConnectorError("schema_drift");
      for (const operation of input.configuration.operations.values()) {
        const tool = listing.tools.find(tool => tool.name === operation.upstreamOperation);
        if (!tool || schemaDigest(parse(JsonObjectSchema, tool.inputSchema, "schema_drift"), tool.outputSchema === undefined ? null : parse(JsonObjectSchema, tool.outputSchema, "schema_drift")) !== operation.schemaDigest) throw new ConnectorError("schema_drift");
      }
      input.signal.throwIfAborted();
      input.beforeEffect();
      return output(await client.callTool({ name: input.operation.upstreamOperation, arguments: parse(JsonObjectSchema, input.request.arguments) }, options), input.operation.maxOutputBytes);
    } finally {
      input.signal.removeEventListener("abort", abort);
      try { await client.close(); } finally { await transport.close(); }
    }
  } finally { if (home !== null) await rm(home, { recursive: true, force: true }); }
}
export async function execute(input: { configuration: ReviewedConnection; operation: ReviewedOperation; request: JsonObject; authorization: TransportAuthorization; signal: AbortSignal; beforeEffect: () => void; dependencies: TransportDependencies; principalPartition: string }): Promise<Json> {
  switch (input.configuration.destination.kind) {
    case "cli": return runCli(input);
    case "mcp_stdio": case "mcp_http": return runMcp(input);
    case "api": {
      const destination = input.configuration.destination, url = z.string().parse(input.request.url), method = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).parse(input.request.method);
      const request = guardedFetch(destination, input.authorization, input.signal, input.operation.maxOutputBytes, input.dependencies);
      input.signal.throwIfAborted(); input.beforeEffect();
      const response = await request(url, { method, headers: { accept: "application/json", "content-type": "application/json" }, body: input.request.body === null ? undefined : JSON.stringify(input.request.body) });
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) { await response.body?.cancel(); throw new ConnectorError("transport_failed"); }
      let value: unknown;
      try { value = await response.json(); } catch (error) { if (error instanceof ConnectorError) throw error; throw new ConnectorError("transport_failed"); }
      return output(value, input.operation.maxOutputBytes);
    }
  }
}
