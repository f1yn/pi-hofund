/**
 * Front-matter helpers for synced assets (cross-domain text utility).
 *
 * Managed assets carry exactly one extra field, `managed-by: pi-hofund`, so a
 * user can tell a Bifrost-owned file from their own. Detection is exact: an
 * existing file without the marker is user-defined and is never overwritten or
 * removed.
 */

/** Marker line identifying a file this extension wrote. */
export const MANAGED_MARKER = "managed-by: pi-hofund";

/** The lines that make up the managed block, without the `---` fences. */
export const MANAGED_LINES = [MANAGED_MARKER];

interface FrontMatter {
	// The lines between the opening and closing `---`.
	block: string;
	// Everything after the closing `---` line.
	body: string;
}

// Split a leading `---` block from the body, or undefined when absent.
function splitFrontMatter(text: string): FrontMatter | undefined {
	const lines = text.split("\n");
	if (lines.length < 2 || lines[0].trim() !== "---") return undefined;
	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
	if (end === -1) return undefined;
	return { block: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

/**
 * Test whether text opens with a `---` YAML front-matter block.
 *
 * @param text - File contents.
 * @returns `true` when a leading front-matter block is present.
 */
export function hasFrontMatter(text: string): boolean {
	return splitFrontMatter(text) !== undefined;
}

/**
 * Test whether a leading front-matter block carries the managed marker.
 *
 * @param text - File contents.
 * @returns `true` when {@link MANAGED_MARKER} is present in the leading block.
 */
export function isManaged(text: string): boolean {
	const parts = splitFrontMatter(text);
	return parts !== undefined && parts.block.includes(MANAGED_MARKER);
}

/**
 * Ensure text carries the managed front-matter marker.
 *
 * @param text - File contents.
 * @returns The text with the marker injected, unchanged when already present, or
 * a new managed block prepended when no front-matter exists.
 */
export function ensureManagedFrontMatter(text: string): string {
	const parts = splitFrontMatter(text);
	if (parts === undefined) {
		return ["---", ...MANAGED_LINES, "---", "", text].join("\n");
	}
	if (parts.block.includes(MANAGED_MARKER)) return text;
	const existing = parts.block.length > 0 ? parts.block.split("\n") : [];
	return ["---", ...MANAGED_LINES, ...existing, "---", parts.body].join("\n");
}
