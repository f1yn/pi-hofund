/**
 * Bifrost model provider.
 *
 * The factory only wires things up: it registers the `bifrost` provider from
 * the rich catalog, exposes a wrapped API that applies per-upstream overrides,
 * and owns the refresh lifecycle. All network work happens in `refreshModels`
 * (TTL-checked, coalesced) and session-start syncs — never in the request path.
 */
import {
	type Api,
	type ApiKeyCredential,
	type AssistantMessageEventStream,
	type Model,
	type Provider,
	type ProviderStreams,
	type RefreshModelsContext,
	type SimpleStreamOptions,
	type StreamOptions,
	createProvider,
	openAICompletionsApi,
} from "@earendil-works/pi-ai/compat";
import { type BifrostProviderModel, fetchCatalog } from "./catalog.ts";
import {
	type DiscoveryNotifier,
	type HofundConfig,
	bifrostHeaders,
	normalizeBifrostUrl,
} from "./config.ts";
import {
	type UpstreamOverride,
	createUpstreamDispatch,
	wrapIncomingStream,
	wrapUpstreamFetch,
} from "./providers/registry.ts";

export type { DiscoveryNotifier } from "./config.ts";

// Placeholder key so Pi never injects a foreign Authorization header.
const PLACEHOLDER_API_KEY = "pi-hofund-keyless";

type BifrostRuntimeModel = Model<"openai-completions">;

// The normalized request context the API streams receive (Pi's TranscriptContext).
type StreamContext = Parameters<ProviderStreams["stream"]>[1];

function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isBifrostRuntimeModel(model: unknown): model is BifrostRuntimeModel {
	const candidate = model as { provider?: string; api?: string } | undefined;
	return candidate?.provider === "bifrost" && candidate.api === "openai-completions";
}

// Attach the provider/api/baseUrl fields Pi's runtime models require.
function runtimeModels(
	models: readonly BifrostProviderModel[],
	baseUrl: string,
): BifrostRuntimeModel[] {
	return models.map((model) => ({
		...model,
		provider: "bifrost",
		api: "openai-completions",
		baseUrl,
	}));
}

// Effective config for a credential. A credential that carries its own URL (from
// `/login`) owns its config; otherwise the ambient config is used.
function credentialConfig(
	credential: ApiKeyCredential | undefined,
	ambient: HofundConfig,
): HofundConfig | undefined {
	const credentialUrl = nonEmpty(credential?.env?.BIFROST_URL);
	const credentialVirtualKey = nonEmpty(credential?.env?.BIFROST_VIRTUAL_KEY);
	if (credentialUrl) {
		return {
			...ambient,
			url: normalizeBifrostUrl(credentialUrl),
			virtualKey: credentialVirtualKey ?? ambient.virtualKey,
		};
	}
	return ambient.virtualKey ? ambient : undefined;
}

// Wrap the openai-completions API so overrides see outgoing/incoming traffic.
function wrapApi(
	base: ProviderStreams,
	dispatch: ReturnType<typeof createUpstreamDispatch>,
): ProviderStreams {
	function withFetch<T extends StreamOptions>(
		options: T | undefined,
		model: Model<"openai-completions">,
	): T {
		return { ...options, fetch: wrapUpstreamFetch(options?.fetch, dispatch, model) } as T;
	}

	function stream(
		model: Model<Api>,
		context: StreamContext,
		options?: StreamOptions,
	): AssistantMessageEventStream {
		const typed = model as Model<"openai-completions">;
		return wrapIncomingStream(
			base.stream(model, context, withFetch(options, typed)),
			dispatch,
			typed,
		);
	}

	function streamSimple(
		model: Model<Api>,
		context: StreamContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const typed = model as Model<"openai-completions">;
		return wrapIncomingStream(
			base.streamSimple(model, context, withFetch(options, typed)),
			dispatch,
			typed,
		);
	}

	return { ...base, stream, streamSimple };
}

/** Options for {@link createBifrostProvider}. */
export interface CreateBifrostProviderOptions {
	/** Where discovery notices go; see {@link DiscoveryNotifier}. */
	notify?: DiscoveryNotifier;
	/** Custom fetch implementation for catalog discovery. */
	fetch?: typeof fetch;
	/** Per-upstream override hooks; see `src/providers/`. */
	overrides?: ReadonlyMap<string, UpstreamOverride>;
}

/**
 * Create the native `bifrost` provider, including its `/login` flow.
 *
 * @param config - Resolved configuration supplying the base URL.
 * @param options - Optional overrides, custom fetch, and notice sink.
 * @returns The provider plus its TTL-checked `refreshModels` lifecycle.
 */
export function createBifrostProvider(
	config: HofundConfig,
	options: CreateBifrostProviderOptions = {},
): Provider<"openai-completions"> & {
	refreshModels(context: RefreshModelsContext): Promise<void>;
} {
	// createProvider captures this array by reference, so updates splice in place.
	const catalog: BifrostRuntimeModel[] = [];
	function replaceCatalog(models: readonly BifrostRuntimeModel[]): void {
		catalog.splice(0, catalog.length, ...models);
	}

	const dispatch = createUpstreamDispatch(options.overrides ?? new Map(), options.notify);
	const api = wrapApi(openAICompletionsApi(), dispatch);

	let lastFetchAt: number | undefined;
	let inFlight: Promise<void> | undefined;

	async function refreshModels(context: RefreshModelsContext): Promise<void> {
		// 1. Offline-safe restore of the persisted catalog first.
		const storedModels = context.stored?.models;
		if (storedModels?.length) {
			const restored = storedModels.filter(isBifrostRuntimeModel);
			if (restored.length > 0) {
				const published = await context.publish({ update: () => replaceCatalog(restored) });
				if (!published) return;
			}
		}
		if (!context.allowNetwork || context.signal.aborted) return;

		// 2. Respect the freshness TTL unless a forced refresh is requested.
		if (
			!context.force &&
			lastFetchAt !== undefined &&
			Date.now() - lastFetchAt < config.modelTtlMs
		) {
			return;
		}
		// 3. Coalesce concurrent refreshes into one network call.
		if (inFlight) return inFlight;

		inFlight = (async function fetchAndPublish(): Promise<void> {
			try {
				const credential = context.credential?.type === "api_key" ? context.credential : undefined;
				const effective = credentialConfig(credential, config);
				if (!effective) throw new Error("no Bifrost credential resolved");
				const discovered = runtimeModels(
					await fetchCatalog(effective, { fetch: options.fetch, signal: context.signal }),
					effective.url,
				);
				await context.publish({
					persist: { models: discovered, checkedAt: Date.now() },
					update: () => replaceCatalog(discovered),
				});
				lastFetchAt = Date.now();
			} catch (error) {
				// Retain the previous catalog on failure; a later refresh retries.
				options.notify?.(`Bifrost catalog refresh failed: ${message(error)}`, "warning");
			} finally {
				inFlight = undefined;
			}
		})();

		await inFlight;
	}

	const base = createProvider({
		id: "bifrost",
		name: "Bifrost AI Gateway",
		baseUrl: config.url,
		api,
		models: catalog,
		auth: {
			apiKey: {
				name: "Bifrost connection",
				async login(interaction) {
					interaction.notify({
						type: "info",
						message: "Configure the Bifrost gateway. The virtual key is required.",
					});
					const url = normalizeBifrostUrl(
						await interaction.prompt({
							type: "text",
							message: "Bifrost URL (required)",
							placeholder: config.url,
						}),
					);
					const virtualKey = nonEmpty(
						await interaction.prompt({ type: "secret", message: "Virtual key (required)" }),
					);
					if (!virtualKey) throw new Error("pi-hofund: a virtual key is required");
					return {
						type: "api_key",
						key: PLACEHOLDER_API_KEY,
						env: { BIFROST_URL: url, BIFROST_VIRTUAL_KEY: virtualKey },
					} satisfies ApiKeyCredential;
				},
				async resolve({ credential }) {
					const effective = credentialConfig(credential, config);
					if (!effective) return undefined;
					return {
						auth: {
							apiKey: effective.apiKey ?? PLACEHOLDER_API_KEY,
							baseUrl: effective.url,
							headers: bifrostHeaders(effective),
						},
						env: { BIFROST_URL: effective.url, BIFROST_VIRTUAL_KEY: effective.virtualKey },
						source: credential ? "stored Bifrost connection" : "settings/env",
					};
				},
			},
		},
	});

	return { ...base, refreshModels };
}
