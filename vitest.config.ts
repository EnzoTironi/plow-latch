import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against src directly; no build step needed.
    alias: {
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
