# Exact integration guidance for Latch #540 and #541

Final inputs: #540 `0171b62615d8d981411aa6ffe827741014eac632` and #541 `fe440205d9a7a1594c95bbb3e584dc479ea7858b`. Common base: `16d871a53b7c495c639670e3ac6e2b87080f4299`. This preview changed no active source, index, branch, commit, PR or remote. Git merge objects and source/build projections are isolated under this evidence directory.

## Four conflicts, one resolution

Either landing order has the same four conflicts and produces resolved source tree `7a65e882513a4cf31efcff3b47358d8c1129da29`.

Keep #540's deletions of:

- `packages/device-core/src/whatsappSkill.ts`
- `packages/device-core/test/whatsappRecipes.test.ts`

These are the legacy SQL read skill and its tests. Restoring them would undo #540. The portable CSV change in #541 applies only to code #540 intentionally removes.

In the top block comment of `packages/device-core/src/imessageSkill.ts`, combine the read and send guidance with this paragraph:

```ts
 * The schema is versioned with macOS Messages, not with the Plow repo. The
 * store path is written as a RESOLVED `/Users/<owner>/…` rather than
 * `~`-relative: an absolute path is the only one that cannot be lost when an
 * agent runtime drops the optional `cwd` argument (see `imessageSkillFor` for
 * the failure that cost). Reading is a query through `plow-messages`. Text
 * sends use `plow_send_message`, outside the sandbox, because Messages refuses
 * Apple events from a sandboxed sender (-10004, `app_refuses_sandboxed_sender`).
```

In `apps/desktop/plugins/messages/skill.md`, preserve all #540 read instructions and resolve the final paragraph to the first-class send guidance from #541:

```md
This plugin only reads message history. For sends, use `plow_send_message` with
the app, canonical recipient and exact body. Its approval can remember the same
recipient; an unverified result must never trigger an automatic retry.
```

Complete resolved copies of both files are in `resolved-files/`. Do not select one complete side of either file: that would lose one PR's instructions. The automatic merge preserves #540's removal of the WhatsApp SQL skill registration/export and retains #541's send dispatch, queue, native body decoder, audit and tool. The messages plugin manifest remains byte-identical to #540.

## What to apply after one PR lands

Refresh the other PR onto the new main using the team's normal merge/rebase workflow. Resolve the two modify/delete conflicts with `git rm -- packages/device-core/src/whatsappSkill.ts packages/device-core/test/whatsappRecipes.test.ts`. Combine the iMessage header and select the new message-send paragraph as above, then stage those two files. Finish the merge/rebase and rerun checks on its actual resulting commit.

For exact frozen-input reproduction:

- `onto-540.patch` applies to #540 `0171b62615d8d981411aa6ffe827741014eac632` and yields the complete combined source.
- `onto-541.patch` applies to #541 `fe440205d9a7a1594c95bbb3e584dc479ea7858b` and yields that identical combined source. `onto-541-snapshot.patch` is an exact alias retained for earlier local references.
- `conflict-resolution.patch` is the exact four-file resolution diff from the auto-merged tree. Its marker labels reflect this captured merge; use the supplied resolved files/excerpts when Git displays different labels.

All patches were applied successfully to temporary indexes and produced `7a65e882513a4cf31efcff3b47358d8c1129da29`. Both merge orders yielded that same final tree. The patches target these exact commits, so regenerate them if either source changes. Raw merge output, source/tree IDs and patch SHA-256 values are in `merge-tree.txt`, `reverse-merge-tree.txt` and `manifest.json`.

## Validation

The full resolved tree was exported into `/tmp/latch-review-20260927/integration-followup/final-doc-dc3ww0_9/resolved-source`. Third-party dependencies were reused through symlinks, while workspace package links point to the temporary projection. The full project command `node <existing typescript>/bin/tsc -b --pretty false` exited **0** with no diagnostics (`typecheck.log`). Build outputs and TypeScript caches stay in that projection.

The combined affected suite ran on the resolved runtime at #541 `107da7ba`: all device-core and mcp-server tests plus desktop pluginsModel/viewModel/auditIndex. Result: **64 test files / 1405 tests passed, 1 file / 4 tests skipped**, in 58 seconds (`combined-tests.log`). The skipped suite is the opt-in Camoufox integration, which requires `DOMO_BROWSER_RUNTIME` and `DOMO_CAMOUFOX`.

Final #541 `fe440205` changes only the three-line messages skill send paragraph. Comparing the two resolved trees proves **every file except `apps/desktop/plugins/messages/skill.md` is identical**, including all runtime and test sources. The SHA-256 over every other tree entry is `01e9d00077c34cbe092f9e53333da5e6170fb87499c8d855a2fb1e66154f62ac` (`runtime-equivalence.json`), so the 1405-test runtime evidence carries forward without claiming it ran on a different source tree.

The final documentation resolution was then tested directly: pluginSkills, imessageRecipes, skills, MCP toolCopy and desktop pluginsModel — **5 files / 196 tests passed**, no skips (`final-doc-tests.log`). These overlap the combined suite and are not additional unique coverage. The final resolved source stayed unchanged after validation. `combined-results.json` records the exact commands, projections, commits, trees and counts. No live messaging action ran in this preview.

#540's independent release/checksums gate remains governed by its own PR. This preview publishes no release and changes no pin.
