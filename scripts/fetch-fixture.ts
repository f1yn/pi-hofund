/**
 * Refresh the test fixtures from a live Bifrost instance.
 *
 * Writes `test/fixtures/models-v1.json` (the aggregate catalog) and, for
 * `HOFUND_FIXTURE_PROVIDER` (default `opencode-go`), the provider-scoped listing
 * whose `extra_fields.raw_response` carries the upstream echo.
 *
 * Convenience only — tests never run this. Requires a Bifrost URL (`hofund.url`,
 * `BIFROST_URL`, or `--hofund-url`) and a virtual key, taken from Pi's stored
 * `bifrost` credential unless `HOFUND_VIRTUAL_KEY`/`BIFROST_VIRTUAL_KEY` is set.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	bifrostHeaders,
	createHofundConfig,
	readHofundSettings,
	readStoredCredential,
	richCatalogUrl,
} from "../src/config.ts";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");

// Drop the upstream key identifiers Bifrost echoes alongside each status. They
// are not credentials, but they identify gateway keys and have no fixture value.
function redactKeyIds(body: unknown): unknown {
	const statuses = (body as { key_statuses?: unknown } | undefined)?.key_statuses;
	if (Array.isArray(statuses)) {
		for (const status of statuses) {
			if (status && typeof status === "object") delete (status as { key_id?: unknown }).key_id;
		}
	}
	return body;
}

async function writeFixture(name: string, url: string, headers: HeadersInit): Promise<void> {
	const response = await fetch(url, { headers });
	if (!response.ok) throw new Error(`fixture fetch failed for ${url} (${response.status})`);
	const outputPath = join(fixturesDir, name);
	const body = redactKeyIds(await response.json());
	// Tabs keep the generated file identical to what the formatter would write.
	await writeFile(outputPath, `${JSON.stringify(body, null, "\t")}\n`);
	process.stdout.write(`wrote ${outputPath}\n`);
}

async function main(): Promise<void> {
	// The URL comes from the same `hofund` settings block the extension reads, and
	// the virtual key from Pi's stored credential, so regeneration never needs a
	// secret on argv or in the shell environment.
	const settings = readHofundSettings() ?? {};
	const envVirtualKey = process.env.HOFUND_VIRTUAL_KEY ?? process.env.BIFROST_VIRTUAL_KEY;
	const config = createHofundConfig({
		credential: readStoredCredential(),
		settings: envVirtualKey === undefined ? settings : { ...settings, virtualKey: envVirtualKey },
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
