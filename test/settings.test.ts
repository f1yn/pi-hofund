import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readHofundSettings } from "../src/config.ts";

let dir: string;

beforeEach(async function () {
	dir = await mkdtemp(join(tmpdir(), "hofund-settings-"));
});

afterEach(async function () {
	await rm(dir, { recursive: true, force: true });
});

describe("readHofundSettings", function () {
	it("returns the hofund block when present", async function () {
		await writeFile(
			join(dir, "settings.json"),
			JSON.stringify({ hofund: { url: "https://host", features: { mcp: true } } }),
		);
		expect(readHofundSettings({ dir })).toEqual({ url: "https://host", features: { mcp: true } });
	});

	it("returns undefined when the file is missing", function () {
		expect(readHofundSettings({ dir: join(dir, "absent") })).toBeUndefined();
	});

	it("returns undefined for malformed JSON", async function () {
		await writeFile(join(dir, "settings.json"), "{ not json");
		expect(readHofundSettings({ dir })).toBeUndefined();
	});

	it("returns undefined when there is no hofund block", async function () {
		await writeFile(join(dir, "settings.json"), JSON.stringify({ theme: "system" }));
		expect(readHofundSettings({ dir })).toBeUndefined();
	});

	it("ignores a non-object hofund value", async function () {
		await writeFile(join(dir, "settings.json"), JSON.stringify({ hofund: ["nope"] }));
		expect(readHofundSettings({ dir })).toBeUndefined();
	});
});
