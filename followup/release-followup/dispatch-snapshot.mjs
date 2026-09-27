import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const latch = process.argv[2];
assert(latch, "usage: node dispatch-snapshot.mjs /absolute/path/to/latch");
const { DeviceAgent, HeadlessPolicy, loadPlugins } = await import(pathToFileURL(path.join(latch, "packages/device-core/dist/index.js")));
const { jv, makeIntent } = await import(pathToFileURL(path.join(latch, "packages/protocol/dist/index.js")));
const plugins = loadPlugins([path.join(root, "staged")]);
assert.equal(plugins.length, 1);
const plugin = plugins[0];
const owner = fs.mkdtempSync(path.join(root, "dispatch-owner-"));
const home = fs.mkdtempSync(path.join(root, "dispatch-device-"));
const device = new DeviceAgent(home, "Release fixture Mac", new HeadlessPolicy({ intent: "allow_once" }), null, owner, null, plugins);
const run = async (argv) => device.handleIntent(makeIntent({
  agentId: "release-fixture", agentDisplay: "Release fixture", deviceId: device.identity.deviceId,
  request: "Validate the staged snapshot's help output", sessionId: "release-fixture",
  capabilities: [{ kind: "process.exec", argv, cwd: plugin.dir }, { kind: "network", allowed: false }],
}), { wait_ms: 8000 });
const probes = [];
for (const argv of [["plow-messages", "--help"], ["plow-messages", "--app", "imessage", "--help"], ["plow-messages", "--app", "whatsapp", "--help"]]) {
  const response = await run(argv);
  const output = jv(response).get("output").str ?? "";
  assert.match(output, /--app/);
  assert.match(output, /untrusted input/);
  probes.push({ argv, helpReturned: true });
}
const binary = path.join(plugin.dir, "runtime", process.arch, "bin", "plow-messages");
const saved = `${binary}.negative-control`;
fs.renameSync(binary, saved);
try {
  const response = await run(["plow-messages", "--app", "whatsapp", "--help"]);
  const encoded = JSON.stringify(response);
  assert.match(encoded, /No such file|ENOENT/);
  assert.doesNotMatch(jv(response).get("output").str ?? "", /untrusted input/);
  probes.push({ argv: ["plow-messages", "--app", "whatsapp", "--help"], stagedBinaryRemoved: true, refusedMissingFile: true });
} finally {
  fs.renameSync(saved, binary);
}
const events = device.audit.entries().map((entry) => jv(entry).get("event").str);
assert(events.includes("exec_start"));
assert(events.includes("exec_end"));
const result = { nativeArch: process.arch, source: "493614d4398c04754e6a5006f0eb78de16947b87", latch: "0171b62615d8d981411aa6ffe827741014eac632", dispatch: "DeviceAgent.handleIntent, normal plugin resolution and sandboxed execution, fixture HeadlessPolicy", ownerArchiveRead: false, probes, auditedExecution: true };
fs.writeFileSync(path.join(root, "dispatch-results.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
