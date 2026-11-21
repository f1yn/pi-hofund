import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type BifrostProviderModel,
	type BifrostRichModel,
	fetchCatalog,
	toProviderModel,
} from "../src/catalog.ts";
import { createHofundConfig } from "../src/config.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Real capture of the aggregate catalog; regenerate with `npm run fixture`. */
const catalogFixture = JSON.parse(readFileSync(join(fixtureDir, "models-v1.json"), "utf8")) as {
	data: BifrostRichModel[];
};

/** Real capture of the provider-scoped listing whose echo completes bare entries. */
const scopedFixture = JSON.parse(
	readFileSync(join(fixtureDir, "models-v1-opencode-go.json"), "utf8"),
) as Record<string, unknown>;

/**
 * Shape coverage the live gateway does not necessarily expose: a duplicate id, a
 * bare entry beside a completed one, mandatory reasoning, numeric pricing, and a
 * provider with no echo. Kept inline so a fixture refresh cannot delete them.
 */
const EDGE_CASES: BifrostRichModel[] = [
	{
		id: "openrouter/moonshotai/kimi-k3",
		canonical_slug: "moonshotai/kimi-k3-20260715",
		name: "Kimi K3",
		normalized_name: "Kimi K3",
		context_length: 1048576,
		max_input_tokens: 1048576,
		max_output_tokens: 943718,
		architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
		pricing: {
			prompt: "0.000003",
			completion: "0.000015",
			input_cache_read: "0.0000003",
			input_cache_write: "0.00000375",
		},
		top_provider: { context_length: 1048576, max_completion_tokens: 943718 },
		supported_parameters: [
			"tools",
			"reasoning",
			"developer",
			"stream_options",
			"structured_outputs",
			"max_completion_tokens",
		],
		default_parameters: { temperature: 1 },
		reasoning: {
			mandatory: false,
			default_enabled: true,
			supported_efforts: ["low", "medium", "high"],
			default_effort: "high",
		},
		description: "Moonshot Kimi K3 (reasoning, vision) via OpenRouter.",
	},
	{
		id: "opencode-go/deepseek-v4.1-flash",
		canonical_slug: "opencode-go/deepseek-v4.1-flash",
		name: "opencode-go/deepseek-v4.1-flash",
		normalized_name: "opencode-go/deepseek-v4.1-flash",
		context_length: 1048576,
		max_input_tokens: 1048576,
		max_output_tokens: 384000,
		architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		pricing: { prompt: "0", completion: "0" },
		top_provider: { context_length: 1048576, max_completion_tokens: 384000 },
		supported_parameters: ["tools", "reasoning", "max_completion_tokens"],
		reasoning: {
			mandatory: true,
			default_enabled: true,
			supported_efforts: ["low", "high", "max"],
		},
		description: "DeepSeek V4.1 Flash with mandatory reasoning.",
	},
	{ id: "opencode-go/glm-5.3-flash" },
	{ id: "opencode-go/kimi-k3" },
	{
		id: "gemini/gemini-3.5-flash-lite",
		canonical_slug: "gemini/gemini-3.5-flash-lite",
		name: "Gemini 3.5 Flash Lite",
		normalized_name: "Gemini 3.5 Flash Lite",
		context_length: 1114112,
		max_input_tokens: 1048576,
		max_output_tokens: 65536,
		architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		pricing: {
			prompt: "0.0000003",
			completion: "0.0000025",
			input_cache_read: "0.00000003",
			input_cache_write: "0.0000003",
		},
		top_provider: { context_length: 1114112, max_completion_tokens: 65536 },
		supported_parameters: ["tools", "max_completion_tokens", "response_format"],
		description: "Gemini 3.5 Flash Lite (non-reasoning).",
	},
	{
		id: "rutledge/rutledge-coder",
		name: "rutledge/rutledge-coder",
		normalized_name: "rutledge/rutledge-coder",
		alias: "nightmedia/Qwen3-Coder-Next-mxfp4-mlx",
		architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		pricing: { prompt: 0.0000005, completion: 0.000002 },
		supported_parameters: [],
		description: "Custom coder with numeric pricing, no limits, and no upstream echo.",
	},
	{
		id: "openrouter/moonshotai/kimi-k3",
		canonical_slug: "moonshotai/kimi-k3-20260715",
		name: "Kimi K3 (duplicate spelling)",
		normalized_name: "Kimi K3 Duplicate",
		context_length: 1048576,
		max_output_tokens: 943718,
		architecture: { input_modalities: ["text"], output_modalities: ["text"] },
		pricing: { prompt: "9", completion: "9" },
		supported_parameters: ["tools"],
		description: "Repeat of a routable id used to prove first-wins dedupe.",
	},
];

/** First-wins map so the contract tests read like the runtime catalog. */
function dedupe(
	models: Array<BifrostProviderModel | undefined>,
): Map<string, BifrostProviderModel> {
	const byId = new Map<string, BifrostProviderModel>();
	for (const model of models) {
		if (model && !byId.has(model.id)) byId.set(model.id, model);
	}
	return byId;
}

const byId = dedupe(EDGE_CASES.map((entry) => toProviderModel(entry)));

describe("toProviderModel", function () {
	it("maps a reasoning + vision entry from the rich catalog", function () {
		const model = byId.get("openrouter/moonshotai/kimi-k3");
		expect(model).toBeDefined();
		expect(model?.name).toBe("Kimi K3");
		expect(model?.contextWindow).toBe(1048576);
		expect(model?.maxTokens).toBe(943718);
		expect(model?.reasoning).toBe(true);
		// No "none" effort is advertised, so thinking cannot be switched off.
		expect(model?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});
		expect(model?.input).toEqual(["text", "image"]);
		expect(model?.cost.input).toBeCloseTo(3, 6);
		expect(model?.cost.output).toBeCloseTo(15, 6);
		expect(model?.cost.cacheRead).toBeCloseTo(0.3, 6);
		expect(model?.cost.cacheWrite).toBeCloseTo(3.75, 6);
		expect(model?.compat).toEqual({
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			supportsStrictMode: true,
			maxTokensField: "max_completion_tokens",
			sendSessionAffinityHeaders: true,
			sessionAffinityFormat: "openrouter",
		});
	});

	it("maps a mandatory-reasoning entry with off disabled", function () {
		const model = byId.get("opencode-go/deepseek-v4.1-flash");
		expect(model?.reasoning).toBe(true);
		expect(model?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
		expect(model?.input).toEqual(["text"]);
		expect(model?.compat.supportsDeveloperRole).toBe(false);
		expect(model?.compat.supportsStrictMode).toBe(false);
		expect(model?.compat.supportsUsageInStreaming).toBe(false);
		expect(model?.compat.maxTokensField).toBe("max_completion_tokens");
	});

	it("maps off to none only when the effort list accepts it", function () {
		const model = toProviderModel({
			id: "x/with-none",
			name: "With None",
			reasoning: { supported_efforts: ["none", "low", "high"] },
		});
		expect(model?.thinkingLevelMap?.off).toBe("none");
		expect(model?.thinkingLevelMap?.low).toBe("low");
		expect(model?.thinkingLevelMap?.medium).toBeNull();

		// A model that supports reasoning without a reported effort list keeps
		// Pi's default: no map, so the requested level is sent as declared.
		const unmapped = toProviderModel({
			id: "x/unmapped",
			name: "Unmapped",
			reasoning: {},
		});
		expect(unmapped?.reasoning).toBe(true);
		expect(unmapped?.thinkingLevelMap).toBeUndefined();
	});

	it("maps a non-reasoning entry with no thinking map and developer disabled", function () {
		const model = byId.get("gemini/gemini-3.5-flash-lite");
		expect(model?.reasoning).toBe(false);
		expect(model?.thinkingLevelMap).toBeUndefined();
		expect(model?.compat.supportsDeveloperRole).toBe(false);
		expect(model?.compat.supportsReasoningEffort).toBe(false);
		expect(model?.compat.supportsStrictMode).toBe(true);
		expect(model?.cost.input).toBeCloseTo(0.3, 6);
		expect(model?.cost.output).toBeCloseTo(2.5, 6);
		expect(model?.cost.cacheRead).toBeCloseTo(0.03, 6);
		expect(model?.cost.cacheWrite).toBeCloseTo(0.3, 6);
	});

	it("scales numeric pricing and defaults missing cache prices to input", function () {
		const model = byId.get("rutledge/rutledge-coder");
		expect(model?.cost.input).toBeCloseTo(0.5, 6);
		expect(model?.cost.output).toBeCloseTo(2, 6);
		expect(model?.cost.cacheRead).toBeCloseTo(0.5, 6);
		expect(model?.cost.cacheWrite).toBeCloseTo(0.5, 6);
	});

	it("scales prices by 1e6 with no magnitude threshold", function () {
		// A value above the old plugin's 0.01 heuristic must still be scaled.
		const pricey = toProviderModel({
			canonical_slug: "x/pricey",
			name: "Pricey",
			pricing: { prompt: "0.02" },
		});
		expect(pricey?.cost.input).toBeCloseTo(20000, 6);
		const cheap = toProviderModel({
			canonical_slug: "x/cheap",
			name: "Cheap",
			pricing: { prompt: "0.000003" },
		});
		expect(cheap?.cost.input).toBeCloseTo(3, 6);
	});

	it("prefers Bifrost's routable id over the canonical slug", function () {
		const model = toProviderModel({
			id: "openrouter/moonshotai/kimi-k3",
			canonical_slug: "moonshotai/kimi-k3-20260715",
			name: "MoonshotAI: Kimi K3",
		});
		expect(model?.id).toBe("openrouter/moonshotai/kimi-k3");
	});

	it("falls back to the canonical slug when Bifrost reports no id", function () {
		const model = toProviderModel({ canonical_slug: "moonshotai/kimi-k3-20260715" });
		expect(model?.id).toBe("moonshotai/kimi-k3-20260715");
	});

	it("dedupes by routable id, keeping the first entry", function () {
		expect(byId.size).toBe(6);
		expect(byId.get("openrouter/moonshotai/kimi-k3")?.name).toBe("Kimi K3");
	});

	it("falls back to conservative limits when Bifrost reports none", function () {
		const model = toProviderModel({ canonical_slug: "x/bare", name: "Bare" });
		expect(model?.contextWindow).toBe(128000);
		expect(model?.maxTokens).toBe(8192);
	});

	it("maps nothing the bare entry does not report", function () {
		// The pure mapper cannot complete a bare entry; only fetchCatalog can.
		const model = byId.get("opencode-go/glm-5.3-flash");
		expect(model?.contextWindow).toBe(128000);
		expect(model?.reasoning).toBe(false);
	});
});

describe("fetchCatalog", function () {
	const config = createHofundConfig({
		settings: { url: "https://host", virtualKey: "vk" },
		env: {},
		argv: [],
	});

	const catalogUrl = "https://host/v1/models";
	const scopedUrl = (provider: string) => `${catalogUrl}?provider=${provider}`;

	// Route aggregate, scoped, and failing requests so call order is observable.
	function routedFetch(
		aggregate: unknown,
		options: { errorProvider?: string; emptyEcho?: string[] } = {},
	): typeof fetch & { calls: string[] } {
		const calls: string[] = [];
		const empty = new Set(options.emptyEcho ?? []);
		const mock = async function (input: string | URL | Request): Promise<Response> {
			const url = String(input);
			calls.push(url);
			if (url === catalogUrl) return new Response(JSON.stringify(aggregate), { status: 200 });
			if (options.errorProvider && url === scopedUrl(options.errorProvider)) {
				return new Response("boom", { status: 500 });
			}
			if (url === scopedUrl("opencode-go") && !empty.has("opencode-go")) {
				return new Response(JSON.stringify(scopedFixture), { status: 200 });
			}
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		};
		return Object.assign(mock as typeof fetch, { calls });
	}

	const edgeCatalog = { data: EDGE_CASES };

	it("requests the rich catalog with vk headers and dedupes by id", async function () {
		let requestedHeaders: HeadersInit | undefined;
		const mockFetch: typeof fetch = async function (input, init) {
			if (String(input) === catalogUrl) requestedHeaders = init?.headers;
			return new Response(JSON.stringify(edgeCatalog), { status: 200 });
		};

		const models = await fetchCatalog(config, { fetch: mockFetch });
		expect(models).toHaveLength(6);
		expect(new Headers(requestedHeaders).get("x-bf-vk")).toBe("vk");
	});

	it("asks only the providers whose entries omit limits or capabilities", async function () {
		const mockFetch = routedFetch(edgeCatalog);
		await fetchCatalog(config, { fetch: mockFetch });
		expect(mockFetch.calls).toEqual([catalogUrl, scopedUrl("opencode-go"), scopedUrl("rutledge")]);
	});

	it("completes a bare entry from the provider-scoped upstream echo", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch(edgeCatalog) });
		const byModelId = new Map(models.map((model) => [model.id, model]));
		const glm = byModelId.get("opencode-go/glm-5.3-flash");

		expect(glm?.name).toBe("GLM-5.3-Flash");
		expect(glm?.contextWindow).toBe(1_000_000);
		expect(glm?.maxTokens).toBe(131_072);
		expect(glm?.cost.input).toBeCloseTo(0.15, 6);
		expect(glm?.cost.output).toBeCloseTo(0.5, 6);
		expect(glm?.cost.cacheRead).toBeCloseTo(0.03, 6);
		expect(glm?.cost.cacheWrite).toBeCloseTo(0.15, 6);
		expect(glm?.reasoning).toBe(true);
		// The echo reports low/high/max only, so off and the other levels are off.
		expect(glm?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
		// Video modalities are dropped: Pi's model shape is text/image only.
		expect(glm?.input).toEqual(["text", "image"]);
		expect(glm?.compat.supportsStrictMode).toBe(true);
		expect(glm?.compat.supportsUsageInStreaming).toBe(false);
		expect(glm?.compat.maxTokensField).toBe("max_tokens");
	});

	it("carries image modalities through from the upstream echo", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch(edgeCatalog) });
		const kimi = models.find((model) => model.id === "opencode-go/kimi-k3");
		expect(kimi?.name).toBe("Kimi K3");
		expect(kimi?.contextWindow).toBe(1_048_576);
		// The echo is the only limit source for a bare entry, so its cap wins.
		expect(kimi?.maxTokens).toBe(1_048_576);
		expect(kimi?.input).toEqual(["text", "image"]);
		expect(kimi?.cost.input).toBeCloseTo(3, 6);
		expect(kimi?.cost.cacheWrite).toBeCloseTo(3, 6);
		expect(kimi?.reasoning).toBe(true);
		// Only "max" is advertised, so every other level is disabled.
		expect(kimi?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
			max: "max",
		});
	});

	it("completes capabilities on an entry that declares its own limits", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch(edgeCatalog) });
		const deepseek = models.find((model) => model.id === "opencode-go/deepseek-v4.1-flash");
		// Declared limits survive; the omitted capability fields are completed.
		expect(deepseek?.contextWindow).toBe(1_048_576);
		expect(deepseek?.maxTokens).toBe(384_000);
		expect(deepseek?.reasoning).toBe(true);
		expect(deepseek?.compat.supportsStrictMode).toBe(true);
	});

	it("does not add upstream models the key cannot use", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch(edgeCatalog) });
		expect(models.some((model) => model.id.includes("gpt-5.6-luna"))).toBe(false);
	});

	it("keeps the conservative fallback when a provider has no echo", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch(edgeCatalog) });
		const rutledge = models.find((model) => model.id === "rutledge/rutledge-coder");
		expect(rutledge?.contextWindow).toBe(128000);
		expect(rutledge?.maxTokens).toBe(8192);
	});

	it("keeps the catalog when a provider-scoped request fails", async function () {
		const models = await fetchCatalog(config, {
			fetch: routedFetch(edgeCatalog, { errorProvider: "rutledge" }),
		});
		const rutledge = models.find((model) => model.id === "rutledge/rutledge-coder");
		expect(rutledge?.contextWindow).toBe(128000);
		expect(models).toHaveLength(6);
	});

	it("throws a descriptive error on a 401 with an error body", async function () {
		const mockFetch: typeof fetch = async function () {
			return new Response(JSON.stringify({ error: { message: "unauthorized" } }), { status: 401 });
		};
		await expect(fetchCatalog(config, { fetch: mockFetch })).rejects.toThrow(/401.*unauthorized/);
	});

	it("throws when data is not an array", async function () {
		const mockFetch: typeof fetch = async function () {
			return new Response(JSON.stringify({ data: {} }), { status: 200 });
		};
		await expect(fetchCatalog(config, { fetch: mockFetch })).rejects.toThrow(/invalid response/);
	});
});

describe("fetchCatalog against a live catalog capture", function () {
	const config = createHofundConfig({
		settings: { url: "https://host", virtualKey: "vk" },
		env: {},
		argv: [],
	});

	const catalogUrl = "https://host/v1/models";
	const scopedUrl = (provider: string) => `${catalogUrl}?provider=${provider}`;

	// The real gateway reports limits for opencode-go but no capability metadata,
	// and no echo at all for openrouter.
	function routedFetch(): typeof fetch & { calls: string[] } {
		const calls: string[] = [];
		const mock = async function (input: string | URL | Request): Promise<Response> {
			const url = String(input);
			calls.push(url);
			if (url === catalogUrl) {
				return new Response(JSON.stringify(catalogFixture), { status: 200 });
			}
			if (url === scopedUrl("opencode-go")) {
				return new Response(JSON.stringify(scopedFixture), { status: 200 });
			}
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		};
		return Object.assign(mock as typeof fetch, { calls });
	}

	it("asks every provider whose entries report no capabilities for its echo", async function () {
		const mockFetch = routedFetch();
		await fetchCatalog(config, { fetch: mockFetch });
		expect(mockFetch.calls).toEqual([
			catalogUrl,
			scopedUrl("gemini"),
			scopedUrl("opencode-go"),
			scopedUrl("openrouter"),
			scopedUrl("rutledge"),
		]);
	});

	it("surfaces reasoning for an entry that reports limits but no capabilities", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch() });
		const glm = models.find((model) => model.id === "opencode-go/glm-5.3-flash");

		expect(glm?.reasoning).toBe(true);
		expect(glm?.compat.supportsReasoningEffort).toBe(true);
		expect(glm?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
		// Aggregate limits and prices are authoritative and untouched.
		expect(glm?.contextWindow).toBe(1_000_000);
		expect(glm?.maxTokens).toBe(131_072);
		expect(glm?.cost.input).toBeCloseTo(0.15, 6);
		expect(glm?.input).toEqual(["text", "image"]);
	});

	it("keeps the aggregate output cap when the echo reports a larger one", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch() });
		const kimi = models.find((model) => model.id === "opencode-go/kimi-k3");
		expect(kimi?.maxTokens).toBe(131_072);
		expect(kimi?.contextWindow).toBe(1_048_576);
	});

	it("leaves the map unset when reasoning is supported without efforts", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch() });
		const kimi = models.find((model) => model.id === "opencode-go/kimi-k2.7-code");
		expect(kimi?.reasoning).toBe(true);
		expect(kimi?.thinkingLevelMap).toBeUndefined();
	});

	it("never invents reasoning for a provider whose echo is empty", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch() });
		const openrouter = models.find((model) => model.id === "openrouter/moonshotai/kimi-k3");
		expect(openrouter?.reasoning).toBe(false);
		expect(openrouter?.thinkingLevelMap).toBeUndefined();
		expect(openrouter?.compat.supportsReasoningEffort).toBe(false);
		// Other providers on this gateway are also capability-silent.
		const gemini = models.find((model) => model.id === "gemini/gemini-3.5-flash-lite");
		expect(gemini?.reasoning).toBe(false);
	});
});
