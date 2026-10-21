import { describe, expect, it } from "vitest";
import {
	MANAGED_MARKER,
	ensureManagedFrontMatter,
	hasFrontMatter,
	isManaged,
} from "../src/shared/frontmatter.ts";

describe("frontmatter", function () {
	it("detects a leading front-matter block", function () {
		expect(hasFrontMatter("---\nname: a\n---\nbody")).toBe(true);
		expect(hasFrontMatter("# no front matter")).toBe(false);
		expect(hasFrontMatter("---\nunclosed: true\n")).toBe(false);
	});

	it("prepends exactly one managed field when none exists", function () {
		const result = ensureManagedFrontMatter("# Body");
		expect(result).toBe("---\nmanaged-by: pi-hofund\n---\n\n# Body");
		expect(result.startsWith("---\n")).toBe(true);
		expect(result).toContain(MANAGED_MARKER);
		expect(result.endsWith("# Body")).toBe(true);
	});

	it("injects only the marker inside existing front-matter and keeps the body", function () {
		const result = ensureManagedFrontMatter("---\nname: a\n---\nbody text");
		expect(result).toContain(MANAGED_MARKER);
		expect(result).not.toContain("defined-in: Bifrost");
		expect(result).toContain("name: a");
		expect(result).toContain("body text");
		expect(isManaged(result)).toBe(true);
	});

	it("is idempotent", function () {
		const once = ensureManagedFrontMatter("---\nname: a\n---\nbody");
		expect(ensureManagedFrontMatter(once)).toBe(once);
	});

	it("treats only marker-carrying blocks as managed", function () {
		expect(isManaged("---\nname: a\n---\nbody")).toBe(false);
		expect(isManaged(ensureManagedFrontMatter("body"))).toBe(true);
	});
});
