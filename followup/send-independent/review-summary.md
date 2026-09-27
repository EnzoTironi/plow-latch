Independent review of the PR #541 follow-up found four concrete defects and verified their fixes against the current working source. The source was based on `5ed85e8488d16f11ed850b6a1a944e28ff88106a`; these closure results are for the follow-up contents before the final commit. The parent review must attach its final build/test results and commit SHA.

| Finding | Before | Independent closure |
| --- | --- | --- |
| A direct iMessage request could match a group or SMS row with the same handle/body | Native SQLite fixtures returned `verified: true` for both wrong chats | Updated SQL excludes both; `verified: false` |
| Pinned v0.1.0 decoder silently fell back to legacy text after malformed attributedBody | Real shipping binary, exact decoder arguments, and real Executor sandbox returned `hello` for nonempty malformed blob `010203` plus legacy text `hello` | Private single-row database contains the original blob and NULL text; malformed blob returns null, valid captured typedstream still decodes |
| A second outbound row arriving during decoding escaped the final check | Deterministic clock/dependency fixture had two rows by the deadline but returned verified after only the snapshot and first verification query | A fresh third SQL read sees both rows and returns `unverified`, reason `many` |
| An approved send waiting for the serialization queue appeared complete | Audit events with approval but no send start produced `Completed` | The queued event produces `Queued`, status kind `running` |

Evidence files are `wrong-chat-repro.json`, `pinned-decoder-repro.json`, `decode-window-race.json`, `queued-audit-repro.json`, and the combined `closure-results.json`.

The old decoder compatibility check used the actual staged `vendor/plugins/messages/runtime/arm64/bin/plow-messages` v0.1.0 binary, with `--store <fixture> search --chat-id 1 --after-rowid 8 --order asc --limit 1`, run through Executor with only the temporary database directory and pinned binary directory readable, no approved writes, network disabled, and Apple events disabled. The private database was confirmed mode 0600 with NULL legacy text and removed after decoding. The valid typedstream blob comes from the existing nonpersonal upstream fixture.

Native schema metadata on this Mac confirms the added direct-send constraints use real columns (`message.service`, `chat.style`, and `chat.chat_identifier`). A content-free aggregate confirmed the existing outbound direct iMessage rows follow the constrained relationship. No message bodies or recipient values from the owner's archive were inspected for that metadata check.

Static review also checked fixed argv construction, bounded and validated blob hex, SQLite input passed through stdin, exact row/chat/native-message/blob cache identity, fresh status/cardinality checks after decoding, temporary-store cleanup, and queue ordering per DeviceAgent. Decoder absence, malformed output, query failure, and failed script execution remain uncertainty rather than automatic retries. The native WhatsApp UI target/composer logic is reviewed separately by the parent and implementation lane.

This lane ran isolated proof checks only. It did not edit source, run broad suites concurrently, drive applications, send messages, commit, push, or change PR metadata. No additional concrete blocker remained in the inspected verifier/queue/decoder changes after these closure checks.
