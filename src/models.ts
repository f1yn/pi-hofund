/**
 * Model catalog refresh, driven through the platform's registry.
 *
 * Pi performs a network refresh for a provider only when *it* calls
 * `refreshModels` with an `allowNetwork` context and a generation-checked
 * `publish`. A provider that fabricates that context (or supplies its own
 * `publish`) can fetch a catalog and never publish it, so the extension must
 * ask the host registry to run the refresh instead of calling its provider
 * directly.
 */
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

/** The provider id this extension registers with Pi. */
export const BIFROST_PROVIDER_ID = "bifrost";

/** Wall-clock budget for one host-driven catalog refresh. */
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * Refresh the Bifrost catalog through Pi's model registry.
 *
 * @param modelRegistry - The session's model registry (`ctx.modelRegistry`).
 * @param force - Bypass the provider's freshness TTL.
 * @returns Resolves once the host has published or skipped the refresh.
 * @throws The provider's refresh error, or an abort error when the refresh
 * exceeded {@link REFRESH_TIMEOUT_MS}.
 * @remarks
 * The registry owns persistence (`models-store.json`) and the in-memory update
 * that `refreshModels` publishes, so the new limits, pricing, and reasoning
 * flags are visible without a restart.
 */
export async function refreshBifrostModels(
	modelRegistry: ModelRegistry,
	force: boolean,
): Promise<void> {
	const result = await modelRegistry.refresh({
		providers: [BIFROST_PROVIDER_ID],
		force,
		allowNetwork: true,
		signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
	});
	const failure = result.errors.get(BIFROST_PROVIDER_ID);
	if (failure) throw failure;
	if (result.aborted) {
		throw new Error(`Bifrost model refresh did not finish within ${REFRESH_TIMEOUT_MS}ms`);
	}
}
