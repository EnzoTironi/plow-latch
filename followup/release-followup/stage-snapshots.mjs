import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const latch = process.argv[2];
assert(latch, "usage: node stage-snapshots.mjs /absolute/path/to/latch");
const { parseManifest, stageBinaries } = await import(pathToFileURL(path.join(latch, "packages/device-core/dist/index.js")));
const sourceSha = fs.readFileSync(path.join(root, "source-sha.txt"), "utf8").trim();
const version = `review-${sourceSha.slice(0, 7)}`;
const plugin = path.join(root, "staged", "messages");
const raw = JSON.parse(fs.readFileSync(path.join(latch, "apps/desktop/plugins/messages/latch-plugin.json"), "utf8"));
raw.version = version;
const archives = new Map();
for (const [arch, assetArch] of [["arm64", "arm64"], ["x64", "amd64"]]) {
  const name = `plow-messages_${version}_darwin_${assetArch}.tar.gz`;
  // Reserved .invalid URLs identify local fixtures; these are never published pins.
  const url = `https://release-review.invalid/${name}`;
  const bytes = fs.readFileSync(path.join(root, "assets", name));
  archives.set(url, bytes);
  raw.runtime.binaries[0].url[arch] = url;
  raw.runtime.binaries[0].sha256[arch] = createHash("sha256").update(bytes).digest("hex");
}
fs.mkdirSync(plugin, { recursive: true });
fs.writeFileSync(path.join(plugin, "latch-plugin.json"), `${JSON.stringify(raw, null, 2)}\n`);
fs.copyFileSync(path.join(latch, "apps/desktop/plugins/messages/skill.md"), path.join(plugin, "skill.md"));
const manifest = parseManifest(JSON.stringify(raw));
const downloads = path.join(root, "downloads");
const fetchLocal = async (url) => {
  assert(archives.has(url), `unexpected local archive URL ${url}`);
  return archives.get(url);
};
const results = [];
for (const arch of ["arm64", "x64"]) {
  await stageBinaries(manifest, plugin, arch, downloads, fetchLocal);
  const binary = path.join(plugin, "runtime", arch, "bin", "plow-messages");
  const probes = [];
  for (const args of [["--help"], ["--app", "imessage", "--help"], ["--app", "whatsapp", "--help"]]) {
    const run = spawnSync(binary, args, { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /--app/);
    assert.match(run.stdout, /untrusted input/);
    probes.push({ args, status: run.status });
  }
  for (const app of ["imessage", "whatsapp"]) {
    const args = ["--app", app, "--store", path.join(root, "absent", "archive.sqlite"), "chats"];
    const run = spawnSync(binary, args, { encoding: "utf8" });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /Full Disk Access/);
    probes.push({ args: ["--app", app, "--store", "<absent archive>", "chats"], status: run.status });
  }
  const expected = createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
  fs.writeFileSync(binary, "corrupted staged file");
  await stageBinaries(manifest, plugin, arch, downloads, fetchLocal);
  assert.equal(createHash("sha256").update(fs.readFileSync(binary)).digest("hex"), expected);
  results.push({ arch, probes, restageRepairsModifiedBinary: true, stagedBinarySha256: expected });
}
const broken = structuredClone(raw);
broken.runtime.binaries[0].sha256.arm64 = "0".repeat(64);
const negativePlugin = path.join(root, "negative-stage", "messages");
await assert.rejects(stageBinaries(parseManifest(JSON.stringify(broken)), negativePlugin, "arm64", path.join(root, "negative-downloads"), fetchLocal), /does not match its sha256/);
assert.equal(fs.existsSync(path.join(negativePlugin, "runtime", "arm64")), false);
const evidence = { sourceSha, latchSource: "0171b62615d8d981411aa6ffe827741014eac632", localSnapshotOnly: true, downloadTransport: "injected local bytes via the public FetchBytes seam; SHA checking and extraction are production stageBinaries", results, mismatchedHashRefusedAndRuntimeRemoved: true };
fs.writeFileSync(path.join(root, "stage-results.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
