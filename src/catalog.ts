/**
 * Catalog client and model mapping.
 *
 * Every field is derived from Bifrost's rich `/v1/models` entry — no fallback
 * catalogs, no magnitude heuristics, no cross-spelling inference. Providers
 * whose aggregate entry is a bare stub are completed from the upstream echo
 * Bifrost includes on the provider-scoped listing. If Bifrost reports a value
 * nowhere, the conservative default below is used and nothing is guessed.
 */
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { bifrostHeaders, type HofundConfig, richCatalogUrl } from "./config.ts";

// Conservative fallbacks used only when Bifrost reports no limit.
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** The subset of a rich `/v1/models` entry this extension consumes. */
export interface BifrostRichModel {
	/** Routable id as reported by Bifrost, normally provider-prefixed. */
	id?: string;
	/** Canonical gateway slug; the preferred model id. */
	canonical_slug?: string;
	/** Human-readable display name. */
	name?: string;
	/** Normalized display name used to match sibling spellings. */
	normalized_name?: string;
	/** Declared context window in tokens. */
	context_length?: number;
	/** Max prompt tokens. */
	max_input_tokens?: number;
	/** Max output tokens. */
	max_output_tokens?: number;
	/** Modalities the model accepts and emits. */
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	/** Per-token prices (dollars), as decimal strings or numbers. */
	pricing?: {
		prompt?: string | number;
		completion?: string | number;
		input_cache_read?: string | number;
		input_cache_write?: string | number;
	};
	/** Limits advertised by the top provider. */
	top_provider?: {
		context_length?: number;
		max_completion_tokens?: number;
	};
	/** OpenAI-compatible parameters the model accepts. */
	supported_parameters?: string[];
	/** Upstream alias, when Bifrost maps a custom name onto a backend model. */
	alias?: string;
	/** Gateway defaults such as temperature. */
	default_parameters?: Record<string, unknown>;
	/** Reasoning metadata, when the model supports it. */
	reasoning?: {
		mandatory?: boolean;
		default_enabled?: boolean;
		supported_efforts?: string[];
		default_effort?: string;
	};
	/** Free-text model description. */
	description?: string;
}

/**
 * The subset of Bifrost's provider-scoped upstream echo this extension consumes.
 *
 * A provider-scoped listing (`/v1/models?provider=<provider>`) carries the raw
 * upstream model list under `extra_fields.raw_response`. That echo is the only
 * surface reporting limits, prices, and capabilities for providers whose
 * aggregate entry is a bare stub (for example `opencode-go`).
 */
export interface BifrostUpstreamModel {
	/** Upstream model id, without the provider prefix. */
	id?: string;
	/** Upstream display name. */
	name?: string;
	/** Token limits as declared by the upstream. */
	limit?: {
		/** Total context window. */
		context?: number;
		/** Max prompt tokens, when reported separately. */
		input?: number;
		/** Max output tokens. */
		output?: number;
	};
	/** Accepted input modalities as MIME types (`text`, `image/png`, …). */
	modalities?: {
		input?: string[];
	};
	/** Capability flags reported by the upstream. */
	capabilities?: {
		/** Tool-calling support. */
		tools?: { supported?: boolean };
		/** Reasoning support and its accepted efforts. */
		reasoning?: { supported?: boolean; effort?: string[] };
		/** Structured-output support. */
		structured_output?: boolean;
	};
	/** Prices in **dollars per million tokens**, unlike the rich catalog. */
	cost?: {
		text?: {
			input?: {
				price?: number | string;
				cache?: { read?: number | string; write?: number | string };
			};
			output?: { price?: number | string };
		};
	};
}

/** OpenAI-completions compatibility flags, all derived from the catalog entry. */
export interface BifrostCompat {
	/** Whether the gateway accepts the `developer` instruction role. */
	supportsDeveloperRole: false;
	/** Whether reasoning effort is accepted. */
	supportsReasoningEffort: boolean;
	/** Whether streaming usage is reported. */
	supportsUsageInStreaming: boolean;
	/** Whether structured output/strict mode is accepted. */
	supportsStrictMode: boolean;
	/** Request field carrying the output cap. */
	maxTokensField: "max_completion_tokens" | "max_tokens";
	/** Always send harness session-affinity headers. */
	sendSessionAffinityHeaders: true;
	/** Affinity header flavor used by Bifrost. */
	sessionAffinityFormat: "openrouter";
}

/** A catalog entry shaped for Pi, before provider/api/baseUrl are attached. */
export interface BifrostProviderModel {
	/** Model id (canonical slug, normalized name, or name). */
	id: string;
	/** Display name. */
	name: string;
	/** Whether the model supports reasoning. */
	reasoning: boolean;
	/** Pi thinking-level mapping, when reasoning is supported. */
	thinkingLevelMap?: ThinkingLevelMap;
	/** Accepted input modalities. */
	input: ("text" | "image")[];
	/** Cost in dollars per million tokens. */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Context window in tokens. */
	contextWindow: number;
	/** Output cap in tokens. */
	maxTokens: number;
	/** Derived OpenAI-completions compatibility flags. */
	compat: BifrostCompat;
}

// Trimmed value, or undefined for empty/whitespace input.
function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

// First positive finite number, floored; undefined when none qualifies.
function positiveInteger(...values: Array<number | undefined>): number | undefined {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	}
	return undefined;
}

// Context window as declared by Bifrost, if any field carries one.
function declaredContextWindow(entry: BifrostRichModel): number | undefined {
	const combined =
		entry.max_input_tokens !== undefined && entry.max_output_tokens !== undefined
			? entry.max_input_tokens + entry.max_output_tokens
			: undefined;
	return positiveInteger(entry.context_length, entry.top_provider?.context_length, combined);
}

// Output cap as declared by Bifrost, if any field carries one.
function declaredMaxTokens(entry: BifrostRichModel): number | undefined {
	return positiveInteger(entry.max_output_tokens, entry.top_provider?.max_completion_tokens);
}

// OpenRouter/Bifrost prices are dollars per token; Pi stores dollars per million.
// Deliberately branchless: the previous plugin guessed the unit from the
// magnitude, which misread cheap models by 1,000,000x.
function pricePerMillion(value: string | number | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const parsed = typeof value === "number" ? value : Number.parseFloat(value);
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;
	return parsed * 1_000_000;
}

// Whether the entry advertises reasoning support.
function hasReasoning(entry: BifrostRichModel, parameters: string[]): boolean {
	return entry.reasoning !== undefined || parameters.includes("reasoning");
}

// Map reported efforts onto Pi's thinking levels, or undefined when unreported.
// "off" maps to the provider's "none" variant, not the literal "off".
function thinkingLevelMapFor(entry: BifrostRichModel): ThinkingLevelMap | undefined {
	const efforts = entry.reasoning?.supported_efforts?.map((effort) => effort.toLowerCase());
	if (!efforts?.length) return undefined;
	const has = (level: string) => efforts.includes(level);
	return {
		off: entry.reasoning?.mandatory === true ? null : "none",
		minimal: has("minimal") ? "minimal" : null,
		low: has("low") ? "low" : null,
		medium: has("medium") ? "medium" : null,
		high: has("high") ? "high" : null,
		xhigh: has("xhigh") ? "xhigh" : null,
		max: has("max") ? "max" : null,
	};
}

// Provider segment of a gateway id: everything before the first slash.
function providerOf(id: string): string | undefined {
	const index = id.indexOf("/");
	return index > 0 ? id.slice(0, index) : undefined;
}

/**
 * Convert one rich catalog entry into Pi's model shape.
 *
 * @param entry - A single entry from Bifrost's rich `/v1/models` catalog.
 * @returns The mapped provider model, or `undefined` when the entry has no id.
 * @remarks
 * Values are derived only from the entry: no fallback catalogs and no
 * cross-spelling inheritance.
 */
export function toProviderModel(entry: BifrostRichModel): BifrostProviderModel | undefined {
	// Bifrost's own `id` is the routable, provider-prefixed name; the other
	// spellings are aliases that do not route on their own.
	const id =
		nonEmpty(entry.id) ??
		nonEmpty(entry.canonical_slug) ??
		nonEmpty(entry.normalized_name) ??
		nonEmpty(entry.name);
	if (!id) return undefined;

	const name = nonEmpty(entry.name) ?? nonEmpty(entry.normalized_name) ?? id;
	const parameters = (entry.supported_parameters ?? []).map((parameter) => parameter.toLowerCase());
	const reasoning = hasReasoning(entry, parameters);
	const contextWindow = declaredContextWindow(entry) ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = Math.min(contextWindow, declaredMaxTokens(entry) ?? DEFAULT_MAX_TOKENS);
	const modalities = (entry.architecture?.input_modalities ?? []).map((m) => m.toLowerCase());
	const inputPrice = pricePerMillion(entry.pricing?.prompt) ?? 0;
	const outputPrice = pricePerMillion(entry.pricing?.completion) ?? 0;

	return {
		id,
		name,
		reasoning,
		thinkingLevelMap: reasoning ? thinkingLevelMapFor(entry) : undefined,
		input: modalities.includes("image") ? ["text", "image"] : ["text"],
		cost: {
			input: inputPrice,
			output: outputPrice,
			cacheRead: pricePerMillion(entry.pricing?.input_cache_read) ?? inputPrice,
			cacheWrite: pricePerMillion(entry.pricing?.input_cache_write) ?? inputPrice,
		},
		contextWindow,
		maxTokens,
		compat: {
			// Bifrost advertises `developer` broadly but upstream models reject it,
			// so always send the universal system role instead.
			supportsDeveloperRole: false,
			supportsReasoningEffort: reasoning,
			supportsUsageInStreaming: parameters.includes("stream_options"),
			supportsStrictMode:
				parameters.includes("structured_outputs") || parameters.includes("response_format"),
			maxTokensField: parameters.includes("max_completion_tokens")
				? "max_completion_tokens"
				: "max_tokens",
			sendSessionAffinityHeaders: true,
			sessionAffinityFormat: "openrouter",
		},
	};
}

// Whether the entry declares any usable context window of its own.
function hasDeclaredContextWindow(entry: BifrostRichModel): boolean {
	return declaredContextWindow(entry) !== undefined;
}

// Providers whose aggregate entries leave the context window unreported. A
// missing window means Bifrost listed a bare stub, so the provider's upstream
// echo is worth one extra request.
function providersWithoutLimits(entries: readonly BifrostRichModel[]): string[] {
	const providers = new Set<string>();
	for (const entry of entries) {
		const id = nonEmpty(entry.id);
		const provider = id ? providerOf(id) : undefined;
		if (!provider || hasDeclaredContextWindow(entry)) continue;
		providers.add(provider);
	}
	return [...providers];
}

// Flatten Bifrost's upstream echo: `extra_fields.raw_response` holds one entry
// per upstream response, each carrying its own `data[]` model list.
function upstreamEcho(body: unknown): BifrostUpstreamModel[] {
	const raw = (body as { extra_fields?: { raw_response?: unknown } } | undefined)?.extra_fields
		?.raw_response;
	if (raw === undefined) return [];
	const roots = Array.isArray(raw) ? raw : [raw];
	const models: BifrostUpstreamModel[] = [];
	for (const root of roots) {
		const data = (root as { data?: unknown } | undefined)?.data;
		if (!Array.isArray(data)) continue;
		for (const item of data) {
			if (item && typeof item === "object") models.push(item as BifrostUpstreamModel);
		}
	}
	return models;
}

// Upstream prices are dollars per million tokens; the rich catalog uses dollars
// per token. Convert here so `pricePerMillion` stays the only scaling site.
function perTokenPrice(perMillion: number | string | undefined): string | undefined {
	if (perMillion === undefined || perMillion === "") return undefined;
	const parsed = typeof perMillion === "number" ? perMillion : Number.parseFloat(perMillion);
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;
	return String(parsed / 1_000_000);
}

// Upstream text prices in the rich catalog's per-token unit.
function upstreamPricing(upstream: BifrostUpstreamModel): BifrostRichModel["pricing"] {
	const text = upstream.cost?.text;
	return {
		prompt: perTokenPrice(text?.input?.price),
		completion: perTokenPrice(text?.output?.price),
		input_cache_read: perTokenPrice(text?.input?.cache?.read),
		input_cache_write: perTokenPrice(text?.input?.cache?.write),
	};
}

// Map upstream MIME modalities onto the rich catalog's modality tokens. Pi's
// model shape is text/image only, so audio and video are not carried over.
function upstreamInputModalities(upstream: BifrostUpstreamModel): string[] | undefined {
	const reported = upstream.modalities?.input;
	if (!reported?.length) return undefined;
	const modalities = new Set<string>();
	for (const modality of reported) {
		const value = modality.toLowerCase();
		if (value === "text") modalities.add("text");
		else if (value === "image" || value.startsWith("image/")) modalities.add("image");
	}
	return modalities.size > 0 ? [...modalities] : undefined;
}

// Upstream reasoning metadata in the rich catalog's shape, or undefined when the
// upstream does not advertise reasoning.
function upstreamReasoning(upstream: BifrostUpstreamModel): BifrostRichModel["reasoning"] {
	const capabilities = upstream.capabilities?.reasoning;
	if (capabilities?.supported !== true) return undefined;
	const efforts = capabilities.effort?.filter((effort) => effort.length > 0);
	return efforts?.length ? { supported_efforts: efforts } : {};
}

// Parameters the upstream explicitly advertises, in the rich catalog's spelling.
function upstreamParameters(upstream: BifrostUpstreamModel): string[] {
	const capabilities = upstream.capabilities;
	const parameters: string[] = [];
	if (capabilities?.tools?.supported === true) parameters.push("tools");
	if (capabilities?.reasoning?.supported === true) parameters.push("reasoning");
	if (capabilities?.structured_output === true) parameters.push("structured_outputs");
	return parameters;
}

// Union of the entry's own parameters and the upstream's advertised ones.
function mergeParameters(
	existing: string[] | undefined,
	upstream: BifrostUpstreamModel,
): string[] | undefined {
	const merged = new Set([...(existing ?? []), ...upstreamParameters(upstream)]);
	return merged.size > 0 ? [...merged] : undefined;
}

// Complete a bare aggregate entry from its upstream echo. Values the aggregate
// already reports always win; nothing is invented where the upstream is silent.
function completeFromUpstream(
	entry: BifrostRichModel,
	upstream: BifrostUpstreamModel,
): BifrostRichModel {
	const limit = upstream.limit;
	const modalities = upstreamInputModalities(upstream);
	const declaredModalities = entry.architecture?.input_modalities;
	return {
		...entry,
		name: nonEmpty(entry.name) ?? nonEmpty(upstream.name),
		context_length: entry.context_length ?? limit?.context,
		max_input_tokens: entry.max_input_tokens ?? limit?.input,
		max_output_tokens: entry.max_output_tokens ?? limit?.output,
		architecture:
			declaredModalities?.length || modalities === undefined
				? entry.architecture
				: { ...entry.architecture, input_modalities: modalities },
		pricing: { ...upstreamPricing(upstream), ...entry.pricing },
		supported_parameters: mergeParameters(entry.supported_parameters, upstream),
		reasoning: entry.reasoning ?? upstreamReasoning(upstream),
	};
}

// Fetch one provider's scoped catalog and return its upstream echo. A failure
// here is non-fatal: the aggregate entry stays authoritative and the next
// refresh retries.
async function fetchUpstreamEcho(
	config: HofundConfig,
	provider: string,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<BifrostUpstreamModel[]> {
	const url = `${richCatalogUrl(config.url)}/models?provider=${encodeURIComponent(provider)}`;
	try {
		const response = await fetchImpl(url, { headers: bifrostHeaders(config), signal });
		if (!response.ok) return [];
		return upstreamEcho(await response.json());
	} catch {
		return [];
	}
}

// Best-effort human-readable message from a Bifrost error body.
function errorMessage(body: unknown): string | undefined {
	if (!body || typeof body !== "object") return undefined;
	const candidate = body as { message?: unknown; error?: { message?: unknown } | string };
	if (typeof candidate.error === "string") return candidate.error;
	if (typeof candidate.error?.message === "string") return candidate.error.message;
	if (typeof candidate.message === "string") return candidate.message;
	return undefined;
}

/** Overrides for tests and callers that supply their own transport. */
export interface FetchCatalogOptions {
	/** Custom fetch implementation. */
	fetch?: typeof fetch;
	/** Abort signal for the discovery request. */
	signal?: AbortSignal;
}

/**
 * Fetch and normalize Bifrost's rich model catalog.
 *
 * @param config - Resolved configuration supplying the URL and headers.
 * @param options - Optional transport overrides.
 * @returns The deduplicated list of provider models; the first entry per id wins.
 * @throws When the response is not OK or `data` is not an array.
 * @remarks
 * Providers whose aggregate entry carries no context window are completed from
 * the upstream echo of one extra provider-scoped request. A failed or empty
 * echo is not an error: the aggregate entry is used unchanged.
 */
export async function fetchCatalog(
	config: HofundConfig,
	options: FetchCatalogOptions = {},
): Promise<BifrostProviderModel[]> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const response = await fetchImpl(`${richCatalogUrl(config.url)}/models`, {
		headers: bifrostHeaders(config),
		signal: options.signal,
	});

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}

	if (!response.ok) {
		const detail = errorMessage(body);
		throw new Error(
			`Bifrost catalog discovery failed (${response.status})${detail ? `: ${detail}` : ""}`,
		);
	}
	const data = (body as { data?: unknown } | undefined)?.data;
	if (!Array.isArray(data)) {
		throw new Error("Bifrost catalog discovery returned an invalid response (expected data[])");
	}

	const entries = data.filter(
		(entry): entry is BifrostRichModel => entry !== null && typeof entry === "object",
	);

	// Providers that report no limits list a bare aggregate entry, so pull their
	// upstream echo once and key it by the routable id the aggregate uses.
	const echo = new Map<string, BifrostUpstreamModel>();
	for (const provider of providersWithoutLimits(entries)) {
		for (const upstream of await fetchUpstreamEcho(config, provider, fetchImpl, options.signal)) {
			const id = nonEmpty(upstream.id);
			if (id) echo.set(`${provider}/${id}`, upstream);
		}
	}

	const models = entries
		.map((entry) => {
			const id = nonEmpty(entry.id);
			// Only bare entries are completed: an entry that declares its own window
			// already describes the model and is left exactly as Bifrost listed it.
			const upstream =
				id === undefined || hasDeclaredContextWindow(entry) ? undefined : echo.get(id);
			return toProviderModel(upstream ? completeFromUpstream(entry, upstream) : entry);
		})
		.filter((model): model is BifrostProviderModel => model !== undefined);

	const unique = new Map<string, BifrostProviderModel>();
	for (const model of models) if (!unique.has(model.id)) unique.set(model.id, model);
	return [...unique.values()];
}
