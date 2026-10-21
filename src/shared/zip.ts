/**
 * Dependency-free ZIP reader over `node:zlib` (cross-domain utility).
 *
 * Bifrost's public skills bundle is a ZIP archive and Pi ships no ZIP decoder,
 * so this module parses the central directory itself and inflates entries with
 * the built-in zlib codec. It is pure and synchronous: no disk, no network, and
 * no knowledge of Bifrost.
 */
import { crc32, inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT_LENGTH = 0xffff;

/** Tagged ZIP failure names. Kept as values (no Error subclasses) per style. */
export type ZipErrorName =
	| "InvalidZipError"
	| "Zip64UnsupportedError"
	| "UnsupportedCompressionError"
	| "CrcMismatchError";

/** An Error carrying a stable `zipError` tag for programmatic handling. */
export interface ZipReadError extends Error {
	/** Stable failure tag. */
	zipError: ZipErrorName;
}

function zipError(name: ZipErrorName, message: string): ZipReadError {
	const error = new Error(message) as ZipReadError;
	error.name = name;
	error.zipError = name;
	return error;
}

/**
 * Narrow an unknown value to a tagged {@link ZipReadError}.
 *
 * @param error - Value to test.
 * @param name - Optional tag the error must carry.
 * @returns `true` when the value is a ZIP error with the requested tag.
 */
export function isZipError(error: unknown, name?: ZipErrorName): error is ZipReadError {
	return (
		error instanceof Error &&
		typeof (error as { zipError?: unknown }).zipError === "string" &&
		(name === undefined || (error as ZipReadError).zipError === name)
	);
}

interface EndOfCentralDirectory {
	entries: number;
	centralOffset: number;
	zip64: boolean;
}

// Locate the EOCD record, rejecting Zip64 archives with a typed error.
function findEndOfCentralDirectory(bytes: Buffer): EndOfCentralDirectory {
	if (bytes.length < EOCD_SIZE) {
		throw zipError("InvalidZipError", "buffer is too small to be a ZIP archive");
	}
	const lowest = Math.max(0, bytes.length - EOCD_SIZE - MAX_COMMENT_LENGTH);
	for (let offset = bytes.length - EOCD_SIZE; offset >= lowest; offset -= 1) {
		if (bytes.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
		const commentLength = bytes.readUInt16LE(offset + 20);
		if (offset + EOCD_SIZE + commentLength !== bytes.length) continue;
		const entries = bytes.readUInt16LE(offset + 10);
		const centralOffset = bytes.readUInt32LE(offset + 16);
		const zip64 =
			entries === 0xffff ||
			centralOffset === 0xffffffff ||
			(offset >= 20 && bytes.readUInt32LE(offset - 20) === ZIP64_LOCATOR_SIGNATURE);
		return { entries, centralOffset, zip64 };
	}
	throw zipError("InvalidZipError", "end of central directory record not found");
}

// Decode one entry payload by compression method.
function decodeEntry(method: number, compressed: Buffer): Uint8Array {
	if (method === 0) return Uint8Array.from(compressed);
	if (method === 8) return new Uint8Array(inflateRawSync(compressed));
	throw zipError("UnsupportedCompressionError", `unsupported compression method ${method}`);
}

/**
 * Read every file entry from a ZIP archive.
 *
 * @param buffer - Raw ZIP bytes.
 * @returns A map of entry path to decoded bytes; directory entries are skipped.
 * @throws A tagged {@link ZipReadError} on a malformed archive, an unsupported
 * compression method, a CRC mismatch, or a Zip64 archive.
 */
export function readZipEntries(buffer: Uint8Array): Map<string, Uint8Array> {
	const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const { entries, centralOffset, zip64 } = findEndOfCentralDirectory(bytes);
	if (zip64) throw zipError("Zip64UnsupportedError", "ZIP64 archives are not supported");

	const result = new Map<string, Uint8Array>();
	let cursor = centralOffset;
	for (let index = 0; index < entries; index += 1) {
		if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
			throw zipError("InvalidZipError", `invalid central directory entry at offset ${cursor}`);
		}
		const method = bytes.readUInt16LE(cursor + 10);
		const expectedCrc = bytes.readUInt32LE(cursor + 16);
		const compressedSize = bytes.readUInt32LE(cursor + 20);
		const nameLength = bytes.readUInt16LE(cursor + 28);
		const extraLength = bytes.readUInt16LE(cursor + 30);
		const commentLength = bytes.readUInt16LE(cursor + 32);
		const localOffset = bytes.readUInt32LE(cursor + 42);
		const name = bytes.toString("utf8", cursor + 46, cursor + 46 + nameLength);
		cursor += 46 + nameLength + extraLength + commentLength;

		if (name.endsWith("/")) continue;

		if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
			throw zipError("InvalidZipError", `invalid local header for ${name}`);
		}
		// Local name/extra lengths can differ from the central values.
		const localNameLength = bytes.readUInt16LE(localOffset + 26);
		const localExtraLength = bytes.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

		const payload = decodeEntry(method, compressed);
		if (crc32(payload) !== expectedCrc) {
			throw zipError("CrcMismatchError", `CRC mismatch for ${name}`);
		}
		result.set(name, payload);
	}
	return result;
}
