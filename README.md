<div align="center">
	<img width="320" height="320" src=".github/logo.svg" alt="pi-hofund logo" />
	<br>
	<h1>pi-hofund</h1>
	<p>Bifrost AI Gateway control-plane extension for the Pi coding agent</p>
	<br>
	<a href="https://github.com/f1yn/pi-hofund/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/f1yn/pi-hofund/ci.yml?branch=main" alt="CI Status" /></a>
	<a href="https://www.npmjs.com/package/pi-hofund"><img src="https://img.shields.io/npm/v/pi-hofund.svg" alt="npm version" /></a>
	<a href="LICENSE"><img src="https://img.shields.io/badge/license-MPL--2.0-blue.svg" alt="License: MPL-2.0" /></a>
	<br />
	<sub style="opacity: .5; text-align: center;">Iconography from <a href="https://github.com/game-icons/icons">game-icons</a>, licensed under <a href="https://github.com/game-icons/icons/blob/master/license.txt">CC BY 3.0</a>.</sub>
</div>

`pi-hofund` is an extension for the [Pi coding agent](https://github.com/earendil-works/pi) that connects directly to a self-hosted [Bifrost AI Gateway](https://www.getmaxim.ai/bifrost).

Instead of treating Bifrost as just an OpenAI-compatible URL, `pi-hofund` exposes the gateway's control plane to Pi: dynamic model catalogs, Virtual MCP tool servers, managed skills, and prompt repositories are integrated into Pi as native surfaces, scoped to your Bifrost Virtual Key.

## Why pi-hofund?

Pointing Pi at an OpenAI-compatible proxy URL only provides raw chat completions. You still have to transcribe model IDs by hand, guess context limits and pricing, configure MCP servers individually, and manually distribute skills and prompt templates.

`pi-hofund` turns Bifrost into the single source of truth for your Pi environment:

| Surface | Generic OpenAI Base URL | With `pi-hofund` |
| --- | --- | --- |
| **Models** | Transcribe model IDs manually; guess limits, pricing, and reasoning parameters | Auto-registered `bifrost` provider derived live from Bifrost's `/v1/models` catalog |
| **Tools (MCP)** | Manually maintain tool configs in `mcp.json` | Dynamic tool discovery: registers one MCP server per Virtual MCP slug, with a whole-key fallback |
| **Skills** | Manually copy and sync `SKILL.md` folders across machines | Opt-in, atomic sync of Bifrost's public skills bundles into `~/.pi/agent/skills/` |
| **Prompts** | Manually maintain prompt templates | Opt-in sync of versioned prompt repositories into `~/.pi/agent/prompts/bifrost/` |
| **Freshness** | Static until configuration files are edited | TTL-checked, coalesced background refresh, re-synced on session start or on demand |
| **Governance** | Treated as an unmetered, generic client | Gateway budgets, rate limits, team scopes, and audit logs remain strictly enforced |

### Core Design Principles

- **Derived, never guessed:** Every model attribute (reasoning capabilities, context windows, pricing, thinking levels) is derived directly from Bifrost's rich model catalog. There are no fallback catalogs, magnitude guesses, or arbitrary `compat` flags.
- **Scoped & governed:** All inference and tool calls pass through your Bifrost Virtual Key (VK). Prompts require an optional management key; skills sync from public bundles. Pi only accesses what your key is permitted to see.
- **Safe & non-destructive:** Synced assets carry a `managed-by: pi-hofund` front-matter marker. Existing local skills and custom prompts without this marker are never overwritten or removed.
- **Zero runtime dependencies:** Built entirely on Node.js built-ins (`node:zlib` for archive handling) and Pi extension APIs.

## Prerequisites

- **Node.js** >= 22
- **[Pi coding agent](https://github.com/earendil-works/pi)** (`@earendil-works/pi-coding-agent`)
- A running **[Bifrost](https://www.getmaxim.ai/bifrost)** instance with a valid Virtual Key (and an optional Management Key if prompt repository sync is enabled)

## Quickstart

### 1. Install the extension

Install `pi-hofund` as a persistent Pi package:

```bash
pi install npm:pi-hofund
```

_(To test the extension for a single run without installing, use `pi -e npm:pi-hofund`.)_

### 2. Connect to Bifrost

Launch Pi and run the login command:

```text
/login bifrost
```

Pi will prompt you for:

1. **Bifrost URL** — the mount URL of your gateway (e.g. `https://bifrost.example.com/openai/v1`).
2. **Virtual Key** — your Bifrost virtual key.

Credentials are saved securely in Pi's credential store (`~/.pi/agent/auth.json`). The virtual key is never written to `settings.json` and is never read from global environment variables.

### 3. Start using models

Models from your Bifrost gateway are available immediately under the `bifrost/` provider prefix:

```text
/model bifrost/<model-id>
```

To set Bifrost as your default provider, add `"defaultProvider": "bifrost"` in `~/.pi/agent/settings.json`.

### 4. Enable optional surfaces

Run the interactive settings menu to enable MCP, skills, or prompt syncing:

```text
/bifrost:settings
```

Toggle desired features with `Space`, save with `Ctrl+S`, or reload the catalog on demand using `/bifrost:reload`.

## Surfaces & Features

### Dynamic Model Catalog (`bifrost/*`)

The `bifrost` provider registers all models exposed by your Virtual Key via Bifrost's `/v1/models` catalog:

- Context limits, max tokens, pricing, and reasoning flags are populated directly from gateway metadata.
- Catalog updates are cached with a configurable TTL (default 6 hours) and refreshed automatically on session start.
- Concurrent refreshes are coalesced into a single network call.
- Run `/bifrost:reload` at any time to bypass the cache and force an immediate refresh.

### Virtual MCP Tool Servers

When `hofund.features.mcp` is enabled:

- `pi-hofund` queries Bifrost for Virtual MCP configurations assigned to your Virtual Key.
- Virtual MCP slugs register as native Pi MCP servers via `pi.registerMcpServer`.
- If no virtual slugs exist, a whole-key fallback server (`mcp__hofund`) is registered so all key-accessible tools remain available.
- All MCP servers unregister cleanly on session shutdown.

### Managed Skills Sync

When `hofund.features.skills` is enabled:

- Pi downloads the public skills archive from Bifrost and materializes them as flat skill directories inside `~/.pi/agent/skills/`.
- **Safety guarantee:** Synced skills are tagged with `managed-by: pi-hofund` in their `SKILL.md` front-matter. Unmanaged user skills are preserved and never modified or deleted during sync or cleanup.
- Use `hofund.zipPathPrefix` (e.g. `"pi/"`) to limit synchronization to a subfolder within the upstream archive.

### Prompt Repositories

When `hofund.features.prompts` is enabled (requires a management key):

- Synchronizes versioned prompts from Bifrost's prompt repository into `~/.pi/agent/prompts/bifrost/`.
- Bifrost's ordered message arrays and parameter specifications are projected into Pi's markdown template structure.
- As with skills, prompts are tracked via manifests and local unmanaged templates are preserved.

## Interactive Commands

| Command | Purpose |
| --- | --- |
| `/login bifrost` | Interactively prompt for gateway URL and Virtual Key, saving them to `auth.json`. |
| `/bifrost:settings` | Open the interactive TUI settings screen to toggle MCP, skills, and prompts, or view current config. |
| `/bifrost:reload` | Force an immediate catalog refresh and re-run active surface syncs. |

## Configuration Reference

Settings can be managed interactively with `/bifrost:settings` or edited directly in `~/.pi/agent/settings.json` under the `hofund` key:

```json
{
	"hofund": {
		"url": "https://bifrost.example.com/openai/v1",
		"features": {
			"mcp": true,
			"skills": true,
			"prompts": false
		},
		"modelTtlMinutes": 360,
		"zipPathPrefix": "pi"
	}
}
```

### Options

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `hofund.url` | string | _required_ | Base URL of your Bifrost OpenAI-compatible endpoint (e.g. `https://bifrost.example.com/openai/v1`). |
| `hofund.features.mcp` | boolean | `false` | Discover and register Virtual MCP tool servers. |
| `hofund.features.skills` | boolean | `false` | Synchronize Bifrost public skills into `~/.pi/agent/skills/`. |
| `hofund.features.prompts` | boolean | `false` | Synchronize prompt repository into `~/.pi/agent/prompts/bifrost/` (requires management key). |
| `hofund.modelTtlMinutes` | number | `360` | Catalog refresh cache duration in minutes. |
| `hofund.zipPathPrefix` | string | `undefined` | Restrict skills sync to a specific subfolder inside the skills ZIP bundle. |
| `hofund.apiKey` | string | `undefined` | Optional upstream API authentication key. |
| `hofund.managementKey` | string | `undefined` | Management API key for prompt sync (prefer setting `HOFUND_MANAGEMENT_KEY` in environment). |

### Environment Variables & CLI Flags

For headless environments, Docker containers, or scripted setups, configuration resolves using the following precedence:

1. **CLI Flags:** `--hofund-url`, `--hofund-api-key`, `--hofund-virtual-key`
2. **Environment Variables:**
   - `BIFROST_URL` — Gateway base URL.
   - `BIFROST_API_KEY` — Optional upstream API key.
   - `HOFUND_MANAGEMENT_KEY` — Management API key (used for prompt repository access).
3. **Settings File:** `~/.pi/agent/settings.json` (`hofund.*` block).
4. **Credential Store:** `~/.pi/agent/auth.json` (populated via `/login bifrost`).

_Note on security: The Virtual Key is read from `auth.json` or the explicit `--hofund-virtual-key` flag. It is never read from ambient environment variables to avoid accidental exposure in process listings or logs._

## Advanced: Upstream Traffic Overrides

If a specific model provider routed behind Bifrost requires payload adjustments or custom stream handling, `pi-hofund` supports file-discovered overrides:

- Drop a module at `src/providers/<upstream>.ts` (where `<upstream>` matches the first segment of the model ID, e.g. `opencode-go`).
- Export `processOutgoing(body, meta)` to modify outgoing JSON request payloads.
- Export `processIncoming(event, meta)` to transform streamed assistant message events.
- See [`docs/extending.md`](docs/extending.md) for details and conventions.

## Behind the Name

In Norse mythology, **Bifröst** is the burning rainbow bridge connecting the realms, and **Hǫfuð** (Hofund) is the sword of Heimdall, guardian of the bridge. As Heimdall keeps watch over the crossing, `pi-hofund` watches the connection between Pi and Bifrost, ensuring models, tools, skills, and governance flow smoothly across.

## Development

```bash
npm run check          # Typecheck with tsc
npm run test           # Run Vitest test suite
npm run lint           # Lint with oxlint
npm run format:check   # Check code formatting with oxfmt
```

For guidelines on architecture and invariants, consult:

- [`docs/ATLAS.md`](docs/ATLAS.md) — Architecture reference, invariants, and module map.
- [`docs/code.md`](docs/code.md) — Code style and formatting rules.
- [`docs/extending.md`](docs/extending.md) — Adding custom upstream overrides or surfaces.

## License

[Mozilla Public License 2.0 (MPL-2.0)](LICENSE).
