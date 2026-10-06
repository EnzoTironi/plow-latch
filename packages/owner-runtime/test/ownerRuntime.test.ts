import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ApprovalStore, DeviceAgent } from "@domo/device-core";
import { loadSettings, saveSettings } from "@domo/owner-core";
import { makeIntent } from "@domo/protocol";
import type { Intent, JSONValue } from "@domo/protocol";
import {
  OwnerController, createHostBinding,
} from "../src/index.js";
import type {
  HostBinding, HostResponse, HostTransport, NativeOwnerAdapter, OwnerChallenge,
} from "../src/index.js";

const node = process.execPath;
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function home(): string {
  const directory = mkdtempSync(join(tmpdir(), "latch-owner-runtime-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function host(input: { principalId?: string; ownerId?: string; userId?: string; connectionId?: string; enrollmentRevision?: number; transport?: Partial<HostTransport> } = {}): { binding: HostBinding; disconnect: AbortController } {
  const disconnect = new AbortController();
  const binding = createHostBinding({
    organizationId: "test_org", ownerId: input.ownerId ?? "test_owner", userId: input.userId ?? "test_user",
    principalId: input.principalId ?? "agent_a", connectionId: input.connectionId ?? "test_connection",
    enrollmentRevision: input.enrollmentRevision ?? 1, expiresAt: Date.now() + 60_000, assurance: "trusted_host_form",
  }, {
    signal: disconnect.signal, isCurrent: () => true,
    verifyResponse: async () => ({ evidenceRef: "fixture_transport_evidence" }),
    ...input.transport,
  });
  return { binding, disconnect };
}

function response(challenge: OwnerChallenge, choice: HostResponse["choice"] = "allow_once"): HostResponse {
  const action = challenge.action;
  return {
    actionId: action.id, revision: action.revision, nonce: action.nonce,
    argumentsDigest: action.argumentsDigest, capabilityDigest: action.capabilityDigest,
    policyRevision: action.policyRevision, enrollmentRevision: action.enrollmentRevision, choice,
  };
}

async function eventually<T>(read: () => T | null): Promise<T> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise<void>(resolve => setTimeout(resolve, 2));
  }
  throw new Error("state did not become available");
}

function crashedProposal(directory: string): OwnerChallenge {
  const script = `
    const { OwnerController, createHostBinding } = await import(${JSON.stringify(pathToFileURL(resolve("packages/owner-runtime/dist/index.js")).href)});
    const owner = new OwnerController({ home: ${JSON.stringify(directory)} });
    const binding = createHostBinding({ organizationId:'test_org', ownerId:'test_owner', userId:'test_user', principalId:'agent_a', connectionId:'test_connection', enrollmentRevision:1, expiresAt:Date.now()+60000, assurance:'trusted_host_form' }, { signal:new AbortController().signal, isCurrent:()=>true, verifyResponse:async()=>({ evidenceRef:'fixture_transport_evidence' }) });
    const challenge = owner.propose(binding,{ kind:'set_mode',mode:'approve',expectedRevision:owner.snapshot(binding).policyRevision });
    process.stdout.write(JSON.stringify(challenge));
    process.exit(0);
  `;
  const child = spawnSync(node, ["--input-type=module", "-e", script], { encoding: "utf8" });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}

async function fixture(options: { ttlMs?: number; standingRuleTtlMs?: number; mode?: "approve" | "adversarial" | "ask" | "deny"; nativeAdapter?: NativeOwnerAdapter; cachedSettings?: boolean } = {}) {
  const directory = home();
  const settings = loadSettings(directory);
  settings.approvalMode = options.mode ?? "ask";
  settings.agentPurpose = "temporary runtime test";
  saveSettings(directory, settings);
  const owner = new OwnerController({ home: directory, standingRuleTtlMs: options.standingRuleTtlMs ?? 2_000, receiptWaitMs: 300, nativeAdapter: options.nativeAdapter });
  let device: DeviceAgent;
  const policy = owner.nativePolicy({ apiBaseUrl: "https://unused.example.test", plowRoot: join(directory, "Plow"), record: (event, fields) => device.audit.record(event, fields), settings: options.cachedSettings ? () => settings : undefined });
  const approvals = new ApprovalStore(join(directory, "device/approvals"), policy, options.ttlMs ?? 10_000);
  device = new DeviceAgent(directory, "isolated owner runtime test", approvals, null);
  await approvals.ready;
  owner.observeNative(device, approvals);
  cleanups.push(async () => { await device.shutdown(); await owner.close(); });
  const make = (agentId = "agent_a", fileName = "input.txt"): Intent => {
    const file = join(directory, fileName);
    writeFileSync(file, `${agentId}:${fileName}`);
    return makeIntent({ agentId, agentDisplay: "same display name", deviceId: device.identity.deviceId, request: `read ${file}`, capabilities: [{ kind: "fs.read", paths: [file] }], sessionId: "test_session" });
  };
  const run = (binding: HostBinding, intent: Intent, args: JSONValue = { path: intent.request }) => owner.interaction(binding, { requesterId: intent.agentId, arguments: args }).run(intent, () => device.handleIntent(intent));
  const challenge = (binding: HostBinding, intent: Intent) => eventually(() => {
    const review = owner.review(binding, { intentId: intent.intentId });
    return review.kind === "challenge" ? review.challenge : null;
  });
  return { directory, owner, device, approvals, make, run, challenge };
}

describe("trusted owner boundary", () => {
  it("preserves scoped receipt history across restart without exposing challenge pins or authorizing a new connection", async () => {
    const directory = home();
    const first = new OwnerController({ home: directory });
    const owner = host().binding;
    const challenge = first.propose(owner, { kind: "set_purpose", purpose: "Private owner instruction", expectedRevision: first.snapshot(owner).policyRevision });
    const receipt = await first.respond(owner, response(challenge));
    await first.close();
    const restarted = new OwnerController({ home: directory });
    cleanups.push(() => restarted.close());
    const renewed = host({ connectionId: "new_verified_connection", enrollmentRevision: 2 }).binding;
    const history = restarted.history(renewed);
    expect(history).toMatchObject({ total: 1, actions: [{ actionId: challenge.action.id, kind: "set_purpose", receipt }] });
    expect(history.actions[0]).not.toHaveProperty("nonce");
    expect(JSON.stringify(history)).not.toContain("Private owner instruction");
    expect(() => restarted.receipt(renewed, challenge.action.id)).toThrow("wrong_owner");
    for (const foreign of [host({ ownerId: "another_owner" }), host({ userId: "another_user" }), host({ principalId: "another_principal" })]) expect(restarted.history(foreign.binding)).toMatchObject({ total: 0, actions: [] });
    expect(restarted.history(renewed, { limit: 1, offset: 1 })).toMatchObject({ total: 1, actions: [] });
  });
  it("fails closed without a verified enrolled host and rejects forged JSON bindings", async () => {
    const f = await fixture();
    const intent = f.make();
    await expect(f.device.handleIntent(intent)).resolves.toEqual({ status: "denied" });
    expect(f.device.audit.entries()).toContainEqual(expect.objectContaining({ event: "intent_decision", source: "owner_unavailable", decision: "deny" }));
    const forged = JSON.parse(JSON.stringify(host().binding));
    expect(() => f.owner.snapshot(forged)).toThrow("owner_not_enrolled");
    expect(f.device.policy.allRules()).toHaveLength(0);
  });

  it("rejects wrong user, owner, principal, connection, enrollment revision and changed challenge pins", async () => {
    const f = await fixture();
    const h = host();
    const intent = f.make();
    const executing = f.run(h.binding, intent, { path: "canonical input" });
    const challenge = await f.challenge(h.binding, intent);
    for (const changed of [host({ userId: "wrong_user" }), host({ ownerId: "wrong_owner" }), host({ principalId: "agent_b" }), host({ connectionId: "wrong_connection" }), host({ enrollmentRevision: 2 })]) {
      await expect(f.owner.respond(changed.binding, response(challenge))).rejects.toThrow("wrong_owner");
    }
    for (const changed of [
      { nonce: "00000000-0000-4000-8000-000000000001" },
      { revision: 2 }, { argumentsDigest: "0".repeat(64) }, { capabilityDigest: "0".repeat(64) },
      { policyRevision: 2 }, { enrollmentRevision: 2 },
    ]) await expect(f.owner.respond(h.binding, { ...response(challenge), ...changed })).rejects.toThrow("conflict");
    expect(f.device.audit.entries().filter(entry => typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.event === "file_read")).toHaveLength(0);
    await f.owner.respond(h.binding, response(challenge, "deny"));
    await expect(executing).resolves.toEqual({ status: "denied" });
  });

  it("requires verified host evidence after validating the server-created form", async () => {
    const f = await fixture();
    const h = host({ transport: { verifyResponse: async () => null } });
    const intent = f.make();
    const executing = f.run(h.binding, intent);
    const challenge = await f.challenge(h.binding, intent);
    expect(challenge.form.requestedSchema.properties.choice.enum).toEqual(["allow_once", "always_allow", "deny"]);
    await expect(f.owner.respond(h.binding, response(challenge))).rejects.toThrow("owner_not_enrolled");
    expect(f.owner.receipt(h.binding, challenge.action.id).status).toBe("pending");
    h.disconnect.abort();
    await expect(executing).resolves.toEqual({ status: "denied" });
  });

  it("keeps settings control proposals bound to real revisions and excludes their private text from SQLite", async () => {
    const f = await fixture();
    const h = host();
    const first = f.owner.snapshot(h.binding).policyRevision;
    const stale = f.owner.propose(h.binding, { kind: "set_mode", mode: "approve", expectedRevision: first });
    const purpose = "PRIVATE_PURPOSE_SHOULD_NOT_ENTER_ACTION_LEDGER";
    const change = f.owner.propose(h.binding, { kind: "set_purpose", purpose, expectedRevision: first });
    const receipt = await f.owner.respond(h.binding, response(change));
    expect(receipt).toMatchObject({ status: "settled", execution: { kind: "applied", policyRevision: first + 1 } });
    expect(loadSettings(f.directory).agentPurpose).toBe(purpose);
    await expect(f.owner.respond(h.binding, response(stale))).rejects.toThrow("cancelled");
    const mode = f.owner.propose(h.binding, { kind: "set_mode", mode: "deny", expectedRevision: first + 1 });
    await f.owner.respond(h.binding, response(mode));
    expect(loadSettings(f.directory).approvalMode).toBe("deny");
    expect(() => f.owner.propose(h.binding, { kind: "set_mode", mode: "approve", expectedRevision: first })).toThrow("conflict");
    expect(readFileSync(join(f.directory, "device/owner/actions.sqlite")).includes(Buffer.from(purpose))).toBe(false);
    expect(readFileSync(join(f.directory, "device/owner/actions.sqlite-wal")).includes(Buffer.from(purpose))).toBe(false);
  });

  it("updates the retained production settings object after a durable owner setting change", async () => {
    const f = await fixture({ cachedSettings: true });
    const h = host();
    const change = f.owner.propose(h.binding, { kind: "set_mode", mode: "approve", expectedRevision: f.owner.snapshot(h.binding).policyRevision });
    await f.owner.respond(h.binding, response(change));
    expect(f.owner.snapshot(h.binding).settings.approvalMode).toBe("approve");
    const intent = f.make();
    await f.device.handleIntent(intent);
    expect(f.device.audit.entries()).toContainEqual(expect.objectContaining({ event: "intent_decision", source: "approve", decision: "allow_once" }));
    expect(loadSettings(f.directory).approvalMode).toBe("approve");
  });

  it("rejects verification completed after owner revocation", async () => {
    const f = await fixture();
    let release = () => {};
    const hold = new Promise<void>(resolve => { release = resolve; });
    const h = host({ transport: { verifyResponse: async () => { await hold; return { evidenceRef: "fixture_transport_evidence" }; } } });
    const intent = f.make();
    const executing = f.run(h.binding, intent);
    const challenge = await f.challenge(h.binding, intent);
    const verifying = f.owner.respond(h.binding, response(challenge, "always_allow"));
    f.owner.cancelScope({ organizationId: "test_org", ownerId: "test_owner" }, "revoked");
    release();
    await expect(verifying).rejects.toThrow("cancelled");
    await executing;
    expect(f.device.policy.allRules()).toHaveLength(0);
  });
});

describe("native decision receipts", () => {
  it("settles automatic Plow-folder decisions without retaining a pending owner ticket", async () => {
    const f = await fixture();
    const h = host();
    mkdirSync(join(f.directory, "Plow"), { recursive: true });
    const intent = f.make("agent_a", "Plow/free.txt");
    await f.run(h.binding, intent);
    expect(f.owner.snapshot(h.binding).approvals).toHaveLength(0);
    const raw = new DatabaseSync(join(f.directory, "device/owner/actions.sqlite"));
    const row = z.object({ data: z.string() }).parse(raw.prepare("SELECT data FROM owner_actions").get());
    const record = z.object({
      action: z.object({ id: z.string().uuid() }), state: z.literal("settled"),
      receipt: z.object({ standingRule: z.literal("unchanged"), execution: z.object({ kind: z.literal("decided"), source: z.literal("plow_folder") }) }),
    }).parse(JSON.parse(row.data));
    raw.close();
    expect(f.owner.receipt(h.binding, record.action.id)).toMatchObject({ status: "settled", execution: { decision: "allow_once", source: "plow_folder" } });
  });

  it("replays a delayed duplicate after the first choice has changed the policy revision", async () => {
    const f = await fixture();
    let verification = 0;
    let release = () => {};
    const hold = new Promise<void>(resolve => { release = resolve; });
    const h = host({ transport: { verifyResponse: async () => {
      verification += 1;
      if (verification === 2) await hold;
      return { evidenceRef: "fixture_transport_evidence" };
    } } });
    const intent = f.make();
    const executing = f.run(h.binding, intent);
    const challenge = await f.challenge(h.binding, intent);
    const original = f.owner.respond(h.binding, response(challenge, "always_allow"));
    const duplicate = f.owner.respond(h.binding, response(challenge, "always_allow"));
    const receipt = await original;
    release();
    await expect(duplicate).resolves.toEqual(receipt);
    await executing;
    expect(f.device.policy.allRules()).toHaveLength(1);
  });

  it("reads the durable audit if a different best-effort event listener interrupts notification", async () => {
    const f = await fixture();
    const h = host();
    const intent = f.make();
    const executing = f.run(h.binding, intent);
    const challenge = await f.challenge(h.binding, intent);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const listener = () => { throw new Error("fixture event interruption"); };
    f.device.audit.events.prependListener("recorded", listener);
    try {
      await expect(f.owner.respond(h.binding, response(challenge, "deny"))).resolves.toMatchObject({ status: "settled", execution: { kind: "decided", decision: "deny", source: "ask" } });
      await executing;
    } finally {
      f.device.audit.events.off("recorded", listener);
      quiet.mockRestore();
    }
  });

  it("retains all four production modes and the stored-rule veto", async () => {
    for (const [mode, source, decision] of [
      ["approve", "approve", "allow_once"], ["deny", "policy", "deny"], ["adversarial", "no_reviewer", "deny"],
    ] satisfies ["approve" | "deny" | "adversarial", string, string][]) {
      const f = await fixture({ mode });
      const intent = f.make();
      f.device.policy.storeRule(intent);
      await f.device.handleIntent(intent);
      expect(f.device.audit.entries()).toContainEqual(expect.objectContaining({ event: "intent_decision", source: mode === "approve" ? "rule" : source, decision: mode === "approve" ? "always_allow" : decision }));
    }
    const f = await fixture({ mode: "ask" });
    const h = host();
    const intent = f.make();
    const executing = f.run(h.binding, intent);
    const challenge = await f.challenge(h.binding, intent);
    await f.owner.respond(h.binding, response(challenge, "deny"));
    await executing;
    expect(f.device.audit.entries()).toContainEqual(expect.objectContaining({ event: "intent_decision", source: "ask", decision: "deny" }));
  });

  it("waits for actual audit and decisionRecorded, then returns the same receipt for duplicate choices", async () => {
    const f = await fixture();
    const h = host();
    const intent = f.make();
    let release = () => {};
    const hold = new Promise<void>(resolve => { release = resolve; });
    const original = f.approvals.decisionRecorded.bind(f.approvals);
    f.approvals.decisionRecorded = async intentId => { await hold; await original(intentId); };
    const executing = f.run(h.binding, intent);
    const challenge = await f.challenge(h.binding, intent);
    let delivered = false;
    const accepted = f.owner.respond(h.binding, response(challenge)).then(receipt => { delivered = true; return receipt; });
    await eventually(() => f.device.audit.entries().some(entry => typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.event === "intent_decision") ? true : null);
    expect(delivered).toBe(false);
    expect(f.owner.receipt(h.binding, challenge.action.id)).toMatchObject({ status: "recording", execution: { kind: "recording" } });
    release();
    const receipt = await accepted;
    expect(receipt).toMatchObject({ status: "settled", execution: { kind: "decided", decision: "allow_once", source: "ask" }, standingRule: "unchanged" });
    await executing;
    await expect(f.owner.respond(h.binding, response(challenge))).resolves.toEqual(receipt);
    await expect(f.owner.respond(h.binding, response(challenge, "always_allow"))).rejects.toThrow("conflict");
    expect(f.device.audit.entries().filter(entry => typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.event === "intent_decision")).toHaveLength(1);
    expect(f.device.audit.entries().filter(entry => typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.event === "file_read")).toHaveLength(1);
  });

  it("uses the sole production rule writer once and revokes rules through trusted evidence", async () => {
    const f = await fixture();
    const h = host();
    const intent = f.make();
    const executing = f.run(h.binding, intent);
    const challenge = await f.challenge(h.binding, intent);
    const receipts = await Promise.all([f.owner.respond(h.binding, response(challenge, "always_allow")), f.owner.respond(h.binding, response(challenge, "always_allow"))]);
    expect(receipts[0]).toEqual(receipts[1]);
    await executing;
    const rule = f.device.policy.allRules()[0];
    expect(rule).toBeDefined();
    expect(f.device.audit.entries().filter(entry => typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.event === "rule_stored")).toHaveLength(1);
    const revoke = f.owner.propose(h.binding, { kind: "revoke_rule", ruleKey: rule.ruleKey, expectedRevision: f.owner.snapshot(h.binding).policyRevision });
    await f.owner.respond(h.binding, response(revoke));
    expect(f.device.policy.allRules()).toHaveLength(0);
    await f.owner.respond(h.binding, response(challenge, "always_allow"));
    expect(f.device.policy.allRules()).toHaveLength(0);
    expect(f.device.audit.entries().filter(entry => typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.event === "rule_revoked")).toHaveLength(1);
  });

  it("releases the execution queue at expiry and permits a finite late standing rule without executing again", async () => {
    const f = await fixture({ ttlMs: 130, standingRuleTtlMs: 1_000 });
    const h = host();
    const expired = f.make("agent_a", "expired.txt");
    const first = f.run(h.binding, expired);
    const initial = await f.challenge(h.binding, expired);
    await new Promise<void>(resolve => setTimeout(resolve, 60));
    const subsequent = f.make("agent_a", "subsequent.txt");
    const second = f.run(h.binding, subsequent);
    await expect(first).resolves.toMatchObject({ status: "denied" });
    const next = await f.challenge(h.binding, subsequent);
    await f.owner.respond(h.binding, response(next));
    await second;
    const late = f.owner.review(h.binding, { intentId: expired.intentId });
    expect(late.kind).toBe("challenge");
    await expect(f.owner.respond(h.binding, response(initial, "allow_once"))).rejects.toThrow("expired");
    const receipt = await f.owner.respond(h.binding, response(initial, "always_allow"));
    expect(receipt).toMatchObject({ status: "settled", execution: { kind: "decided", decision: "deny", source: "expired" }, standingRule: "stored" });
    expect(f.device.policy.allRules()).toHaveLength(1);
    const reads = f.device.audit.entries().filter(entry => typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.event === "file_read");
    expect(reads).toHaveLength(1);
    expect(JSON.stringify(reads)).toContain("subsequent.txt");
    expect(JSON.stringify(reads)).not.toContain("expired.txt");
  });

  it("expires the standing-rule ticket and rejects later grants", async () => {
    const f = await fixture({ ttlMs: 35, standingRuleTtlMs: 35 });
    const h = host();
    const intent = f.make();
    const executing = f.run(h.binding, intent);
    const challenge = await f.challenge(h.binding, intent);
    await executing;
    await eventually(() => f.owner.receipt(h.binding, challenge.action.id).standingRule === "expired" ? true : null);
    await expect(f.owner.respond(h.binding, response(challenge, "always_allow"))).rejects.toThrow("cancelled");
    expect(f.device.policy.allRules()).toHaveLength(0);
  });

  it("sweeps a matching queued request through production policy after saving a standing rule", async () => {
    const f = await fixture();
    const h = host();
    const firstIntent = f.make();
    const first = f.run(h.binding, firstIntent);
    const challenge = await f.challenge(h.binding, firstIntent);
    const secondIntent = f.make();
    const second = f.run(h.binding, secondIntent);
    await eventually(() => f.owner.snapshot(h.binding).approvals.length === 2 ? true : null);
    await f.owner.respond(h.binding, response(challenge, "always_allow"));
    await Promise.all([first, second]);
    expect(f.device.audit.entries()).toContainEqual(expect.objectContaining({ event: "intent_decision", intentId: secondIntent.intentId, decision: "always_allow", source: "rule" }));
    expect(f.device.policy.allRules()).toHaveLength(1);
  });
});

describe("lifetime and request isolation", () => {
  it("retains two concurrent intent bindings for principals with the same display name", async () => {
    const f = await fixture();
    const a = host();
    const b = host({ principalId: "agent_b", connectionId: "connection_b" });
    const intentA = f.make("agent_a", "a.txt");
    const intentB = f.make("agent_b", "b.txt");
    const first = f.run(a.binding, intentA, { path: "a" });
    const challengeA = await f.challenge(a.binding, intentA);
    const second = f.run(b.binding, intentB, { path: "b" });
    await eventually(() => f.owner.snapshot(b.binding).approvals.length === 1 ? true : null);
    expect(f.owner.snapshot(a.binding).approvals.map(item => item.intentId)).toEqual([intentA.intentId]);
    expect(f.owner.snapshot(b.binding).approvals.map(item => item.intentId)).toEqual([intentB.intentId]);
    await expect(f.owner.respond(b.binding, response(challengeA))).rejects.toThrow("wrong_owner");
    await f.owner.respond(a.binding, response(challengeA, "deny"));
    const challengeB = await f.challenge(b.binding, intentB);
    expect(challengeB.action.argumentsDigest).not.toBe(challengeA.action.argumentsDigest);
    expect(challengeB.action.requesterId).toBe("agent_b");
    await f.owner.respond(b.binding, response(challengeB));
    await expect(first).resolves.toEqual({ status: "denied" });
    await second;
    expect(f.owner.snapshot(a.binding).approvals).toHaveLength(0);
    expect(f.owner.snapshot(b.binding).approvals).toHaveLength(0);
  });

  it("cancels both tickets on disconnection and advances the next request", async () => {
    const f = await fixture();
    const a = host();
    const b = host({ principalId: "agent_b", connectionId: "connection_b" });
    const intentA = f.make();
    const first = f.run(a.binding, intentA);
    const challengeA = await f.challenge(a.binding, intentA);
    const intentB = f.make("agent_b", "b.txt");
    const second = f.run(b.binding, intentB);
    a.disconnect.abort();
    await expect(first).resolves.toEqual({ status: "denied" });
    await expect(f.owner.respond(a.binding, response(challengeA, "always_allow"))).rejects.toThrow("owner_not_enrolled");
    const challengeB = await f.challenge(b.binding, intentB);
    await f.owner.respond(b.binding, response(challengeB, "deny"));
    await second;
    expect(f.device.policy.allRules()).toHaveLength(0);
  });

  it("revocation and supersession reject old evidence without reviving execution", async () => {
    const f = await fixture();
    const h = host();
    const intent = f.make();
    const executing = f.run(h.binding, intent);
    const challenge = await f.challenge(h.binding, intent);
    f.owner.cancelScope({ organizationId: "test_org", ownerId: "test_owner" }, "revoked");
    await executing;
    await expect(f.owner.respond(h.binding, response(challenge, "always_allow"))).rejects.toThrow("cancelled");
    expect(f.owner.receipt(h.binding, challenge.action.id)).toMatchObject({ status: "cancelled", standingRule: "cancelled", execution: { kind: "decided", decision: "deny" } });
    const secondIntent = f.make("agent_a", "second.txt");
    const second = f.run(h.binding, secondIntent);
    const superseded = await f.challenge(h.binding, secondIntent);
    const changed = loadSettings(f.directory);
    changed.approvalMode = "deny";
    saveSettings(f.directory, changed);
    await expect(f.owner.respond(h.binding, response(superseded, "always_allow"))).rejects.toThrow("conflict");
    await second;
    expect(f.owner.receipt(h.binding, superseded.action.id).reason).toBe("superseded");
    expect(f.device.policy.allRules()).toHaveLength(0);
  });

  it("uses the legacy trusted form callback through the same host response path", async () => {
    const f = await fixture();
    const h = host({ transport: { requestForm: async challenge => response(challenge, "deny") } });
    const intent = f.make();
    await expect(f.run(h.binding, intent)).resolves.toEqual({ status: "denied" });
    expect(f.device.audit.entries()).toContainEqual(expect.objectContaining({ event: "intent_decision", source: "ask", decision: "deny" }));
  });

  it("reports unavailable native controls and preserves unknown effects when their adapter is cancelled", async () => {
    const f = await fixture();
    const h = host();
    const challenge = f.owner.propose(h.binding, { kind: "native_control", operation: "vault.unlock", input: {}, expectedRevision: f.owner.snapshot(h.binding).policyRevision });
    await expect(f.owner.respond(h.binding, response(challenge))).resolves.toMatchObject({ status: "settled", execution: { kind: "unavailable", reason: "native_adapter_unavailable" } });
    let release: (result: { kind: "applied" }) => void = () => {};
    const adapter: NativeOwnerAdapter = { availability: () => ({ kind: "ready" }), perform: () => new Promise(resolve => { release = resolve; }) };
    const pending = await fixture({ nativeAdapter: adapter });
    const action = pending.owner.propose(h.binding, { kind: "native_control", operation: "updates.install", input: {}, expectedRevision: pending.owner.snapshot(h.binding).policyRevision });
    const accepting = pending.owner.respond(h.binding, response(action));
    await eventually(() => pending.owner.receipt(h.binding, action.action.id).execution.kind === "recording" ? true : null);
    pending.owner.cancelScope({ organizationId: "test_org", ownerId: "test_owner" }, "revoked");
    release({ kind: "applied" });
    await expect(accepting).resolves.toMatchObject({ status: "cancelled", execution: { kind: "outcome_unknown" } });
  });
});

describe("durable restart", () => {
  it("abandons pending owner actions on restart and never applies their old choices", async () => {
    const directory = home();
    const challenge = crashedProposal(directory);
    const owner = new OwnerController({ home: directory });
    cleanups.push(() => owner.close());
    const h = host();
    expect(owner.receipt(h.binding, challenge.action.id)).toMatchObject({ status: "abandoned", execution: { kind: "outcome_unknown" }, reason: "restart" });
    await expect(owner.respond(h.binding, response(challenge))).rejects.toThrow("cancelled");
    expect(loadSettings(directory).approvalMode).toBe("adversarial");
  });

  it("recovers a crashed writer when its PID now belongs to a different process birth", async () => {
    const directory = home();
    const challenge = crashedProposal(directory);
    const raw = new DatabaseSync(join(directory, "device/owner/actions.sqlite"));
    raw.prepare("UPDATE owner_writer SET pid=?,birth=?").run(process.pid, "prior_process_birth");
    raw.close();
    const owner = new OwnerController({ home: directory });
    cleanups.push(() => owner.close());
    const h = host();
    expect(owner.receipt(h.binding, challenge.action.id)).toMatchObject({ status: "abandoned", reason: "restart" });
    await expect(owner.respond(h.binding, response(challenge))).rejects.toThrow("cancelled");
    expect(loadSettings(directory).approvalMode).toBe("adversarial");
  });

  it("preserves a live writer conservatively when its process birth cannot be verified", () => {
    const directory = home();
    crashedProposal(directory);
    const raw = new DatabaseSync(join(directory, "device/owner/actions.sqlite"));
    raw.prepare("UPDATE owner_writer SET pid=?,birth=NULL").run(process.pid);
    expect(() => new OwnerController({ home: directory })).toThrow("writer_exists");
    const row = z.object({ data: z.string() }).parse(raw.prepare("SELECT data FROM owner_actions").get());
    expect(z.object({ state: z.literal("pending") }).parse(JSON.parse(row.data)).state).toBe("pending");
    raw.close();
  });

  it("reconciles a claimed native answer with the real audit handoff without executing it after restart", async () => {
    const directory = home();
    const script = `
      const { OwnerController, createHostBinding } = await import(${JSON.stringify(pathToFileURL(resolve("packages/owner-runtime/dist/index.js")).href)});
      const { DeviceAgent, ApprovalStore } = await import('@domo/device-core');
      const { loadSettings, saveSettings } = await import('@domo/owner-core');
      const { makeIntent } = await import('@domo/protocol');
      const { join } = await import('node:path');
      const { writeFileSync } = await import('node:fs');
      const home=${JSON.stringify(directory)};
      const settings=loadSettings(home); settings.approvalMode='ask'; saveSettings(home,settings);
      const owner=new OwnerController({home});
      let device;
      const delegate=owner.nativePolicy({apiBaseUrl:'https://unused.example.test',plowRoot:join(home,'Plow'),record:(e,f)=>device.audit.record(e,f)});
      const approvals=new ApprovalStore(join(home,'device/approvals'),delegate);
      device=new DeviceAgent(home,'restart fixture',approvals,null); await approvals.ready; owner.observeNative(device,approvals);
      const binding=createHostBinding({organizationId:'test_org',ownerId:'test_owner',userId:'test_user',principalId:'agent_a',connectionId:'test_connection',enrollmentRevision:1,expiresAt:Date.now()+60000,assurance:'trusted_host_form'},{signal:new AbortController().signal,isCurrent:()=>true,verifyResponse:async()=>({evidenceRef:'fixture_transport_evidence'})});
      const file=join(home,'never-reexecute.txt');writeFileSync(file,'test');
      const intent=makeIntent({agentId:'agent_a',agentDisplay:'same display name',deviceId:device.identity.deviceId,request:'read file',capabilities:[{kind:'fs.read',paths:[file]}],sessionId:'test_session'});
      void owner.interaction(binding,{requesterId:'agent_a',arguments:{path:file}}).run(intent,()=>device.handleIntent(intent,null,()=>process.exit(0)));
      let review;
      do {await new Promise(r=>setTimeout(r,2));review=owner.review(binding,{intentId:intent.intentId});} while(review.kind!=='challenge');
      const a=review.challenge.action;
      process.stdout.write(JSON.stringify(review.challenge));
      void owner.respond(binding,{actionId:a.id,revision:a.revision,nonce:a.nonce,argumentsDigest:a.argumentsDigest,capabilityDigest:a.capabilityDigest,policyRevision:a.policyRevision,enrollmentRevision:a.enrollmentRevision,choice:'allow_once'});
    `;
    const child = spawnSync(node, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 5_000 });
    expect(child.status, child.stderr).toBe(0);
    const challenge: OwnerChallenge = JSON.parse(child.stdout);
    const owner = new OwnerController({ home: directory });
    let device: DeviceAgent;
    const delegate = owner.nativePolicy({ apiBaseUrl: "https://unused.example.test", plowRoot: join(directory, "Plow"), record: (event, fields) => device.audit.record(event, fields) });
    const approvals = new ApprovalStore(join(directory, "device/approvals"), delegate);
    device = new DeviceAgent(directory, "restart fixture", approvals, null);
    approvals.onUnrecorded = record => device.audit.record("intent_decision", { intentId: record.intentId, decision: record.decision ?? "deny", source: record.source ?? "prompt" });
    await approvals.ready;
    owner.observeNative(device, approvals);
    cleanups.push(async () => { await device.shutdown(); await owner.close(); });
    const h = host();
    const receipt = owner.receipt(h.binding, challenge.action.id);
    expect(receipt).toMatchObject({ status: "settled", execution: { kind: "decided", decision: "allow_once", source: "ask" }, reason: "restart_reconciled" });
    await expect(owner.respond(h.binding, response(challenge))).resolves.toEqual(receipt);
    expect(device.audit.entries().filter(entry => typeof entry === "object" && entry !== null && !Array.isArray(entry) && entry.event === "file_read")).toHaveLength(0);
    expect(await approvals.pending()).toHaveLength(0);
  });

  it("keeps a single SQLite writer and waits for audited shutdown before closing the ledger", async () => {
    const f = await fixture();
    expect(() => new OwnerController({ home: f.directory })).toThrow("writer_exists");
    const h = host();
    const intent = f.make();
    const executing = f.run(h.binding, intent);
    const challenge = await f.challenge(h.binding, intent);
    const closing = f.owner.close();
    await executing;
    await closing;
    const restarted = new OwnerController({ home: f.directory });
    cleanups.push(() => restarted.close());
    expect(restarted.receipt(h.binding, challenge.action.id)).toMatchObject({ status: "cancelled", standingRule: "cancelled", execution: { kind: "decided", decision: "deny" }, reason: "shutdown" });
  });

  it("vetoes cached standing rules once owner shutdown starts", async () => {
    const f = await fixture();
    const intent = f.make();
    f.device.policy.storeRule(intent);
    await f.owner.close();
    await expect(f.device.handleIntent(intent)).resolves.toMatchObject({ status: "denied" });
    expect(f.device.audit.entries()).toContainEqual(expect.objectContaining({ event: "intent_decision", source: "shutdown", decision: "deny" }));
  });
});
