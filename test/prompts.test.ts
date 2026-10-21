import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHofundConfig } from "../src/config.ts";
import { createPromptsSyncer } from "../src/sync.ts";

let promptsRoot: string;

beforeEach(async function () {
	promptsRoot = await mkdtemp(join(tmpdir(), "hofund-prompts-"));
});

afterEach(async function () {
	await rm(promptsRoot, { recursive: true, force: true });
});

function makeConfig(options: { prompts: boolean; managementKey?: string }) {
	return createHofundConfig({
		settings: {
			url: "https://host",
			virtualKey: "vk",
			features: { prompts: options.prompts },
			...(options.managementKey ? { managementKey: options.managementKey } : {}),
		},
		env: {},
		argv: [],
	});
}

function jsonFetch(body: unknown): typeof fetch {
	return async function () {
		return new Response(JSON.stringify(body), { status: 200 });
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

describe("createPromptsSyncer", function () {
	it("renders ordered role sections and injects the managed marker", async function () {
		const payload = {
			prompts: [
				{
					id: "p1",
					name: "Code Review",
					latest_version: {
						version_number: 3,
						commit_message: "init",
						provider: "openai",
						model: "gpt-test",
						model_params: { temperature: 0.2 },
						messages: [
							{ order_index: 1, message: { role: "user", content: "second" } },
							{ order_index: 0, message: { role: "system", content: "first" } },
						],
					},
				},
			],
		};
		const syncer = createPromptsSyncer(makeConfig({ prompts: true, managementKey: "mgmt" }), {
			fetch: jsonFetch(payload),
			promptsRoot,
		});

		const result = await syncer.sync();

		expect(result).toEqual({ synced: 1, removed: 0, preserved: 0 });
		const markdown = await readFile(join(promptsRoot, "bifrost", "code-review.md"), "utf8");
		expect(markdown).toContain('description: "Code Review — init"');
		expect(markdown).toContain("version: 3");
		expect(markdown).toContain("managed-by: pi-hofund");
		expect(markdown).not.toContain("defined-in: Bifrost");
		expect(markdown.indexOf("## system")).toBeLessThan(markdown.indexOf("## user"));
		expect(markdown).toContain("first");
		expect(markdown).toContain("second");
	});

	it("renders a single system message without a role heading", async function () {
		const payload = {
			prompts: [
				{
					name: "Solo",
					latest_version: {
						version_number: 1,
						messages: [
							{ order_index: 0, message: { role: "system", content: "just instructions" } },
						],
					},
				},
			],
		};
		const syncer = createPromptsSyncer(makeConfig({ prompts: true, managementKey: "mgmt" }), {
			fetch: jsonFetch(payload),
			promptsRoot,
		});

		await syncer.sync();

		const markdown = await readFile(join(promptsRoot, "bifrost", "solo.md"), "utf8");
		expect(markdown).toContain("just instructions");
		expect(markdown).toContain("managed-by: pi-hofund");
		expect(markdown).not.toContain("## system");
	});

	it("sends the management key and is a no-op when the feature is disabled", async function () {
		let authorization: string | null = null;
		const syncer = createPromptsSyncer(makeConfig({ prompts: true, managementKey: "mgmt" }), {
			fetch: async function (_input, init) {
				authorization = new Headers(init?.headers).get("authorization");
				return new Response(JSON.stringify({ prompts: [] }), { status: 200 });
			},
			promptsRoot,
		});
		await syncer.sync();
		expect(authorization).toBe("Bearer mgmt");

		let fetches = 0;
		const disabled = createPromptsSyncer(makeConfig({ prompts: false }), {
			fetch: async function () {
				fetches += 1;
				return new Response("{}");
			},
			promptsRoot,
		});
		expect(await disabled.sync()).toBeUndefined();
		expect(fetches).toBe(0);
	});

	it("never fetches or writes without a management key", async function () {
		const notices: string[] = [];
		let fetches = 0;
		const syncer = createPromptsSyncer(makeConfig({ prompts: true }), {
			fetch: async function () {
				fetches += 1;
				return new Response("{}");
			},
			notify: function (msg) {
				notices.push(msg);
			},
			promptsRoot,
		});

		expect(await syncer.sync()).toBeUndefined();
		expect(fetches).toBe(0);
		expect(await exists(join(promptsRoot, "bifrost"))).toBe(false);
		expect(notices).toHaveLength(1);
	});

	it("removes only dropped prompts within the bifrost directory", async function () {
		const first = createPromptsSyncer(makeConfig({ prompts: true, managementKey: "mgmt" }), {
			fetch: jsonFetch({
				prompts: [
					{ name: "Keep", latest_version: { version_number: 1, messages: [] } },
					{ name: "Drop", latest_version: { version_number: 1, messages: [] } },
				],
			}),
			promptsRoot,
		});
		await first.sync();

		const second = createPromptsSyncer(makeConfig({ prompts: true, managementKey: "mgmt" }), {
			fetch: jsonFetch({
				prompts: [{ name: "Keep", latest_version: { version_number: 2, messages: [] } }],
			}),
			promptsRoot,
		});
		const result = await second.sync();

		expect(result).toEqual({ synced: 1, removed: 1, preserved: 0 });
		expect(await exists(join(promptsRoot, "bifrost", "keep.md"))).toBe(true);
		expect(await exists(join(promptsRoot, "bifrost", "drop.md"))).toBe(false);
		expect(await readFile(join(promptsRoot, "bifrost", "keep.md"), "utf8")).toContain("version: 2");
	});

	it("preserves a user-defined prompt file without the marker", async function () {
		const payload = {
			prompts: [{ name: "Mine", latest_version: { version_number: 1, messages: [] } }],
		};
		const syncer = createPromptsSyncer(makeConfig({ prompts: true, managementKey: "mgmt" }), {
			fetch: jsonFetch(payload),
			promptsRoot,
		});
		await mkdir(join(promptsRoot, "bifrost"), { recursive: true });
		await writeFile(join(promptsRoot, "bifrost", "mine.md"), "# my own template");

		const result = await syncer.sync();

		expect(result).toEqual({ synced: 0, removed: 0, preserved: 1 });
		expect(await readFile(join(promptsRoot, "bifrost", "mine.md"), "utf8")).toBe(
			"# my own template",
		);
	});
});
