import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against src directly; no build step needed.
    alias: {
      "@domo/owner-services/maintained/onboarding": p("packages/owner-services/src/maintained/onboarding.ts"),
      "@domo/owner-services/maintained/cloudAgentState": p("packages/owner-services/src/maintained/cloudAgentState.ts"),
      "@domo/owner-services/maintained/cloudAgents": p("packages/owner-services/src/maintained/cloudAgents.ts"),
      "@domo/owner-services/maintained/providerWiring": p("packages/owner-services/src/maintained/providerWiring.ts"),
      "@domo/owner-services/maintained/connectors": p("packages/owner-services/src/maintained/connectors.ts"),
      "@domo/owner-services/maintained/settingsActions": p("packages/owner-services/src/maintained/settingsActions.ts"),
      "@domo/owner-services/maintained/agentIndex": p("packages/owner-services/src/maintained/agentIndex.ts"),
      "@domo/owner-services/maintained/auditIndex": p("packages/owner-services/src/maintained/auditIndex.ts"),
      "@domo/owner-services/maintained/pluginsModel": p("packages/owner-services/src/maintained/pluginsModel.ts"),
      "@domo/owner-services/maintained/capabilitiesModel": p("packages/owner-services/src/maintained/capabilitiesModel.ts"),
      "@domo/owner-services/maintained/requirements": p("packages/owner-services/src/maintained/requirements.ts"),
      "@domo/owner-services/maintained/connectClient": p("packages/owner-services/src/maintained/connectClient.ts"),
      "@domo/owner-services/maintained/importStaging": p("packages/owner-services/src/maintained/importStaging.ts"),
      "@domo/owner-services/maintained/loginItem": p("packages/owner-services/src/maintained/loginItem.ts"),
      "@domo/owner-services/maintained/keepAwake": p("packages/owner-services/src/maintained/keepAwake.ts"),
      "@domo/owner-services/maintained/updates": p("packages/owner-services/src/maintained/updates.ts"),
      "@domo/owner-services/maintained/cloudAgentMapper": p("packages/owner-services/src/maintained/cloudAgentMapper.ts"),
      "@domo/owner-services/maintained/chatRows": p("packages/owner-services/src/maintained/chatRows.ts"),
      "@domo/owner-services/maintained/rosterSections": p("packages/owner-services/src/maintained/rosterSections.ts"),
      "@domo/owner-services/maintained/gatekeeperPreview": p("packages/owner-services/src/maintained/gatekeeperPreview.ts"),
      "@domo/owner-services/maintained/gatekeeperRecovery": p("packages/owner-services/src/maintained/gatekeeperRecovery.ts"),
      "@domo/owner-services/maintained/onboardingExamples": p("packages/owner-services/src/maintained/onboardingExamples.ts"),
      "@domo/owner-services/maintained/onboardingExampleCatalog": p("packages/owner-services/src/maintained/onboardingExampleCatalog.ts"),
      "@domo/owner-services": p("packages/owner-services/src/index.ts"),
      "@domo/integration-hub": p("packages/integration-hub/src/index.ts"),
      "@domo/owner-runtime": p("packages/owner-runtime/src/index.ts"),
      "@domo/connector-runtime": p("packages/connector-runtime/src/index.ts"),
      "@domo/owner-core/settings": p("packages/owner-core/src/settings.ts"),
      "@domo/owner-core/reviewPolicy": p("packages/owner-core/src/reviewPolicy.ts"),
      "@domo/owner-core/adversarialAgent": p("packages/owner-core/src/adversarialAgent.ts"),
      "@domo/owner-core/plowApi": p("packages/owner-core/src/plowApi.ts"),
      "@domo/owner-core/onboardingSteps": p("packages/owner-core/src/onboardingSteps.ts"),
      "@domo/owner-core/viewModel": p("packages/owner-core/src/viewModel.ts"),
      "@domo/owner-core": p("packages/owner-core/src/index.ts"),
      "@domo/protocol": p("packages/protocol/src/index.ts"),
      "@domo/transport": p("packages/transport/src/index.ts"),
      "@domo/browser-server": p("packages/browser-server/src/index.ts"),
      "@domo/device-core": p("packages/device-core/src/index.ts"),
      "@domo/mcp-server": p("packages/mcp-server/src/index.ts"),
      "@domo/relay-client": p("packages/relay-client/src/index.ts"),
    },
  },
  test: {
    // `e2e/` is back in scope for main's own suites (worktree naming, and the
    // browser fixtures its package tests import). What went with the stand-in
    // Plow were the two files under it that needed one — the relay+MCP gate and
    // the transcript runner — not the directory.
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "e2e/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
