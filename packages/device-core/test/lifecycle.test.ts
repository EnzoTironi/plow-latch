import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalize, makeIntent } from "@domo/protocol";
import { ApprovalStore, DeviceAgent, Executor, type IntentDecision, type PolicyDelegate } from "@domo/device-core";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "latch-lifecycle-"));
  roots.push(value);
  return fs.realpathSync(value);
}

function intent(deviceId = "device-1", file = "/tmp/latch-lifecycle.txt") {
  return makeIntent({ agentId: "agent-a", deviceId, request: "write fixture", sessionId: "session-a",
    capabilities: [{ kind: "fs.write", paths: [file] }] });
}

async function answerable(store: ApprovalStore): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await store.pending()).length) {
    if (Date.now() >= deadline) throw new Error("approval did not become pending");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("approval lifecycle", () => {
  it("consumes a decision once before an asynchronous continuation can replay it", async () => {
    let innerReply: (decision: IntentDecision) => void = () => {};
    const store = new ApprovalStore(root(), {
      decideIntent: () => new Promise((resolve) => { innerReply = resolve; }),
    });
    const requested = intent();
    const decided = store.decideIntent(requested);
    await answerable(store);
    expect(store.resolve(requested.intentId, "allow_once", "owner_protocol")).toBe(true);
    expect(store.resolve(requested.intentId, "always_allow", "replay")).toBe(false);
    innerReply("always_allow");
    expect(await decided).toEqual({ decision: "allow_once", source: "owner_protocol" });
    expect((await store.all())[0].decision).toBe("allow_once");
  });

  it("denies pending approvals on shutdown and rejects a late reply", async () => {
    const store = new ApprovalStore(root(), { decideIntent: () => new Promise(() => {}) });
    const requested = intent();
    const decided = store.decideIntent(requested);
    await answerable(store);
    await store.shutdown();
    expect(await decided).toEqual({ decision: "deny", source: "shutdown" });
    expect(store.resolve(requested.intentId, "allow_once")).toBe(false);
    expect(await store.pending()).toEqual([]);
    expect(await store.decideIntent(intent())).toEqual({ decision: "deny", source: "shutdown" });
  });

  it("does not open a prompt if shutdown races the durable pending write", async () => {
    let prompts = 0;
    const store = new ApprovalStore(root(), {
      async decideIntent() { prompts += 1; return "allow_once"; },
    });
    await store.ready;
    const decided = store.decideIntent(intent());
    await store.shutdown();
    expect(await decided).toEqual({ decision: "deny", source: "shutdown" });
    expect(prompts).toBe(0);
  });

  it.each([false, true])("contains a throwing observer, asynchronous=%s", async asynchronous => {
    const store = new ApprovalStore(root(), { async decideIntent() { return "allow_once"; } });
    store.onSettled = asynchronous ? async () => { throw new Error("observer failed"); } : () => { throw new Error("observer failed"); };
    expect(await store.decideIntent(intent())).toBe("allow_once");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect((await store.all())[0]).toMatchObject({ decision: "allow_once", status: "decided" });
    await store.shutdown();
  });
});

describe("device lifecycle", () => {
  it("never writes from an approval that returns after shutdown", async () => {
    const home = root();
    let answer: (decision: IntentDecision) => void = () => {};
    let opened: () => void = () => {};
    const asking = new Promise<void>((resolve) => { opened = resolve; });
    const delegate: PolicyDelegate = {
      decideIntent: () => { opened(); return new Promise((resolve) => { answer = resolve; }); },
    };
    const device = new DeviceAgent(home, "Lifecycle fixture", delegate, null, path.join(home, "owner"));
    const file = canonicalize(path.join(home, "late.txt"));
    const requested = intent(device.identity.deviceId, file);
    const operation = device.handleIntent(requested, { content_base64: Buffer.from("late write").toString("base64") });
    await asking;
    await device.shutdown();
    answer("always_allow");
    expect(await operation).toEqual({ status: "denied", reason: "device is shutting down" });
    expect(fs.existsSync(file)).toBe(false);
    const audit = fs.readFileSync(path.join(home, "device/audit.ndjson"), "utf8");
    expect(audit).toContain('"event":"intent_cancelled"');
    expect(audit).not.toContain('"event":"file_write"');
    expect(device.policy.allRules()).toEqual([]);
    await device.shutdown();
  });

  it("drains delayed settled records and terminal audit before shutdown returns", async () => {
    const home = root();
    const store = new ApprovalStore(path.join(home, "approvals"), { decideIntent: () => new Promise(() => {}) });
    const device = new DeviceAgent(home, "Drained fixture", store, null, path.join(home, "owner"));
    const original = fsp.writeFile;
    vi.spyOn(fsp, "writeFile").mockImplementation(async (...args: Parameters<typeof fsp.writeFile>) => {
      if (String(args[0]).startsWith(home) && typeof args[1] === "string" && args[1].includes('"recorded": false')) await new Promise(resolve => setTimeout(resolve, 100));
      return original(...args);
    });
    let completed = false;
    const file = canonicalize(path.join(home, "cancelled.txt"));
    const operation = device.handleIntent(intent(device.identity.deviceId, file), { content_base64: "bGF0ZQ==" }).then(value => { completed = true; return value; });
    await answerable(store);
    await device.shutdown();
    expect(completed).toBe(true);
    expect(await operation).toEqual({ status: "denied", reason: "device is shutting down" });
    expect(device.audit.entries().filter(entry => typeof entry === "object" && entry !== null && !Array.isArray(entry)).map(entry => entry.event)).toEqual(["intent_received", "intent_decision", "intent_cancelled"]);
    expect(await store.all()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe.runIf(process.platform === "darwin")("owned command shutdown", () => {
  it("terminates a command group and refuses a new launch", async () => {
    const executor = new Executor(root());
    const job = await executor.run({ argv: ["/bin/sh", "-c", "printf '%s\\n' $$; /bin/sleep 120"],
      readPaths: [], writePaths: [], network: false, appleEvents: false, waitMs: 100 });
    const pid = Number(job.output.toString("utf8").trim());
    expect(job.running).toBe(true);
    expect(pid).toBeGreaterThan(1);
    try {
      process.kill(-pid, 0);
      await executor.shutdown();
      expect(() => process.kill(-pid, 0)).toThrow();
      expect(executor.output(job.handle, 0).running).toBe(false);
      await executor.shutdown();
      await expect(executor.run({ argv: ["/usr/bin/true"], readPaths: [], writePaths: [],
        network: false, appleEvents: false, waitMs: 0 })).rejects.toThrow("shutting down");
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
  });

  it("terminates a descendant left after its shell already exited", async () => {
    const executor = new Executor(root());
    const job = await executor.run({ argv: ["/bin/sh", "-c", "/bin/sleep 120 & printf '%s\\n' $$"],
      readPaths: [], writePaths: [], network: false, appleEvents: false, waitMs: 1000 });
    const pid = Number(job.output.toString("utf8").trim());
    expect(job.running).toBe(false);
    expect(pid).toBeGreaterThan(1);
    try {
      process.kill(-pid, 0);
      await executor.shutdown();
      expect(() => process.kill(-pid, 0)).toThrow();
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
  });
});
