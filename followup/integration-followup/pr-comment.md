Integration with the other messaging PR is prepared against #540 `0171b626` and #541 `fe440205`. Either merge order produces the same resolved tree and has four conflicts:

- Keep #540's deletion of `packages/device-core/src/whatsappSkill.ts` and `packages/device-core/test/whatsappRecipes.test.ts`.
- Combine the header of `packages/device-core/src/imessageSkill.ts`: reads go through `plow-messages`; text sends use `plow_send_message`. Preserve the remaining automatic merge, including exact local-sent/no-retry guidance.
- Keep #540's read instructions in `apps/desktop/plugins/messages/skill.md`, and select #541's new final send paragraph below. Do not take one whole side of either content-conflicted file.

Exact iMessage header paragraph:

```ts
 * The schema is versioned with macOS Messages, not with the Plow repo. The
 * store path is written as a RESOLVED `/Users/<owner>/…` rather than
 * `~`-relative: an absolute path is the only one that cannot be lost when an
 * agent runtime drops the optional `cwd` argument (see `imessageSkillFor` for
 * the failure that cost). Reading is a query through `plow-messages`. Text
 * sends use `plow_send_message`, outside the sandbox, because Messages refuses
 * Apple events from a sandboxed sender (-10004, `app_refuses_sandboxed_sender`).
```

Exact final messages skill paragraph:

```md
This plugin only reads message history. For sends, use `plow_send_message` with
the app, canonical recipient and exact body. Its approval can remember the same
recipient; an unverified result must never trigger an automatic retry.
```

The automatic merge retains send dispatch/queue/native-body decoding/audit while removing the old WhatsApp read skill's registration/export. The plugin manifest remains byte-identical to #540. Patches onto either exact PR commit apply cleanly and produce tree `7a65e882513a4cf31efcff3b47358d8c1129da29`.

Validation: the full TypeScript project build of the final combined tree passed in an isolated source projection with workspace imports resolving to the combined source. The combined affected suites passed **1405 tests, 4 skipped** across **64 passing files and 1 skipped file**. This ran before the final documentation-only commit; a tree comparison proves all runtime/test/config files are identical afterward. The final documentation resolution then passed **196 overlapping plugin/skill/copy tests** directly. The four skips are opt-in Camoufox integration tests. No real send was performed for this integration check. Refresh the remaining branch after the first merge and rerun checks on the resulting commit.
