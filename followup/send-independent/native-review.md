# Independent review of the WhatsApp native sender

The three concrete failures reproduced in the initial implementation are closed in the final reviewed source. Twenty-seven isolated closure probes pass, including the final bounded transient-read retry. No additional actionable defect was found in the fixed controller or the executor language selection during this review.

This is a scoped source and fixture result. It is not evidence of a real WhatsApp delivery. The parent reviewer separately completed a guarded native app run through the final permanently disabled Send boundary. Its sanitized evidence confirms actual phone checks, reference and label stability, exact multiline text, transient-read recovery, and clipboard restoration. The synthetic draft was cleared, and no outbound message was created.

## Reviewed state

- Worktree: `/Users/reviewer/.codex/worktrees/review-message-send/latch`
- Base commit: `5ed85e8488d16f11ed850b6a1a944e28ff88106a`
- Follow-up files are working changes, not yet committed at the time of review.
- `packages/device-core/src/whatsappSend.ts` SHA-256: `5617a8caab2b6d46e99f9fb879aec0619f9c3bc3e411617f0c3ad12d8dff7983`
- `packages/device-core/test/whatsappSend.test.ts` SHA-256: `7e67a9e3b9f70b1a7a22924c21af93fc94add2acab0ea4deec1fa0ad1a4e6d3b`
- Final closure execution: `2026-09-27T12:31:54.411Z`

## Findings and closure

| Original defect | Concrete initial reproduction | Fixed behavior and independent closure |
| --- | --- | --- |
| A conversation change during the final contact-info close could reach Send. | Change the visible heading and phone after the second Escape while preserving the window, control references, and exact body. The original controller returned `LATCH_SEND_ATTEMPTED` and pressed Send. | The header label and both header/composer references are now compared before and after info navigation and again before paste/Send. Separate heading, header-reference, and composer-reference changes all return `LATCH_RECIPIENT_UNVERIFIED`, with zero Send actions. The label is a continuity witness after phone proof; it is not accepted as recipient identity. |
| Unsupported composer `AXValue` was treated as proof of emptiness. | Native adapter fixture returns AX error `-25205`; the original adapter produced `""`. | `-25205` throws `AX attribute unsupported`. Native `-25202` and `-25204` produce specific transient-read errors; other failures retain their numeric diagnostic. Only `-25212` (no value) maps to the supported empty-composer representation. |
| Identifier-matching controls with unexpected roles were accepted. | Mark composer and Send as `AXStaticText` while retaining their semantic identifiers. The original controller pressed Send. | Header and Send require `AXButton`; composer requires `AXTextArea`; main window requires `AXWindow`. Each wrong-control-role probe refuses with zero Send actions. |

Initial reproductions are in `native-boundary-probes.json`. Fixed results are in `native-closure-results.json`.

## Additional boundary evidence

- The happy path proves the secondary phone field twice, pastes the exact multiline Unicode body, and performs one Send action.
- A Send action that throws remains `LATCH_SEND_UNVERIFIED`. Clipboard restoration that throws after Send also remains `LATCH_SEND_UNVERIFIED`. Neither path retries Send nor reports a pre-send refusal.
- Transient snapshot errors `-25202` and `-25204` recover only inside bounded readiness waits. Four injected read failures across the two info closes recover after 600 ms of fixture time, with exactly two info actions, two Escape actions, one paste, and one Send. Persistent failures stop at the 30-second deadline (30,150 ms including the final fixture pause). Unsupported errors and unknown transient markers stop without a retry. A conversation change during a transient read still refuses before Send. The same transient marker thrown by an info or Send action is never retried; an attempted Send remains unverified.
- A changed focused element or newer clipboard before paste stops before paste/Send.
- The native clipboard fixture preserves two items and all text, RTF, PNG, and custom-type bytes. A later user copy is retained. Exceptions both before and after accepting the temporary payload restore the original items when ownership remains established.
- Phone identity is restricted to the expected secondary static field inside the semantic contact-info container. The accepted recipient is an E.164-shaped direct `@s.whatsapp.net` JID, and the deep-link URL must agree exactly. Group and LID addresses remain refused.
- Source inspection confirms bounded AX traversal and pruning of chat history/list subtrees. Controls must be unique and inside the selected main window; unexpected sheets, window/focus changes, nonempty existing drafts, disabled controls, and unsupported layouts refuse.
- Executor inspection: `JavaScript` adds only the fixed `-l JavaScript` arguments before the fixed script filename. Message and recipient values remain arguments after the filename. The default remains AppleScript, file permissions remain `0600`, and execution remains non-reapable. The implementer separately reports 54 sender and executor-language tests passing, including actual `osascript` execution; this independent pass did not rerun their suite.

## Native evidence inspected

The parent-owned `/tmp/latch-review-20260927/followup-send/native-validation.json` records the same final source SHA. Its native-draft-5 diagnostic log contains two `LATCH_AX_TRANSIENT:-25202` read errors followed by `AX_REVIEW_FINAL_SEND_STUB_REACHED`, the deliberate `REVIEW_SEND_DISABLED` exception, and `AX_REVIEW_CLIPBOARD_RESTORE_RETURNED`. The controller reports `LATCH_SEND_UNVERIFIED` after that deliberately stopped action boundary. This validates navigation, drafting, and refusal/uncertainty behavior in the real app while keeping Send disabled. Actual WhatsApp sending/delivery is still untested.

## Native limitations to keep explicit

An Accessibility snapshot and a subsequent GUI action cannot be atomic against a concurrent human/application switch. The new continuity checks close the observed navigation-time gap; they do not establish an immutable WhatsApp chat identifier outside the info pane. A same-label conversation switch that reuses both native control references may be indistinguishable until the next phone inspection. The guarded native run establishes reference/label stability for the tested normal navigation path; it does not establish atomic target binding.

The success sentinel is `LATCH_SEND_ATTEMPTED`, not proof of delivery. The separate outbound-store verification must still confirm the exact new outbound row; downstream uncertainty must remain explicit.

## Reproduce the independent probes

```sh
node /tmp/latch-review-20260927/send-independent/probe-native-closure.mjs
```

This bundles only the selected production module into this evidence directory, evaluates its fixed script with fixture adapters, and asserts all twenty-seven cases. It records source/test hashes and rejects files changing during the run. It does not access native UI, send messages, modify repository source, run a broad build, or mutate a PR.
