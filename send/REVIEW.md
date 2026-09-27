# PR #541 review evidence

PR: https://github.com/plow-pbc/latch/pull/541

Original head: `60ce8261fa12bb2f51e64e3447dcf4487300bd0b`.
Base: `16d871a5`.
Reviewed final head: `5ed85e8488d16f11ed850b6a1a944e28ff88106a`.
Local review branch: `codex/review-541-send`.

Two reviewed follow-up commits were pushed to this PR:

- `489214dfd927987acbf05d52c1861f7302081a8a` — Wait for message sends and preserve verification uncertainty.
- `5ed85e8488d16f11ed850b6a1a944e28ff88106a` — Preserve message text spacing on approval cards.

The first commit contains the send runtime exercised in the live self-message test. The second changes only approval rendering and its existing view-model test.

## Readiness

Keep this PR in draft. The new safeguards work, but WhatsApp destination selection and delivery verification are not safe enough to approve. Neither app's verification correlates the outbound row to the requested body; a concurrent message to the same recipient can be misattributed.

## Remaining findings for Patrick

1. **P1 — WhatsApp can type/send into the wrong conversation.** `packages/device-core/src/messageSend.ts:70` opens a deep link, sleeps 0.5 seconds, brings WhatsApp forward, types, and presses Return. It never verifies the selected chat or the active input. A slow or refused deep link can leave the previous chat active. The later read cannot undo a send to the wrong recipient. This was reviewed in source; no real WhatsApp message was sent.
2. **P1 — WhatsApp reports an arbitrary outbound row as successful.** `packages/device-core/src/messageSend.ts:118` selects literal `1`; `parseOutbound` at line 126 unconditionally assigns `sent: true` for WhatsApp. The real current schema includes `ZMESSAGESTATUS` and `ZMESSAGEERRORSTATUS`, but neither is inspected. A disposable SQLite fixture with status 1 and nonzero error 99 returns `verified: true`; see `whatsapp-false-verification.json`. This proves the verifier ignores those fields, without relying on an assumed interpretation of every native status value.
3. **P1 — Recipient + post-snapshot ROWID does not identify the requested message.** `packages/device-core/src/imessageSkill.ts:64` and `messageSend.ts:118` do not compare body or a send identifier. A synthetic iMessage row with a different text still verifies; see `imessage-body-correlation.json`. Rejecting multiple rows now closes the mixed-success/failure case, but a single concurrent row can still be falsely attributed. Resolve the identity limitation or make the result explicitly describe only an observed outbound row.

## Fixed during review

- A script still running after the executor's 20-second wait stays pending until its actual exit. Verification no longer runs before the script finishes.
- Audit remains Running until verification finishes, and records pre-send refusals.
- Empty, whitespace-only, non-decimal, negative, fractional, multiline, and unsafe-integer snapshots prevent any send.
- A pre-send SQLite refusal uses the existing host-permission diagnosis. A post-send store failure remains unverified; it does not trigger a resend.
- Verification polls the same read-only query at 250ms intervals during a five-second window. The original snapshot stays fixed. Each SQLite child is itself bounded by a five-second timeout. The send script is invoked once.
- Any second matching outbound row makes verification ambiguous, even if only one row is marked successful.
- The old WhatsApp CSV recipe and its fallback now apply `-csv` before `-header`. On this Mac's SQLite 3.54, the reverse order removes the header. The test also accepts native CRLF line endings.
- Message approval chips preserve whitespace and wrap long unbroken text inside the card. Recipient and body still enter the DOM as inert text. Other capability chip styles are unchanged.

## Validation

All commands were run in the PR #541 review worktree.

| Command | Result | Evidence |
| --- | --- | --- |
| `npx vitest run packages/device-core/test/messageSend.test.ts packages/mcp-server/test/messageSend.test.ts` | 26 passed | `focused-after.log` |
| `npx vitest run` | 2655 passed, 11 skipped; one existing SQLite CSV header failure | `full-suite.log` |
| `npx vitest run packages/device-core/test/whatsappRecipes.test.ts packages/device-core/test/skills.test.ts` after portable flag-order fix | 124 passed, including the formerly failing test | `sqlite-portability-after.log` |
| `npx vitest run apps/desktop/test/viewModel.test.ts apps/desktop/test/copyRenderer.test.ts` after whitespace fix | 42 passed | `approval-whitespace-tests.log` |
| `npx tsc -b` | Passed | `build.log`; rerun after the whitespace change also passed |
| `node apps/desktop/scripts/copy-renderer.mjs` | Passed; 19 renderer scripts parsed and copied | `build.log`; rerun after the whitespace change also passed |
| `git diff --check` | Passed before both commits | Local commit validation |

The full suite was not repeated after the localized CSV and approval fixes; their affected tests were rerun. The full-suite log is intentionally retained with its original failure rather than rewritten as a green run.

The original failing WhatsApp recipe test was byte-identical at base `16d871a5` and original PR head `60ce8261` (SHA256 `e534699ea947cb74578fdd860d05dcfa15023a5c6ffd02d6634ef6cd673e6292`). `sqlite-portability-reproduction.json` records both actual CLI outputs: `-header -csv` prints only the value, and `-csv -header` prints the header and value.

The new MCP integration test exercises actual tool envelopes, capability canonicalization, policy/rule storage, deferred handles, SQLite reads, and audit aggregation. Its irreversible `runAppleScript` boundary is replaced, and the permission-refusal case uses scripted probes. It covers denial without a script, exact recipient/body approval, remembered permission for a later body, isolation by recipient/agent, a slow inner script, and pre-send Full Disk Access diagnosis.

Existing policy tests also cover the same recipient in a different app not inheriting a rule. The regression-before log records eight failures against the unpatched send code; the final focused run passes all 26 tests.

## Live testing performed by the parent reviewer

See the redacted `../live/send-results.json` and the parent's UI evidence. The live driver used actual in-process MCP + DeviceAgent + executor + Messages + the real message store, with an explicitly approved self recipient, a disposable rule home, and a preauthorized test delegate. It did not test a live relay or click the approval card for those actual sends; approval UI was exercised separately with synthetic content.

- Self-message A: one real outbound row, `is_sent=1`, `error=0`; tool returned verified after about 4.873 seconds. No delivery receipt was claimed.
- Different text to the same self recipient: stored rule reused, exactly one outbound row, tool returned unverified after about 5.56 seconds. A later read showed `is_sent=0`, `error=22`; Messages displayed Not Delivered. No automatic retry occurred.
- A different recipient was denied before a script ran.
- The real renderer initially collapsed line breaks. Final recheck at `5ed85e84` preserved the exact complete body in all three cases, kept decision controls in the window, and rendered markup as inert text. Long content is scrollable (791px content in a 372px pane). See [metrics](../ui/ui-evidence.ndjson) and the [short](../ui/short-imessage.png), [WhatsApp](../ui/whatsapp-always-allow.png), and [long](../ui/long-message.png) synthetic screenshots.

`verified` means the local store marks the row sent. It is not a claim that the recipient received or read it. The second self-message is retained as an observed failed send, not relabeled as successful.

## Structural checks and limits

`pr-context-final.xml` records the final PR footprint versus its base. `edit-check-send.xml` and `edit-check-device.xml` found unchanged signatures and no incompatible indexed callers for the repaired send path.

`quality-delta.xml` is the pre-commit comparison against `60ce8261`. It is not green: seven major findings are additional churn, ten lines added to the already large DeviceAgent class, and increased complexity in the existing audit classifier. These are documented tradeoffs for the focused safeguards; no unrelated class refactor or acknowledgement ledger was added to conceal them. `quality-delta-whitespace.xml` has zero gating findings and two minor findings for the kind-specific renderer branch.

`test-gate.xml` reports a broad name-based reach (77 named tests, 202 untested symbols before final commit), not runtime coverage. The full suite plus focused integration tests provide the behavioral evidence; that static map alone is not a proof of merge safety.

## Suggested reviewer order

1. Resolve the three remaining findings before marking ready to merge.
2. Read `messageSend.ts`, then `DeviceAgent.executeMessageSend`, and compare `messageSend.test.ts` in device-core and mcp-server.
3. Check the redacted real-store results and the exact distinction between verified, unverified, and delivered.
4. Inspect the actual approval screenshots: both target and complete body, line breaks, long token wrapping, and visible decision controls.
5. Confirm recipient/app/agent rule boundaries in `deviceCore.test.ts` and the MCP integration test.

No real WhatsApp send was attempted. No source change turns that untested path into a validated one.

## Live evidence files

[Send results](../live/send-results.json) and [final store states](../live/send-final-store-state.json) contain only redacted metadata. The send ran against uncommitted contents then committed as `489214df`; the final `5ed85e84` changes only rendering/tests. No second live run was made to manufacture a successful result.
