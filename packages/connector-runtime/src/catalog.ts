import { isAbsolute } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { z } from "zod";
import type { Connection, Principal } from "@domo/integration-hub";
import { ConnectorError, CostSchema, DigestSchema, EffectSchema, JsonObjectSchema, ReferenceSchema, digest, freeze, parse, pointer, type JsonObject, type ReviewedCost } from "./model.js";
import { GrantBindingSchema, type GrantBinding } from "./credentials.js";

const absolutePath = z.string().min(1).max(4096).refine(isAbsolute);
const environment = z.object({ PATH: z.string().max(4096).optional(), LANG: z.string().max(80).optional(), LC_ALL: z.string().max(80).optional(), TZ: z.string().max(80).optional(), TERM: z.string().max(80).optional() }).strict().default({});
const program = { executable: absolutePath, executableDigest: DigestSchema, cwd: absolutePath, environment, artifacts: z.array(z.object({ path: absolutePath, digest: DigestSchema }).strict()).max(32).default([]) };
const https = z.string().url().refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash; });
const destinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("api"), origin: https.refine(value => new URL(value).pathname === "/") }).strict(),
  z.object({ kind: z.literal("cli"), ...program }).strict(),
  z.object({ kind: z.literal("mcp_stdio"), ...program, arguments: z.array(z.string().max(4096)).max(64) }).strict(),
  z.object({ kind: z.literal("mcp_http"), endpoint: https }).strict(),
]);
export type ReviewedDestination = z.infer<typeof destinationSchema>;
const operationSchema = z.object({
  name: ReferenceSchema, upstreamOperation: ReferenceSchema,
  inputSchema: JsonObjectSchema, outputSchema: JsonObjectSchema.nullable().default(null), schemaDigest: DigestSchema,
  requiredScopes: z.array(ReferenceSchema).max(100), effects: z.array(EffectSchema).min(1).max(32), cost: CostSchema,
  timeoutMs: z.number().int().min(1).max(300_000).default(30_000), maxOutputBytes: z.number().int().min(1).max(65_536).default(32_768),
  api: z.object({ method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().min(1).max(2048).regex(/^\/(?!\/)[A-Za-z0-9/_~.-]*$/) }).strict().optional(),
}).strict();
export type OperationReview = z.input<typeof operationSchema> & { buildArguments?: (input: JsonObject) => string[] };
export type ConnectionReview = {
  configurationRef: string; revision: number; organizationId: string; principalId: string; ownerPrincipalId: string;
  destination: z.input<typeof destinationSchema>; grant: GrantBinding | null; operations: readonly OperationReview[];
};
export type ReviewedOperation = z.infer<typeof operationSchema> & { validateInput: ValidateFunction; validateOutput: ValidateFunction | null; buildArguments: ((input: JsonObject) => string[]) | null };
export type ReviewedConnection = {
  configurationRef: string; revision: number; organizationId: string; principalId: string; ownerPrincipalId: string;
  destination: ReviewedDestination; grant: GrantBinding | null; operations: ReadonlyMap<string, ReviewedOperation>; catalogDigest: string;
};
const metadataSchema = z.object({ configurationRef: z.string().regex(/^config:[A-Za-z0-9_.:-]{1,120}$/), revision: z.number().int().positive(), organizationId: ReferenceSchema, principalId: ReferenceSchema, ownerPrincipalId: ReferenceSchema }).strict();

/** Only reviewed installation configuration constructs this registry. Remote annotations are ignored. */
export class ReviewedCatalog {
  private readonly configurations = new Map<string, ReviewedConnection>();
  constructor(reviews: readonly ConnectionReview[]) {
    const validator = new Ajv2020({ strict: true, allErrors: false });
    addFormats.default(validator);
    for (const review of reviews) {
      const { destination: rawDestination, grant: rawGrant, operations: rawOperations, ...rawMetadata } = review;
      const metadata = parse(metadataSchema, rawMetadata, "invalid_catalog");
      if (this.configurations.has(metadata.configurationRef) || rawOperations.length < 1 || rawOperations.length > 100) throw new ConnectorError("invalid_catalog");
      const destination = parse(destinationSchema, rawDestination, "invalid_catalog");
      const grant = rawGrant === null ? null : parse(GrantBindingSchema, rawGrant, "invalid_catalog");
      const expectedResource = destination.kind === "api" ? new URL(destination.origin).origin : destination.kind === "mcp_http" ? destination.endpoint : `${destination.kind === "cli" ? "executable" : "stdio"}:${destination.executable}`;
      if (grant !== null) {
        const network = destination.kind === "api" || destination.kind === "mcp_http";
        const deliveryAllowed = network ? grant.delivery.kind !== "environment" : grant.delivery.kind === "environment";
        if (!deliveryAllowed || grant.resource !== expectedResource || grant.organizationId !== metadata.organizationId || grant.ownerPrincipalId !== metadata.ownerPrincipalId) throw new ConnectorError("invalid_catalog");
      }
      const operations = new Map<string, ReviewedOperation>();
      const operationPins: JsonObject[] = [];
      for (const raw of rawOperations) {
        const { buildArguments, ...serializable } = raw;
        const operation = parse(operationSchema, serializable, "invalid_catalog");
        if (operation.schemaDigest !== digest({ inputSchema: operation.inputSchema, outputSchema: operation.outputSchema }) || operations.has(operation.name)) throw new ConnectorError("invalid_catalog");
        if ((destination.kind === "api") !== !!operation.api || (destination.kind === "cli") !== (typeof buildArguments === "function")) throw new ConnectorError("invalid_catalog");
        if (operation.api && new URL(operation.api.path, destination.kind === "api" ? destination.origin : "https://invalid.test").pathname !== operation.api.path) throw new ConnectorError("invalid_catalog");
        try {
          operations.set(operation.name, freeze({ ...operation, buildArguments: buildArguments ?? null, validateInput: validator.compile(operation.inputSchema), validateOutput: operation.outputSchema === null ? null : validator.compile(operation.outputSchema) }));
        } catch { throw new ConnectorError("invalid_catalog"); }
        operationPins.push(operation);
      }
      const catalogDigest = digest(parse(JsonObjectSchema, { ...metadata, destination, grant, operations: operationPins }));
      this.configurations.set(metadata.configurationRef, freeze({ ...metadata, destination, grant, operations, catalogDigest }));
    }
  }
  resolve(principal: Principal, connection: Connection, operationName: string): { configuration: ReviewedConnection; operation: ReviewedOperation } {
    const configuration = this.configurations.get(connection.configuration.configurationRef);
    if (!configuration || configuration.destination.kind !== connection.configuration.kind || configuration.organizationId !== principal.organizationId || configuration.principalId !== principal.id || configuration.ownerPrincipalId !== (principal.ownerId ?? principal.id)) throw new ConnectorError("unreviewed_operation");
    const operation = configuration.operations.get(operationName);
    if (!operation) throw new ConnectorError("unreviewed_operation");
    if (operation.requiredScopes.some(scope => !principal.scopes.includes(scope))) throw new ConnectorError("scope_denied");
    return { configuration, operation };
  }
}
export function schemaDigest(inputSchema: JsonObject, outputSchema: JsonObject | null = null): z.infer<typeof DigestSchema> { return digest({ inputSchema, outputSchema }); }
export function actualCost(cost: ReviewedCost, value: import("./model.js").Json): number | null {
  if (cost.settlement.kind === "fixed") return cost.settlement.actualMicros;
  if (cost.settlement.kind === "unknown") return null;
  const raw = pointer(value, cost.settlement.pointer);
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= cost.upperBoundMicros ? raw : null;
}
