import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MODEL_TTL_MS,
	bifrostHeaders,
	createHofundConfig,
	flagFromArgv,
	managementHeaders,
	readHofundSettings,
	writeHofundSettings,
} from "../src/config.ts";

describe("createHofundConfig", function () {
	it("resolves url least-specific to most-specific (settings < env < argv)", function () {
		const settings = { url: "https://settings.test", virtualKey: "vk-settings" };

		expect(createHofundConfig({ settings, env: {} }).url).toBe("https://settings.test/openai/v1");
		expect(createHofundConfig({ settings, env: { BIFROST_URL: "https://env.test" } }).url).toBe(
			"https://env.test/openai/v1",
		);
		expect(
			createHofundConfig({
				settings,
				env: { BIFROST_URL: "https://env.test" },
				argv: ["--hofund-url", "https://argv.test"],
			}).url,
		).toBe("https://argv.test/openai/v1");
		expect(createHofundConfig({ settings, argv: ["--hofund-url=https://argv.test"] }).url).toBe(
			"https://argv.test/openai/v1",
		);
	});

	it("sources the virtual key from the stored credential, never the environment", function () {
		const fromCredential = createHofundConfig({
			env: {},
			argv: [],
			credential: {
				type: "api_key",
				env: { BIFROST_URL: "https://cred.test", BIFROST_VIRTUAL_KEY: "vk-cred" },
			},
		});
		expect(fromCredential.url).toBe("https://cred.test/openai/v1");
		expect(fromCredential.virtualKey).toBe("vk-cred");

		expect(function () {
			createHofundConfig({
				settings: { url: "https://host" },
				env: { BIFROST_VIRTUAL_KEY: "env-vk" },
				argv: [],
			});
		}).toThrow(/virtual key/);
	});

	it("normalizes the skills zip path prefix", function () {
		const base = { url: "https://host", virtualKey: "vk" };
		expect(
			createHofundConfig({ settings: { ...base, zipPathPrefix: "/pi/" }, env: {}, argv: [] })
				.zipPathPrefix,
		).toBe("pi");
		expect(createHofundConfig({ settings: base, env: {}, argv: [] }).zipPathPrefix).toBeUndefined();
		expect(
			createHofundConfig({ settings: { ...base, zipPathPrefix: "   " }, env: {}, argv: [] })
				.zipPathPrefix,
		).toBeUndefined();
	});

	it("defaults every opt-in feature OFF", function () {
		const config = createHofundConfig({
			settings: { url: "https://host", virtualKey: "vk" },
			env: {},
			argv: [],
		});
		expect(config.features).toEqual({ models: true, mcp: false, skills: false, prompts: false });
	});

	it("enables only the features explicitly turned on", function () {
		const config = createHofundConfig({
			settings: {
				url: "https://host",
				virtualKey: "vk",
				features: { mcp: true, prompts: true },
			},
			env: {},
			argv: [],
		});
		expect(config.features).toEqual({ models: true, mcp: true, skills: false, prompts: true });
	});

	it("defaults the model TTL to six hours and honors an override", function () {
		const base = createHofundConfig({
			settings: { url: "https://host", virtualKey: "vk" },
			env: {},
			argv: [],
		});
		expect(base.modelTtlMs).toBe(DEFAULT_MODEL_TTL_MS);

		const overridden = createHofundConfig({
			settings: { url: "https://host", virtualKey: "vk", modelTtlMinutes: 30 },
			env: {},
			argv: [],
		});
		expect(overridden.modelTtlMs).toBe(30 * 60 * 1000);
	});

	it("throws when the URL or virtual key is missing, or the TTL is invalid", function () {
		expect(function () {
			createHofundConfig({ settings: { virtualKey: "vk" }, env: {}, argv: [] });
		}).toThrow(/Bifrost URL/);
		expect(function () {
			createHofundConfig({ settings: { url: "https://host" }, env: {}, argv: [] });
		}).toThrow(/virtual key/);
		expect(function () {
			createHofundConfig({
				settings: { url: "https://host", virtualKey: "vk", modelTtlMinutes: 0 },
				env: {},
				argv: [],
			});
		}).toThrow(/modelTtlMinutes/);
	});
});

describe("flagFromArgv", function () {
	it("reads both value forms and ignores a flag-shaped next token", function () {
		expect(flagFromArgv("hofund-url", ["--hofund-url", "https://a"])).toBe("https://a");
		expect(flagFromArgv("hofund-url", ["--hofund-url=https://b"])).toBe("https://b");
		expect(flagFromArgv("hofund-url", ["--hofund-url", "--other"])).toBeUndefined();
		expect(flagFromArgv("hofund-url", [])).toBeUndefined();
	});
});

describe("headers", function () {
	it("always sends x-bf-vk and a placeholder Bearer without an apiKey", function () {
		const config = createHofundConfig({
			settings: { url: "https://host", virtualKey: "vk-123" },
			env: {},
			argv: [],
		});
		expect(bifrostHeaders(config)).toEqual({
			"x-bf-vk": "vk-123",
			Authorization: "Bearer pi-hofund-keyless",
		});
	});

	it("uses the apiKey for Authorization when present", function () {
		const config = createHofundConfig({
			settings: { url: "https://host", virtualKey: "vk", apiKey: "real-key" },
			env: {},
			argv: [],
		});
		expect(bifrostHeaders(config).Authorization).toBe("Bearer real-key");
	});

	it("managementHeaders throws without a management key and works with one", function () {
		const without = createHofundConfig({
			settings: { url: "https://host", virtualKey: "vk" },
			env: {},
			argv: [],
		});
		expect(function () {
			managementHeaders(without);
		}).toThrow(/management API key/);

		const withKey = createHofundConfig({
			settings: { url: "https://host", virtualKey: "vk" },
			env: { HOFUND_MANAGEMENT_KEY: "mgmt" },
			argv: [],
		});
		expect(managementHeaders(withKey)).toEqual({ Authorization: "Bearer mgmt" });
	});
});

describe("writeHofundSettings", function () {
	let dir: string;

	beforeEach(async function () {
		dir = await mkdtemp(join(tmpdir(), "hofund-config-"));
	});

	afterEach(async function () {
		await rm(dir, { recursive: true, force: true });
	});

	it("creates the hofund block and preserves unrelated keys", async function () {
		await writeFile(join(dir, "settings.json"), JSON.stringify({ theme: "nightfox" }));

		await writeHofundSettings({ url: "https://host", features: { mcp: true } }, { dir });

		const parsed = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<
			string,
			unknown
		>;
		expect(parsed.theme).toBe("nightfox");
		expect(parsed.hofund).toEqual({ url: "https://host", features: { mcp: true } });
		expect(readHofundSettings({ dir })).toEqual({ url: "https://host", features: { mcp: true } });
	});

	it("merges into an existing hofund block", async function () {
		await writeFile(join(dir, "settings.json"), JSON.stringify({ hofund: { url: "https://old" } }));
		await writeHofundSettings({ modelTtlMinutes: 30 }, { dir });
		expect(readHofundSettings({ dir })).toEqual({ url: "https://old", modelTtlMinutes: 30 });
	});
});
