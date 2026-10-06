# Headless Latch and integration hub

This branch runs Latch's shared device tools without Electron. It adds an owner service, a persistent integration hub, and an MCP Apps panel. It is an experimental implementation. It does not establish official ChatGPT distribution or full native feature parity.

## Architecture

`packages/mcp-server` creates one server for HTTP and STDIO. It preserves the 15 maintained device tools and permits a typed extension. `apps/headless` adds 10 hub tools and the `ui://latch/hub.html` resource.

`packages/owner-core` owns six controllers previously defined in the desktop app. `packages/owner-services` owns 23 additional maintained controllers and an owner operation registry. The desktop app imports those modules, so the headless and desktop paths share their implementation.

`packages/owner-runtime` binds a decision to its owner, organization, principal, transport connection, enrollment revision, policy revision, request arguments, capabilities, and deadlines. It stores actions and receipts durably. A completed continuation returns the original receipt without repeating the effect.

`packages/integration-hub` stores scoped connections, versioned memory with source references, jobs, bounded results, audit entries, and cost reservations in SQLite. `packages/connector-runtime` executes reviewed MCP, API, and CLI configurations through a protected credential broker. Unknown effects retain their reservations and do not replay automatically.

The panel has six tabs: current activity, connections, memory, activity and costs, access, and resources. It uses the MCP Apps bridge and service state. It does not import the host's conversation memory automatically.

## Owner authority

A production host must inject `OwnerHost`. Its binding must come from an authenticated owner channel. Its confirmation must verify evidence outside model-controlled tool arguments and metadata.

The standalone package has no production owner adapter. Its owner controls remain locked. `{owner:true}`, `{confirmed:true}`, an accepted form by itself, and widget clicks cannot enroll an owner.

The verification host injects a private test binding and renders a separate confirmation dialog. Every screenshot and video identifies this host. These checks verify the protocol and application behavior, not ChatGPT identity or rendering.

Protected vault queries do not return passwords through ordinary MCP results. Owner input uses a consumed private ticket. Delivery uses an opaque reference to a protected owner view. A production implementation of those views and the native credential codec is still required.

## Feature coverage and outstanding gates

The inventory contains 92 owner operation channels, 17 subscriptions, and 18 functional families. Registry presence is not proof that all 92 operations execute. Availability depends on injected adapters and the authenticated owner.

| Feature | Implementation | Required production proof |
| --- | --- | --- |
| Files, commands, jobs, policy, results, and history | Shared maintained device core and MCP server | Host identity and real macOS permissions |
| Owner decisions and controls | Durable controller, ledger, and bound continuation | Verified ChatGPT owner adapter |
| Preferences and sign-out | Atomic settings, protected codec contract, encrypted retirement queue | Plow's native credential codec |
| MCP, API, and CLI connections | Reviewed catalog, scope checks, broker, jobs, costs, and idempotency | Real provider credentials, OAuth, catalogs, and contracts |
| Memory | Scoped SQLite records, revisions, correction, removal, source references, and pagination | Deployment backup and retention policy |
| Plow signup, SMS, accounts, relay, reviewer, and cloud agents | Maintained controllers behind the account adapter | Access to the private Plow backend and real accounts |
| Browser and browser credentials | Maintained interfaces and availability gates | Distributed browser assets and signed native broker |
| Vault, TOTP, import, and Apple Passwords | Owner-only contracts, protected tickets, maintained staging | Signed Keychain identity, credential extension, protected views, and platform eligibility |
| Automation, Full Disk Access, launch, keep awake, and updater | Maintained controllers and native adapter | Signed distributed executable and dedicated Mac verification |
| ChatGPT installation and official publication | Portable metadata and experimental local package | OpenAI support for this local distribution and Plow authorization |

The experimental package uses an isolated owner home under `PLUGIN_DATA`. It does not enable the user's native owner environment. The existing maintained folder approval behavior remains in force inside that isolated home. Existing browser bearer scope and broad sandbox home reads have not been redesigned into stronger security claims.

## Build and verify

Use Node 24.19.0 for the SQLite API and the verified package. Install dependencies with lifecycle scripts disabled, then build the workspace and the UI.

```sh
npm install --ignore-scripts --no-audit --no-fund
npm run build
node apps/headless/scripts/build-ui.mjs
npm test
```

Build the test-host fixture and verify the panel in Chrome. This starts an explicitly labeled localhost host with temporary data. It does not launch Electron or inspect the Codex or ChatGPT UI.

```sh
node apps/headless/test-host/build.mjs
node apps/headless/test-host/verify.mjs /absolute/evidence/ui
```

Build the portable Darwin arm64 experiment with the verified Node binary. The builder includes the runtime dependency closure, licenses, provenance, and a SHA-256 file manifest. Workspace packages are real directories because the host's installer does not preserve workspace symlinks.

```sh
node scripts/build-headless-plugin.mjs --output /absolute/package --node /absolute/node-24.19.0 --version 0.1.4-dev
node apps/headless/test-host/package-probe.mjs /absolute/package/marketplace/plugins/latch-headless-dev /absolute/evidence/package
```

The package probe checks each manifest hash, starts the bundled runtime with a system-only PATH, discovers 25 tools, executes memory, verifies locked owner controls, and waits for process cleanup. It also writes the complete owner operation matrix using the labeled test host.

Register the marketplace before the installed protocol probe. Keep its isolated evidence directory between runs so it can locate only this experiment's data.

```sh
codex plugin marketplace add /absolute/package/marketplace --json
python3 apps/headless/test-host/installed-probe.py --marketplace /absolute/package/marketplace --cwd /absolute/evidence/cwd --evidence /absolute/evidence/installed --install
```

Add `--lifecycle --node /absolute/node-24.19.0` to verify update, rollback, removal, and reinstall. This operates only on `latch-headless-dev@latch-development`. It checks the executing cache version, memory and identity persistence, refusal of forged owner metadata, isolated native execution, graceful EOF, absence of child processes, and byte-for-byte data preservation after removal. It leaves the baseline package installed.

These commands verify Codex's installed plugin protocol. They do not prove automatic public installation in ChatGPT, consent in ChatGPT, signed native distribution, or live Plow and provider integration. Official local distribution requires the path described in the [OpenAI packaging documentation](https://developers.openai.com/plugins/build/plugins).
