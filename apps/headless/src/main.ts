import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { serveDomoStdio } from "@domo/mcp-server";
import { HeadlessHub } from "./hub.js";
import { openRuntime } from "./runtime.js";
import type { RuntimeOptions } from "./runtime.js";

export async function startHeadless(options: RuntimeOptions, hub = new HeadlessHub(), budgetMs?: number) {
  const runtime = await openRuntime(options, hub.adapter);
  try {
    hub.attach(runtime);
    const html = readFileSync(new URL("./hub.html", import.meta.url), "utf8");
    const server = serveDomoStdio(runtime.device, { agent_id: runtime.principal.id, agent_name: "Latch Plugin" }, { version: "0.1.0-dev", budgetMs, extension: hub.extension(html) });
    let closed: Promise<void> | null = null;
    return {
      runtime, hub, server,
      close: () => closed ??= (async () => {
        const failures: unknown[] = [];
        try { await server.close(); } catch (error) { failures.push(error); }
        try { await hub.close(); } catch (error) { failures.push(error); }
        try { await runtime.close(); } catch (error) { failures.push(error); }
        if (failures.length) throw new AggregateError(failures, "headless_shutdown_failed");
      })(),
    };
  } catch (error) {
    const failures: unknown[] = [error];
    try { await hub.close(); } catch (failure) { failures.push(failure); }
    try { await runtime.close(); } catch (failure) { failures.push(failure); }
    throw new AggregateError(failures, "headless_startup_failed");
  }
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("unsupported_platform");
  const pluginData = z.string().min(1).parse(process.env.PLUGIN_DATA);
  const program = await startHeadless({ home: join(resolve(pluginData), "headless"), ownerHome: process.env.LATCH_OWNER_HOME ? resolve(process.env.LATCH_OWNER_HOME) : homedir() });
  const close = () => { void program.close().catch(() => { process.stderr.write("Latch shutdown failed; its outcome must be reviewed.\n"); process.exitCode = 1; }); };
  process.stdin.once("end", close);
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { process.stderr.write("Latch could not start. Check installation state and platform compatibility.\n"); process.exitCode = 1; });
}
