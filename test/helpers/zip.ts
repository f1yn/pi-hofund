/**
 * Test-only ZIP writer. Produces real ZIP bytes with `node:zlib` so the reader
 * is exercised against the format, not a mock. Never imported by `src/`.
 */
import { crc32, deflateRawSync } from "node:zlib";

export interface MakeZipOptions {
	deflate?: boolean;
}

/** Build a ZIP archive from `path -> contents` entries (STORED unless `deflate`). */
export function makeZip(
	entries: Record<string, string | Uint8Array>,
	options: MakeZipOptions = {},
): Uint8Array {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	const names = Object.keys(entries);
	let offset = 0;

	for (const name of names) {
		const value = entries[name] as string | Uint8Array;
		const raw = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
		const nameBytes = Buffer.from(name, "utf8");
		const method = options.deflate ? 8 : 0;
		const compressed = options.deflate ? deflateRawSync(raw) : raw;
		const checksum = crc32(raw);

		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt16LE(0, 6);
		localHeader.writeUInt16LE(method, 8);
		localHeader.writeUInt32LE(checksum, 14);
		localHeader.writeUInt32LE(compressed.length, 18);
		localHeader.writeUInt32LE(raw.length, 22);
		localHeader.writeUInt16LE(nameBytes.length, 26);
		local.push(localHeader, nameBytes, compressed);

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(method, 10);
		centralHeader.writeUInt32LE(checksum, 16);
		centralHeader.writeUInt32LE(compressed.length, 20);
		centralHeader.writeUInt32LE(raw.length, 24);
		centralHeader.writeUInt16LE(nameBytes.length, 28);
		centralHeader.writeUInt32LE(offset, 42);
		central.push(centralHeader, nameBytes);

		offset += 30 + nameBytes.length + compressed.length;
	}

	const centralSize = central.reduce((sum, part) => sum + part.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(names.length, 8);
	eocd.writeUInt16LE(names.length, 10);
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(offset, 16);
	central.push(eocd);

	return new Uint8Array(Buffer.concat([...local, ...central]));
}
