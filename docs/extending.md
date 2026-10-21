# Extending pi-hofund

The extension is deliberately small: one module per concern, plus one escape hatch for per-upstream behavior. [`ATLAS.md`](ATLAS.md) is the contract; this page is the how-to.

## Add an upstream traffic override

Drop a file at `src/providers/<upstream>.ts`, where `<upstream>` is the first path segment of the model id (for example `opencode-go` or `openrouter`). Export either or both hooks:

```ts
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { OutgoingBody, UpstreamMeta } from "./registry.ts";

export async function processOutgoing(body: OutgoingBody, meta: UpstreamMeta): Promise<void> {
	// mutate `body` in place, or return a replacement
}

export async function processIncoming(
	event: AssistantMessageEvent,
	meta: UpstreamMeta,
): Promise<AssistantMessageEvent | void> {
	// mutate `event.partial`, or return a replacement
}
```

Rules:

- Files are auto-discovered; only modules exporting a hook become overrides. Subdirectories (including `shared/`) and `*.d.ts` are skipped. Put helpers in `shared/` and import them explicitly.
- Hooks must not perform network I/O. A thrown hook is caught, reported as a warning, and the original input is used.
- `processOutgoing` sees the parsed chat-completions request body; `processIncoming` sees each streamed `AssistantMessageEvent`.

`src/providers/opencode-go.ts` is a no-op template — copy it.

## Add a Bifrost surface

1. Fetch it in `src/`: models in `catalog.ts`, disk assets in `sync.ts`, tools in `mcp.ts`, credentials and endpoints in `config.ts`.
2. Gate it behind a `hofund.features` toggle in `src/config.ts` if it is opt-in.
3. Add a Vitest suite beside the others, and a fixture when the Bifrost response shape matters.
4. Record the endpoint and credential in the credential matrix and module map in [`ATLAS.md`](ATLAS.md).

## Quality gates

`npm run lint`, `npm run format:check`, `npm run check`, and `npm test` must all pass. Source is tab-indented (oxfmt), prefers `function` declarations over arrows, uses factories over classes, and keeps zero runtime dependencies.
