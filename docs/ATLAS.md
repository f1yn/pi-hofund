# ATLAS — pi-hofund

Grounding document for anyone (human or model) modifying this extension. Read this first; it is the steering surface, not the spec.

## Purpose

`pi-hofund` is a lean, control-plane-first Pi extension for a self-hosted Bifrost AI Gateway. It registers the `bifrost` model provider from Bifrost's rich catalog and, when enabled, syncs Bifrost's MCP, skills, and prompt surfaces into Pi. It replaces the `pi-bifrost-provider` package and derives everything from Bifrost's own API rather than reconstructing it.

## Invariants

1. **Provider id stays `bifrost`.** `settings.json` has `defaultProvider: bifrost` and `enabledModels` entries of the form `bifrost/<id>`.
2. **Factory pattern over classes.** The top level is `createBifrostAbstract(config, pi, overrides, notify)`, a closed-over contract object. No classes, no `this`, no inheritance — error values are tagged `Error`s, not subclasses.
3. **No heuristics.** `compat`, `reasoning`, `thinkingLevelMap`, limits, and pricing come from the rich `/v1/models` entry alone. No magnitude guesses, no fallback catalogs, no cross-spelling inference.
4. **No network in the factory or request path.** Fetching happens in `refreshModels` (TTL-checked, coalesced) and in `session_start` syncs.
5. **Refresh lifecycle.** No one-shot latch: restore stored → TTL check → conditional network fetch; re-sync on `session_start`.
6. **Filesystem containment.** Skills write only as flat skill directories under `~/.pi/agent/skills/`; prompts only under `~/.pi/agent/prompts/bifrost/`; writes are atomic (temp + rename); orphan cleanup is manifest-driven and never touches unmanaged files.
7. **Follow the Pi abstract.** Models via `pi.registerProvider`; MCP via `pi.registerMcpServer`; skills/prompts via file discovery. No bespoke runtime where a Pi hook exists.
8. **Zero runtime dependencies.** Keep-alive for `node:zlib`-based ZIP decode; never add an archive dependency and never shell out to `unzip`.
9. **`docs/ATLAS.md` is non-negotiable** and must be updated with any change to surfaces, invariants, or forbidden patterns.
10. **Upstream overrides are opt-in and file-discovered.** `src/providers/<upstream>.ts` may export async `processOutgoing` and/or `processIncoming`. Upstream is the first path segment of `model.id`. Hooks never do network I/O; a thrown hook is caught, notified, and bypassed.
11. **Auto-discovery boundary.** Direct `src/providers/*.ts`/`*.js` children are discovered, but only files exporting a hook become overrides; subdirectories (including `shared/**`) and `*.d.ts` never are.
12. **Code style is owned by `docs/code.md`.** Declaration style (`function` over arrow for named exports), formatting, and comments are defined there, not here.
13. **Load-time safety.** The extension factory must not call Pi action methods (`getSettings`, `sendMessage`, `setModel`, `getActiveTools`, …); only `registerFlag`, `registerProvider`, `registerMcpServer`, `on`, and `getFlag` are load-safe. Config is read from disk (`auth.json`, `settings.json`); runtime-dependent work runs in `session_start`.
14. **Style gates.** Every change passes `npm run lint` (oxlint, correctness+suspicious), `npm run format:check` (oxfmt, tabs), `npm run check`, and `npm run test`.
15. **Managed assets carry the single extra front-matter field `managed-by: pi-hofund`.** Existing assets without the marker are user-defined: never overwritten, never removed, tracked as `preserved` in the manifest.
16. **Zip path prefix (skills only).** `hofund.zipPathPrefix` restricts skills sync to assets under that path inside the upstream zip; prompts sync is JSON-based and unaffected.
17. **Comment style.** `/** ... */` for exported declarations, `//` for internals and inline notes — specified in `docs/code.md`.

## Module Map

- `index.ts` — extension entry: flags, credential read, controller wiring, `session_start`/`session_shutdown`. Owns lifecycle; never fetches.
- `src/config.ts` — settings/env/argv/credential resolution, feature gating, headers, load-safe `auth.json`/`settings.json` reads and writes, and endpoint derivation. Never touches the network or a Pi action method at load.
- `src/command.ts` — the interactive `/bifrost:settings` and `/bifrost:reload` commands. Run only at command time.
- `src/catalog.ts` — rich-catalog fetch and pure entry→model mapping. No fallbacks or heuristics.
- `src/provider.ts` — `bifrost` provider, auth resolution, wrapped API, and the refresh lifecycle. Never networks outside `refreshModels`.
- `src/mcp.ts` — VK-scoped MCP registration (per-slug, whole-key fallback). Never writes disk.
- `src/sync.ts` — the opt-in skills/prompts syncers (business logic). Skills write only as flat directories under `skills/`; prompts only under `prompts/bifrost/`.
- `src/shared/zip.ts` — dependency-free ZIP reader over `node:zlib`. Cross-domain and pure; knows nothing about Bifrost.
- `src/shared/frontmatter.ts` — front-matter detection and managed-marker injection. Cross-domain and pure.
- `src/providers/registry.ts` — the override hook contract plus discovery and traffic dispatch. Never performs I/O inside a hook.
- `src/providers/opencode-go.ts` — documented no-op override template.

## Commands

- Typecheck: `npm run check`
- Tests: `npm run test` (Vitest)
- Lint: `npm run lint` (oxlint)
- Format: `npm run format` / `npm run format:check` (oxfmt, tabs)

## Data Flow

1. **Load:** `index.ts` reads settings → `createHofundConfig` (URL from credential/argv/env/settings; VK from `auth.json`) → `loadUpstreamOverrides` → `createBifrostAbstract` → `registerProvider`. Filesystem only.
2. **`session_start`:** flush queued notices; run `syncModels` (provider `refreshModels`) and the gated `syncMcp` / `syncSkills` / `syncPrompts` in parallel; each failure is caught and notified independently.
3. **Request time:** the wrapped `api` runs `processOutgoing` on the JSON body and `processIncoming` on each stream event. No fetches beyond the model call.
4. **`session_shutdown`:** `shutdown()` unregisters hofund-registered MCP servers; idempotent.

## Credential Matrix

| Surface                 | Endpoint                       | Credential                   |
| ----------------------- | ------------------------------ | ---------------------------- |
| Models (rich catalog)   | `GET <rich>/v1/models`         | VK from `auth.json`          |
| Models (inference)      | `<openai>/v1/chat/completions` | VK from `auth.json`          |
| MCP gateway             | `/mcp`, `/mcp/<slug>`          | VK from `auth.json`          |
| Virtual MCP enumeration | `GET /api/mcp/virtual-mcps`    | VK + optional management key |
| Skills                  | `GET /api/skills/serve/...`    | none (public)                |
| Prompts                 | `GET /api/prompt-repo/prompts` | management key               |

## Where To Change What

- **Add a `compat` flag** → `src/catalog.ts` `toProviderModel` + a `test/catalog.test.ts` fixture assertion.
- **Change refresh cadence** → `modelTtlMinutes` in `hofund` settings (mapped to `modelTtlMs`).
- **Add a Bifrost surface** → a new `src/` module + a feature gate in `src/config.ts` + a fixture test.
- **Add an upstream override** → `src/providers/<upstream>.ts` with optional `processOutgoing`/`processIncoming`, plus a `test/providers.test.ts` case.
- **Change credential handling** → `src/credential.ts` and `src/config.ts`; update this matrix.

## Forbidden Patterns

- classes / `this` / inheritance (including `Error` subclasses);
- network I/O in the factory or the request path;
- `models.dev` fallback catalog;
- magnitude-based price heuristics;
- cross-spelling reasoning inheritance;
- hardcoded `supportsDeveloperRole: true` (Bifrost always uses the system role);
- adding an archive/ZIP dependency or shelling out to `unzip`;
- network I/O inside an upstream override hook;
- style violations covered by `docs/code.md` (formatting, declaration style, comments);
- auto-importing `src/providers/shared/**`;
- writing outside `skills/` or `prompts/bifrost/`;
- deleting files a previous run did not write;
- disabling a feature deleting data.

## Known Lossy Projections

- **Bifrost prompt version → markdown template:** one-way. Bifrost stores ordered message arrays plus `model_params`; Pi templates are one markdown file. The projection renders messages as role sections and keeps `model_params` as metadata only. Verified against Bifrost's OpenAPI `management/prompts.yaml`, not live traffic.
- **ZIP64:** rejected with a typed `Zip64UnsupportedError`. Skill bundles are small, so this is acceptable; extend `src/shared/zip.ts` if that changes.
