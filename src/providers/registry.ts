/**
 * Per-upstream override registry and traffic dispatch.
 *
 * Overrides are optional files in `src/providers/<upstream>.ts` exporting
 * `processOutgoing` and/or `processIncoming`. Files are discovered at load;
 * subdirectories and `*.d.ts` are never discovered. The hook contract and the
 * dispatcher live together so an override imports a single module.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createAssistantMessageEventStream,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import type { DiscoveryNotifier } from "../config.ts";

// ---------------------------------------------------------------------------
// Hook contract
// ---------------------------------------------------------------------------

/** Identity passed to every override hook. */
export interface UpstreamMeta {
	/** First path segment of the model id, e.g. "opencode-go" or "openrouter". */
	readonly upstream: string;
	readonly model: Model<"openai-completions">;
	/** Pi session id for this request, when the caller supplies one. */
	readonly sessionId?: string;
}

/** Parsed chat-completions request body. */
export type OutgoingBody = Record<string, unknown>;

/**
 * Outgoing hook: mutate `body` in place, or return a replacement. Returning
 * undefined keeps the mutated body.
 */
export type ProcessOutgoing = (
	body: OutgoingBody,
	meta: UpstreamMeta,
) => void | OutgoingBody | Promise<void | OutgoingBody>;

/**
 * Incoming hook: mutate `event` in place, or return a replacement. Returning
 * undefined keeps the mutated event.
 */
export type ProcessIncoming = (
	event: AssistantMessageEvent,
	meta: UpstreamMeta,
) => void | AssistantMessageEvent | Promise<void | AssistantMessageEvent>;

/**
 * Header hook: mutate the outgoing request headers in place.
 *
 * @param headers - Request headers; mutate them directly (`set`/`delete`).
 * @param meta - Upstream identity, including the Pi session id when available.
 * @returns A promise that settles once the headers are final.
 * @remarks
 * Runs once per request, before the body hook. The return value is ignored.
 */
export type ProcessHeaders = (headers: Headers, meta: UpstreamMeta) => void | Promise<void>;

/** Optional hooks for one upstream. */
export interface UpstreamOverride {
	/** Mutate the outgoing request headers. */
	processHeaders?: ProcessHeaders;
	/** Mutate or replace the outgoing request body. */
	processOutgoing?: ProcessOutgoing;
	/** Mutate or replace each incoming stream event. */
	processIncoming?: ProcessIncoming;
}

/** Runtime dispatch used by the provider's wrapped API. */
export interface UpstreamDispatch {
	/** Run the header hook for the model's upstream. */
	runHeaders(
		model: Model<"openai-completions">,
		headers: Headers,
		sessionId?: string,
	): Promise<Headers>;
	/** Run the outgoing hook for the model's upstream. */
	runOutgoing(
		model: Model<"openai-completions">,
		body: OutgoingBody,
		sessionId?: string,
	): Promise<OutgoingBody>;
	/** Run the incoming hook for the model's upstream. */
	runIncoming(
		model: Model<"openai-completions">,
		event: AssistantMessageEvent,
		sessionId?: string,
	): Promise<AssistantMessageEvent>;
}

// ---------------------------------------------------------------------------
// Registry and dispatch
// ---------------------------------------------------------------------------

// A provider module may export any of the hooks.
interface OverrideModule {
	processHeaders?: UpstreamOverride["processHeaders"];
	processOutgoing?: UpstreamOverride["processOutgoing"];
	processIncoming?: UpstreamOverride["processIncoming"];
}

/** Injectable so tests can discover synthetic modules without a real import. */
export type ImportModule = (url: string) => Promise<unknown>;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Default dynamic importer; overridden in tests.
function loadModule(url: string): Promise<unknown> {
	return import(url);
}

/**
 * Discover per-upstream override modules.
 *
 * @param dir - Directory to scan; defaults to this module's directory.
 * @param importModule - Dynamic importer, injectable for tests.
 * @returns A map of upstream name to its optional hooks.
 * @remarks
 * The scan is non-recursive and skips `*.d.ts`; only modules exporting a hook
 * are included. Hooks are `processHeaders`, `processOutgoing`, `processIncoming`.
 */
export async function loadUpstreamOverrides(
	dir: string | URL = new URL(".", import.meta.url),
	importModule: ImportModule = loadModule,
): Promise<Map<string, UpstreamOverride>> {
	const directory = dir instanceof URL ? fileURLToPath(dir) : dir;
	const overrides = new Map<string, UpstreamOverride>();

	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isFile()) continue;
		if (!/\.(?:ts|js)$/u.test(entry.name) || entry.name.endsWith(".d.ts")) continue;

		const module = (await importModule(
			pathToFileURL(join(directory, entry.name)).href,
		)) as OverrideModule;
		const override: UpstreamOverride = {};
		if (typeof module.processHeaders === "function") {
			override.processHeaders = module.processHeaders;
		}
		if (typeof module.processOutgoing === "function") {
			override.processOutgoing = module.processOutgoing;
		}
		if (typeof module.processIncoming === "function") {
			override.processIncoming = module.processIncoming;
		}
		if (!override.processHeaders && !override.processOutgoing && !override.processIncoming) {
			continue;
		}

		overrides.set(entry.name.replace(/\.(?:ts|js)$/u, ""), override);
	}
	return overrides;
}

/**
 * Build the dispatcher the provider uses to run hooks for a model's upstream.
 *
 * @param overrides - Overrides keyed by upstream name.
 * @param notify - Optional sink for hook failures.
 * @returns A dispatcher for outgoing bodies and incoming events.
 * @remarks
 * A throwing hook is caught, reported, and bypassed.
 */
export function createUpstreamDispatch(
	overrides: ReadonlyMap<string, UpstreamOverride>,
	notify?: DiscoveryNotifier,
): UpstreamDispatch {
	function upstreamOf(model: Model<"openai-completions">): string {
		return model.id.split("/")[0] ?? model.provider;
	}

	async function runHeaders(
		model: Model<"openai-completions">,
		headers: Headers,
		sessionId?: string,
	): Promise<Headers> {
		const upstream = upstreamOf(model);
		const hook = overrides.get(upstream)?.processHeaders;
		if (!hook) return headers;
		try {
			await hook(headers, { upstream, model, sessionId });
		} catch (error) {
			notify?.(
				`Bifrost upstream override "${upstream}" processHeaders failed: ${message(error)}`,
				"warning",
			);
		}
		return headers;
	}

	async function runOutgoing(
		model: Model<"openai-completions">,
		body: OutgoingBody,
		sessionId?: string,
	): Promise<OutgoingBody> {
		const upstream = upstreamOf(model);
		const hook = overrides.get(upstream)?.processOutgoing;
		if (!hook) return body;
		try {
			return (await hook(body, { upstream, model, sessionId })) ?? body;
		} catch (error) {
			notify?.(
				`Bifrost upstream override "${upstream}" processOutgoing failed: ${message(error)}`,
				"warning",
			);
			return body;
		}
	}

	async function runIncoming(
		model: Model<"openai-completions">,
		event: AssistantMessageEvent,
		sessionId?: string,
	): Promise<AssistantMessageEvent> {
		const upstream = upstreamOf(model);
		const hook = overrides.get(upstream)?.processIncoming;
		if (!hook) return event;
		try {
			return (await hook(event, { upstream, model, sessionId })) ?? event;
		} catch (error) {
			notify?.(
				`Bifrost upstream override "${upstream}" processIncoming failed: ${message(error)}`,
				"warning",
			);
			return event;
		}
	}

	return { runHeaders, runOutgoing, runIncoming };
}

/**
 * Wrap fetch so the parsed JSON request body flows through `processOutgoing`.
 *
 * @param baseFetch - Fetch to wrap, or `undefined` for the global fetch.
 * @param dispatch - Dispatcher selecting the upstream hook.
 * @param model - Model whose upstream hook applies.
 * @param sessionId - Pi session id handed to the hooks, when known.
 * @returns A fetch that transforms headers and JSON bodies and forwards everything else.
 */
export function wrapUpstreamFetch(
	baseFetch: typeof fetch | undefined,
	dispatch: UpstreamDispatch,
	model: Model<"openai-completions">,
	sessionId?: string,
): typeof fetch {
	const inner = baseFetch ?? globalThis.fetch;
	return async function (input, init) {
		let body = init?.body;
		if (typeof body === "string") {
			try {
				const parsed = JSON.parse(body) as unknown;
				if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
					body = JSON.stringify(
						await dispatch.runOutgoing(model, parsed as OutgoingBody, sessionId),
					);
				}
			} catch {
				// Non-JSON body, or a hook returned something unserializable: forward as-is.
			}
		}
		const headers = await dispatch.runHeaders(model, new Headers(init?.headers), sessionId);
		return inner(input, { ...init, body, headers });
	};
}

/**
 * Wrap a stream so every event flows through `processIncoming`.
 *
 * @param baseStream - Stream to wrap.
 * @param dispatch - Dispatcher selecting the upstream hook.
 * @param model - Model whose upstream hook applies.
 * @param sessionId - Pi session id handed to the hooks, when known.
 * @returns A stream forwarding transformed events.
 * @remarks
 * The base stream's terminal `done`/`error` event still settles the wrapper.
 */
export function wrapIncomingStream(
	baseStream: AssistantMessageEventStream,
	dispatch: UpstreamDispatch,
	model: Model<"openai-completions">,
	sessionId?: string,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();

	void (async function pump(): Promise<void> {
		try {
			for await (const event of baseStream) {
				out.push(await dispatch.runIncoming(model, event, sessionId));
			}
		} catch {
			// The base stream is authoritative; fall through and settle consumers.
		}
		out.end();
	})();

	return out;
}
