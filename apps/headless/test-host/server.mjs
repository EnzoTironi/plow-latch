import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { z } from "zod";
import { fixture } from "../dist/test-host/fixture.mjs";

export async function startTestHost({ enrolled = true } = {}) {
  const host = await fixture({ enrolled });
  const html = await host.html();
  const script = await readFile(new URL("../dist/test-host/host.js", import.meta.url));
  const token = randomBytes(32).toString("hex");
  const toolNames = new Set((await host.client.listTools()).tools.map(tool => tool.name));
  let origin = "";
  const routes = new Set(["/api/call", "/api/forms", "/api/answer", "/api/prepare"]);
  const page = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Latch · verificação MCP Apps</title><style>body{margin:0;background:#e6ebe5;font-family:system-ui,sans-serif;color:#203136}header{padding:18px 24px;display:flex;gap:20px;flex-wrap:wrap;justify-content:space-between;align-items:center}header strong{display:block;font-size:15px}header p{font-size:12px;max-width:700px;margin:5px 0 0;line-height:1.5}button{font:inherit;padding:9px 13px;cursor:pointer;border:1px solid #becac1;border-radius:8px;background:#fff;color:inherit}button:focus-visible{outline:3px solid #8ab8a3}#view{display:block;border:0;width:min(1160px,100%);margin:0 auto;background:#fff;min-height:900px;border-radius:14px}#host-message{font-size:12px;padding:0 24px 10px}dialog{max-width:720px;width:calc(100% - 40px);border:1px solid #b8c5ba;border-radius:14px;padding:24px}dialog::backdrop{background:#112c2375}dialog h2{font-size:21px}#form-message{white-space:pre-wrap;max-height:55vh;overflow:auto;font-size:13px;line-height:1.6;overflow-wrap:anywhere}#choices{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}#choices button:first-child{background:#13634d;color:#fff}</style><header><div><strong>MCP Apps · ambiente de verificação</strong><p>Interface conectada ao serviço real com dados temporários. As confirmações abaixo pertencem ao host de teste. Esta demonstração não comprova a identidade nem a apresentação no ChatGPT.</p></div><div><button id="prepare-native">Preparar pedido de arquivo</button> <button id="prepare-connection">Preparar operação de conexão</button></div></header><div id="host-message" role="status"></div><iframe id="view" title="Latch Hub" sandbox="allow-scripts"></iframe><dialog id="owner-form" aria-labelledby="form-title"><h2 id="form-title">Confirmação do proprietário no host de teste</h2><p id="form-message"></p><div id="choices"></div></dialog><script src="/host.js" type="module"></script></html>`;
  async function input(request) {
    let bytes = 0; const chunks = [];
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 65_536) throw new Error("input_limit"); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  const server = createServer(async (request, response) => {
    const send = (code, value, type = "application/json") => { response.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(type === "application/json" ? JSON.stringify(value) : value); };
    try {
      if (request.headers.host !== new URL(origin).host) { send(403, { error: "host_refused" }); return; }
      const path = new URL(request.url, origin).pathname;
      if (request.method === "GET" && path === "/favicon.ico") { response.writeHead(204); response.end(); return; }
      if (request.method === "GET" && path === "/") {
        response.setHeader("Set-Cookie", `latch_fixture=${token}; HttpOnly; SameSite=Strict; Path=/`);
        response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        send(200, page, "text/html; charset=utf-8"); return;
      }
      const cookies = request.headers.cookie?.split(";").map(value => value.trim()) ?? [];
      if (!cookies.includes(`latch_fixture=${token}`)) { send(403, { error: "fixture_session_required" }); return; }
      if (request.method === "GET" && path === "/host.js") { send(200, script, "text/javascript; charset=utf-8"); return; }
      if (request.method === "GET" && path === "/view") {
        response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
        send(200, html, "text/html; charset=utf-8"); return;
      }
      if (!routes.has(path)) { send(404, { error: "not_found" }); return; }
      if (request.method === "GET" && path === "/api/forms") { send(200, { forms: host.forms() }); return; }
      if (request.method !== "POST" || request.headers.origin !== origin || !request.headers["content-type"]?.startsWith("application/json")) { send(403, { error: "origin_refused" }); return; }
      const data = await input(request);
      if (path === "/api/call") {
        const call = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) }).strict().parse(data);
        if (!toolNames.has(call.name)) { send(400, { error: "unknown_tool" }); return; }
        send(200, await host.call(call.name, call.arguments)); return;
      }
      if (path === "/api/answer") {
        const answer = z.object({ id: z.string().uuid(), choice: z.enum(["allow_once", "always_allow", "deny", "cancel"]) }).strict().parse(data);
        const form = host.forms().find(value => value.id === answer.id);
        if (!form || (answer.choice !== "cancel" && !form.choices.includes(answer.choice))) { send(400, { error: "invalid_answer" }); return; }
        host.answer(answer.id, answer.choice); send(200, { answered: true }); return;
      }
      if (path === "/api/prepare") {
        const { kind } = z.object({ kind: z.enum(["native", "connection"]) }).strict().parse(data);
        if (kind === "native") await host.call("plow_write_file", { path: join(host.runtime.device.ownerHome, "arquivo-revisado.txt"), content: "Arquivo criado após a confirmação do proprietário.\n", goal: "Verificar um pedido local com dados temporários" });
        else await host.call("latch_call_connection", { connectionId: host.connection.id, operation: "echo", arguments: { text: "Conexão executada após confirmação" }, idempotencyKey: "fixture:visual-once" });
        send(200, await host.call("latch_open_hub", {})); return;
      }
      send(405, { error: "method_refused" });
    } catch { send(500, { error: "fixture_request_failed" }); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture_address_missing");
  origin = `http://127.0.0.1:${address.port}`;
  let closing;
  return { url: origin, host, close: () => closing ??= (async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await host.close(); })() };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = await startTestHost({ enrolled: !process.argv.includes("--unverified") });
  process.stdout.write(JSON.stringify({ url: server.url, assurance: "test_host" }) + "\n");
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void server.close().catch(() => { process.exitCode = 1; }); });
}
