import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createDomoMcpServer } from "@domo/mcp-server";
import { createHostBinding, HostResponseSchema } from "@domo/owner-runtime";
import type { HostResponse } from "@domo/owner-runtime";
import { saveSettings } from "@domo/owner-core";
import { schemaDigest, DigestSchema } from "@domo/connector-runtime";
import type { ConnectionReview } from "@domo/connector-runtime";
import { openRuntime } from "../src/runtime.js";
import { HeadlessHub, HUB_URI } from "../src/hub.js";
import type { OwnerHost } from "../src/ownerGateway.js";

const choiceSchema = z.enum(["allow_once", "always_allow", "deny"]);
type Choice = z.infer<typeof choiceSchema>;
const actionSchema = HostResponseSchema.omit({ actionId: true, choice: true }).pick({ revision: true, nonce: true, argumentsDigest: true, capabilityDigest: true, policyRevision: true, enrollmentRevision: true }).extend({ id: z.string().uuid() }).passthrough();
export type Form = { id: string; message: string; choices: Choice[]; action: z.infer<typeof actionSchema> };

export async function fixture(options: { enrolled?: boolean; root?: string; choose?: (form: Form) => Promise<Choice | "cancel"> } = {}) {
  const root = options.root ?? await realpath(await mkdtemp(join(tmpdir(), "latch-hub-fixture-")));
  const home = join(root, "data"), ownerHome = join(root, "owner");
  const principal = { id: "fixture-owner", organizationId: "fixture-org", kind: "member" as const, scopes: ["echo"] };
  const lifetime = new AbortController();
  const proofs = new Map<string, HostResponse>();
  const pending = new Map<string, { form: Form; resolve: (choice: Choice | "cancel") => void }>();
  const host: OwnerHost = {
    assurance: "test_host",
    binding: () => options.enrolled === false ? null : createHostBinding({
      organizationId: principal.organizationId, ownerId: principal.id, userId: principal.id, principalId: principal.id,
      connectionId: "fixture-transport", enrollmentRevision: 1, expiresAt: Date.now() + 3_600_000, assurance: "trusted_host_form",
    }, {
      signal: lifetime.signal, isCurrent: () => !lifetime.signal.aborted,
      verifyResponse: async (_challenge, response) => {
        for (const [id, proof] of proofs) if (JSON.stringify(proof) === JSON.stringify(response)) return { evidenceRef: id };
        return null;
      },
    }),
    confirm: async (_binding, challenge, response) => {
      const evidence = z.object({ action: z.literal("accept"), content: z.object({ choice: choiceSchema }).strict() }).passthrough().safeParse(response);
      if (!evidence.success) return null;
      for (const proof of proofs.values()) if (proof.actionId === challenge.action.id && proof.choice === evidence.data.content.choice) return proof;
      return null;
    },
  };
  const executable = join(root, "echo-cli.mjs");
  await writeFile(executable, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(join(root, "echo-effects.txt"))},'effect\\n');process.stdout.write(JSON.stringify({echo:process.argv[2]}));\n`, { mode: 0o700 });
  const inputSchema = { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 2048 } }, required: ["text"], additionalProperties: false };
  const connection: ConnectionReview = {
    configurationRef: "config:fixture-echo", revision: 1, organizationId: principal.organizationId, principalId: principal.id, ownerPrincipalId: principal.id,
    destination: { kind: "cli", executable, executableDigest: DigestSchema.parse(createHash("sha256").update(await readFile(executable)).digest("hex")), cwd: root }, grant: null,
    operations: [{ name: "echo", upstreamOperation: "echo", inputSchema, schemaDigest: schemaDigest(inputSchema), requiredScopes: ["echo"], effects: [{ kind: "read", resource: "fixture:text" }], cost: { upperBoundMicros: 25_000, settlement: { kind: "fixed", actualMicros: 10_000 } }, buildArguments: input => [z.string().parse(input.text)] }],
  };
  const hub = new HeadlessHub({ connections: [connection] });
  saveSettings(home, { approvalMode: "ask" });
  const runtime = await openRuntime({ home, ownerHome, principal, host, approvalTtlMs: 30_000 }, hub.adapter);
  hub.attach(runtime);
  const html = await readFile(new URL("../dist/hub.html", import.meta.url), "utf8");
  const server = createDomoMcpServer(runtime.device, { budgetMs: 25, version: "0.1.0-dev", extension: hub.extension(html) });
  const client = new Client({ name: "latch-test-host", version: "0.1" }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: { pin: "2026-07-28" } } });
  client.setRequestHandler("elicitation/create", async request => {
    const formInput = z.object({ message: z.string(), requestedSchema: z.object({ properties: z.object({ choice: z.object({ enum: z.array(choiceSchema) }) }) }), _meta: z.object({ "latch/ownerAction": actionSchema }) }).passthrough().parse(request.params);
    const action = formInput._meta["latch/ownerAction"];
    const form: Form = { id: randomUUID(), message: formInput.message, choices: formInput.requestedSchema.properties.choice.enum, action };
    const choice = options.choose ? await options.choose(form) : await new Promise<Choice | "cancel">(resolve => pending.set(form.id, { form, resolve }));
    if (choice === "cancel") return { action: "cancel" };
    const evidenceRef = `fixture:${randomUUID()}`;
    const response = HostResponseSchema.parse({ actionId: action.id, revision: action.revision, nonce: action.nonce, argumentsDigest: action.argumentsDigest, capabilityDigest: action.capabilityDigest, policyRevision: action.policyRevision, enrollmentRevision: action.enrollmentRevision, choice });
    proofs.set(evidenceRef, response);
    return { action: "accept", content: { choice } };
  });
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), { fetch: async (input, init) => server.fetch(new Request(input, init), { agent_id: principal.id, agent_name: "Fixture owner" }) });
  await client.connect(transport);
  runtime.store.setBudget(principal, 2_000_000);
  const connected = runtime.store.addConnection(principal, { namespace: "eco-verificado", configuration: { kind: "cli", configurationRef: connection.configurationRef }, status: "ready" });
  return {
    root, runtime, hub, server, client, connection: connected,
    forms: () => [...pending.values()].map(value => value.form),
    answer: (id: string, choice: Choice | "cancel") => { const value = pending.get(id); if (!value) throw new Error("form_not_pending"); pending.delete(id); value.resolve(choice); },
    call: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }, { timeout: 120_000, maxTotalTimeout: 120_000 }),
    html: async () => {
      const result = await client.readResource({ uri: HUB_URI });
      const content = result.contents.find(item => "text" in item);
      if (!content || !("text" in content)) throw new Error("widget_resource_missing");
      return content.text;
    },
    close: async (remove = true) => {
      for (const value of pending.values()) value.resolve("cancel"); pending.clear();
      await hub.close(); await runtime.close(); lifetime.abort(); await client.close(); await server.close();
      if (remove) await rm(root, { recursive: true, force: true });
    },
  };
}
