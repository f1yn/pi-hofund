import { describe, expect, it } from "vitest";
import { isZipError, readZipEntries } from "../src/shared/zip.ts";
import { makeZip } from "./helpers/zip.ts";

function expectZipError(fn: () => unknown, name: string): void {
	try {
		fn();
	} catch (error) {
		expect(isZipError(error, name as never)).toBe(true);
		expect((error as { name?: string }).name).toBe(name);
		return;
	}
	throw new Error(`expected ${name} to be thrown`);
}

function readUInt32(bytes: Uint8Array, offset: number): number {
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

describe("readZipEntries", function () {
	it("round-trips STORED and DEFLATE archives", function () {
		const stored = readZipEntries(makeZip({ "a.txt": "hello", "b.txt": "world" }));
		expect(new TextDecoder().decode(stored.get("a.txt"))).toBe("hello");
		expect(new TextDecoder().decode(stored.get("b.txt"))).toBe("world");

		const deflated = readZipEntries(makeZip({ "a.txt": "hello" }, { deflate: true }));
		expect(new TextDecoder().decode(deflated.get("a.txt"))).toBe("hello");
	});

	it("keeps nested directory entries", function () {
		const entries = readZipEntries(
			makeZip({ "skill/SKILL.md": "# Skill", "skill/refs/a.md": "ref" }),
		);
		expect([...entries.keys()].sort()).toEqual(["skill/SKILL.md", "skill/refs/a.md"]);
	});

	it("returns an empty map for an empty archive", function () {
		expect(readZipEntries(makeZip({})).size).toBe(0);
	});

	it("throws CrcMismatchError when payload bytes are corrupted", function () {
		const zip = makeZip({ "a.txt": "hello" });
		const nameLength = Buffer.from("a.txt").length;
		zip[30 + nameLength] ^= 0xff;
		expectZipError(function () {
			readZipEntries(zip);
		}, "CrcMismatchError");
	});

	it("throws Zip64UnsupportedError when the archive declares Zip64", function () {
		const zip = makeZip({ "a.txt": "hi" });
		const eocd = zip.length - 22;
		zip[eocd + 10] = 0xff;
		zip[eocd + 11] = 0xff;
		expectZipError(function () {
			readZipEntries(zip);
		}, "Zip64UnsupportedError");
	});

	it("throws UnsupportedCompressionError for an unknown method", function () {
		const zip = makeZip({ "a.txt": "hi" });
		const eocd = zip.length - 22;
		const centralOffset = readUInt32(zip, eocd + 16);
		zip[centralOffset + 10] = 12; // bzip2, unsupported
		zip[centralOffset + 11] = 0;
		expectZipError(function () {
			readZipEntries(zip);
		}, "UnsupportedCompressionError");
	});
});
