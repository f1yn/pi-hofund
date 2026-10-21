/**
 * MCP gateway registration.
 *
 * Registers the virtual key's Bifrost MCP surface with Pi. When the
 * management API enumerates Virtual MCPs, one Pi server is registered per
 * slug; otherwise a single whole-key `/mcp` server is registered. Everything
 * is VK-authenticated, so no management key is required for the fallback.
 */
import {
	type DiscoveryNotifier,
	type HofundConfig,
	bifrostHeaders,
	gatewayRootUrl,
	mcpGatewayUrl,
	virtualMcpUrl,
} from "./config.ts";

/** The subset of Pi's MCP HTTP config this module registers. */
export interface McpServerConfig {
	/** Streamable-HTTP endpoint of the Bifrost MCP gateway. */
	url: string;
	/** Request headers; carries the virtual key as `x-bf-vk`. */
	headers: Record<string, string>;
	/** One-line description shown in Pi's MCP tool listing. */
	description?: string;
	/** Per-request timeout in seconds. */
	timeout?: number;
}

/** Callback matching `pi.registerMcpServer`, injected for testability. */
export type RegisterMcpServer = (name: string, config: McpServerConfig) => void;

/** Callback matching `pi.unregisterMcpServer`, injected for testability. */
export type UnregisterMcpServer = (name: string) => void;

/** MCP registration contract returned by {@link createMcpRegistrar}. */
export interface McpRegistrar {
	/** Register the virtual key's MCP surface; resolves to the number of servers added. */
	register(registerServer: RegisterMcpServer): Promise<number>;
	/** Remove every server this registrar added; idempotent. */
	unregisterAll(unregisterServer: UnregisterMcpServer): void;
}

/** Injectable dependencies for {@link createMcpRegistrar}. */
export interface McpRegistrarOptions {
	fetch?: typeof fetch;
	notify?: DiscoveryNotifier;
}

// Read a list out of either a bare array or a wrapped collection.
function extractList(body: unknown): unknown[] {
	if (Array.isArray(body)) return body;
	if (body && typeof body === "object") {
		const record = body as Record<string, unknown>;
		for (const key of ["virtual_mcps", "data", "items", "results"]) {
			if (Array.isArray(record[key])) return record[key] as unknown[];
		}
	}
	return [];
}

// Defensively derive slugs from strings or `{ slug }`/`{ endpoint_slug }`/`{ name }` entries.
function parseSlugs(body: unknown): string[] {
	const slugs: string[] = [];
	for (const entry of extractList(body)) {
		if (typeof entry === "string") {
			if (entry) slugs.push(entry);
			continue;
		}
		if (entry && typeof entry === "object") {
			const candidate = entry as { slug?: unknown; endpoint_slug?: unknown; name?: unknown };
			const value = [candidate.slug, candidate.endpoint_slug, candidate.name].find(
				(item): item is string => typeof item === "string" && item.length > 0,
			);
			if (value) slugs.push(value);
		}
	}
	return slugs;
}

/**
 * Register the Bifrost MCP surface with Pi.
 *
 * @param config - Resolved configuration supplying the URL and virtual key.
 * @param options - Optional transport overrides and notice sink.
 * @returns A registrar that tracks registered names for teardown.
 * @remarks
 * One server per Virtual MCP slug is registered when enumeration succeeds;
 * otherwise a single whole-key `/mcp` server is registered.
 */
export function createMcpRegistrar(
	config: HofundConfig,
	options: McpRegistrarOptions = {},
): McpRegistrar {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const registered: string[] = [];

	async function register(registerServer: RegisterMcpServer): Promise<number> {
		const headers = bifrostHeaders(config);
		let slugs: string[] = [];
		try {
			const response = await fetchImpl(`${gatewayRootUrl(config.url)}/api/mcp/virtual-mcps`, {
				headers,
			});
			if (response.ok) {
				slugs = parseSlugs(await response.json().catch(() => undefined));
			}
		} catch {
			// Enumeration is best-effort; fall back to the whole-key union below.
			slugs = [];
		}

		if (slugs.length > 0) {
			for (const slug of slugs) {
				const name = `hofund-${slug}`;
				registerServer(name, {
					url: virtualMcpUrl(config.url, slug),
					headers,
					description: `Bifrost virtual MCP gateway (${slug})`,
				});
				registered.push(name);
			}
			return slugs.length;
		}

		registerServer("hofund", {
			url: mcpGatewayUrl(config.url),
			headers,
			description: "Bifrost MCP gateway (whole-key union)",
		});
		registered.push("hofund");
		options.notify?.(
			"Bifrost virtual MCP enumeration unavailable; registered the whole-key /mcp gateway.",
			"info",
		);
		return 1;
	}

	function unregisterAll(unregisterServer: UnregisterMcpServer): void {
		// splice drains the list, so a second call is a no-op.
		for (const name of registered.splice(0)) unregisterServer(name);
	}

	return { register, unregisterAll };
}
