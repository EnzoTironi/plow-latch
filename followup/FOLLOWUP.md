# Follow-up: source blockers fixed, remaining acceptance gates explicit

Final send head: `fe440205d9a7a1594c95bbb3e584dc479ea7858b` (runtime fix commit `107da7ba`; final commit changes only plugin guidance, with 79 affected tests passing). CLI #3 remains `493614d4398c04754e6a5006f0eb78de16947b87`; reads #540 remains `0171b62615d8d981411aa6ffe827741014eac632`.

The historical review evidence at commit `98147c8` correctly described three then-open P1 defects. This follow-up fixes those defects and additional ones found by independent review. Old reproductions remain available as the before state.

| Area | Final evidence |
| --- | --- |
| Full Latch suite on final runtime source | **2,757 passed, 11 skipped**; [log](followup-send/full-suite-final.log) |
| Build and production renderer copy | Passed; 19 renderer scripts parsed; [log](followup-send/build-final.log) |
| Exact sent-row verification | [Verifier guide](followup-send/REVIEW.md), [independent before/after closure](send-independent/closure-results.json) |
| Native target/composer safeguards | [Controller review](followup-send/controller-review.md), [independent closure](send-independent/native-closure-results.json) |
| Actual WhatsApp app through production approval UI | [Guarded native validation](followup-send/native-validation.json): exact multiline draft, two phone checks, stable controls, clipboard restoration; permanently stubbed Send boundary reached |
| Actual iMessage through production approval UI on committed source | [Tool result](followup-send/imessage-final/result.json), [native store/UI](followup-send/imessage-final/store-check.json): one row, error22/Not Delivered, correctly unverified, no retry |
| Both architecture release candidates | 50 CLI tests each; checksum/staging/dispatch controls pass; [maintainer release handoff](release-followup/RELEASE-HANDOFF.md), [reproducible bundle](release-followup/release-validation-493614d.zip) |

## Closed source findings

- WhatsApp no longer types after a guessed fixed delay. It confirms the canonical phone in a narrowly supported contact-info layout, requires an empty composer, binds the same window/header/composer, rechecks identity and exact body, and presses the specific Send control once. Groups, hidden phone fields, ambiguous or changed layouts, existing drafts, and observable focus/context changes refuse safely.
- Native Accessibility transitions use bounded snapshot reads. Only invalid-element/cannot-complete read errors may retry in existing waits; no action retries. The real guarded test recovered from two -25202 errors. The exact emitted controller is tested; it is not an untested string copy.
- WhatsApp requires a known sent state, explicit error0, eligible text type, native ID and exact body. iMessage additionally excludes another group/SMS at the same handle. Lossless hex projection preserves multiline/Unicode/pipe text.
- The shipping v0.1.0 attributed-body decoder runs over a private bounded single-row copy with NULL legacy text, preventing malformed blobs from verifying via stale-text fallback. Exact identity/cardinality/status are reread after decoding.
- Each DeviceAgent serializes sends before their snapshots. Queued, blocked, running and unverified audit states are honest. A failed script cannot be rescued by another observed row; any second candidate is ambiguous; no send retries.

## Remaining gates and practical limits

1. **#540 official release:** this GitHub account has no upstream push/maintain/admin permission. A maintainer must merge #3 and publish the two official assets plus checksums. The prepared helper verifies release source and actual published checksums, then emits the exact pin patch. Local review archives do not replace the shipping pin.
2. **#541 live WhatsApp acceptance:** no real WhatsApp recipient was authorized. The parent asked for one; no message was sent. Guarded native UI evidence stops deliberately before Send. Complete one approved real delivery/store test before landing. The latest iMessage self test hit the native account's delivery failure, which is reported rather than retried or mislabelled verified; prior local-sent success and failure remain in the original evidence.
3. **Integration:** both Latch PRs independently merge with current main but conflict with each other. Prepared patches, an isolated build, 1,405 passing combined tests (4 skipped), and 196 final overlapping doc checks document the exact combined resolution in `integration-followup/`.

The approval tests use production renderer/preload/view-model and actual MCP/DeviceAgent/executor, with a temporary Electron host and local-file approval bridge. This validates the native approval click and operation; it does not claim live relay transport. Private recipients, account identifiers, private message text and native private screenshots are excluded. The synthetic test text is retained.

Local verified means one exact successful outbound store row observed during a bounded window, not remote delivery/read receipt or absolute causal proof. A simultaneous human or another DeviceAgent can race native GUI snapshots; controls and labels detect observable changes but macOS exposes no atomic identity+Send operation. Missing/unknown evidence fails closed. Static quality output remains nonclean and is included, with maintenance/churn tradeoffs disclosed; no baseline manipulation was used.
