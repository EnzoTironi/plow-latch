import type { OwnerChallenge } from "@domo/owner-runtime";
import { z } from "zod";
import { EffectSchema } from "@domo/connector-runtime";
import { ownerLabels } from "./ownerLabels.js";

const modes = { approve: "Aprovar operações", adversarial: "AI Reviewer", ask: "Perguntar a você", deny: "Negar operações" };
const connectionPlan = z.object({ operation: z.string(), request: z.record(z.string(), z.json()), arguments: z.record(z.string(), z.json()), effects: z.array(EffectSchema), requiredScopes: z.array(z.string()), upperBoundMicros: z.number().int().nonnegative() });
const effectNames = { read: "Ler", write: "Alterar", delete: "Excluir", send: "Enviar", publish: "Publicar" };

export function ownerPrompt(challenge: OwnerChallenge): string {
  const display = challenge.form.display;
  const expiry = new Date(challenge.action.executionDeadline).toLocaleString("pt-BR");
  const lines = ["Confirme este pedido no canal do proprietário."];
  if (display.kind === "native_review") {
    const approval = display.approval;
    lines.push(`Agente: ${approval.agentDisplay} (${approval.agentId})`, `Contexto informado pelo agente: ${approval.goal}`, `Pedido: ${approval.request}`, "Acesso solicitado:", ...approval.capabilities.map(capability => `• ${capability.display}`));
    if (approval.planContext) lines.push(`Plano informado pelo agente: ${approval.planContext}`);
    if (approval.scriptsApp) lines.push(`Aplicativo: ${approval.scriptsApp.app} (${approval.scriptsApp.bundleId})`, `Script solicitado:\n${approval.scriptsApp.script}`, `Argumentos: ${JSON.stringify(approval.scriptsApp.args)}`);
    if (display.hint) lines.push(`Sugestão do revisor: ${JSON.stringify(display.hint)}`);
  } else {
    const command = display.command;
    switch (command.kind) {
      case "set_mode": lines.push(`Alterar o Gatekeeper para "${modes[command.mode]}".`); break;
      case "set_purpose": lines.push(`Salvar estas instruções para o Gatekeeper:\n${command.purpose}`); break;
      case "revoke_rule": lines.push(`Revogar a concessão permanente ${command.ruleKey}.`); break;
      case "native_control": {
        if (command.operation === "hub:authorize_connection") {
          const plan = connectionPlan.parse(command.input);
          lines.push(`Executar a operação "${plan.operation}" nesta conexão.`, `Destino e execução:\n${JSON.stringify(plan.request, null, 2)}`, `Dados enviados:\n${JSON.stringify(plan.arguments, null, 2)}`, "Efeitos previstos:", ...plan.effects.map(effect => effect.kind === "unknown" ? `• Efeito incerto: ${effect.reason}` : `• ${effectNames[effect.kind]}: ${effect.resource}`), `Permissões necessárias: ${plan.requiredScopes.join(", ") || "nenhuma"}`, `Custo máximo autorizado: US$ ${(plan.upperBoundMicros / 1_000_000).toFixed(6)}`);
        } else if (command.operation === "hub:set_budget") {
          const budget = z.object({ limitMicros: z.number().int().nonnegative() }).parse(command.input);
          lines.push(`Alterar o limite total das conexões para US$ ${(budget.limitMicros / 1_000_000).toFixed(6)}.`);
        } else lines.push(`Operação: ${Object.hasOwn(ownerLabels, command.operation) ? ownerLabels[command.operation as keyof typeof ownerLabels] : command.operation}`, `Escopo e valores deste pedido:\n${JSON.stringify(command.input, null, 2)}`);
        break;
      }
    }
  }
  lines.push(`Este pedido expira em ${expiry}.`, "Autorizar este pedido permite somente esta operação. Negar pedido impede a execução.");
  if (challenge.form.requestedSchema.properties.choice.enum.includes("always_allow")) lines.push("Autorizar e guardar regra também permite futuros pedidos com este mesmo escopo.");
  return lines.join("\n\n");
}
