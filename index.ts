/**
 * pi-hofund extension entry point.
 *
 * The factory only registers: flags, the `bifrost` provider, and session
 * lifecycle handlers. All network work happens in `session_start` syncs and in
 * `refreshModels`, never while the factory runs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type DiscoveryNotifier,
	type HofundConfig,
	createHofundConfig,
	readHofundSettings,
	readStoredCredential,
} from "./src/config.ts";
import { createMcpRegistrar } from "./src/mcp.ts";
import { registerReloadCommand, registerSettingsCommand } from "./src/command.ts";
import { createBifrostProvider } from "./src/provider.ts";
import { type UpstreamOverride, loadUpstreamOverrides } from "./src/providers/registry.ts";
import { createPromptsSyncer, createSkillsSyncer } from "./src/sync.ts";

/** The single closed-over contract the extension composes and exposes. */
export interface HofundController {
	/** Register the `bifrost` provider with Pi. */
	registerProvider(): void;
	/** Refresh the model catalog for this session; `force` bypasses the TTL. */
	syncModels(force?: boolean): Promise<void>;
	/** Register the MCP surface; resolves to the number of servers added. */
	syncMcp(): Promise<number>;
	/** Materialize skills when the feature is enabled. */
	syncSkills(): Promise<void>;
	/** Materialize prompts when the feature is enabled. */
	syncPrompts(): Promise<void>;
	/** Unregister the MCP servers this extension added; idempotent. */
	shutdown(): void;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Compose the provider, MCP, skills, and prompts units into one controller.
 *
 * @param config - Resolved configuration.
 * @param pi - The Pi extension API.
 * @param overrides - Per-upstream override hooks.
 * @param notify - Optional sink for discovery notices.
 * @returns The closed-over controller contract.
 * @remarks
 * No classes, no `this`: all state stays in this closure.
 */
export function createBifrostAbstract(
	config: HofundConfig,
	pi: ExtensionAPI,
	overrides: ReadonlyMap<string, UpstreamOverride> = new Map(),
	notify?: DiscoveryNotifier,
): HofundController {
	const provider = createBifrostProvider(config, { overrides, notify });
	const mcp = createMcpRegistrar(config, { notify });
	const skills = createSkillsSyncer(config, { notify });
	const prompts = createPromptsSyncer(config, { notify });
	let shutDown = false;

	async function syncModels(force = false): Promise<void> {
		// The provider owns TTL/coalescing; this only nudges it for the new session.
		await provider.refreshModels({
			allowNetwork: true,
			signal: AbortSignal.timeout(15_000),
			publish: async function () {
				return true;
			},
			stored: undefined,
			force,
		});
	}

	async function syncMcp(): Promise<number> {
		if (!config.features.mcp) return 0;
		// Wrap so ExtensionAPI methods keep their `this` binding.
		return mcp.register(function (name, serverConfig) {
			pi.registerMcpServer(name, serverConfig);
		});
	}

	async function syncSkills(): Promise<void> {
		await skills.sync();
	}

	async function syncPrompts(): Promise<void> {
		await prompts.sync();
	}

	function shutdown(): void {
		if (shutDown) return;
		shutDown = true;
		mcp.unregisterAll(function (name) {
			pi.unregisterMcpServer(name);
		});
	}

	return {
		registerProvider: function () {
			pi.registerProvider(provider);
		},
		syncModels,
		syncMcp,
		syncSkills,
		syncPrompts,
		shutdown,
	};
}

/**
 * Pi extension entry point.
 *
 * @param pi - The Pi extension API.
 */
export default async function hofund(pi: ExtensionAPI): Promise<void> {
	pi.registerFlag("hofund-url", {
		description: "Bifrost instance or OpenAI-compatible base URL (env: BIFROST_URL)",
		type: "string",
	});
	pi.registerFlag("hofund-api-key", {
		description: "Bifrost API/auth key (optional; prefer env: BIFROST_API_KEY)",
		type: "string",
	});
	pi.registerFlag("hofund-virtual-key", {
		description: "Bifrost virtual key (env: BIFROST_VIRTUAL_KEY)",
		type: "string",
	});

	// The interactive config command is registration-only and load-safe.
	registerSettingsCommand(pi);

	// Notices must not be written straight to stderr (Pi's TUI owns the screen);
	// queue them until session_start supplies a UI context, then flush.
	let ui: { notify(message: string, type?: "info" | "warning" | "error"): void } | undefined;
	const queued: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
	const notify: DiscoveryNotifier = function (message, type) {
		if (ui) {
			ui.notify(message, type);
			return;
		}
		queued.push({ message, type });
	};

	let config: HofundConfig | undefined;
	let configError: Error | undefined;
	try {
		config = createHofundConfig({
			settings: readHofundSettings(),
			env: process.env,
			argv: process.argv.slice(2),
			credential: readStoredCredential(),
		});
	} catch (error) {
		configError = error instanceof Error ? error : new Error(String(error));
	}

	const overrides = await loadUpstreamOverrides();
	const controller = config ? createBifrostAbstract(config, pi, overrides, notify) : undefined;
	controller?.registerProvider();
	registerReloadCommand(pi, function () {
		return controller;
	});

	pi.on("session_start", async function (_event, ctx) {
		ui = ctx.ui;
		for (const notice of queued.splice(0)) ctx.ui.notify(notice.message, notice.type);

		if (!controller) {
			ctx.ui.notify(
				`pi-hofund is not configured: ${configError?.message ?? "missing config"}`,
				"error",
			);
			return;
		}
		// Syncs are independent: one failure must not abort the others.
		await Promise.all([
			controller.syncModels().catch(function (error) {
				ctx.ui.notify(`Bifrost model sync failed: ${describe(error)}`, "error");
			}),
			controller.syncMcp().catch(function (error) {
				ctx.ui.notify(`Bifrost MCP sync failed: ${describe(error)}`, "error");
			}),
			controller.syncSkills().catch(function (error) {
				ctx.ui.notify(`Bifrost skills sync failed: ${describe(error)}`, "error");
			}),
			controller.syncPrompts().catch(function (error) {
				ctx.ui.notify(`Bifrost prompts sync failed: ${describe(error)}`, "error");
			}),
		]);
	});

	pi.on("session_shutdown", function () {
		controller?.shutdown();
	});
}
