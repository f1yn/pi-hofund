# ATLAS — pi-hofund

Grounding document for anyone (human or model) modifying this extension. Read this first; it is the steering surface, not the spec.

## Purpose

`pi-hofund` is a lean, control-plane-first Pi extension for a self-hosted Bifrost AI Gateway. It registers the `bifrost` model provider from Bifrost's rich catalog and, when enabled, syncs Bifrost's MCP, skills, and prompt surfaces into Pi. It replaces the `pi-bifrost-provider` package and derives everything from Bifrost's own API rather than reconstructing it.

## Invariants

1. **Provider id stays `bifrost`.** `settings.json` has `defaultProvider: bifrost` and `enabledModels` entries of the form `bifrost/<id>`.
2. **Factory pattern over classes.** The top level is `createBifrostAbstract(config, pi, overrides, notify)`, a closed-over contract object. No classes, no `this`, no inheritance — error values are tagged `Error`s, not subclasses.
3. **No heuristics.** `compat`, `reasoning`, `thinkingLevelMap`, limits, and pricing come from Bifrost alone: the rich `/v1/models` entry, completed — only where that entry is a bare stub — from the upstream echo on the provider-scoped listing. No magnitude guesses, no fallback catalogs, no cross-spelling inference.
4. **No network in the factory or request path.** Fetching happens in `refreshModels` (TTL-checked, coalesced) and in the `session_start` syncs.
5. **Refresh lifecycle.** No one-shot latch: restore stored → TTL check → conditional network fetch; re-sync on `session_start`. The refresh is _driven through Pi_: `refreshBifrostModels` calls `ctx.modelRegistry.refresh`, and Pi calls `refreshModels` with a generation-checked `publish`.
6. **Filesystem containment.** Skills write only as flat skill directories under `~/.pi/agent/skills/`; prompts only under `~/.pi/agent/prompts/bifrost/`; writes are atomic (temp + rename); orphan cleanup is manifest-driven and never touches unmanaged files.
7. **Follow the Pi abstract.** Models via `pi.registerProvider`; MCP via `pi.registerMcpServer`; skills/prompts via file discovery. No bespoke runtime where a Pi hook exists.
8. **Zero runtime dependencies.** Keep-alive for `node:zlib`-based ZIP decode; never add an archive dependency and never shell out to `unzip`.
9. **`docs/ATLAS.md` is non-negotiable** and must be updated with any change to surfaces, invariants, or forbidden patterns.
10. **Upstream overrides are opt-in and file-discovered.** `src/providers/<upstream>.ts` may export async `processHeaders`, `processOutgoing`, and/or `processIncoming`. Upstream is the first path segment of `model.id`. `processHeaders` mutates the outgoing request headers in place and runs before the body hook; `processOutgoing` sees the parsed chat-completions body; `processIncoming` sees each streamed event. Every hook receives `meta.sessionId` (the Pi session id) when the adapter supplies one. Hooks never do network I/O; a thrown hook is caught, notified, and bypassed.
11. **Auto-discovery boundary.** Direct `src/providers/*.ts`/`*.js` children are discovered, but only files exporting a hook become overrides; subdirectories (including `shared/**`) and `*.d.ts` never are.
12. **Code style is owned by `docs/code.md`.** Declaration style (`function` over arrow for named exports), formatting, and comments are defined there, not here.
13. **Load-time safety.** The extension factory must not call Pi action methods (`getSettings`, `sendMessage`, `setModel`, `getActiveTools`, …); only `registerFlag`, `registerProvider`, `registerMcpServer`, `on`, and `getFlag` are load-safe. Config is read from disk (`auth.json`, `settings.json`); runtime-dependent work runs in `session_start`.
14. **Style gates.** Every change passes `npm run lint` (oxlint, correctness+suspicious), `npm run format:check` (oxfmt, tabs), `npm run check`, and `npm run test`.
15. **Managed assets carry the single extra front-matter field `managed-by: pi-hofund`.** Existing assets without the marker are user-defined: never overwritten, never removed, tracked as `preserved` in the manifest.
16. **Zip path prefix (skills only).** `hofund.zipPathPrefix` restricts skills sync to assets under that path inside the upstream zip; prompts sync is JSON-based and unaffected.
17. **Comment style.** `/** ... */` for exported declarations, `//` for internals and inline notes — specified in `docs/code.md`.
18. **Login persists the credential itself.** `provider.auth.apiKey.login` writes the resolved shape — `{ type: "api_key", key: "pi-hofund-keyless", env: { BIFROST_URL, BIFROST_VIRTUAL_KEY } }` — to `auth.json` through `writeStoredCredential` instead of trusting the caller to persist it. A bare `{ type: "api_key", key }` entry carries no virtual key and is never treated as configured.
19. **Bare catalog entries are completed, never invented.** An aggregate entry that reports no context window is treated as a stub and completed from `extra_fields.raw_response` of one `GET <rich>/v1/models?provider=<provider>` request per affected provider. Aggregate values always win, an entry that declares its own window is left untouched, upstream models absent from the aggregate are never added (they may be outside the key's policy), and a failed or empty echo is non-fatal. Upstream `cost` is dollars per million tokens and is converted once into the rich catalog's per-token unit.
20. **Model id is Bifrost's routable id.** `toProviderModel` uses `entry.id` first — the provider-prefixed name the gateway actually routes — falling back to `canonical_slug`, `normalized_name`, then `name` only when no id is reported. `canonical_slug` alone is not routable and would collide with `bifrost/<id>` entries in `settings.json`.
21. **The platform owns refresh publication.** `refreshModels` may only publish through the `RefreshModelsContext` Pi hands it. Never build that context by hand: `publish` is the sole channel for persisting `models-store.json` and for the in-memory catalog update, so a fabricated context (or a no-op `publish` returning `true`) silently discards everything it fetches. Session-start and `/bifrost:reload` call `refreshBifrostModels`, which asks `ctx.modelRegistry.refresh({ providers: ["bifrost"], force, allowNetwork: true })` — Pi then runs the restore and network phases and persists the result.

## Module Map

- `index.ts` — extension entry: flags, credential read, controller wiring, `session_start`/`session_shutdown`. Owns lifecycle; never fetches.
- `src/config.ts` — settings/env/argv/credential resolution, feature gating, headers, load-safe `auth.json`/`settings.json` reads and atomic writes (`writeStoredCredential`, `writeHofundSettings`), and endpoint derivation. Never touches the network or a Pi action method at load.
- `src/command.ts` — the interactive `/bifrost:settings` and `/bifrost:reload` commands. Run only at command time.
- `src/catalog.ts` — rich-catalog fetch, provider-scoped echo completion, and pure entry→model mapping. No fallbacks or heuristics.
- `src/provider.ts` — `bifrost` provider, auth resolution, wrapped API, and the refresh lifecycle. Never networks outside `refreshModels`.
- `src/models.ts` — the provider id and `refreshBifrostModels`, the only path that triggers a catalog refresh. Delegates to `ctx.modelRegistry` so Pi owns publication and persistence.
- `src/mcp.ts` — VK-scoped MCP registration (per-slug, whole-key fallback). Never writes disk.
- `src/sync.ts` — the opt-in skills/prompts syncers (business logic). Skills write only as flat directories under `skills/`; prompts only under `prompts/bifrost/`.
- `src/shared/zip.ts` — dependency-free ZIP reader over `node:zlib`. Cross-domain and pure; knows nothing about Bifrost.
- `src/shared/frontmatter.ts` — front-matter detection and managed-marker injection. Cross-domain and pure.
- `src/providers/registry.ts` — the override hook contract (headers, body, stream events) plus discovery and traffic dispatch. Never performs I/O inside a hook.
- `src/providers/opencode-go.ts` — the `opencode-go` override: attaches the `x-bf-eh-x-opencode-session` affinity header from the Pi session id. Doubles as the template for new upstreams.

## Commands

- Typecheck: `npm run check`
- Tests: `npm run test` (Vitest)
- Lint: `npm run lint` (oxlint)
- Format: `npm run format` / `npm run format:check` (oxfmt, tabs)

## Data Flow

1. **Load:** `index.ts` reads settings → `createHofundConfig` (URL from credential/argv/env/settings; VK from `auth.json`) → `loadUpstreamOverrides` → `createBifrostAbstract` → `registerProvider`. Filesystem only.
2. **`session_start`:** flush queued notices; run `refreshBifrostModels` (host-driven `refreshModels`: restore → TTL → network → publish) and the gated `syncMcp` / `syncSkills` / `syncPrompts` in parallel; each failure is caught and notified independently.
3. **Request time:** the wrapped `api` runs `processHeaders` on the outgoing headers, then `processOutgoing` on the JSON body, then `processIncoming` on each stream event; `meta.sessionId` carries the Pi session id. No fetches beyond the model call.
4. **`session_shutdown`:** `shutdown()` unregisters hofund-registered MCP servers; idempotent.

## Credential Matrix

| Surface                 | Endpoint                            | Credential                   |
| ----------------------- | ----------------------------------- | ---------------------------- |
| Models (rich catalog)   | `GET <rich>/v1/models`              | VK from `auth.json`          |
| Models (upstream echo)  | `GET <rich>/v1/models?provider=<p>` | VK from `auth.json`          |
| Models (inference)      | `<openai>/v1/chat/completions`      | VK from `auth.json`          |
| MCP gateway             | `/mcp`, `/mcp/<slug>`               | VK from `auth.json`          |
| Virtual MCP enumeration | `GET /api/mcp/virtual-mcps`         | VK + optional management key |
| Skills                  | `GET /api/skills/serve/...`         | none (public)                |
| Prompts                 | `GET /api/prompt-repo/prompts`      | management key               |

## Where To Change What

- **Add a `compat` flag** → `src/catalog.ts` `toProviderModel` + a `test/catalog.test.ts` fixture assertion.
- **Change how a bare entry is completed** → `completeFromUpstream` in `src/catalog.ts` + `test/catalog.test.ts` with `test/fixtures/models-v1-opencode-go.json` (regenerate both fixtures with `node scripts/fetch-fixture.ts`, `HOFUND_FIXTURE_PROVIDER` picks the provider).
- **Change refresh cadence** → `modelTtlMinutes` in `hofund` settings (mapped to `modelTtlMs`).
- **Add a Bifrost surface** → a new `src/` module + a feature gate in `src/config.ts` + a fixture test.
- **Add an upstream override** → `src/providers/<upstream>.ts` with optional `processHeaders`/`processOutgoing`/`processIncoming`, plus a `test/providers.test.ts` case.
- **Add a request header for one upstream** → `processHeaders` in that upstream's file (see `opencode-go.ts`); never fork the client.
- **Change credential handling** → `src/config.ts` (`createHofundConfig`, `readStoredCredential`, `writeStoredCredential`); update this matrix.

## Forbidden Patterns

- classes / `this` / inheritance (including `Error` subclasses);
- network I/O in the factory or the request path;
- `models.dev` fallback catalog;
- magnitude-based price heuristics;
- completing a bare aggregate entry from anything but Bifrost's own provider-scoped echo (a client-side table, another provider's entry, or a magnitude guess);
- adding a model the aggregate listing did not expose (the key may be barred from it);
- rewriting an entry that declares its own limits;
- triggering a catalog refresh by any route other than `refreshBifrostModels` → `ctx.modelRegistry.refresh` (a hand-built `RefreshModelsContext`, or a no-op `publish`, discards what it fetches);
- cross-spelling reasoning inheritance;
- hardcoded `supportsDeveloperRole: true` (Bifrost always uses the system role);
- adding an archive/ZIP dependency or shelling out to `unzip`;
- network I/O inside an upstream override hook;
- style violations covered by `docs/code.md` (formatting, declaration style, comments);
- auto-importing `src/providers/shared/**`;
- trusting a bare `{ type, key }` credential (no `env`) as configured;
- reimplementing an upstream requirement in a client fork when an override header satisfies it;
- writing outside `skills/` or `prompts/bifrost/`;
- deleting files a previous run did not write;
- disabling a feature deleting data.

## Known Lossy Projections

- **Bifrost prompt version → markdown template:** one-way. Bifrost stores ordered message arrays plus `model_params`; Pi templates are one markdown file. The projection renders messages as role sections and keeps `model_params` as metadata only. Verified against Bifrost's OpenAPI `management/prompts.yaml`, not live traffic.
- **ZIP64:** rejected with a typed `Zip64UnsupportedError`. Skill bundles are small, so this is acceptable; extend `src/shared/zip.ts` if that changes.
- **Upstream echo → rich entry:** prices are converted from per-million to per-token; peak-hour `cost.multipliers` and context-threshold `cost.overrides` have no Pi equivalent and are ignored; the echo reports no `mandatory` flag, so reasoning `off` stays `"none"`; audio/video modalities are dropped because Pi's model shape is text/image only; `maxTokensField` is not derivable from the echo and stays `max_tokens`.
