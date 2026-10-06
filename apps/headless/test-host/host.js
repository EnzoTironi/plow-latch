import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
const iframe = document.getElementById("view");
const dialog = document.getElementById("owner-form");
const message = document.getElementById("host-message");
let shown = null;
let answering = false;
let prepared = false;
async function post(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
}
const bridge = new AppBridge(null, { name: "Latch verification host", version: "0.1" }, { serverTools: {} }, { hostContext: { theme: window.matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light", locale: "pt-BR", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] } });
bridge.oncalltool = params => post("/api/call", { name: params.name, arguments: params.arguments ?? {} });
bridge.onsizechange = ({ height }) => { if (height) iframe.style.height = `${Math.min(2400, Math.max(700, height))}px`; };
bridge.onrequestdisplaymode = async ({ mode }) => { bridge.setHostContext({ displayMode: mode }); return { mode }; };
bridge.oninitialized = async () => { await bridge.sendToolInput({ arguments: {} }); await bridge.sendToolResult(await post("/api/call", { name: "latch_open_hub", arguments: {} })); message.textContent = "Painel conectado pelo protocolo MCP Apps."; };
await bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
iframe.src = "/view";
const labels = { allow_once: "Autorizar este pedido", always_allow: "Autorizar e guardar regra", deny: "Negar pedido", cancel: "Cancelar revisão" };
async function forms() {
  try {
    const data = await (await fetch("/api/forms")).json();
    const form = data.forms[0];
    if (form && shown !== form.id && !answering) {
      shown = form.id;
      document.getElementById("form-message").textContent = form.message;
      const choices = document.getElementById("choices"); choices.replaceChildren();
      for (const choice of [...form.choices, "cancel"]) {
        const button = document.createElement("button"); button.textContent = labels[choice];
        button.addEventListener("click", async () => { answering = true; for (const item of choices.children) item.disabled = true; try { await post("/api/answer", { id: form.id, choice }); dialog.close(); shown = null; } catch { message.textContent = "A confirmação falhou."; } finally { answering = false; } });
        choices.append(button);
      }
      dialog.showModal();
    }
  } catch { message.textContent = "Não foi possível consultar as confirmações do host de teste."; }
  setTimeout(forms, 300);
}
dialog.addEventListener("cancel", event => { event.preventDefault(); const cancel = [...document.getElementById("choices").children].find(button => button.textContent === labels.cancel); cancel?.click(); });
void forms();
for (const [id, kind] of [["prepare-native", "native"], ["prepare-connection", "connection"]]) {
  document.getElementById(id).addEventListener("click", async () => {
    if (prepared) return; prepared = true;
    try { await bridge.sendToolResult(await post("/api/prepare", { kind })); message.textContent = "Pedido real preparado no serviço temporário."; }
    catch { message.textContent = "O serviço não conseguiu preparar o pedido."; }
    finally { prepared = false; }
  });
}
