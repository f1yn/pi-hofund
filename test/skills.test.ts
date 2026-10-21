import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHofundConfig } from "../src/config.ts";
import { createSkillsSyncer } from "../src/sync.ts";
import { makeZip } from "./helpers/zip.ts";

let skillsRoot: string;

beforeEach(async function () {
	skillsRoot = await mkdtemp(join(tmpdir(), "hofund-skills-"));
});

afterEach(async function () {
	await rm(skillsRoot, { recursive: true, force: true });
});

function makeConfig(skills: boolean, zipPathPrefix?: string) {
	return createHofundConfig({
		settings: {
			url: "https://host",
			virtualKey: "vk",
			features: { skills },
			...(zipPathPrefix !== undefined ? { zipPathPrefix } : {}),
		},
		env: {},
		argv: [],
	});
}

function zipResponse(zip: Uint8Array): Response {
	// A Uint8Array is a valid fetch body at runtime; the DOM lib's BodyInit is narrower.
	return new Response(zip as unknown as BodyInit, { status: 200 });
}

function zipFetch(zip: Uint8Array): typeof fetch {
	return async function () {
		return zipResponse(zip);
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

describe("createSkillsSyncer", function () {
	it("materializes skills flat and injects only the managed marker", async function () {
		const zip = makeZip({
			"pdf-tools/SKILL.md": "# PDF tools",
			"pdf-tools/refs/a.md": "reference",
		});
		const syncer = createSkillsSyncer(makeConfig(true), { fetch: zipFetch(zip), skillsRoot });

		const result = await syncer.sync();

		expect(result).toEqual({ synced: 1, removed: 0, preserved: 0 });
		const skill = await readFile(join(skillsRoot, "pdf-tools", "SKILL.md"), "utf8");
		expect(skill).toContain("# PDF tools");
		expect(skill).toContain("managed-by: pi-hofund");
		expect(skill).not.toContain("defined-in: Bifrost");
		expect(await readFile(join(skillsRoot, "pdf-tools", "refs", "a.md"), "utf8")).toBe("reference");
		expect(await exists(join(skillsRoot, "bifrost"))).toBe(false);
	});

	it("is a no-op on a second identical sync", async function () {
		const zip = makeZip({ "a/SKILL.md": "# A" });
		const syncer = createSkillsSyncer(makeConfig(true), { fetch: zipFetch(zip), skillsRoot });

		await syncer.sync();
		expect(await syncer.sync()).toEqual({ synced: 0, removed: 0, preserved: 0 });
	});

	it("handles an empty archive and removes previously synced skills", async function () {
		const first = createSkillsSyncer(makeConfig(true), {
			fetch: zipFetch(makeZip({ "a/SKILL.md": "# A", "b/SKILL.md": "# B" })),
			skillsRoot,
		});
		await first.sync();

		const second = createSkillsSyncer(makeConfig(true), {
			fetch: zipFetch(makeZip({})),
			skillsRoot,
		});
		const result = await second.sync();

		expect(result).toEqual({ synced: 0, removed: 2, preserved: 0 });
		expect(await exists(join(skillsRoot, "a"))).toBe(false);
		expect(await exists(join(skillsRoot, "b"))).toBe(false);
	});

	it("removes only dropped skills and keeps user-authored ones", async function () {
		const first = createSkillsSyncer(makeConfig(true), {
			fetch: zipFetch(makeZip({ "a/SKILL.md": "# A", "b/SKILL.md": "# B" })),
			skillsRoot,
		});
		await first.sync();

		const manual = join(skillsRoot, "manual", "SKILL.md");
		await mkdir(join(skillsRoot, "manual"), { recursive: true });
		await writeFile(manual, "# Manual");

		const second = createSkillsSyncer(makeConfig(true), {
			fetch: zipFetch(makeZip({ "a/SKILL.md": "# A2" })),
			skillsRoot,
		});
		const result = await second.sync();

		expect(result).toEqual({ synced: 1, removed: 1, preserved: 0 });
		expect(await exists(join(skillsRoot, "b"))).toBe(false);
		expect(await exists(manual)).toBe(true);
		expect(await readFile(join(skillsRoot, "a", "SKILL.md"), "utf8")).toContain("# A2");
	});

	it("preserves a user-defined skill whose SKILL.md lacks the marker", async function () {
		const zip = makeZip({ "a/SKILL.md": "# From Bifrost" });
		const syncer = createSkillsSyncer(makeConfig(true), { fetch: zipFetch(zip), skillsRoot });
		await mkdir(join(skillsRoot, "a"), { recursive: true });
		await writeFile(join(skillsRoot, "a", "SKILL.md"), "# Mine");

		const result = await syncer.sync();

		expect(result).toEqual({ synced: 0, removed: 0, preserved: 1 });
		expect(await readFile(join(skillsRoot, "a", "SKILL.md"), "utf8")).toBe("# Mine");
	});

	it("keeps a preserved skill even when a later payload drops it", async function () {
		const first = createSkillsSyncer(makeConfig(true), {
			fetch: zipFetch(makeZip({ "a/SKILL.md": "# A", "b/SKILL.md": "# B" })),
			skillsRoot,
		});
		await first.sync();
		await writeFile(join(skillsRoot, "b", "SKILL.md"), "# Mine");

		const second = createSkillsSyncer(makeConfig(true), {
			fetch: zipFetch(makeZip({ "a/SKILL.md": "# A2" })),
			skillsRoot,
		});
		const result = await second.sync();

		expect(result).toEqual({ synced: 1, removed: 0, preserved: 1 });
		expect(await exists(join(skillsRoot, "b"))).toBe(true);
	});

	it("retires the legacy managed skills/bifrost tree without touching user skills", async function () {
		const legacy = join(skillsRoot, "bifrost");
		await mkdir(join(legacy, "old"), { recursive: true });
		await writeFile(join(legacy, "old", "SKILL.md"), "---\nmanaged-by: pi-hofund\n---\n\n# Old");
		await writeFile(
			join(legacy, ".hofund-manifest.json"),
			JSON.stringify({ version: "legacy", syncedAt: 1, skills: ["old"] }),
		);
		await mkdir(join(legacy, "mine"), { recursive: true });
		await writeFile(join(legacy, "mine", "SKILL.md"), "# Mine");

		const zip = makeZip({ "new/SKILL.md": "# New" });
		const syncer = createSkillsSyncer(makeConfig(true), { fetch: zipFetch(zip), skillsRoot });

		const result = await syncer.sync();

		expect(result).toEqual({ synced: 1, removed: 0, preserved: 0 });
		expect(await exists(join(legacy, "old"))).toBe(false);
		expect(await readFile(join(legacy, "mine", "SKILL.md"), "utf8")).toBe("# Mine");
		expect(await exists(join(skillsRoot, "new", "SKILL.md"))).toBe(true);
	});

	it("restricts sync to a configured zip path prefix and strips it on disk", async function () {
		const zip = makeZip({
			"pi/tools/SKILL.md": "# Tools",
			"other/nope/SKILL.md": "# Nope",
		});
		const syncer = createSkillsSyncer(makeConfig(true, "/pi/"), {
			fetch: zipFetch(zip),
			skillsRoot,
		});

		const result = await syncer.sync();

		expect(result).toEqual({ synced: 1, removed: 0, preserved: 0 });
		expect(await exists(join(skillsRoot, "tools", "SKILL.md"))).toBe(true);
		expect(await exists(join(skillsRoot, "nope"))).toBe(false);
	});

	it("is a no-op when the feature is disabled", async function () {
		let fetches = 0;
		const syncer = createSkillsSyncer(makeConfig(false), {
			fetch: async function () {
				fetches += 1;
				return zipResponse(makeZip({}));
			},
			skillsRoot,
		});

		expect(await syncer.sync()).toBeUndefined();
		expect(fetches).toBe(0);
		expect(await exists(join(skillsRoot, ".hofund-manifest.json"))).toBe(false);
	});

	it("accepts a single root wrapper around several skills", async function () {
		const zip = makeZip({
			"repo-main/a/SKILL.md": "# A",
			"repo-main/a/x.md": "x",
			"repo-main/b/SKILL.md": "# B",
		});
		const syncer = createSkillsSyncer(makeConfig(true), { fetch: zipFetch(zip), skillsRoot });

		const result = await syncer.sync();

		expect(result).toEqual({ synced: 2, removed: 0, preserved: 0 });
		expect(await readFile(join(skillsRoot, "a", "x.md"), "utf8")).toBe("x");
		expect(await exists(join(skillsRoot, "b", "SKILL.md"))).toBe(true);
	});
});
