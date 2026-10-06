import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fixture } from "../dist/test-host/fixture.mjs";

const plugin = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
await mkdir(output, { recursive: true });
const report = { surface: "packaged STDIO runtime with a system-only PATH", chatgptOwnerVerified: false, modelCalls: 0 };
const directory = await mkdtemp(join(tmpdir(), "latch-package-probe-"));
const transport = new StdioClientTransport({ command: join(plugin, "runtime/node"), args: [join(plugin, "apps/headless/dist/main.js")], cwd: plugin, env: { PATH: "/usr/bin:/bin", PLUGIN_DATA: directory, LATCH_OWNER_HOME: join(directory, "isolated-owner") }, stderr: "pipe" });
transport.stderr.on("data", () => {});
const client = new Client({ name: "latch-package-verification", version: "0.1" });
let host;
let pid;
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
try {
  const manifest = JSON.parse(await readFile(join(plugin, "MANIFEST.json"), "utf8"));
  for (const entry of manifest.files) {
    assert.equal(entry.link, undefined);
    assert.equal(resolve(plugin, entry.path).startsWith(`${plugin}/`), true);
    const bytes = await readFile(join(plugin, entry.path));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  }
  report.manifestFilesVerified = manifest.files.length;
  await client.connect(transport);
  pid = transport.pid;
  assert.ok(pid && alive(pid));
  const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
  assert.equal(tools.length, 25);
  report.tools = tools;
  const state = (await client.callTool({ name: "latch_hub_query", arguments: {} })).structuredContent.hub;
  assert.equal(state.enrollment.status, "unverified");
  const channels = state.capabilities.flatMap(family => family.operations.map(operation => operation.channel));
  assert.equal(new Set(channels).size, 92);
  assert.equal(state.capabilities.length, 18);
  assert.ok(state.capabilities.every(family => family.operations.every(operation => operation.availability.reason === "owner_not_enrolled")));
  report.ownerControlsRemainLocked = true;
  report.capabilityFamilies = 18;
  report.mappedOwnerOperations = 92;
  const stored = await client.callTool({ name: "latch_memory", arguments: { action: "remember", text: "System-only PATH packaged runtime fixture", sourceRefs: ["fixture:packaged-runtime"] } });
  assert.equal(stored.structuredContent.memory.version, 1);
  report.packagedMemoryExecuted = true;
  host = await fixture();
  const verified = (await host.call("latch_hub_query", {})).structuredContent.hub;
  assert.equal(verified.ownerServices.registry.length, 92);
  assert.equal(verified.ownerServices.subscriptions.length, 17);
  const parity = state.capabilities.flatMap(family => family.operations.map(operation => ({ family: family.family, channel: operation.channel, packageAvailability: operation.availability, testHostAvailability: verified.ownerServices.registry.find(entry => entry.channel === operation.channel)?.availability, verifiedInChatgpt: false })));
  assert.ok(parity.every(entry => entry.testHostAvailability));
  await writeFile(join(output, "owner-operation-matrix.json"), JSON.stringify({ note: "Mapping and adapter availability only. Each operation still requires its own end-to-end proof. Test-host authority does not verify ChatGPT authority.", operations: parity, subscriptions: verified.ownerServices.subscriptions }, null, 2) + "\n");
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await host?.close();
  await client.close();
  if (pid) {
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    report.processAfterClose = alive(pid);
    if (report.processAfterClose) { report.status = "failed"; process.exitCode = 1; }
  }
  await rm(directory, { recursive: true, force: true });
  await writeFile(join(output, "package-report.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify(report) + "\n");
}
