# Messaging PR review — final follow-up

The source blockers found in the first review are fixed and pushed. [Full follow-up, commands and evidence](followup/FOLLOWUP.md).

| PR | Current source | State and remaining work |
| --- | --- | --- |
| [plow-messages #3](https://github.com/plow-pbc/plow-messages/pull/3) | `493614d` | Ready for review. 50 CLI tests pass on both architectures, real archive checks pass. [Release preparation](followup/release-followup/RELEASE-HANDOFF.md). |
| [Latch #540](https://github.com/plow-pbc/latch/pull/540) | `0171b626` | Draft pending official CLI release and verified pin update. 1,227 tests passed; both release candidates staged and dispatched successfully. |
| [Latch #541](https://github.com/plow-pbc/latch/pull/541) | `fe440205` | All reproduced source blockers fixed; 2,757 tests passed, 11 skipped. Draft pending real WhatsApp acceptance. Guarded native flow reached the disabled Send boundary. iMessage self test produced one failed native row and correctly stayed unverified without retry. |

[Final send suite](followup/followup-send/full-suite-final.log) · [native WhatsApp evidence](followup/followup-send/native-validation.json) · [iMessage result and native store/UI](followup/followup-send/imessage-final/store-check.json) · [independent review](followup/send-independent/native-review.md) · [tested integration patches](followup/integration-followup/README.md).

The original evidence below is retained as historical baseline. Its three open P1 findings are superseded by this follow-up. The complete original state is immutable at [98147c8](https://github.com/EnzoTironi/plow-latch/tree/98147c8f00cdb3451d1159165e74502541044e80).

No upstream release or merge was performed. GitHub reports no PR checks; that is unavailable CI, not green CI. Published artifacts exclude private recipients, account identifiers, owner message content and private native screenshots.
