import { App } from "@modelcontextprotocol/ext-apps";
import { ownerLabels, ownerReasons } from "../src/ownerLabels.ts";

const app = new App({ name: "Latch Hub", version: "0.1.0-dev" }, {}, { autoResize: true });
const node = id => document.getElementById(id);
let hub = null;
let editing = null;
let connected = false;
let busy = false;
let memoryResults = null;
let memoryTotal = 0;
let searchSequence = 0;
let searchTimer = null;
let pollTimer = null;
const modes = { adversarial: "AI Reviewer", ask: "Perguntar a você", approve: "Aprovar operações", deny: "Negar operações" };
const jobLabels = { waiting: "Aguardando revisão", running: "Em andamento", completed: "Concluída", failed: "Falhou", cancelled: "Cancelada", outcome_unknown: "Resultado incerto" };
const connectionLabels = { ready: "Disponível", needs_auth: "Conectar conta", needs_reauth: "Renovar acesso", disabled: "Desativada", revoked: "Acesso local revogado" };
const auditLabels = { memory_remembered: "Informação guardada", memory_corrected: "Memória corrigida", memory_deleted: "Informação removida", connection_added: "Conexão cadastrada", connection_changed: "Acesso à conexão alterado", budget_changed: "Orçamento alterado", job_created: "Operação solicitada", job_started: "Execução iniciada", job_settled: "Resultado registrado", job_cancelled: "Operação cancelada", job_outcome_unknown: "Resultado incerto" };
const decisionLabels = { Allowed: "Autorizado", "Always allowed": "Autorização permanente", Denied: "Negado", "Timed out": "Expirado", Rejected: "Recusado", Pending: "Pendente", "Not answered": "Sem resposta", Granted: "Concedido" };
const statusLabels = { Completed: "Concluída", Running: "Em andamento", Error: "Erro", Failed: "Falhou" };
const ownerOutcomes = { pending: "Aguardando confirmação", recording: "Registrando decisão", applied: "Mudança aplicada", rejected: "Pedido recusado", unavailable: "Acesso indisponível", outcome_unknown: "Resultado incerto", decided: "Acesso decidido" };
const ownerActions = { native_review: "Revisão de acesso ao computador", set_mode: "Modo do Gatekeeper", set_purpose: "Instruções do Gatekeeper", revoke_rule: "Revogação de acesso permanente" };
const errors = { owner_not_enrolled: "O canal do proprietário ainda não foi verificado.", conflict: "Este registro mudou. Atualize o painel e revise o pedido novamente.", budget_exceeded: "O orçamento disponível não cobre esta operação.", invalid_input: "Revise os valores deste pedido.", operation_failed: "Não foi possível concluir o pedido.", unavailable: "Este recurso ainda precisa de uma conexão autorizada.", expired: "Este pedido expirou. Prepare uma nova revisão.", connection_unavailable: "Esta conexão está indisponível." };
const money = micros => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD" }).format((micros ?? 0) / 1_000_000);
function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = String(text ?? "");
  if (className) element.className = className;
  return element;
}
function message(text, error = false) { node("message").textContent = text; node("message").dataset.error = String(error); }
function switchTab(name) {
  for (const button of document.querySelectorAll("[data-tab]")) button.setAttribute("aria-selected", String(button.dataset.tab === name));
  for (const panel of document.querySelectorAll(".panel")) panel.hidden = panel.id !== name;
}
function button(text, action, disabled = false, className) {
  const element = textElement("button", text, className);
  element.disabled = disabled;
  element.addEventListener("click", () => perform(action));
  return element;
}
function row(title, description, status, actions = []) {
  const element = textElement("div", "", "row");
  const body = textElement("div", "", "body");
  body.append(textElement("strong", title), textElement("p", description));
  element.append(body);
  const controls = textElement("div", "", "actions");
  if (status) controls.append(textElement("span", status.text, `pill ${status.kind ?? ""}`));
  controls.append(...actions);
  element.append(controls);
  return element;
}
function list(id, items, render, empty) {
  const container = node(id);
  container.replaceChildren();
  if (!items.length) { container.append(textElement("div", empty, "empty")); return; }
  container.append(...items.map(render));
}
function ownerAvailable() { return hub?.enrollment?.status === "verified"; }
function ownerOutcome(receipt) {
  if (receipt.status === "cancelled") return "Pedido cancelado";
  if (receipt.status === "abandoned") return "Pedido interrompido";
  if (receipt.execution.kind === "decided") return receipt.execution.decision === "deny" ? "Acesso negado" : "Acesso autorizado";
  return ownerOutcomes[receipt.execution.kind] ?? "Pedido encerrado";
}
async function call(name, argumentsValue = {}) {
  const result = await app.callServerTool({ name, arguments: argumentsValue }, { timeout: 120_000 });
  const data = result.structuredContent;
  if (result.isError) throw new Error(errors[data?.error] ?? "Não foi possível concluir este pedido.");
  if (!data) throw new Error("O serviço não retornou o estado solicitado.");
  return data;
}
async function refresh() {
  clearTimeout(searchTimer);
  searchSequence += 1;
  const data = await call("latch_hub_query", { view: "overview", limit: 50 });
  render(data.hub);
  if (node("memory-search").value) await searchMemories();
}
async function perform(action) {
  if (busy || !connected) return;
  busy = true;
  node("refresh").disabled = true;
  node("memory-more").disabled = true;
  try { await action(); }
  catch (error) { message(error instanceof Error ? error.message : "O pedido falhou.", true); }
  finally { busy = false; node("refresh").disabled = false; node("memory-more").disabled = false; }
}
async function propose(command) {
  message("Aguardando a confirmação do proprietário no host.");
  const result = await call("latch_owner_propose", { command, expectedRevision: hub.revision });
  receiptMessage(result.receipt);
  await refresh();
}
async function ownerCommand(channel, input = {}) {
  message("Aguardando a confirmação do proprietário no host.");
  const result = await call("latch_owner_command", { channel, input, expectedRevision: hub.revision });
  receiptMessage(result.receipt); await refresh();
}
async function ownerQuery(channel, input = {}) {
  const result = await call("latch_owner_query", { channel, input });
  if (result.service.kind !== "value") throw new Error(ownerReasons[result.service.reason] ?? "Este controle está indisponível neste ambiente.");
  return result.service.value;
}
async function showPlugins() {
  const value = await ownerQuery("plugins:get");
  list("plugins-list", value.rows, item => row(item.kind === "Browser" ? "Navegador privado" : item.title, item.requirements.filter(requirement => requirement.status !== "met").map(requirement => requirement.id === "browser-runtime" ? "Navegador privado ausente neste pacote" : requirement.id === "safari-javascript-from-apple-events" ? "Permissão de automação do Safari pendente" : requirement.id.startsWith("account:") ? "Conta do provedor pendente" : "Permissão do macOS pendente").join(" · ") || "Permissões atendidas", { text: item.status === "ready" ? "Disponível" : item.status === "off" ? "Desativada" : "Acesso pendente", kind: item.status === "ready" ? "" : "wait" }, [button(item.status === "off" ? "Ativar" : "Desativar", () => ownerCommand("plugins:setEnabled", { name: item.name, on: item.status === "off" }), !ownerAvailable())]), "Nenhuma ferramenta preparada neste pacote.");
}
async function review(intentId) {
  message("Abra a revisão apresentada pelo host para decidir sobre este pedido.");
  const result = await call("latch_review_intent", { intentId });
  receiptMessage(result.receipt);
  await refresh();
}
function receiptMessage(receipt) {
  if (!receipt) { message("Pedido registrado. Acompanhe o estado no painel."); return; }
  const kind = receipt.execution?.kind;
  if (kind === "outcome_unknown") { message("O resultado ficou incerto. Consulte o histórico antes de repetir o pedido.", true); return; }
  if (kind === "unavailable") { message("A mudança não pôde ser concluída. O acesso necessário ainda está indisponível.", true); return; }
  if (kind === "applied") { message("Mudança confirmada e aplicada."); return; }
  if (kind === "decided") {
    const allowed = receipt.execution.decision === "allow_once" || receipt.execution.decision === "always_allow";
    message(allowed ? "Acesso autorizado. Consulte a atividade para ver o resultado da execução." : receipt.standingRule === "stored" ? "A execução expirou. A regra para futuros pedidos foi guardada." : "O acesso foi negado. A decisão está no histórico."); return;
  }
  if (kind === "rejected" || receipt.status === "cancelled" || receipt.status === "abandoned") { message("Pedido encerrado sem aplicar a mudança."); return; }
  message("A decisão ainda está sendo registrada. Atualize o painel para consultar o resultado.");
}
async function reviewConnection(jobId) {
  message("Revise o destino, a operação e o limite de custo apresentados pelo host.");
  const result = await call("latch_review_connection", { jobId });
  receiptMessage(result.receipt); await refresh();
}
async function showResult(jobId) {
  const result = await call("latch_job_status", { jobId });
  node("job-result").hidden = false;
  node("job-result-title").textContent = `${result.job.operation} · ${jobLabels[result.job.outcome.kind]}`;
  node("job-result-value").textContent = result.result ? JSON.stringify(result.result.value.output ?? result.result.value, null, 2) : "Esta operação ainda não tem um resultado registrado.";
  switchTab("activity");
}
function render(value) {
  if (!value || !Array.isArray(value.connections) || !Array.isArray(value.memories)) return;
  hub = value;
  memoryResults = null;
  memoryTotal = value.totals?.memories ?? value.memories.length;
  const authority = node("authority");
  authority.replaceChildren();
  if (value.enrollment?.assurance === "test_host") {
    authority.append(textElement("span", "Host de verificação", "banner-label"), document.createTextNode("Este painel usa dados reais de teste. A apresentação e a identidade do proprietário no ChatGPT ainda precisam ser verificadas."));
    authority.className = "notice";
  } else if (ownerAvailable()) {
    authority.append(textElement("span", "Proprietário verificado", "banner-label"), document.createTextNode("Mudanças de acesso exigem uma confirmação vinculada ao pedido."));
    authority.className = "notice good";
  } else {
    authority.append(textElement("span", "Verificação do proprietário pendente", "banner-label"), document.createTextNode("Você pode consultar o estado e a memória deste contexto. Aprovações e configurações de acesso ficam bloqueadas até conectar um canal de proprietário verificado."));
    authority.className = "notice";
  }
  const pending = value.pending ?? [];
  const jobs = value.jobs ?? [];
  node("pending-count").textContent = String(pending.length);
  node("connection-count").textContent = String(value.totals?.readyConnections ?? value.connections.filter(item => item.status === "ready").length);
  const budget = value.budget ?? {};
  node("remaining-budget").textContent = money((budget.limitMicros ?? 0) - (budget.spentMicros ?? 0) - (budget.reservedMicros ?? 0));
  node("budget-detail").textContent = `${money(budget.spentMicros)} usados · ${money(budget.reservedMicros)} reservados`;
  node("mode-pill").textContent = modes[value.mode] ?? "AI Reviewer";
  if (document.activeElement !== node("approval-mode")) node("approval-mode").value = value.mode ?? "adversarial";
  if (document.activeElement !== node("purpose")) node("purpose").value = value.purpose ?? "";
  if (document.activeElement !== node("budget-limit")) node("budget-limit").value = String((budget.limitMicros ?? 0) / 1_000_000);
  for (const id of ["mode-save", "purpose-save", "budget-save", "connection-add", "connection-save", "telemetry-save", "updates-check-save", "updates-install-save", "plugins-refresh"]) node(id).disabled = !ownerAvailable();
  for (const [id, key] of [["telemetry-enabled", "telemetryEnabled"], ["updates-auto-check", "autoCheckUpdates"], ["updates-auto-install", "autoInstallUpdates"]]) {
    if (document.activeElement !== node(id)) node(id).checked = Boolean(value.ownerServices?.preferences?.[key]);
    node(id).disabled = !ownerAvailable();
  }
  list("pending-list", pending, item => row(item.request ?? "Pedido de acesso", (item.capabilities ?? []).join("\n"), { text: item.status === "expired" ? "Expirado" : "Aguardando", kind: "wait" }, [button("Revisar pedido", () => review(item.intentId), !ownerAvailable())]), "Nenhum pedido aguardando aprovação.");
  const jobRow = item => row(item.operation ?? item.request ?? "Operação", item.updatedAt ? new Date(item.updatedAt).toLocaleString("pt-BR") : "", { text: jobLabels[item.outcome?.kind] ?? item.status ?? "Em andamento", kind: item.outcome?.kind === "outcome_unknown" ? "wait" : item.outcome?.kind === "failed" ? "bad" : "" }, [button("Ver resultado", () => showResult(item.id)), ...(item.outcome?.kind === "waiting" ? [button("Revisar", () => reviewConnection(item.id), !ownerAvailable()), button("Cancelar", () => propose({ kind: "cancel_job", jobId: item.id }), !ownerAvailable())] : [])]);
  list("recent-jobs", jobs.slice(0, 4), jobRow, "Nenhuma operação de conexão neste contexto.");
  list("job-list", jobs, jobRow, "As operações aparecerão aqui quando uma conexão for utilizada.");
  list("connection-list", value.connections, item => {
    const controls = [];
    if (item.status !== "revoked") controls.push(button(item.status === "disabled" ? "Ativar" : "Desativar", () => propose({ kind: "connection_status", connectionId: item.id, status: item.status === "disabled" ? "ready" : "disabled" }), !ownerAvailable()));
    if (item.status !== "revoked") controls.push(button("Revogar", () => propose({ kind: "connection_status", connectionId: item.id, status: "revoked" }), !ownerAvailable(), "danger"));
    return row(item.namespace, item.configuration?.kind ?? "", { text: connectionLabels[item.status] ?? item.status, kind: item.status === "ready" ? "" : "wait" }, controls);
  }, "Nenhuma conexão cadastrada. Cadastre uma configuração revisada e autorize a conta do provedor.");
  renderMemories();
  list("audit-list", value.audit ?? [], item => row(auditLabels[item.event] ?? item.title ?? item.event, item.at ? new Date(item.at).toLocaleString("pt-BR") : "", null), "Nenhuma decisão registrada neste contexto.");
  list("owner-history", value.ownerHistory?.actions ?? [], item => row(ownerLabels[item.targetId] ?? ownerActions[item.kind] ?? (item.targetId.startsWith("hub:") ? "Controle de conexão" : "Confirmação do proprietário"), new Date(item.updatedAt).toLocaleString("pt-BR"), { text: ownerOutcome(item.receipt), kind: ["outcome_unknown", "unavailable"].includes(item.receipt.execution.kind) ? "wait" : "" }), ownerAvailable() ? "Nenhuma confirmação registrada para este proprietário." : "Conecte um proprietário verificado para consultar suas confirmações.");
  list("native-activity", value.nativeActivity ?? [], item => row(item.title, `${item.agentDisplay ?? item.agentId} · ${new Date(item.ts).toLocaleString("pt-BR")} · ${decisionLabels[item.decision] ?? item.decision}`, { text: item.status ? statusLabels[item.status] ?? item.status : decisionLabels[item.decision] ?? item.decision, kind: item.statusKind === "failed" || item.decisionKind === "denied" ? "bad" : "" }), "Nenhuma operação local neste contexto.");
  list("rules-list", value.rules ?? [], item => row(item.agentDisplay ?? item.agentId, (item.capabilities ?? []).map(bound => typeof bound === "string" ? bound : JSON.stringify(bound)).join("\n"), null, [button("Revogar", () => propose({ kind: "revoke_rule", ruleKey: item.ruleKey }), !ownerAvailable(), "danger")]), "Nenhuma concessão permanente.");
  node("capability-list").replaceChildren(...(value.capabilities ?? []).map(item => {
    const card = textElement("article", "", "card");
    card.append(textElement("h3", item.title), textElement("span", item.status === "ready" ? "Disponível no serviço" : item.status === "partial" ? "Disponível em parte" : "Acesso pendente", `pill ${item.status === "ready" ? "" : "wait"}`), textElement("p", item.reason));
    if (item.operations?.length) {
      const details = document.createElement("details");
      details.append(textElement("summary", `${item.operations.length} controles`));
      const operations = document.createElement("ul");
      operations.append(...item.operations.map(operation => textElement("li", `${ownerLabels[operation.channel] ?? operation.label ?? operation.channel} · ${operation.availability?.kind === "ready" ? "Disponível" : ownerReasons[operation.availability?.reason] ?? "Integração pendente"}`)));
      details.append(operations); card.append(details);
    }
    return card;
  }));
  node("connection-status").textContent = `Conectado ao serviço · ${value.deviceName ?? "Latch"} · ${new Date().toLocaleTimeString("pt-BR")}`;
  clearTimeout(pollTimer);
  if (pending.length || jobs.some(item => item.outcome?.kind === "waiting" || item.outcome?.kind === "running")) pollTimer = setTimeout(poll, 5_000);
}
function poll() { if (document.hidden || busy) { pollTimer = setTimeout(poll, 5_000); return; } void perform(refresh); }
function renderMemories() {
  const query = node("memory-search").value;
  const memories = memoryResults ?? hub?.memories ?? [];
  node("memory-count").textContent = `${memories.length} resultados nesta página · ${memoryTotal} no total`;
  node("memory-more").hidden = memories.length >= memoryTotal;
  node("memory-more").disabled = busy;
  list("memory-list", memories, item => row(item.text, `Versão ${item.version} · ${(item.sourceRefs ?? []).join(", ") || "Informação guardada neste contexto"}`, null, [button("Corrigir", () => { editing = item; node("memory-text").value = item.text; node("memory-title").textContent = "Corrigir informação"; node("memory-save").textContent = "Salvar correção"; node("memory-cancel").hidden = false; node("memory-text").focus(); }), button("Remover", async () => { await call("latch_memory", { action: "delete", id: item.id }); message("Informação removida da memória."); if (editing?.id === item.id) cancelEdit(); await refresh(); }, false, "danger")]), query ? "Nenhuma informação corresponde à busca." : "Sua memória está vazia. Guarde uma informação abaixo.");
}
async function searchMemories(more = false) {
  clearTimeout(searchTimer);
  const sequence = ++searchSequence;
  const previous = more ? memoryResults ?? hub?.memories ?? [] : [];
  const data = await call("latch_memory", { action: "search", query: node("memory-search").value, limit: 50, offset: previous.length });
  if (sequence !== searchSequence) return;
  memoryResults = [...new Map([...previous, ...data.memories].map(memory => [memory.id, memory])).values()];
  memoryTotal = data.pagination.total; renderMemories();
}
function cancelEdit() { editing = null; node("memory-text").value = ""; node("memory-title").textContent = "Lembrar uma informação"; node("memory-save").textContent = "Guardar na memória"; node("memory-cancel").hidden = true; }
for (const element of document.querySelectorAll("[data-tab]")) element.addEventListener("click", () => switchTab(element.dataset.tab));
for (const element of document.querySelectorAll("[data-switch]")) element.addEventListener("click", () => switchTab(element.dataset.switch));
node("refresh").addEventListener("click", () => perform(async () => { await refresh(); message("Estado atualizado."); }));
node("expand").addEventListener("click", () => perform(() => app.requestDisplayMode({ mode: "fullscreen" })));
node("memory-search").addEventListener("input", () => { clearTimeout(searchTimer); searchSequence += 1; searchTimer = setTimeout(() => { if (connected) void searchMemories().catch(() => message("Não foi possível consultar a memória.", true)); }, 200); });
node("job-result-close").addEventListener("click", () => { node("job-result").hidden = true; });
node("memory-cancel").addEventListener("click", cancelEdit);
node("memory-more").addEventListener("click", () => perform(() => searchMemories(true)));
node("memory-save").addEventListener("click", () => perform(async () => {
  const text = node("memory-text").value.trim();
  if (!text) { message("Escreva uma informação para guardar.", true); return; }
  await call("latch_memory", editing ? { action: "correct", id: editing.id, expectedVersion: editing.version, text } : { action: "remember", text });
  message(editing ? "Correção salva na memória." : "Informação guardada na memória.");
  cancelEdit(); await refresh();
}));
node("mode-save").addEventListener("click", () => perform(() => propose({ kind: "set_mode", mode: node("approval-mode").value })));
node("purpose-save").addEventListener("click", () => perform(() => propose({ kind: "set_purpose", text: node("purpose").value })));
node("telemetry-save").addEventListener("click", () => perform(() => ownerCommand("telemetry:set", { on: node("telemetry-enabled").checked })));
node("updates-check-save").addEventListener("click", () => perform(() => ownerCommand("updates:setAutoCheck", { on: node("updates-auto-check").checked })));
node("updates-install-save").addEventListener("click", () => perform(() => ownerCommand("updates:setAutoInstall", { on: node("updates-auto-install").checked })));
node("plugins-refresh").addEventListener("click", () => perform(showPlugins));
node("budget-save").addEventListener("click", () => perform(async () => {
  const amount = Number(node("budget-limit").value);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) throw new Error("Digite um limite válido.");
  await propose({ kind: "set_budget", limitMicros: Math.round(amount * 1_000_000) });
}));
node("connection-add").addEventListener("click", () => { node("connection-form").hidden = !node("connection-form").hidden; });
node("connection-save").addEventListener("click", () => perform(async () => {
  await propose({ kind: "add_connection", namespace: node("connection-name").value.trim(), configuration: { kind: node("connection-kind").value, configurationRef: node("connection-reference").value.trim() } });
  node("connection-form").hidden = true;
}));
app.ontoolresult = result => { if (result.structuredContent?.hub) render(result.structuredContent.hub); };
app.onhostcontextchanged = context => { if (context.theme) document.documentElement.style.colorScheme = context.theme; };
try { await app.connect(); connected = true; await refresh(); }
catch { node("authority").replaceChildren(textElement("span", "O painel precisa de um host MCP Apps", "banner-label"), document.createTextNode("Abra o Latch pelo plugin em um host compatível. Este arquivo sozinho não tem acesso ao serviço.")); message("Conexão indisponível.", true); }
