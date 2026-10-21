# Code Style — pi-hofund

This page is the single source of truth for how code in this repository is written. [`ATLAS.md`](ATLAS.md) maps responsibilities and invariants; this page fixes style. Architectural rules live in `AGENTS.md` and `ATLAS.md` — they are not restated here.

## Gates

Every change passes all four gates before it is pushed:

| Gate                   | Tool                              |
| ---------------------- | --------------------------------- |
| `npm run lint`         | oxlint (correctness + suspicious) |
| `npm run format:check` | oxfmt                             |
| `npm run check`        | `tsc --noEmit`                    |
| `npm run test`         | Vitest                            |

A failing gate is a bug, not a preference. Fix the code. Never weaken `.oxfmtrc.json` or `.oxlintrc.json` to make a gate pass; lint stays scoped to correctness and suspicious findings — do not add stylistic plugins or ignore rules for convenience.

## What the tools decide

Formatting is oxfmt's job: tab indentation, quoting, line width, layout. Do not hand-format and do not argue with the formatter — run `npm run format` and let it win. `useTabs: true` in `.oxfmtrc.json` is the last word on indentation.

Markdown prose is never hard-wrapped: `proseWrap: "never"` keeps each paragraph on one line and leaves wrapping to the viewer. Write a paragraph as one line; never insert manual line breaks to hit a column width.

## What the tools cannot decide

- **Factories, not classes.** Model behavior with `create*` functions that return closed-over contract objects. Never write `class`, `this`, or inheritance.
- **`function` declarations for named or hoisted functions.** Arrow functions are for inline, unnamed callbacks only. Never export an arrow function.
- **No heuristics.** Derive values from Bifrost's rich catalog. Never add magnitude guesses, fallback catalogs, or blind `compat` flags.
- **Comments.** Exported declarations — functions, interfaces, type aliases, exported constants — get `/** ... */` doc comments, with `@param`/`@returns` (plus `@remarks`/`@throws` where useful) on exported functions. Everything else — internal functions, internal interfaces and consts, inline notes — gets `//`.
