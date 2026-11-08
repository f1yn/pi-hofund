/**
 * Refresh the test fixtures from a live Bifrost instance.
 *
 * Writes `test/fixtures/models-v1.json` (the aggregate catalog) and, for
 * `HOFUND_FIXTURE_PROVIDER` (default `opencode-go`), the provider-scoped listing
 * whose `extra_fields.raw_response` carries the upstream echo.
 *
 * Convenience only — tests never run this. Requires either BIFROST_URL or
 * --hofund-url, plus HOFUND_VIRTUAL_KEY (or BIFROST_VIRTUAL_KEY).
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bifrostHeaders, createHofundConfig, richCatalogUrl } from "../src/config.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");

async function writeFixture(name: string, url: string, headers: HeadersInit): Promise<void> {
	const response = await fetch(url, { headers });
	if (!response.ok) throw new Error(`fixture fetch failed for ${url} (${response.status})`);
	const outputPath = join(fixturesDir, name);
	await writeFile(outputPath, `${JSON.stringify(await response.json(), null, 2)}\n`);
	process.stdout.write(`wrote ${outputPath}\n`);
}

async function main(): Promise<void> {
	const config = createHofundConfig({
		settings: { virtualKey: process.env.HOFUND_VIRTUAL_KEY },
		env: process.env,
		argv: process.argv.slice(2),
	});
	const headers = bifrostHeaders(config);
	const catalogUrl = `${richCatalogUrl(config.url)}/models`;
	await writeFixture("models-v1.json", catalogUrl, headers);

	const provider = process.env.HOFUND_FIXTURE_PROVIDER ?? "opencode-go";
	await writeFixture(
		`models-v1-${provider}.json`,
		`${catalogUrl}?provider=${encodeURIComponent(provider)}`,
		headers,
	);
}

void main();
