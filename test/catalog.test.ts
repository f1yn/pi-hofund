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

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "models-v1.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { data: BifrostRichModel[] };

const scopedPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"fixtures",
	"models-v1-opencode-go.json",
);
const scopedFixture = JSON.parse(readFileSync(scopedPath, "utf8")) as Record<string, unknown>;

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

const byId = dedupe(fixture.data.map((entry) => toProviderModel(entry)));

describe("toProviderModel", function () {
	it("maps a reasoning + vision entry from the rich catalog", function () {
		const model = byId.get("openrouter/moonshotai/kimi-k3");
		expect(model).toBeDefined();
		expect(model?.name).toBe("Kimi K3");
		expect(model?.contextWindow).toBe(1048576);
		expect(model?.maxTokens).toBe(943718);
		expect(model?.reasoning).toBe(true);
		expect(model?.thinkingLevelMap).toEqual({
			off: "none",
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

	// Route aggregate, scoped, and failing requests so call order is observable.
	function routedFetch(errorProvider?: string): typeof fetch & { calls: string[] } {
		const calls: string[] = [];
		const mock = async function (input: string | URL | Request): Promise<Response> {
			const url = String(input);
			calls.push(url);
			if (url.endsWith("?provider=opencode-go")) {
				return new Response(JSON.stringify(scopedFixture), { status: 200 });
			}
			if (url.endsWith("?provider=rutledge")) {
				if (errorProvider === "rutledge") return new Response("boom", { status: 500 });
				return new Response(JSON.stringify({ data: [] }), { status: 200 });
			}
			return new Response(JSON.stringify(fixture), { status: 200 });
		};
		return Object.assign(mock as typeof fetch, { calls });
	}

	it("requests the rich catalog with vk headers and dedupes by id", async function () {
		let requestedHeaders: HeadersInit | undefined;
		const mockFetch: typeof fetch = async function (input, init) {
			if (String(input) === "https://host/v1/models") requestedHeaders = init?.headers;
			return new Response(JSON.stringify(fixture), { status: 200 });
		};

		const models = await fetchCatalog(config, { fetch: mockFetch });
		expect(models).toHaveLength(6);
		expect(new Headers(requestedHeaders).get("x-bf-vk")).toBe("vk");
	});

	it("asks only the limit-less providers for their upstream echo", async function () {
		const mockFetch = routedFetch();
		await fetchCatalog(config, { fetch: mockFetch });
		expect(mockFetch.calls).toEqual([
			"https://host/v1/models",
			"https://host/v1/models?provider=opencode-go",
			"https://host/v1/models?provider=rutledge",
		]);
	});

	it("completes a bare entry from the provider-scoped upstream echo", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch() });
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
		expect(glm?.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
		// Video modalities are dropped: Pi's model shape is text/image only.
		expect(glm?.input).toEqual(["text"]);
		expect(glm?.compat.supportsStrictMode).toBe(true);
		expect(glm?.compat.supportsUsageInStreaming).toBe(false);
		expect(glm?.compat.maxTokensField).toBe("max_tokens");
	});

	it("carries image modalities through from the upstream echo", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch() });
		const kimi = models.find((model) => model.id === "opencode-go/kimi-k3");
		expect(kimi?.name).toBe("Kimi K3");
		expect(kimi?.contextWindow).toBe(1_048_576);
		expect(kimi?.maxTokens).toBe(131_072);
		expect(kimi?.input).toEqual(["text", "image"]);
		expect(kimi?.cost.input).toBeCloseTo(3, 6);
		expect(kimi?.cost.cacheWrite).toBeCloseTo(3, 6);
		expect(kimi?.reasoning).toBe(true);
		// Only "max" is advertised, so every other level is disabled.
		expect(kimi?.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: null,
			medium: null,
			high: null,
			xhigh: null,
			max: "max",
		});
	});

	it("leaves an entry that declares its own limits untouched", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch() });
		const deepseek = models.find((model) => model.id === "opencode-go/deepseek-v4.1-flash");
		// The echo advertises structured output, but the aggregate entry did not.
		expect(deepseek?.compat.supportsStrictMode).toBe(false);
	});

	it("does not add upstream models the key cannot use", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch() });
		expect(models.some((model) => model.id.includes("gpt-5.6-luna"))).toBe(false);
	});

	it("keeps the conservative fallback when a provider has no echo", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch() });
		const rutledge = models.find((model) => model.id === "rutledge/rutledge-coder");
		expect(rutledge?.contextWindow).toBe(128000);
		expect(rutledge?.maxTokens).toBe(8192);
	});

	it("keeps the catalog when a provider-scoped request fails", async function () {
		const models = await fetchCatalog(config, { fetch: routedFetch("rutledge") });
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
