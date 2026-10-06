import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium } from "playwright-core";
import { startTestHost } from "./server.mjs";

const output = resolve(process.argv[2] ?? "latch-ui-evidence");
await mkdir(output, { recursive: true });
const results = [];
const errors = [];
const servers = [];
const paginationCalls = [];
const browser = await chromium.launch({ executablePath: process.env.LATCH_TEST_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
let context;
let page;
let video;
async function check(name, action) { await action(); results.push({ name, status: "passed" }); }
async function textContains(locator, text) { await locator.filter({ hasText: text }).first().waitFor({ timeout: 10_000 }); }
try {
  const server = await startTestHost(); servers.push(server);
  context = await browser.newContext({ viewport: { width: 1320, height: 1100 }, recordVideo: { dir: output, size: { width: 1320, height: 1100 } } });
  page = await context.newPage(); video = page.video();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(server.url);
  const app = page.frameLocator("#view");
  const screenshot = async name => {
    await page.frameLocator("#view").locator("body").evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(output, name) });
  };
  const authorize = async () => { await page.getByRole("dialog").waitFor(); await page.getByRole("button", { name: "Autorizar este pedido", exact: true }).click(); await page.getByRole("dialog").waitFor({ state: "hidden" }); };
  await check("one built widget initializes through AppBridge", async () => { await app.getByText("Host de verificação", { exact: true }).waitFor(); assert.equal(await app.locator("#authority").count(), 1); await screenshot("01-painel.png"); });
  await check("embedded brand fonts load in the sandboxed widget", async () => {
    const fonts = await app.locator("body").evaluate(async () => {
      await document.fonts.ready;
      return Array.from(document.fonts).filter(font => font.status === "loaded").map(font => font.family.replaceAll('"', "")).sort();
    });
    assert.deepEqual(fonts, ["DM Sans", "Epilogue"]);
  });
  await check("keyboard navigation moves focus and selects the visible panel", async () => {
    const overview = app.getByRole("tab", { name: "Agora", exact: true });
    await overview.focus(); await overview.press("End");
    await app.getByRole("heading", { name: "Recursos do Latch", exact: true }).waitFor();
    assert.equal(await app.getByRole("tab", { name: "Recursos", exact: true }).evaluate(element => element === document.activeElement), true);
    await app.getByRole("tab", { name: "Recursos", exact: true }).press("Home");
    await overview.press("ArrowDown");
    await app.getByRole("heading", { name: "Suas conexões", exact: true }).waitFor();
    assert.equal(await app.getByRole("tab", { name: "Conexões", exact: true }).getAttribute("aria-selected"), "true");
    await screenshot("10-conexoes.png");
    await app.getByRole("tab", { name: "Conexões", exact: true }).press("Home");
  });
  await check("memory create, correction and search use persisted service state", async () => {
    await app.getByRole("tab", { name: "Memória", exact: true }).click();
    await app.getByLabel("Informação", { exact: true }).fill("Meu idioma preferido é português.");
    await app.getByRole("button", { name: "Guardar na memória", exact: true }).click();
    await textContains(app.locator("#memory-list .row"), "Meu idioma preferido é português.");
    assert.equal(server.host.runtime.store.list(server.host.runtime.principal)[0].text, "Meu idioma preferido é português.");
    await app.getByRole("button", { name: "Corrigir", exact: true }).click();
    await app.getByLabel("Informação", { exact: true }).fill("Prefiro receber respostas em português do Brasil.");
    await app.getByRole("button", { name: "Salvar correção", exact: true }).click();
    await textContains(app.locator("#memory-list .row"), "Prefiro receber respostas em português do Brasil.");
    await app.getByLabel("Buscar na memória").fill("PORTUGUÊS");
    await textContains(app.locator("#memory-count"), "1 resultados");
    assert.equal(server.host.runtime.store.list(server.host.runtime.principal)[0].version, 2);
    await screenshot("02-memoria.png");
  });
  await check("native file operation waits for the separate host decision", async () => {
    await app.getByRole("tab", { name: "Agora", exact: true }).click();
    await page.getByRole("button", { name: "Preparar pedido de arquivo", exact: true }).click();
    await app.getByRole("button", { name: "Revisar pedido", exact: true }).waitFor();
    await assert.rejects(readFile(join(server.host.runtime.device.ownerHome, "arquivo-revisado.txt")));
    await app.getByRole("button", { name: "Revisar pedido", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await textContains(page.locator("#form-message"), "arquivo-revisado.txt");
    await screenshot("03-confirmacao.png");
    await authorize();
    await textContains(app.locator("#message"), "Acesso autorizado");
    await page.waitForFunction(() => document.getElementById("owner-form").open === false);
    assert.equal(await readFile(join(server.host.runtime.device.ownerHome, "arquivo-revisado.txt"), "utf8"), "Arquivo criado após a confirmação do proprietário.\n");
    await app.getByRole("tab", { name: "Atividade", exact: true }).click();
    await app.getByRole("button", { name: "Atualizar", exact: true }).click();
    await textContains(app.locator("#native-activity"), "arquivo-revisado.txt");
  });
  await check("connection review produces one effect, durable result and settled cost", async () => {
    await app.getByRole("tab", { name: "Agora", exact: true }).click();
    await page.getByRole("button", { name: "Preparar operação de conexão", exact: true }).click();
    await app.locator("#recent-jobs").getByRole("button", { name: "Revisar", exact: true }).waitFor();
    await app.locator("#recent-jobs").getByRole("button", { name: "Revisar", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await textContains(page.locator("#form-message"), "Custo máximo autorizado");
    await screenshot("04-conexao.png"); await authorize();
    const job = server.host.runtime.store.listJobs(server.host.runtime.principal)[0];
    await server.host.hub.waitForJob(server.host.runtime.principal, job.id);
    assert.equal(await readFile(join(server.host.root, "echo-effects.txt"), "utf8"), "effect\n");
    assert.equal(server.host.runtime.store.getBudget(server.host.runtime.principal).spentMicros, 10_000);
    await app.getByRole("tab", { name: "Atividade", exact: true }).click();
    await app.getByRole("button", { name: "Atualizar", exact: true }).click();
    await textContains(app.locator("#job-list"), "Concluída");
    await app.locator("#job-list").getByRole("button", { name: "Ver resultado", exact: true }).click();
    await textContains(app.locator("#job-result-value"), "Conexão executada após confirmação");
    await screenshot("05-resultado.png");
    await page.getByRole("button", { name: "Preparar operação de conexão", exact: true }).click();
    await textContains(page.locator("#host-message"), "Pedido real preparado");
    assert.equal(server.host.runtime.store.listJobs(server.host.runtime.principal).length, 1);
    assert.equal(await readFile(join(server.host.root, "echo-effects.txt"), "utf8"), "effect\n");
  });
  await check("owner settings support refusal and a bound accepted change", async () => {
    await app.getByRole("tab", { name: "Acesso", exact: true }).click();
    await app.getByLabel("Modo de aprovação").selectOption("deny");
    await app.getByRole("button", { name: "Revisar mudança de modo", exact: true }).click();
    await page.getByRole("dialog").waitFor(); await page.getByRole("button", { name: "Negar pedido", exact: true }).click();
    await textContains(app.locator("#message"), "Pedido encerrado");
    assert.equal((await server.host.call("latch_hub_query", {})).structuredContent.hub.mode, "ask");
    await app.getByLabel("Modo de aprovação").selectOption("deny");
    await app.getByRole("button", { name: "Revisar mudança de modo", exact: true }).click(); await authorize();
    await textContains(app.locator("#message"), "Mudança confirmada e aplicada");
    assert.equal((await server.host.call("latch_hub_query", {})).structuredContent.hub.mode, "deny");
    await screenshot("11-acesso.png");
  });
  await check("maintained preference controls require confirmation and use real settings", async () => {
    await app.getByRole("tab", { name: "Recursos", exact: true }).click();
    await app.getByLabel("Compartilhar dados de diagnóstico", { exact: true }).uncheck();
    await app.locator("#telemetry-save").click();
    await page.getByRole("dialog").waitFor();
    await textContains(page.locator("#form-message"), "Alterar dados de diagnóstico");
    assert.equal(server.host.runtime.settings.load().telemetryEnabled, true);
    await authorize();
    await textContains(app.locator("#message"), "Mudança confirmada e aplicada");
    assert.equal(server.host.runtime.settings.load().telemetryEnabled, false);
    assert.equal(await app.getByLabel("Compartilhar dados de diagnóstico", { exact: true }).isChecked(), false);
    await app.getByRole("button", { name: "Consultar ferramentas", exact: true }).click();
    await textContains(app.locator("#plugins-list"), "Navegador privado ausente neste pacote");
    await screenshot("08-recursos.png");
    const state = (await server.host.call("latch_hub_query", {})).structuredContent.hub;
    assert.equal(state.ownerServices.registry.length, 92);
    assert.equal(state.ownerServices.subscriptions.length, 17);
    assert.equal(await app.locator("#capability-list article").count(), 18);
  });
  await app.getByRole("tab", { name: "Memória", exact: true }).click();
  await check("memory removal deletes the real record", async () => { await app.getByRole("button", { name: "Remover", exact: true }).click(); await textContains(app.locator("#memory-list"), "Nenhuma informação"); assert.equal(server.host.runtime.store.list(server.host.runtime.principal).length, 0); });
  await check("memory pagination retrieves records beyond the initial page", async () => {
    for (let i = 0; i < 55; i++) await server.host.call("latch_memory", { action: "remember", text: `Registro adicional ${i}` });
    const original = server.host.call;
    server.host.call = async (name, input) => { const result = await original(name, input); paginationCalls.push({ name, input, rows: result.structuredContent?.memories?.length, error: result.structuredContent?.error }); return result; };
    await app.getByLabel("Buscar na memória").fill("");
    await app.getByRole("button", { name: "Atualizar", exact: true }).click();
    await textContains(app.locator("#memory-count"), "50 resultados");
    await app.locator("body").evaluate(body => {
      body.dataset.paginationEvents = "[]";
      body.addEventListener("click", event => {
        if (event.target.id === "memory-more") body.dataset.paginationEvents = JSON.stringify([...JSON.parse(body.dataset.paginationEvents), { trusted: event.isTrusted, disabled: event.target.disabled }]);
      }, true);
    });
    await app.getByRole("button", { name: "Carregar mais informações", exact: true }).click();
    await textContains(app.locator("#memory-count"), "55 resultados");
    assert.equal(await app.locator("#memory-list .row").count(), 55);
    assert.equal(await app.getByRole("button", { name: "Carregar mais informações", exact: true }).isVisible(), false);
  });
  await context.close(); context = null;
  if (video) await video.saveAs(join(output, "demonstracao.webm"));
  context = await browser.newContext({ viewport: { width: 390, height: 844 } }); page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.url);
  const mobileApp = page.frameLocator("#view");
  await check("small viewport keeps the page within its width", async () => {
    await mobileApp.getByText("Host de verificação", { exact: true }).waitFor();
    await mobileApp.getByRole("tab", { name: "Memória", exact: true }).click();
    assert.equal(await mobileApp.locator("body").evaluate(body => body.scrollWidth <= window.innerWidth + 1), true);
    await screenshot("06-celular.png");
  });
  await context.close(); context = null;
  context = await browser.newContext({ viewport: { width: 1320, height: 1100 }, colorScheme: "dark", reducedMotion: "reduce" }); page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(server.url);
  const darkApp = page.frameLocator("#view");
  await check("host dark theme and reduced motion preferences reach the widget", async () => {
    await darkApp.getByText("Host de verificação", { exact: true }).waitFor();
    assert.equal(await darkApp.locator("html").getAttribute("data-theme"), "dark");
    assert.equal(await darkApp.locator("#overview").evaluate(element => getComputedStyle(element).animationName), "none");
    assert.equal(await darkApp.locator("body").evaluate(element => getComputedStyle(element).color), "rgb(232, 237, 223)");
    await darkApp.getByRole("button", { name: "Ampliar painel", exact: true }).click();
    assert.equal(await darkApp.locator("html").getAttribute("data-theme"), "dark");
    await screenshot("09-tema-escuro.png");
  });
  await context.close(); context = null;
  const locked = await startTestHost({ enrolled: false }); servers.push(locked);
  context = await browser.newContext({ viewport: { width: 1320, height: 1100 } }); page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(locked.url);
  const lockedApp = page.frameLocator("#view");
  await check("an unverified host keeps owner controls disabled", async () => {
    await lockedApp.getByText("Verificação do proprietário pendente", { exact: true }).waitFor();
    await lockedApp.getByRole("tab", { name: "Acesso", exact: true }).click();
    assert.equal(await lockedApp.getByRole("button", { name: "Revisar mudança de modo", exact: true }).isDisabled(), true);
    await screenshot("07-sem-proprietario.png");
    await lockedApp.getByRole("tab", { name: "Recursos", exact: true }).click();
    assert.equal(await lockedApp.locator("#telemetry-save").isDisabled(), true);
    assert.equal(await lockedApp.getByRole("button", { name: "Consultar ferramentas", exact: true }).isDisabled(), true);
  });
  assert.deepEqual(errors, []);
} catch (error) {
  results.push({ name: "verification", status: "failed", error: error instanceof Error ? error.message : String(error) });
  if (page) {
    const state = await page.frameLocator("#view").locator("body").evaluate(body => ({ count: body.querySelector("#memory-count")?.textContent, message: body.querySelector("#message")?.textContent, rows: body.querySelectorAll("#memory-list .row").length, disabled: body.querySelector("#memory-more")?.disabled, events: body.dataset.paginationEvents })).catch(() => null);
    await writeFile(join(output,"failure-state.json"), JSON.stringify(state)+"\n");
  }
  if (page) await page.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await context?.close(); await browser.close();
  for (const server of servers) await server.close();
  await writeFile(join(output, "report.json"), JSON.stringify({ host: "local MCP Apps verification host", ownerAssurance: "test_host", chatgptOwnerVerified: false, results, consoleErrors: errors }, null, 2) + "\n");
  await writeFile(join(output, "pagination-calls.json"), JSON.stringify(paginationCalls, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ passed: results.filter(result => result.status === "passed").length, failures: results.filter(result => result.status === "failed"), output }) + "\n");
}
