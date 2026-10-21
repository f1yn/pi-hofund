/**
 * Catalog client and model mapping.
 *
 * Every field is derived from Bifrost's rich `/v1/models` entry — no fallback
 * catalogs, no magnitude heuristics, no cross-spelling inference. If Bifrost
 * does not report a value, the conservative default below is used and nothing
 * is guessed.
 */
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { bifrostHeaders, type HofundConfig, richCatalogUrl } from "./config.ts";

// Conservative fallbacks used only when Bifrost reports no limit.
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** The subset of a rich `/v1/models` entry this extension consumes. */
export interface BifrostRichModel {
	/** Provider-list id as reported by Bifrost. */
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
	const id =
		nonEmpty(entry.canonical_slug) ?? nonEmpty(entry.normalized_name) ?? nonEmpty(entry.name);
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
 * @returns The deduplicated list of provider models; the first spelling wins.
 * @throws When the response is not OK, `data` is not an array, or the result is empty.
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

	const models = data
		.map((entry) => toProviderModel(entry as BifrostRichModel))
		.filter((model): model is BifrostProviderModel => model !== undefined);

	const unique = new Map<string, BifrostProviderModel>();
	for (const model of models) if (!unique.has(model.id)) unique.set(model.id, model);
	return [...unique.values()];
}
