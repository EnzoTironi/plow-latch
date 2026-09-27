All feasible local release preparation is complete for plow-messages PR #3 at `493614d4398c04754e6a5006f0eb78de16947b87` and Latch PR #540 at `0171b62615d8d981411aa6ffe827741014eac632`. No checkout, PR, tag, or official release was changed in this follow-up.

Both macOS architectures were compiled with the release workflow's flags (`swiftc -O`, `-target <arch>-apple-macos13.0`, the Objective-C bridge header). The local machine is arm64 macOS 27.2, Xcode 27.0 / Swift 6.4 / macOS SDK 27.0. The Intel binary was executed through Rosetta. This verifies the Intel executable on this machine; it does not replace the workflow's native Intel runner or testing on macOS 13. Both builds have the existing NSUnarchiver deprecation warning, whose legacy typedstream behavior is covered by the CLI fixture suite.

| Completed validation | Result | Evidence |
| --- | --- | --- |
| arm64 release-shape build | Mach-O arm64; exit 0 | `build-arm64.log` |
| amd64 release-shape build | Mach-O x86_64; exit 0 | `build-amd64.log` |
| Production `stageBinaries`, both architectures | Verified archive SHA-256; extracted the named executable; all smoke probes passed | `stage-results.json` |
| Complete CLI suite against staged arm64 binary | 50 passed, 0 skipped | `tests-arm64.log` |
| Complete CLI suite against staged Intel binary via Rosetta | 50 passed, 0 skipped | `tests-amd64.log` |
| Stage a deliberately wrong checksum | Refused; incomplete runtime removed | `stage-results.json` |
| Restage a deliberately corrupted staged executable | Restored bytes from the verified archive | `stage-results.json` |
| Normal Latch plugin dispatch via `DeviceAgent.handleIntent` | Default, explicit iMessage, and explicit WhatsApp help succeeded through sandboxed execution and were audited | `dispatch-results.json` |
| Remove the loaded plugin's staged executable | Dispatch failed with missing-file error and returned no CLI help | `dispatch-results.json` |
| Official pin generator against the current v0.1.0 release | Refused incompatible source and created no proposed pin | `official-pin-negative.log` |

Staging uses Latch's production SHA/extraction/rebuild code with local bytes injected through its existing `FetchBytes` seam. The test manifest has explicitly local `https://release-review.invalid/...` fixture URLs and is saved only under this evidence directory. Dispatch uses a temporary device, temporary owner home, and the normal `HeadlessPolicy` fixture. No owner archive was read and no message was sent in this follow-up.

The actual local candidate archive checksums are:

```text
42b0b9c67b653a7aaf0d432e63e38ae4fa1b739cedadc78b3e88d150a7496af0  plow-messages_review-493614d_darwin_arm64.tar.gz
028fe549d9f37d96589a69a938355b406a3bdf5157e6dd5c9999ff57653df921  plow-messages_review-493614d_darwin_amd64.tar.gz
```

These are local review snapshots, with their own `assets/checksums.txt`. They are not official releases or candidate values to paste into the shipped manifest. GitHub's macOS 15 builders may produce different bytes; the final pin must come from the published release's actual checksums. Rebuild the snapshots with `sh build-snapshots.sh`, restage with `node stage-snapshots.mjs /absolute/path/to/latch`, and verify native dispatch with `node dispatch-snapshot.mjs /absolute/path/to/latch`. The included source snapshot and lockfile are from the exact reviewed commit.

The only external dependency is official publication. Read-only GitHub API verification reports `push: false`, `maintain: false`, and `admin: false` for this account. PR #3 is still open; the latest official release is v0.1.0, published September 18. The existing `.github/workflows/release.yml` already builds arm64 on `macos-15`, amd64 on `macos-15-intel`, creates the tarballs, calculates `checksums.txt`, and publishes when a `v*` tag is pushed. No workflow change is needed.

After an authorized maintainer merges PR #3, they can run these commands from the extracted evidence directory. They must choose the release version; no version or official URL has been invented here.

```sh
set -eu
: "${PLOW_RELEASE_TAG:?Set the maintainer-chosen vMAJOR.MINOR.PATCH tag}"
PLOW_REVIEW_DIR="$PWD"
PLOW_RELEASE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/plow-release.XXXXXX")
test "$(gh pr view 3 --repo plow-pbc/plow-messages --json state --jq .state)" = MERGED
gh repo clone plow-pbc/plow-messages "$PLOW_RELEASE_DIR"
git -C "$PLOW_RELEASE_DIR" switch --detach origin/main
cmp "$PLOW_REVIEW_DIR/source/plow-messages.swift" "$PLOW_RELEASE_DIR/plow-messages.swift"
cmp "$PLOW_REVIEW_DIR/source/plow-messages-bridge.h" "$PLOW_RELEASE_DIR/plow-messages-bridge.h"
cmp "$PLOW_REVIEW_DIR/source/.github/workflows/release.yml" "$PLOW_RELEASE_DIR/.github/workflows/release.yml"
git -C "$PLOW_RELEASE_DIR" tag -a "$PLOW_RELEASE_TAG" -m "$PLOW_RELEASE_TAG"
git -C "$PLOW_RELEASE_DIR" push origin "refs/tags/$PLOW_RELEASE_TAG"
gh run list --repo plow-pbc/plow-messages --workflow release.yml --limit 5
```

The comparisons stop if the merged source or workflow differs from this review; that change needs validation before a release. The tag operation fails if the selected tag already exists. Use the displayed release workflow run to verify both builders and publication complete, then verify `gh release view "$PLOW_RELEASE_TAG" --repo plow-pbc/plow-messages` lists both macOS tarballs and `checksums.txt`.

Once the official release exists, the prepared helper performs all read/download/verification work and emits a precise patch without editing Latch:

```sh
python3 "$PLOW_REVIEW_DIR/prepare-official-pin.py" "$PLOW_RELEASE_TAG" /absolute/path/to/latch
cd /absolute/path/to/latch
git apply --check "$PLOW_REVIEW_DIR/official-pin.patch"
git apply "$PLOW_REVIEW_DIR/official-pin.patch"
just stage-plugins messages
npm run build
npx vitest run packages/device-core packages/mcp-server apps/desktop/test/pluginsModel.test.ts
```

The helper requires a published release from `plow-pbc/plow-messages`, confirms its Swift and bridge bytes equal reviewed commit `493614d`, downloads both archives and `checksums.txt`, and verifies each archive against that checksum file and GitHub's asset digest when present. Only then does it create `official-pin.patch`, `latch-plugin.proposed.json`, and `official-release-verification.json`. It preserves the manifest's formatting and changes only its version, URLs, and hashes. Its refusal against v0.1.0 has been exercised; the positive official-release path remains pending publication.

After staging that official pin, repeat the staged default/iMessage/WhatsApp commands and the missing-staged-binary negative control, remove the now-resolved v0.1.0 blocker paragraph from the messages README, and record the official tag, asset checksums, and updated Latch commit on PR #540. These final checks depend on the official assets, so the local candidate evidence cannot honestly mark the current v0.1.0 pin as resolved.
