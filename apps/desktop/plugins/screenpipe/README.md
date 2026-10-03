# Screenpipe history for Latch

Adds `plow-screenpipe`, a read-only adapter to an existing [Screenpipe](https://github.com/screenpipe/screenpipe)
installation. Agents can search screen text and audio transcripts through `plow_run_command`. The Plugins
tab lists **Screenpipe history**; turning it off withdraws its skill and refuses its commands.

## Setup

1. Install and run Screenpipe separately. Grant its capture permissions in Screenpipe's own setup.
2. Stage this plugin with `just stage-plugins screenpipe`, then restart a from-source Latch. Packaged builds
   include it through the existing `vendor/plugins` resource entry.
3. If Screenpipe requires authentication, run this in the owner's terminal with Screenpipe's CLI installed:

   ```sh
   mkdir -p "$HOME/.config/plow-latch"
   (umask 077; screenpipe auth token > "$HOME/.config/plow-latch/screenpipe-api-key")
   chmod 600 "$HOME/.config/plow-latch/screenpipe-api-key"
   ```

   This copies the key without printing it. Keep it out of chat, manifests, tool arguments, and logs.
   Repeat after rotating the Screenpipe key. An empty or malformed file fails closed. Without a key file,
   the adapter supports instances with API authentication disabled; an authenticated instance returns a
   fixed setup hint. `/health` does not require a key.
4. Run the health and search examples in [skill.md](skill.md). Every API call requires `network=true`.

The default port is 3030. For a different local port, change the manifest's fixed `SCREENPIPE_API_PORT`
before staging. Callers cannot supply a host, port, URL, key file, or curl configuration through argv.
The manifest's `SCREENPIPE_API_KEY_FILE` resolves against the owner's home, independently of `DOMO_HOME`.
Latch's **Ready** status means the adapter is available. It does not probe Screenpipe or verify recording;
the skill explicitly requires `health` before a search.

## Commands and boundaries

| Command | API | Behavior |
| --- | --- | --- |
| `plow-screenpipe --help` | None | Local usage; no network or key access |
| `plow-screenpipe health` | `GET /health` | Recorder status and capture timestamps; no key access |
| `plow-screenpipe search [options]` | `GET /search` | JSON results and pagination; requests `max_content_length=2000` |

Search accepts `--query`, `--content-type`, `--app-name`, `--window-name`, `--start-time`, `--end-time`,
`--limit`, `--offset`, and `--order`. It defaults to 20 results, newest first. Limits are 1..100; offsets
are 0..1000000. Text and timestamp values use curl's `--data-urlencode`; even `@file` and `&token=...` are
query text rather than file reads or extra parameters. Unknown flags and subcommands fail before HTTP.
Date parsing stays with Screenpipe; use RFC3339 with an explicit timezone.
Current Screenpipe keeps the first and last halves of long text, plus a truncation marker; the marker adds
characters beyond 2000. Older API versions may ignore this option. The adapter also bounds the response file.

```mermaid
sequenceDiagram
    participant Agent
    participant Latch
    participant Owner
    participant Adapter as plow-screenpipe
    participant API as Screenpipe on 127.0.0.1
    Agent->>Latch: plow_run_command + network=true
    Latch->>Owner: Approve command and capabilities
    Owner-->>Latch: Allow once / Always allow / Deny
    Latch->>Adapter: Approved sandboxed execution
    Adapter->>API: GET /health or /search
    API-->>Adapter: JSON
    Adapter-->>Latch: Successful response
    Latch-->>Agent: Result + audit trail
```

The adapter uses macOS `/bin/sh` and `/usr/bin/curl`, so both Mac architectures use the same source files.
It adds no runtime downloads, postinstall hooks, daemon, npm dependency, Screenpipe source, or binaries.
The existing staging script copies the plugin, and the existing manifest parser and dispatcher load it.

The network capability grants network generally in Latch's current sandbox. The adapter itself fixes the
host to `127.0.0.1`, ignores `.curlrc`, disables proxies, and refuses redirects. It sends the bearer header
through curl's stdin, keeping the key out of process argv and Latch's audit records. Error bodies are
discarded; errors use fixed messages. Responses use a disposable file in the executor's scratch directory,
with a file-size limit and a 15-second request deadline; the file is removed on exit.

The manifest has no write prefixes. The wrapper has no route for recording controls, raw SQL, media
export, notifications, pipes, or computer control. Searches explicitly disable embedded frames and cloud
retrieval. Successful results travel to the requesting agent through Latch, so enabling a local adapter
does not keep the retrieved history on-device. The skill limits retrieval to the owner's task and treats
captured content as untrusted input. An Always allow rule for `search` covers future query/filter values
with the same capabilities, following Latch's existing read-prefix rule behavior.

## Research and design decision

Investigated upstream commit [`798ac08`](https://github.com/screenpipe/screenpipe/tree/798ac0866fc671971845e810782b23b77683fafb)
on 2026-10-03. Source links below pin that revision because upstream main moves frequently.

| Area | Findings and consequence for this plugin | Source |
| --- | --- | --- |
| Capture | Rust capture reacts to app switches, clicks, scrolling, typing pauses, and idle timers. It pairs screen captures with accessibility text and uses OCR as fallback. Audio has its own transcription pipeline. Screenpipe owns these permissions and processes. | [Architecture](https://github.com/screenpipe/screenpipe/blob/798ac0866fc671971845e810782b23b77683fafb/docs/mintlify/docs-mintlify-mig-tmp/architecture.mdx) |
| Storage | History uses SQLite and media files under Screenpipe's data directory. Its daemon owns queries and database lifecycle. This adapter uses HTTP rather than opening a live database or WAL. | [Database architecture tests](https://github.com/screenpipe/screenpipe/blob/798ac0866fc671971845e810782b23b77683fafb/crates/screenpipe-db/tests/sqlite_architecture_invariants_test.rs) |
| Search | `/search` accepts text, content type, app/window, timestamps, ordering and pagination. `include_frames` and `include_cloud` default false; we also send false explicitly. `parsed` records are experimental. | [SearchQuery and handler](https://github.com/screenpipe/screenpipe/blob/798ac0866fc671971845e810782b23b77683fafb/crates/screenpipe-engine/src/routes/search.rs) |
| Health | `/health` reports frame/audio states and freshness. Healthy transport alone does not prove ongoing capture. | [Health route](https://github.com/screenpipe/screenpipe/blob/798ac0866fc671971845e810782b23b77683fafb/crates/screenpipe-engine/src/routes/health.rs) |
| Authentication | When enabled, auth applies even on localhost. `/health` is exempt. `screenpipe auth token` resolves the existing key from environment, encrypted storage, or legacy/recovery files without minting one. We let the owner export it through that supported CLI. | [Middleware](https://github.com/screenpipe/screenpipe/blob/798ac0866fc671971845e810782b23b77683fafb/crates/screenpipe-engine/src/server.rs), [resolver](https://github.com/screenpipe/screenpipe/blob/798ac0866fc671971845e810782b23b77683fafb/crates/screenpipe-engine/src/auth_key.rs), [auth command](https://github.com/screenpipe/screenpipe/blob/798ac0866fc671971845e810782b23b77683fafb/crates/screenpipe-engine/src/cli/auth.rs) |
| MCP | `screenpipe-mcp` is an HTTP API client with stdio and HTTP transports. Its full tool set includes writes and computer control; HTTP exposes fewer tools. Latch currently integrates CLI plugins rather than chaining MCP servers, so a dedicated read-only adapter fits its approval path. | [MCP implementation](https://github.com/screenpipe/screenpipe/blob/798ac0866fc671971845e810782b23b77683fafb/packages/screenpipe-mcp/src/index.ts), [HTTP transport](https://github.com/screenpipe/screenpipe/blob/798ac0866fc671971845e810782b23b77683fafb/packages/screenpipe-mcp/src/http-server.ts) |
| Distribution | Current upstream uses the Screenpipe Commercial License. This PR contains an independently written API adapter and does not redistribute upstream code or executables. Screenpipe installation and its applicable license remain separate. | [Upstream license](https://github.com/screenpipe/screenpipe/blob/798ac0866fc671971845e810782b23b77683fafb/LICENSE.md) |

Alternatives considered: bundling the recorder would add capture permissions, installation lifecycle and
distribution obligations; invoking `npx screenpipe-mcp` would add a runtime dependency, first-run downloads
and an MCP client bridge; direct SQLite queries would couple the plugin to storage and encryption details.
The HTTP adapter uses the existing Latch plugin contract and a small command allowlist.

## Verification

```sh
npx tsc -b
npx vitest run packages/device-core/test/screenpipePlugin.test.ts packages/device-core/test/pluginSkills.test.ts packages/mcp-server/test/screenpipe.test.ts apps/desktop/test/pluginsModel.test.ts apps/desktop/test/onboardingExamples.test.ts
node scripts/stage-plugins.mjs screenpipe
node scripts/screenpipe-smoke.mjs
```

The CLI tests run the actual shell parser against an executable curl fixture, with no listening server.
The MCP tests use the real manifest, skill registry, capability construction, policy engine and audit log.
The help execution also runs through macOS seatbelt. HTTP evidence should identify whether its backend is
a synthetic API fixture or a real Screenpipe installation; UI evidence should identify whether it comes
from a browser renderer fixture or the Electron app. Neither fixture proves real capture or transcription.
The manual smoke script runs nine cases against a synthetic HTTP API using system curl through the real
MCP approval and sandbox path, and saves its report, audit events and approval view model under `work/`.
