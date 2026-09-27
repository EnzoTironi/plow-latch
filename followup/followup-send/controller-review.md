Final binding: runtime committed as `107da7ba`; final PR head `fe440205` adds only plugin documentation. See the parent [follow-up](../FOLLOWUP.md) for complete tests and actual native outcomes.

# WhatsApp native sender review notes

Working copy: `/Users/reviewer/.codex/worktrees/review-message-send/latch`. This note covers the new `whatsappSend.ts` controller and native adapter, their fixture tests, and the optional Executor language setting. The parent review owns the final commit, full suites, real-app preflight, and publication.

## Supported identity and send path

- Accept only a canonical phone JID and a deep-link URL derived from the identical phone. Groups and LIDs are refused before opening the application.
- Open the contact-info sheet and prove the recipient from the secondary static-text phone field in the unique `contact-info-view-name-number-view` container. The first child must be a heading or exactly one group containing one heading. Display names never establish identity. Unknown layouts, hidden-phone usernames, unsaved-contact profile labels, and groups fail closed.
- Require the known native roles, one active main window, an empty composer, and no enabled Send button that could indicate an AX/app-model disagreement about an existing draft.
- Preserve every clipboard item/type before pasting the approved body. Do not type the body as keystrokes. Do not restore over a later clipboard revision. A failed clipboard write restores the original data only when ownership can still be established.
- Reopen contact info after staging; prove the phone again. Check the header/composer native references and header label remain continuous across closing info and the final snapshot. The label is a continuity witness after phone proof, never recipient identity.
- Require the exact staged body and an enabled, unique `ChatBar_SendButton` of role `AXButton`. Invoke its AXPress action once. Never press Return and never retry an action.
- Keep pre-send refusal distinct from an attempted action. Once the Send action is attempted, errors remain unverified outcomes and cannot become a safe-to-retry pre-send refusal.
- Prune message-history/sidebar tables from AX traversal, cap depth/nodes, and use bounded waits. Unsupported composer AXValue is unknown; only the documented no-value state can represent empty text. Existing bounded waits retry snapshot reads only for native invalid-element (-25202) and cannot-complete (-25204) errors; all actions remain single attempts. Other native read failures retain only a numeric diagnostic.

## Evidence

`controller-tests.log`: 52 WhatsApp tests plus 2 actual macOS osascript Executor language/argv tests, 54/54 passed. The WhatsApp tests execute the exact generated JXA controller and native-helper source under Node VM fixtures. They cover recipient spoofing, unsupported recipient/layout cases, duplicate controls, existing/stale drafts, role mismatches, context changes after final info close, body changes, clipboard ownership/data preservation/write failures, multiline Unicode, Send exactly once, post-attempt errors, native value fallbacks, and traversal bounds.

`controller-build.log`: `npx tsc -b packages/device-core --pretty false` passed. `git diff --check` passed. `executor-contract.xml` reports the existing Executor method contract unchanged, with no incompatible callers found.

`native-draft-5/` records the parent's final guarded run against the actual WhatsApp desktop app. It reached the permanently disabled final Send stub after both canonical-phone checks, exact multiline/apostrophe/Unicode body staging, stable header/composer native references, and final composer validation. Two real native -25202 invalid-element read failures recovered within the existing bounded waits. Clipboard restoration returned without error. The intentional final Send stub produced an unverified result with script exit 1, as expected after an attempted action. No WhatsApp message was sent. The parent cleared the synthetic draft and verified a truly empty composer with the Voice button present.

`controller-source-hashes.json` records SHA-256 hashes for the frozen source/tests, compiled module, and emitted JXA script before the parent's final commit. The parent's full-suite and final-commit evidence complements these focused results.

An independent reviewer also ran 18 closure probes against the emitted script: all passed. Evidence is `../send-independent/native-closure-results.json` and `../send-independent/probe-native-closure.mjs`. These include separate heading/header-reference/composer-reference changes, unknown composer values, role mismatches, failed Send once, post-action restoration failure, binary clipboard restoration, and later user copies. This evidence is also fixture-based.

`controller-quality.xml`: scoped preexisting-major gating count is zero, but this is not a claim of no new maintenance cost. The new controller is 166 lines including local guard helpers (computed complexity 56); the fixed native-adapter string is 161 lines. The closure keeps the single deadline, claimed window, clipboard lease, and attempt state together. Dynamic embedding/VM use also creates static dead-code false positives. Findings outside this scope belong to the other review work and were not acknowledged or altered here.

## Limits Patrick should assess

- This is a strict adapter for the observed WhatsApp 26.38.20 desktop layout, not a general WhatsApp automation API. A layout change should refuse before sending. The final guarded native run confirmed normal header/composer reference stability and successful bounded recovery from transient reads.
- A GUI snapshot and AXPress cannot be atomic against a human changing the app in the final instant. Serializing Latch's WhatsApp calls prevents its own concurrency; it cannot lock out the user. The continuity checks detect observable changes, but should not be described as eliminating every UI race.
- Fixture results do not prove native delivery. The parent's guarded native preflight permanently disables Send while testing identity, staging, revalidation, and clipboard restoration. Actual WhatsApp delivery requires separate authorization and evidence.

No commit, push, GitHub edit, or real UI send was performed by this child agent for this sender implementation.
