import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, ProviderStreams, RefreshModelsContext } from "@earendil-works/pi-ai/compat";

type StreamContext = Parameters<ProviderStreams["stream"]>[1];
import { describe, expect, it } from "vitest";
import { createHofundConfig } from "../src/config.ts";
import { createBifrostProvider } from "../src/provider.ts";
import type { UpstreamOverride } from "../src/providers/registry.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "models-v1.json");
const fixtureBody = readFileSync(fixturePath, "utf8");

function makeConfig(modelTtlMinutes?: number) {
	return createHofundConfig({
		settings: {
			url: "https://host",
			virtualKey: "vk",
			...(modelTtlMinutes !== undefined ? { modelTtlMinutes } : {}),
		},
		env: {},
		argv: [],
	});
}

interface Publication {
	persist?: unknown;
	update?: () => void;
}

/** Minimal RefreshModelsContext double that applies published updates. */
function makeContext(overrides: Partial<RefreshModelsContext> = {}): {
	context: RefreshModelsContext;
	publications: Publication[];
} {
	const publications: Publication[] = [];
	const context = {
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async function (publication: Publication): Promise<boolean> {
			publications.push(publication);
			publication.update?.();
			return true;
		},
		...overrides,
	} as unknown as RefreshModelsContext;
	return { context, publications };
}

function catalogResponse(): Response {
	return new Response(fixtureBody, { status: 200 });
}

/** Seed a provider with the fixture catalog by running one refresh. */
async function seededProvider(
	fetchImpl: typeof fetch = async function () {
		return catalogResponse();
	},
	config = makeConfig(),
) {
	const provider = createBifrostProvider(config, { fetch: fetchImpl });
	await provider.refreshModels(makeContext().context);
	return provider;
}

describe("refreshModels lifecycle", function () {
	it("fetches once when stale and publishes the persisted catalog", async function () {
		let fetches = 0;
		const provider = createBifrostProvider(makeConfig(), {
			fetch: async function () {
				fetches += 1;
				return catalogResponse();
			},
		});
		const { context, publications } = makeContext();

		await provider.refreshModels(context);

		expect(fetches).toBe(1);
		expect(provider.getModels()).toHaveLength(4);
		expect(publications.some((publication) => publication.persist !== undefined)).toBe(true);
	});

	it("does not fetch again while the TTL is fresh, restoring the stored catalog", async function () {
		let fetches = 0;
		const provider = createBifrostProvider(makeConfig(), {
			fetch: async function () {
				fetches += 1;
				return catalogResponse();
			},
		});
		await provider.refreshModels(makeContext().context);
		expect(fetches).toBe(1);

		const stored = {
			models: provider.getModels().map((model) => structuredClone(model)),
			checkedAt: Date.now(),
		};
		await provider.refreshModels(
			makeContext({ stored: stored as unknown as RefreshModelsContext["stored"] }).context,
		);

		expect(fetches).toBe(1);
	});

	it("restores without fetching when network is disallowed", async function () {
		const seeded = await seededProvider();
		const stored = {
			models: seeded.getModels().map((model) => structuredClone(model)),
			checkedAt: 1,
		};

		let fetches = 0;
		const provider = createBifrostProvider(makeConfig(), {
			fetch: async function () {
				fetches += 1;
				return catalogResponse();
			},
		});
		const { context } = makeContext({
			allowNetwork: false,
			stored: stored as unknown as RefreshModelsContext["stored"],
		});
		await provider.refreshModels(context);

		expect(fetches).toBe(0);
		expect(provider.getModels()).toHaveLength(4);
	});

	it("retains the previous catalog and warns when a fetch fails", async function () {
		const seeded = await seededProvider();
		const stored = {
			models: seeded.getModels().map((model) => structuredClone(model)),
			checkedAt: 1,
		};

		const notices: string[] = [];
		const provider = createBifrostProvider(makeConfig(), {
			fetch: async function () {
				throw new Error("boom");
			},
			notify: function (msg, type) {
				if (type === "warning") notices.push(msg);
			},
		});
		await provider.refreshModels(
			makeContext({ stored: stored as unknown as RefreshModelsContext["stored"] }).context,
		);

		expect(provider.getModels()).toHaveLength(4);
		expect(notices.join(" ")).toContain("boom");
	});

	it("coalesces concurrent refreshes into one network call", async function () {
		let fetches = 0;
		const provider = createBifrostProvider(makeConfig(), {
			fetch: async function () {
				fetches += 1;
				await new Promise((resolve) => setTimeout(resolve, 5));
				return catalogResponse();
			},
		});

		await Promise.all([
			provider.refreshModels(makeContext().context),
			provider.refreshModels(makeContext().context),
		]);

		expect(fetches).toBe(1);
	});

	it("re-syncs on a later refresh once the TTL expires", async function () {
		let fetches = 0;
		const provider = createBifrostProvider(makeConfig(0.0001), {
			fetch: async function () {
				fetches += 1;
				return catalogResponse();
			},
		});

		await provider.refreshModels(makeContext().context);
		await new Promise((resolve) => setTimeout(resolve, 20));
		await provider.refreshModels(makeContext().context);

		expect(fetches).toBe(2);
	});

	it("routes outgoing bodies through an injected upstream override", async function () {
		const overrides = new Map<string, UpstreamOverride>([
			[
				"opencode-go",
				{
					processOutgoing: function (body) {
						body.messages = ["hooked"];
					},
				},
			],
		]);

		let captured: string | undefined;
		const fetchImpl: typeof fetch = async function (input, init) {
			if (String(input).endsWith("/models")) return catalogResponse();
			captured = String(init?.body);
			return new Response("nope", { status: 500 });
		};

		const provider = createBifrostProvider(makeConfig(), { fetch: fetchImpl, overrides });
		await provider.refreshModels(makeContext().context);
		const model = provider.getModels().find((m) => m.id.startsWith("opencode-go/")) as
			| Model<"openai-completions">
			| undefined;
		expect(model).toBeDefined();

		const context = { messages: [{ role: "user", content: "hi" }] } as unknown as StreamContext;
		let streamError: unknown;
		try {
			const stream = provider.stream(model as Model<"openai-completions">, context, {
				apiKey: "test",
				fetch: fetchImpl,
			});
			for await (const _event of stream) {
				// Drain; the mock returns 500, which the adapter surfaces below.
			}
		} catch (error) {
			streamError = error;
		}

		expect(streamError, `stream error: ${String(streamError)}`).toBeUndefined();
		expect(JSON.parse(captured ?? "{}").messages).toEqual(["hooked"]);
	});
});
