import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHofundConfig, readStoredCredential, writeStoredCredential } from "../src/config.ts";
import { createBifrostProvider } from "../src/provider.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hofund-credential-"));
	dirs.push(dir);
	return dir;
}

function authPath(dir: string): string {
	return join(dir, "auth.json");
}

function readAuth(dir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(authPath(dir), "utf8")) as Record<string, unknown>;
}

const hofundCredential = {
	type: "api_key" as const,
	key: "pi-hofund-keyless",
	env: {
		BIFROST_URL: "https://ai.example.test/openai/v1",
		BIFROST_VIRTUAL_KEY: "sk-bf-test",
	},
};

afterEach(function () {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("writeStoredCredential", function () {
	it("writes the hofund shape and preserves other providers", async function () {
		const dir = tempDir();
		writeFileSync(
			authPath(dir),
			`${JSON.stringify({ "opencode-go": { type: "api_key", key: "other" } }, null, 2)}\n`,
			{ mode: 0o600 },
		);

		await writeStoredCredential(hofundCredential, { dir });

		const stored = readAuth(dir);
		expect(stored["bifrost"]).toEqual(hofundCredential);
		expect(stored["opencode-go"]).toEqual({ type: "api_key", key: "other" });
		expect(statSync(authPath(dir)).mode & 0o777).toBe(0o600);
		expect(existsSync(`${authPath(dir)}.tmp`)).toBe(false);
	});

	it("replaces a legacy bare-key entry and creates a missing store", async function () {
		const dir = tempDir();
		writeFileSync(
			authPath(dir),
			`${JSON.stringify({ bifrost: { type: "api_key", key: "sk-bf-legacy" } })}\n`,
			{ mode: 0o600 },
		);

		await writeStoredCredential(hofundCredential, { dir });
		expect(readAuth(dir)["bifrost"]).toEqual(hofundCredential);

		const fresh = tempDir();
		await writeStoredCredential(hofundCredential, { dir: fresh });
		expect(readAuth(fresh)["bifrost"]).toEqual(hofundCredential);
	});

	it("survives a malformed store and round-trips through readStoredCredential", async function () {
		const dir = tempDir();
		writeFileSync(authPath(dir), "not json", { mode: 0o600 });

		await writeStoredCredential(hofundCredential, { dir });

		expect(readAuth(dir)["bifrost"]).toEqual(hofundCredential);
		expect(readStoredCredential(dir)).toEqual(hofundCredential);
	});
});

describe("provider login persistence", function () {
	it("saves the URL and virtual key the user entered", async function () {
		const dir = tempDir();
		const answers = ["https://ai.example.test/", "sk-bf-entered"];
		const asked: string[] = [];
		const notices: string[] = [];
		const interaction = {
			signal: new AbortController().signal,
			notify: function (event: { type: string }) {
				notices.push(event.type);
			},
			prompt: async function (prompt: { type: string; message: string }) {
				asked.push(prompt.type);
				return answers[asked.length - 1] ?? "";
			},
		};

		const config = createHofundConfig({
			settings: { url: "https://ai.example.test/", virtualKey: "vk-ambient" },
			env: {},
			argv: [],
		});
		const provider = createBifrostProvider(config, { credentialDir: dir });
		const login = provider.auth?.apiKey?.login;
		expect(login).toBeTypeOf("function");

		const credential = await login?.(interaction);

		expect(asked).toEqual(["text", "secret"]);
		expect(notices).toEqual(["info"]);
		expect(credential).toEqual({
			type: "api_key",
			key: "pi-hofund-keyless",
			env: {
				BIFROST_URL: "https://ai.example.test/openai/v1",
				BIFROST_VIRTUAL_KEY: "sk-bf-entered",
			},
		});
		expect(readStoredCredential(dir)).toEqual(credential);
	});

	it("keeps the provider resolvable from the credential it just wrote", async function () {
		const dir = tempDir();
		const interaction = {
			signal: new AbortController().signal,
			notify: function () {},
			async prompt(prompt: { type: string }): Promise<string> {
				return prompt.type === "text" ? "https://ai.example.test/" : "sk-bf-entered";
			},
		};
		const provider = createBifrostProvider(
			createHofundConfig({
				settings: { url: "https://ai.example.test/", virtualKey: "vk-ambient" },
				env: {},
				argv: [],
			}),
			{ credentialDir: dir },
		);

		const credential = await provider.auth?.apiKey?.login?.(interaction);
		expect(credential?.env?.BIFROST_VIRTUAL_KEY).toBe("sk-bf-entered");
		expect(readStoredCredential(dir)?.env?.BIFROST_URL).toBe("https://ai.example.test/openai/v1");
	});
});
