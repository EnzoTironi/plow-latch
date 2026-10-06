import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { output: { type: "string" }, node: { type: "string", default: process.execPath }, version: { type: "string", default: "0.1.0-dev" } } });
if (!values.output || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(values.version)) throw new Error("Pass --output and a valid --version");
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(values.output);
const plugin = path.join(output, "marketplace/plugins/latch-headless-dev");
const marker = path.join(output, ".latch-headless-build.json");
if (fs.existsSync(output) && fs.readdirSync(output).length && (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker, "utf8")).name !== "latch-headless-dev")) throw new Error("Output contains files from another task");
const nodeVersion = execFileSync(values.node, ["--version"], { encoding: "utf8" }).trim();
if (nodeVersion !== "v24.19.0") throw new Error("This experimental package requires the verified Node v24.19.0 distribution");
for (const relative of ["apps/headless/dist/main.js", "apps/headless/dist/hub.html", "apps/headless/dist/capabilities.json", "packages/owner-services/dist/index.js"]) if (!fs.existsSync(path.join(repository, relative))) throw new Error(`Build the workspace before packaging: ${relative}`);
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(marker, JSON.stringify({ name: "latch-headless-dev" }) + "\n");
if (fs.existsSync(plugin)) fs.rmSync(plugin, { recursive: true });
fs.mkdirSync(plugin, { recursive: true });

const packages = new Map();
const omittedOptional = new Set();
const workspaceCopies = [];
function packageDirectory(name, from) {
  const require = createRequire(path.join(from, "package.json"));
  for (const directory of require.resolve.paths(name) ?? []) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return fs.realpathSync(candidate);
  }
  throw new Error(`Dependency unavailable: ${name}`);
}
function include(directory) {
  const relative = path.relative(repository, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Dependency outside the verified checkout");
  if (packages.has(relative)) return;
  const identity = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  packages.set(relative, identity);
  const target = path.join(plugin, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (relative.startsWith("node_modules/")) {
    fs.cpSync(directory, target, { recursive: true, dereference: false, filter: file => path.basename(file) !== "node_modules" && ![".git", ".cache"].includes(path.basename(file)) });
  } else {
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(directory, "package.json"), path.join(target, "package.json"));
    const entries = new Set(["dist", "src", "native", "LICENSE", "LICENSE.md", "README.md", "binding.gyp", ...fs.readdirSync(directory).filter(name => /\.(?:cjs|mjs|js)$/.test(name))]);
    for (const name of entries) if (fs.existsSync(path.join(directory, name))) fs.cpSync(path.join(directory, name), path.join(target, name), { recursive: true, filter: file => !["test-host", ".debug-hub.mjs", ".debug-connection.mjs"].includes(path.basename(file)) });
    const link = path.join(plugin, "node_modules", identity.name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    workspaceCopies.push({ target, link });
  }
  for (const [name] of Object.entries(identity.dependencies ?? {})) include(packageDirectory(name, directory));
  for (const [name] of Object.entries(identity.optionalDependencies ?? {})) {
    let optional;
    try { optional = packageDirectory(name, directory); } catch { omittedOptional.add(name); continue; }
    include(optional);
  }
}
include(path.join(repository, "apps/headless"));
for (const { target, link } of workspaceCopies) fs.cpSync(target, link, { recursive: true });
fs.mkdirSync(path.join(plugin, "runtime"));
fs.copyFileSync(values.node, path.join(plugin, "runtime/node"));
fs.chmodSync(path.join(plugin, "runtime/node"), 0o755);
fs.copyFileSync(path.join(path.dirname(values.node), "../LICENSE"), path.join(plugin, "runtime/LICENSE-node.txt"));
fs.copyFileSync(path.join(repository, "LICENSE"), path.join(plugin, "LICENSE-latch.txt"));
fs.copyFileSync(path.join(repository, "package-lock.json"), path.join(plugin, "package-lock.source.json"));
fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ name: "latch-headless-dev-runtime", private: true, type: "module" }, null, 2) + "\n");

const presentation = { displayName: "Latch Headless Dev", shortDescription: "Painel local experimental do Latch.", longDescription: "Executa o núcleo do Latch sem Electron. Inclui memória, conexões revisadas e UI MCP Apps. Proprietário no ChatGPT, serviços Plow, cofre nativo, navegador e distribuição assinada ainda exigem integração e verificação.", developerName: "Latch development experiment", category: "Developer Tools" };
const identity = { name: "latch-headless-dev", version: values.version, description: "Experimental headless Latch owner panel and integration hub", license: "Apache-2.0" };
const mcp = { mcpServers: { latch_headless: { command: "./runtime/node", args: ["${PLUGIN_ROOT}/apps/headless/dist/main.js"], env: { LATCH_OWNER_HOME: "${PLUGIN_DATA}/verification-owner-home" } } } };
fs.mkdirSync(path.join(plugin, ".codex-plugin"));
fs.writeFileSync(path.join(plugin, ".codex-plugin/plugin.json"), JSON.stringify({ ...identity, mcpServers: "./.mcp.json", interface: presentation }, null, 2) + "\n");
fs.writeFileSync(path.join(plugin, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", ...identity, extensions: { "com.openai": { interface: presentation } } }, null, 2) + "\n");
fs.writeFileSync(path.join(plugin, ".mcp.json"), JSON.stringify(mcp, null, 2) + "\n");
fs.writeFileSync(path.join(plugin, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { latch_headless: { type: "stdio", ...mcp.mcpServers.latch_headless } } }, null, 2) + "\n");
const catalog = { name: "latch-development", interface: { displayName: "Latch development" }, plugins: [{ name: identity.name, source: { source: "local", path: "./plugins/latch-headless-dev" }, policy: { installation: "AVAILABLE", authentication: "ON_USE" }, category: "Developer Tools" }] };
fs.mkdirSync(path.join(output, "marketplace/.agents/plugins"), { recursive: true });
fs.writeFileSync(path.join(output, "marketplace/.agents/plugins/marketplace.json"), JSON.stringify(catalog, null, 2) + "\n");
const notices = [...packages].map(([relative, pkg]) => {
  const directory = path.join(repository, relative);
  const license = fs.readdirSync(directory).find(name => /^licen[sc]e(?:\.|$)/i.test(name) && fs.statSync(path.join(directory, name)).isFile());
  return `${pkg.name}@${pkg.version} (${pkg.license ?? "See repository"})\n${license ? fs.readFileSync(path.join(directory, license), "utf8") : JSON.stringify(pkg.repository ?? null)}`;
});
fs.writeFileSync(path.join(plugin, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n") + "\n");
fs.writeFileSync(path.join(plugin, "PROVENANCE.json"), JSON.stringify({ repository: "https://github.com/plow-pbc/latch", sourceBase: "46428fc7eb3d512767511e5af3f688a27afef7ad", head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(), workingTreeClean: !execFileSync("git", ["status", "--porcelain"], { cwd: repository, encoding: "utf8" }).trim(), target: "darwin-arm64", node: nodeVersion, experiment: true, packages: [...packages].map(([location, pkg]) => ({ location, name: pkg.name, version: pkg.version })), omittedOptional: [...omittedOptional].sort(), ownerEnrollment: "unavailable", ownerHome: "isolated verification home; native user access not enabled" }, null, 2) + "\n");
const files = [];
function inventory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) inventory(file);
    else if (entry.isSymbolicLink()) files.push({ path: path.relative(plugin, file), link: fs.readlinkSync(file) });
    else files.push({ path: path.relative(plugin, file), bytes: fs.statSync(file).size, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") });
  }
}
inventory(plugin);
fs.writeFileSync(path.join(plugin, "MANIFEST.json"), JSON.stringify({ schemaVersion: 1, files }, null, 2) + "\n");
process.stdout.write(JSON.stringify({ plugin: path.relative(repository, plugin), packages: packages.size, files: files.length, node: nodeVersion }) + "\n");
