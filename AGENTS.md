# pi-hofund contributor notes

Grounded by **`docs/ATLAS.md`** (architecture and responsibility map) and **`docs/code.md`** (code style) — read both before changing anything.

## Rules

- **Factory pattern, no classes.** The top-level API is `createBifrostAbstract(config, pi, overrides, notify)` returning a closed-over contract object. No classes, no `this`, no inheritance anywhere.
- **Lean, no heuristics.** Derive model fields from Bifrost's rich catalog; do not add magnitude guesses, fallback catalogs, or blind `compat` flags.
- **No network in the factory or request path.** Fetch in `refreshModels` and in `session_start` syncs only.
- **Per-upstream overrides:** add `src/providers/<upstream>.ts` exporting an optional `processOutgoing` and/or `processIncoming`. These files are auto-discovered; `src/providers/shared/**` never is. Hooks must not do I/O.
- **No runtime dependencies.** ZIP decoding uses `node:zlib` via `src/shared/zip.ts`.
- **No action methods at load.** The extension factory may only register (flags, provider, MCP, `on`). Never call `getSettings` or other action methods until `session_start`; read config from `auth.json`/`settings.json` via `src/config.ts`.
- **Code style.** Formatting, declaration style, and comments are defined in [`docs/code.md`](docs/code.md) and enforced by the gates below — the tools, not this file, are the enforcement surface.

## Commands

- Typecheck: `npm run check`
- Tests: `npm run test` (Vitest)
- Lint: `npm run lint`
- Format check: `npm run format:check`
