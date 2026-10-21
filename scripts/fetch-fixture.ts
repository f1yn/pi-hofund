/**
 * Refresh test/fixtures/models-v1.json from a live Bifrost instance.
 *
 * Convenience only — tests never run this. Requires either BIFROST_URL or
 * --hofund-url, plus HOFUND_VIRTUAL_KEY (or BIFROST_VIRTUAL_KEY).
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bifrostHeaders, createHofundConfig, richCatalogUrl } from "../src/config.ts";

async function main(): Promise<void> {
	const config = createHofundConfig({
		settings: { virtualKey: process.env.HOFUND_VIRTUAL_KEY },
		env: process.env,
		argv: process.argv.slice(2),
	});
	const response = await fetch(`${richCatalogUrl(config.url)}/models`, {
		headers: bifrostHeaders(config),
	});
	if (!response.ok) throw new Error(`fixture fetch failed (${response.status})`);

	const body = await response.json();
	const outputPath = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"test",
		"fixtures",
		"models-v1.json",
	);
	await writeFile(outputPath, `${JSON.stringify(body, null, 2)}\n`);
	process.stdout.write(`wrote ${outputPath}\n`);
}

void main();
