PR #3 review evidence — tested `493614d4398c04754e6a5006f0eb78de16947b87`

The WhatsApp adapter now uses the same read verbs and output contract as iMessage, with explicit JID handling and regression coverage against the actual Swift executable. The review found and fixed these defects in local commit `493614d4398c04754e6a5006f0eb78de16947b87`:

- A group row without a member foreign key claimed the group itself was the sender. It now emits `sender: null`; `is_from_me` continues to distinguish owner rows. Missing member records also stay null.
- Group/system records were returned as messages and could change `unreplied`. Types 6 and 10 are excluded consistently from search, thread, chats, and both sides of the newest-row selection. Attachments with null bodies, null type codes, and unknown message types remain eligible.
- `chats` used cached session activity, which could point to system-only/empty conversations. It now derives `last_message` from the newest eligible message and omits sessions with no eligible rows.
- `thread --handle` and `unreplied` accepted broadcast/status identifiers as direct conversations. Direct filters now accept personal `@s.whatsapp.net` and `@lid` JIDs.
- Help and the skill now explain that WhatsApp handles come unchanged from `chats.chat_identifier`, while Contacts phone/email handles apply to iMessage. Unknown senders are documented and the manifest title covers both apps.

Validation

- Pinned baseline: `npm ci`, `just test`: 42/42 passed at `7befff7`.
- Final: `just test`: 50/50 passed across 2 test files; no skipped tests. Built with Apple Swift 6.4, arm64 macOS 27.2, Node 22.22.3, Vitest 2.1.9, and `/usr/bin/sqlite3` 3.54.0. The existing NSUnarchiver deprecation warning remains; it is the pre-existing typedstream decoder.
- Reproduced before fixing: missing group sender (1 failing regression), event/direct-chat scenarios (3 failing regressions), then type-10 newest-row scenarios (2 failing regressions). After the predicate and sender changes all pass.
- Binary tests cover four verbs; sender/owner distinction; group attribution; unknown group sender; system-event filtering; newest real timestamps; old inbound outside the 36-hour window; recent bodiless attachments and unknown message types; personal LID handles; group/broadcast/status exclusion from direct reads; literal `%`, `_`, regex-shaped and SQL-shaped phrases; bound apostrophes; date windows; thread limits/order; combined filters; row-id cursor; and omitted `--app` compatibility with explicit iMessage.
- 24 selector override cases: 4 verbs × 6 forms (`--app`, `--app=`, `-a`, `--store`, `--store=`, `-s`) after the verb all exit 2 without rows. This proves the CLI parser defense; Latch's before-intent allowlist defense is validated on the Latch PR.
- `git diff --check` passed. `runWhatsappChats`'s static contract check reports unchanged, incompatible callers 0. Ripwire quality delta reports 7 recent-churn entries and no complexity, duplication, API, or error-masking regressions; the churn was not hidden with acknowledgements. Its static graph does not connect TypeScript `execFileSync` test calls to Swift, so its empty affected-test list is not coverage evidence; the built-binary suite is.

Schema and real-user evidence boundary

- The native-app lane confirmed a group-join notice in WhatsApp 26.38.20 corresponds to `ZMESSAGETYPE=6`, `ZGROUPEVENTTYPE=15`. The actual store also contains type-10 metadata records (identifier/business-name fields rather than message content). A [primary SQLite parser](https://gist.github.com/mattura/14d110042f5dc86ade73f8d28080c2cd) independently classifies type 10 as system information. Type 10 was not separately matched to a native UI notice during this review.
- This is a narrow exclusion of known event types, not a speculative allowlist. `ZGROUPEVENTTYPE` is not used as a generic event flag, and a null body never makes a row disappear.
- Live aggregate inspection confirmed missing group-member rows have a group-valued `ZFROMJID`, so falling back to `ZFROMJID` would not identify a member. No private message bodies, names, phone numbers, or real JIDs belong in the PR evidence.
- Parent review lane owns the final live-store four-verb retest and native-app observations; attach its redacted results alongside this report. This lane sent no messages.

Reviewer path

1. `plow-messages.swift`: inspect `whatsappRealRows`, `WHATSAPP_MESSAGE_COLUMNS`, and the four WhatsApp read functions. Confirm the same event predicate appears inside the correlated newest-row query.
2. `test/whatsappCli.test.ts`: read the synthetic edge store and event/sender regressions; this uses `/usr/bin/sqlite3` and executes the compiled binary.
3. `test/cli.test.ts`: confirm default iMessage compatibility remains covered.
4. `skill.md`, `latch-plugin.json`, and CLI help: check the pinned global selector and JID guidance match Latch #540.

Reproduce with `npm ci && just test` on macOS. Release packaging for both architectures and publishing `checksums.txt` remain the dependency gate for Latch #540; this review did not create a release or change the downstream pin.

## Final live retest

[Redacted results](../live/read-results-final.json) at `493614d`: all four verbs ran against both real stores. WhatsApp newest-chat thread now returns 12 rows; the earlier build selected an empty session. Checked 24 returned WhatsApp rows against native type metadata; none were events 6/10. Both unreplied results had personal JIDs. Default/explicit iMessage and three baseline/current iMessage commands were identical. Native schema and UI were inspected, with private values omitted. [Latch source-binary dispatch](../live/read-dispatch-results.json) also passed for both archives.
