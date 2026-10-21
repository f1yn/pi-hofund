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

	it("dedupes by canonical_slug, keeping the first spelling", function () {
		expect(byId.size).toBe(4);
		expect(byId.get("openrouter/moonshotai/kimi-k3")?.name).toBe("Kimi K3");
	});

	it("falls back to conservative limits when Bifrost reports none", function () {
		const model = toProviderModel({ canonical_slug: "x/bare", name: "Bare" });
		expect(model?.contextWindow).toBe(128000);
		expect(model?.maxTokens).toBe(8192);
	});
});

describe("fetchCatalog", function () {
	const config = createHofundConfig({
		settings: { url: "https://host", virtualKey: "vk" },
		env: {},
		argv: [],
	});

	it("requests the rich catalog with vk headers and dedupes by id", async function () {
		let requestedUrl: string | undefined;
		let requestedHeaders: HeadersInit | undefined;
		const mockFetch: typeof fetch = async function (input, init) {
			requestedUrl = String(input);
			requestedHeaders = init?.headers;
			return new Response(JSON.stringify(fixture), { status: 200 });
		};

		const models = await fetchCatalog(config, { fetch: mockFetch });
		expect(requestedUrl).toBe("https://host/v1/models");
		expect(models).toHaveLength(4);
		expect(new Headers(requestedHeaders).get("x-bf-vk")).toBe("vk");
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
