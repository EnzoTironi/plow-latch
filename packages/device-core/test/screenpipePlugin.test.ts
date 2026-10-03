import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classifyArgv, ruleArgv } from "../src/plugins/argvRules.js";
import { resolveEnv } from "../src/plugins/env.js";
import { parseManifest } from "../src/plugins/manifest.js";
import { loadPlugins } from "../src/plugins/registry.js";
import { tempDirs } from "./pluginFixtures.js";

const pluginDir = fileURLToPath(new URL("../../../apps/desktop/plugins/screenpipe", import.meta.url));
const manifest = parseManifest(fs.readFileSync(path.join(pluginDir, "latch-plugin.json"), "utf8"));
const { tmp, cleanup } = tempDirs("latch-screenpipe-");
afterEach(cleanup);

// Substitute only curl in a disposable copy. Production always uses the
// system binary; the fixture records its argv/stdin without opening a port.
function cli(key: string | null = "sp-test-key") {
  const root = tmp();
  const capture = path.join(root, "request.json");
  const keyFile = path.join(root, "api-key");
  if (key !== null) fs.writeFileSync(keyFile, key, { mode: 0o600 });
  const curl = path.join(root, "curl");
  fs.writeFileSync(curl, `#!${process.execPath}
import fs from "node:fs";
const argv = process.argv.slice(2);
const config = fs.readFileSync(0, "utf8");
fs.writeFileSync(process.env.TEST_CAPTURE, JSON.stringify({ argv, config }));
const body = process.env.TEST_LARGE_BODY ? "x".repeat(8 * 1024 * 1024) : (process.env.TEST_BODY ?? '{"data":[],"pagination":{"limit":20,"offset":0,"total":0}}');
fs.writeFileSync(argv[argv.indexOf("--output") + 1], body);
process.stdout.write(process.env.TEST_STATUS ?? "200");
process.exit(Number(process.env.TEST_CURL_EXIT ?? "0"));
`, { mode: 0o755 });
  const script = path.join(root, "cli.sh");
  const source = fs.readFileSync(path.join(pluginDir, "cli.sh"), "utf8");
  expect(source.match(/\/usr\/bin\/curl/g)).toHaveLength(1);
  fs.writeFileSync(script, source.replace("/usr/bin/curl", curl));
  return {
    root,
    capture,
    request: (): unknown => JSON.parse(fs.readFileSync(capture, "utf8")),
    run: (argv: string[], env: NodeJS.ProcessEnv = {}) => spawnSync("/bin/sh", [script, ...argv], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, TMPDIR: root, SCREENPIPE_API_PORT: "3030", SCREENPIPE_API_KEY_FILE: keyFile, TEST_CAPTURE: capture, ...env },
    }),
  };
}

describe("bundled Screenpipe manifest", () => {
  it("loads without downloaded binaries and resolves only owner configuration", () => {
    const plugin = loadPlugins([path.dirname(pluginDir)]).find((p) => p.manifest.name === "screenpipe");
    expect(plugin?.manifest.exec.argv).toEqual(["/bin/sh", "cli.sh"]);
    expect(manifest.runtime.binaries).toEqual([]);
    expect(manifest.daemon).toBeNull();
    expect(manifest.hooks).toEqual({});
    expect(resolveEnv(manifest, { pluginHome: pluginDir, ownerHome: "/owner" })).toEqual({
      SCREENPIPE_API_PORT: "3030", SCREENPIPE_API_KEY_FILE: "/owner/.config/plow-latch/screenpipe-api-key",
    });
  });

  it.each(["health", "search", "--help"])("classifies %s as a read", (command) => {
    expect(classifyArgv(manifest, ["plow-screenpipe", command]).kind).toBe("read");
  });

  it.each(["record", "stop", "sql", "export-video", "notify", "pipe", "control", "--url"])("refuses %s", (command) => {
    expect(classifyArgv(manifest, ["plow-screenpipe", command]).kind).toBe("refused");
  });

  it("uses the existing read-prefix rule for different searches", () => {
    expect(ruleArgv(manifest, ["plow-screenpipe", "search", "--query", "one"])).toEqual(["plow-screenpipe", "search"]);
    expect(ruleArgv(manifest, ["plow-screenpipe", "search", "--query", "two", "--content-type", "audio"])).toEqual(["plow-screenpipe", "search"]);
    expect(manifest.argv.write).toEqual([]);
  });
});

describe("Screenpipe CLI", () => {
  it("prints help without a request or reading a malformed key", () => {
    const fixture = cli("malformed key");
    const result = fixture.run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("network=true");
    expect(fs.existsSync(fixture.capture)).toBe(false);
  });

  it("reads health without authentication", () => {
    const fixture = cli("malformed key");
    expect(fixture.run(["health"]).status).toBe(0);
    expect(fixture.request()).toMatchObject({ config: "", argv: expect.arrayContaining(["http://127.0.0.1:3030/health"]) });
  });

  it("passes the JSON envelope unchanged and keeps the token out of argv", () => {
    const fixture = cli();
    const json = JSON.stringify({ data: [{ type: "Audio", content: { transcription: "Synthetic meeting", timestamp: "2026-10-01T12:00:00Z" } }], pagination: { total: 1, limit: 20, offset: 0 } });
    const result = fixture.run(["search"], { TEST_BODY: json });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(json);
    expect(fixture.request()).toMatchObject({
      config: 'header = "Authorization: Bearer sp-test-key"\n',
      argv: expect.arrayContaining(["-q", "--config", "-", "--get", "--proxy", "", "--noproxy", "*", "--max-time", "15", "include_frames=false", "include_cloud=false", "max_content_length=2000", "limit=20"]),
    });
    expect(fixture.request()).toMatchObject({ argv: expect.not.arrayContaining([expect.stringContaining("sp-test-key")]) });
    expect(fixture.request()).toMatchObject({ argv: expect.not.arrayContaining(["--location"]) });
    expect(fs.readdirSync(fixture.root).filter((name) => name.startsWith("latch-screenpipe."))).toEqual([]);
  });

  it("treats special query characters and file-shaped values as encoded data", () => {
    const fixture = cli();
    const query = '@secret &token=other; $(touch /tmp/should-not-exist) "quoted"';
    const result = fixture.run(["search", "--query", query, "--content-type", "audio", "--app-name", "Google Chrome", "--window-name", "Design & review", "--start-time", "2026-10-01T09:00:00-03:00", "--end-time", "2026-10-01T10:00:00-03:00", "--limit", "100", "--offset", "20", "--order", "asc"]);
    expect(result.status).toBe(0);
    expect(fixture.request()).toMatchObject({ argv: expect.arrayContaining([
      "--data-urlencode", `q=${query}`, "content_type=audio", "app_name=Google Chrome", "window_name=Design & review",
      "start_time=2026-10-01T09:00:00-03:00", "end_time=2026-10-01T10:00:00-03:00", "limit=100", "offset=20", "order=asc",
    ]) });
  });

  it.each(["all", "ocr", "audio", "input", "accessibility", "parsed"])("supports %s searches", (type) => {
    expect(cli().run(["search", "--content-type", type]).status).toBe(0);
  });

  it.each([
    [], ["record"], ["health", "--url", "https://example.com"], ["--help", "extra"],
    ["search", "--query"], ["search", "--url", "https://example.com"], ["search", "--config", "/tmp/config"],
    ["search", "--header", "Authorization: Bearer other"], ["search", "--include-frames", "true"],
    ["search", "--content-type", "video"], ["search", "--order", "random"],
    ["search", "--limit", "0"], ["search", "--limit", "101"], ["search", "--limit", "1e2"],
    ["search", "--limit", "999999999999999999999"], ["search", "--offset", "-1"], ["search", "--offset", "1000001"],
    ["search", "--query", "x".repeat(4097)],
  ])("refuses invalid argv case %# before HTTP", (...argv) => {
    const fixture = cli();
    expect(fixture.run(argv).status).toBe(2);
    expect(fs.existsSync(fixture.capture)).toBe(false);
  });

  it.each(["", "sp-secret\nurl = https://example.com", 'sp-secret"', "sp-secret\\", "sp-secret key"])("refuses malformed token case %# without echoing it", (key) => {
    const fixture = cli(key);
    const result = fixture.run(["search"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("sp-secret");
    expect(fs.existsSync(fixture.capture)).toBe(false);
  });

  it("supports an unauthenticated instance when the owner has no key file", () => {
    const fixture = cli(null);
    expect(fixture.run(["search"]).status).toBe(0);
    expect(fixture.request()).toMatchObject({ config: "" });
  });

  it.each(["0", "65536", "3030/other", "localhost:3030"])("refuses invalid owner port %s", (port) => {
    const fixture = cli();
    expect(fixture.run(["health"], { SCREENPIPE_API_PORT: port }).status).toBe(1);
    expect(fs.existsSync(fixture.capture)).toBe(false);
  });

  it.each([
    ["401", "authentication"], ["403", "authentication"], ["302", "Redirects are refused"],
    ["400", "parameters"], ["404", "API version"], ["500", "HTTP error"],
  ])("suppresses HTTP %s response bodies", (status, hint) => {
    const fixture = cli();
    const result = fixture.run(["search"], { TEST_STATUS: status, TEST_BODY: "sp-secret-key and private history" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(hint);
    expect(result.stderr).not.toContain("sp-secret");
    expect(fs.readdirSync(fixture.root).filter((name) => name.startsWith("latch-screenpipe."))).toEqual([]);
  });

  it.each([["7", "Start Screenpipe"], ["28", "15 seconds"], ["63", "size limit"]])("reports curl exit %s without partial output", (code, hint) => {
    const result = cli().run(["search"], { TEST_CURL_EXIT: code, TEST_BODY: "partial private history" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(hint);
  });

  it("bounds the response file and removes it even when the transport exceeds the limit", () => {
    const fixture = cli();
    const result = fixture.run(["search"], { TEST_LARGE_BODY: "1" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(fs.readdirSync(fixture.root).filter((name) => name.startsWith("latch-screenpipe."))).toEqual([]);
  });
});
