PR #540 was reviewed at `0171b62615d8d981411aa6ffe827741014eac632` against `16d871a53b7c495c639670e3ac6e2b87080f4299` (main). The additional commit is `0171b626`, “Clarify WhatsApp handles and cover archive selector guards.” The worktree is clean. The review commit has been pushed to the PR.

The source is ready for Patrick to review. It is **not ready to merge or ship** while `apps/desktop/plugins/messages/latch-plugin.json` still pins `plow-messages` v0.1.0. The current archive only supports iMessage and rejects the new explicit app syntax. The new README states that dependency visibly, with the existing release/checksum update procedure.

| Validation | Result | Evidence |
| --- | --- | --- |
| `npm run build` | Exit 0; `tsc -b` clean | `final-build.log` |
| `npx vitest run packages/device-core packages/mcp-server apps/desktop/test/pluginsModel.test.ts` | 1,227 passed, 4 skipped; 57 files passed, 1 skipped | `final-tests.log` |
| `git diff --check` | Exit 0 | Run before committing |
| Read-rule scoping | All five verbs preserve default iMessage prefixes and explicit `--app imessage` / `--app whatsapp` prefixes | `packages/device-core/test/pluginSkills.test.ts:68` |
| Archive-selector rejection at MCP boundary | Five prohibited selector shapes return refusal before `decideIntent`, `intent_received`, or `exec_start` | `packages/mcp-server/test/mcpServer.test.ts:958` |
| Documented commands | The added WhatsApp `thread --handle` example is accepted by the real manifest | `packages/device-core/test/pluginSkills.test.ts:39` |
| Static structural review | `argvRules.ts` is the broadest affected file: 208 transitive dependents across 67 files, with 26 indexed affected tests; the full relevant package suites were run | `final-pr-context.xml`, stamped `0171b6261` |

The broad test run was performed immediately before committing these exact contents. The four skipped tests are reported as skipped, not counted as successful coverage. The suite prints its existing deliberate error-path/teardown diagnostics but exits successfully. The structural tool reports name-based lower-bound counts (115 ambiguous and 886 unresolved graph edges); these counts are review navigation, not runtime proof. The working-change quality measurement had zero gating regressions and one minor ambient churn observation in the existing test `decideIntent` helper. No finding was suppressed or acknowledged to obtain that result.

The dependency failure was reproduced by staging the actual v0.1.0 release and checking both archive SHA-256 values against the manifest:

| Architecture | Manifest and downloaded archive SHA-256 |
| --- | --- |
| arm64 | `edc4d60ed4bb30b4509a6f3699b08af76a0bf678ddaabdbf62e3fda903524f2a` |
| x64 | `29a3986a8d9803820748c2a7aa1ae007f8548753ff342cef0385d379b7e89f09` |

The runnable staged binary prints the old iMessage-only help and exits 2 for both of these manifest-allowed commands:

```text
plow-messages --app whatsapp chats
plow-messages --app imessage chats

plow-messages: search takes one phrase; quote it if it contains spaces
```

The SHA verification covers both release archives; it does not claim both CPU architectures were executed. `pinned-release-probe.json` records that probe at `72f833ab1b47f05e630822575b64c1d0b85bd570`. The runtime version, URLs, hashes, and argv allowlist are unchanged in the review commit, so the same blocker applies at `0171b626`.

Review order:

1. `apps/desktop/plugins/messages/latch-plugin.json`: the explicit app prefixes and unchanged release pin. `--store` is not exposed to agents.
2. `packages/device-core/src/plugins/argvRules.ts`: selection flags after the matched verb are refused; `ruleArgv` retains the whole approved app prefix.
3. `packages/mcp-server/test/mcpServer.test.ts:958`: the real manifest is exercised through `plow_run_command`; the denial occurs before an approval request or execution.
4. `apps/desktop/plugins/messages/skill.md`: use exact WhatsApp JIDs returned by `chats`, take `--chat-id` for groups, and keep iMessage contact-resolution instructions app-specific.
5. `packages/device-core/src/deviceAgent.ts` and removed `whatsappSkill.ts`: raw WhatsApp SQL skill registration is removed in favor of the pinned messages plugin. The read gate must be resolved before that replacement ships.

To clear the merge gate, merge/release the upstream plow-messages change with macOS arm64 and amd64 archives and `checksums.txt`, then update the plugin version, both URLs, and both hashes from that published checksum file. Run `just stage-plugins messages` and repeat both explicit app commands using the staged binary. Repeat the real-user read workflow through Latch and the documented missing-staged-binary negative control. Keep the release blocker visible until these observations are recorded against the new pin.

This lane did not drive Messages/WhatsApp, send a message, or claim real-user archive validation. The parent review is performing the owner-authorized live checks and should append those results separately, naming whether each ran through the built upstream binary, Latch's dispatch path, or the app UI.

## Live integration

[Dispatch evidence](../live/read-dispatch-results.json): both explicit app `chats --limit 3` calls traversed the actual MCP/DeviceAgent/sandbox path and returned three JSON rows with exit 0. The source-built CLI was copied into an isolated test plugin directory; this is **not** the shipping release pin. A forbidden store override was rejected before approval, and removing the staged test executable caused exit 71 (no PATH fallback). No live relay was used. [Four-verb source CLI evidence](../live/read-results-final.json).
