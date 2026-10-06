import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { alice, httpFixture, operation, removeRoot, runtime, stdio, temporaryRoot } from "./transportFixtures.js";

const roots: string[] = [], closers: (() => Promise<void>)[] = [], cleanupPids: number[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const pid of cleanupPids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  for (const root of roots.splice(0)) await removeRoot(root);
});
async function root() { const value = await temporaryRoot(); roots.push(value); return value; }
function track<T extends { close: () => Promise<void> }>(value: T): T { closers.push(value.close); return value; }
async function eventually<T>(read: () => Promise<T>): Promise<T> {
  for (let index = 0; index < 500; index++) { try { return await read(); } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  return read();
}
async function dead(pid: number): Promise<boolean> {
  for (let index = 0; index < 300; index++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return true; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}
function startup(directory: string): string {
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(join(directory, "descendant-started.txt"))},'descendant-started');process.stdout.write('ready');setInterval(()=>{},1000);`;
  return `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const descendant=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore']});
await new Promise((resolve,reject)=>{descendant.stdout.once('data',resolve);descendant.once('error',reject);});
descendant.stdout.destroy();descendant.unref();
writeFileSync(${JSON.stringify(join(directory, "pids.json"))},JSON.stringify({parent:process.pid,descendant:descendant.pid,home:process.env.HOME}));
appendFileSync(${JSON.stringify(join(directory, "startup-effects.txt"))},'startup-effect\\n');`;
}
const pidsSchema = z.object({ parent: z.number().int().positive(), descendant: z.number().int().positive(), home: z.string() });

describe("MCP startup and process-group transport fixtures, not provider proof", () => {
  it("retains startup uncertainty and reaps ordinary descendants when SDK schema discovery refuses drift", async () => {
    const directory = await root(), program = await stdio(directory, { changedSchema: true, startupSource: startup(directory) });
    const subject = track(await runtime(directory, { kind: "mcp_stdio", destination: { kind: "mcp_stdio", ...program }, operation: operation({ timeoutMs: 5000 }) }));
    const job = await subject.call("refuse drift"); await subject.dispatcher.wait(alice, job.id);
    const pids = pidsSchema.parse(JSON.parse(await readFile(join(directory, "pids.json"), "utf8"))); cleanupPids.push(pids.parent, pids.descendant);
    expect(await readFile(join(directory, "startup-effects.txt"), "utf8")).toBe("startup-effect\n");
    expect(await readFile(join(directory, "descendant-started.txt"), "utf8")).toBe("descendant-started");
    expect(subject.store.getJob(alice, job.id).outcome.kind).toBe("outcome_unknown");
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { errorCode: "schema_drift" } });
    expect(subject.store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 7 });
    expect(await dead(pids.parent)).toBe(true); expect(await dead(pids.descendant)).toBe(true);
    await expect(readFile(pids.home)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await subject.call("refuse drift")).id).toBe(job.id);
    expect(await readFile(join(directory, "startup-effects.txt"), "utf8")).toBe("startup-effect\n");
  });
  it("retains its reservation when a child records a startup effect and fails the SDK handshake", async () => {
    const directory = await root(), marker = join(directory, "startup-effects.txt");
    const program = await stdio(directory, { source: `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(marker)},'startup-effect\\n');process.exit(7);` });
    const subject = track(await runtime(directory, { kind: "mcp_stdio", destination: { kind: "mcp_stdio", ...program }, operation: operation({ timeoutMs: 5000 }) }));
    const job = await subject.call(); await subject.dispatcher.wait(alice, job.id);
    expect(await readFile(marker, "utf8")).toBe("startup-effect\n");
    expect(subject.store.getJob(alice, job.id).outcome.kind).toBe("outcome_unknown");
    expect(subject.dispatcher.result(alice, job.id)?.value).toMatchObject({ output: { errorCode: "transport_failed" } });
    expect(subject.store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 7 });
  });
  it("counts HTTP initialization as an effect when the real endpoint fails the SDK handshake", async () => {
    const directory = await root(), marker = join(directory, "http-startup-effects.txt");
    const fixture = track(await httpFixture({ handler: (_req, res, body) => { const request = JSON.parse(body.toString("utf8")); appendFileSync(marker, `${request.method}\n`); res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":"fixture unavailable"}'); } }));
    const subject = track(await runtime(directory, { kind: "mcp_http", transport: fixture.transport, operation: operation() }));
    const job = await subject.call(); await subject.dispatcher.wait(alice, job.id);
    expect(await readFile(marker, "utf8")).toBe("initialize\n");
    expect(subject.store.getJob(alice, job.id).outcome.kind).toBe("outcome_unknown");
    expect(subject.store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 7 });
  });
  it("reaps a live server and its ordinary descendant when an in-flight SDK tool call is cancelled", async () => {
    const directory = await root(), program = await stdio(directory, { startupSource: startup(directory), hangTool: true });
    const subject = track(await runtime(directory, { kind: "mcp_stdio", destination: { kind: "mcp_stdio", ...program }, operation: operation({ timeoutMs: 10000 }) }));
    const job = await subject.call("cancel descendants");
    const pids = pidsSchema.parse(JSON.parse(await eventually(() => readFile(join(directory, "pids.json"), "utf8")))); cleanupPids.push(pids.parent, pids.descendant);
    expect(await eventually(() => readFile(join(directory, "mcp-effects.txt"), "utf8"))).toBe("effect\n");
    process.kill(pids.parent, 0); process.kill(pids.descendant, 0);
    subject.dispatcher.cancel(alice, job.id); await subject.dispatcher.wait(alice, job.id);
    expect(subject.store.getJob(alice, job.id).outcome.kind).toBe("outcome_unknown");
    expect(subject.store.getBudget(alice)).toMatchObject({ spentMicros: 0, reservedMicros: 7 });
    expect(await dead(pids.parent)).toBe(true); expect(await dead(pids.descendant)).toBe(true);
    await expect(readFile(pids.home)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
