# Messaging PR review — 2026-09-27

This evidence accompanies [plow-messages #3](https://github.com/plow-pbc/plow-messages/pull/3), [Latch #540](https://github.com/plow-pbc/latch/pull/540), and [Latch #541](https://github.com/plow-pbc/latch/pull/541). Follow-up fixes were pushed without rewriting history.

| PR | Tested source | Review outcome | Evidence |
| --- | --- | --- | --- |
| plow-messages #3 | `493614d4398c04754e6a5006f0eb78de16947b87` | Ready for review; 50 tests pass and real-store checks pass | [Reviewer guide](cli/reviewer-guide.md), [test log](cli/final-just-test.log), [live results](live/read-results-final.json) |
| Latch #540 | `0171b62615d8d981411aa6ffe827741014eac632` | Draft: release pin still lacks `--app` support | [Reviewer guide](reads/reviewer-evidence.md), [1,227-pass test log](reads/final-tests.log), [actual pinned-binary failure](reads/pinned-release-probe.json), [live source-binary dispatch](live/read-dispatch-results.json) |
| Latch #541 | `5ed85e8488d16f11ed850b6a1a944e28ff88106a` | Draft: wrong-chat WhatsApp send, false WhatsApp success, and message-correlation blockers | [Review findings](send/REVIEW.md), [26-pass integration log](send/focused-after.log), [live send results](live/send-results.json), [approval screenshots](ui/) |

The full Latch send-branch run had 2,655 passes, 11 skips, and one SQLite header-order failure. That failure was reproduced on unchanged base code, fixed, and its 124-test recipe/skill suite rerun successfully. The final approval-text fix passed 42 affected tests; both builds passed. The [original full-suite log](send/full-suite.log) is retained rather than described as an all-green final run.

## What was exercised

- All four compiled CLI verbs against both real archives. A native WhatsApp group-join notice was matched to its system-event row. Private bodies, account identifiers, names, and actual JIDs are omitted from the published evidence.
- Actual Latch MCP envelopes, policy, sandboxed plugin dispatch, and real stores for each app using a deliberately staged **source build** in a temporary plugin directory. Missing-binary and forbidden-store negative controls passed. This does not validate the unchanged shipping v0.1.0 pin.
- Two user-authorized iMessage self-test calls through actual MCP, DeviceAgent, executor, Messages, SQLite verification, and a disposable rule home. A test-only delegate supplied the already-authorized approval; no production rule was changed. The live relay and interactive approval click were not part of these two sends.
- The first self-test was verified by the local sent flag. The second used the stored recipient rule, stayed unverified, then showed error 22 / Not Delivered. Each created exactly one outbound row, with no retry. A different recipient was denied. Local sent status is not a delivery/read receipt.
- Real Electron view model, preload and renderer with synthetic short/long bodies: full text and whitespace preserved, markup inert, controls inside the window, long content scrollable. The live Messages UI separately confirmed the two self-test texts and the second failure. No real WhatsApp send was attempted.

## Landing order and unresolved work

1. Review/merge plow-messages #3, then publish macOS arm64 and amd64 release archives with `checksums.txt`.
2. Update all five pin values in Latch #540 (version, two URLs, two hashes), restage, and repeat packaged read tests before removing its draft gate.
3. Resolve #541's three P1 findings and complete safe live WhatsApp validation before removing its draft gate.
4. The two Latch PRs currently conflict in `imessageSkill.ts`, plus modify/delete conflicts for `whatsappSkill.ts` and `whatsappRecipes.test.ts`. When integrating after #540, retain the deletions and keep the new first-class send documentation. Update the messages plugin skill's send guidance to `plow_send_message`; its current AppleScript text is correct only before #541 lands. Run the affected suites again after integration.

No published release, merge, or automatic reviewer approval was performed. GitHub reports no PR checks for these fork branches; that is recorded as unavailable CI, not green CI. The automated reviewer says a maintainer must invoke its review; no authorization workaround was attempted.

## Reproduction

The per-PR guides list exact commands and test boundaries. The live drivers are included for review; running the send driver sends real messages and requires an explicitly chosen self/test recipient. Set `REVIEW_WORKTREE` and `REVIEW_RECIPIENT` for `live/send-self.mjs`. Set `REVIEW_READS_WORKTREE` and `REVIEW_CLI_BINARY` for `live/read-dispatch.mjs`. Use built checkouts at the cited commits. The test recipient is intentionally absent from this archive.

Environment: macOS 27.2 (26B5086k), Messages 26.0, WhatsApp 26.38.20, system SQLite 3.54.0. Full Disk Access was granted by the owner before the live tests. Full detailed static-analysis reports are navigation aids, with their limits and non-green churn findings disclosed in the per-PR guides.
