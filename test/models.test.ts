import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { refreshBifrostModels } from "../src/models.ts";

interface RefreshCall {
	providers: readonly string[] | undefined;
	force: boolean | undefined;
	allowNetwork: boolean | undefined;
	signal: AbortSignal;
}

function registryReturning(result: { aborted?: boolean; errors?: Map<string, Error> }): {
	registry: ModelRegistry;
	calls: RefreshCall[];
} {
	const calls: RefreshCall[] = [];
	const registry = {
		refresh: async function (options: {
			providers?: readonly string[];
			force?: boolean;
			allowNetwork?: boolean;
			signal?: AbortSignal;
		}) {
			calls.push({
				providers: options.providers,
				force: options.force,
				allowNetwork: options.allowNetwork,
				signal: options.signal ?? new AbortController().signal,
			});
			return { aborted: result.aborted ?? false, errors: result.errors ?? new Map() };
		},
	} as unknown as ModelRegistry;
	return { registry, calls };
}

describe("refreshBifrostModels", function () {
	it("asks the host registry for a networked, provider-scoped refresh", async function () {
		const { registry, calls } = registryReturning({});

		await refreshBifrostModels(registry, true);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.providers).toEqual(["bifrost"]);
		expect(calls[0]?.force).toBe(true);
		expect(calls[0]?.allowNetwork).toBe(true);
		// The registry owns persistence; the caller only supplies a bounded signal.
		expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
	});

	it("leaves the freshness TTL in place when not forced", async function () {
		const { registry, calls } = registryReturning({});

		await refreshBifrostModels(registry, false);

		expect(calls[0]?.force).toBe(false);
	});

	it("surfaces the provider's refresh error", async function () {
		const failure = new Error("catalog unreachable");
		const { registry } = registryReturning({ errors: new Map([["bifrost", failure]]) });

		await expect(refreshBifrostModels(registry, true)).rejects.toBe(failure);
	});

	it("reports an aborted refresh instead of pretending it succeeded", async function () {
		const { registry } = registryReturning({ aborted: true });

		await expect(refreshBifrostModels(registry, true)).rejects.toThrow(/did not finish/);
	});
});
