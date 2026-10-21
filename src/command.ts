/**
 * Interactive `/bifrost:settings` command.
 *
 * Pi exposes no API for writing arbitrary settings keys, so this command
 * read-modify-writes the `hofund` block in the user settings file and then
 * reloads extensions so the change takes effect. Everything here runs at command
 * time (never at extension load), where Pi's UI and runtime are available.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import {
	type HofundSettings,
	readHofundSettings,
	readStoredCredential,
	writeHofundSettings,
} from "./config.ts";

const COMMAND_NAME = "bifrost:settings";

interface FeatureState {
	mcp: boolean;
	skills: boolean;
	prompts: boolean;
}

interface FeatureToggleResult {
	features: FeatureState;
	saved: boolean;
}

function featureState(settings: HofundSettings | undefined): FeatureState {
	return {
		mcp: settings?.features?.mcp === true,
		skills: settings?.features?.skills === true,
		prompts: settings?.features?.prompts === true,
	};
}

// Human-readable summary shown above the settings menu.
function describe(settings: HofundSettings | undefined): string {
	const features = featureState(settings);
	const enabled =
		Object.entries(features)
			.filter(([, on]) => on)
			.map(([name]) => name)
			.join(", ") || "none";
	return [
		`URL: ${settings?.url ?? "(from auth.json / env)"}`,
		`Features: ${enabled}`,
		`Model TTL: ${settings?.modelTtlMinutes ?? 360} min`,
		`Skills zip prefix: ${settings?.zipPathPrefix ?? "(none)"}`,
		`Management key: ${settings?.managementKey ? "set" : "unset"}`,
	].join("\n");
}

// Full-screen checklist for the feature toggles. Space toggles, Ctrl+S saves,
// Esc cancels; Enter is deliberately inert so the screen never closes on it.
async function toggleFeatures(
	settings: HofundSettings,
	ctx: ExtensionCommandContext,
): Promise<HofundSettings> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Feature toggles need the interactive TUI.", "warning");
		return settings;
	}
	const rows: Array<{ key: keyof FeatureState; label: string }> = [
		{ key: "mcp", label: "MCP gateway" },
		{ key: "skills", label: "Skills sync" },
		{ key: "prompts", label: "Prompts sync" },
	];
	const initial = featureState(settings);

	const result = await ctx.ui.custom<FeatureToggleResult>(function (tui, theme, _kb, done) {
		let cursor = 0;
		let cached: string[] | undefined;
		const features: FeatureState = { ...initial };

		function refresh(): void {
			cached = undefined;
			tui.requestRender();
		}

		function render(_width: number): string[] {
			if (cached) return cached;
			const lines: string[] = [];
			lines.push(theme.fg("accent", theme.bold("Bifrost features")));
			lines.push(theme.fg("dim", "space toggle · ctrl+s save · esc cancel"));
			lines.push("");
			rows.forEach(function (row, index) {
				const pointer = index === cursor ? theme.fg("accent", "> ") : "  ";
				const box = features[row.key] ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
				const label = `${row.label}: ${features[row.key] ? "on" : "off"}`;
				const text = index === cursor ? theme.fg("accent", label) : theme.fg("text", label);
				lines.push(`${pointer}${box} ${text}`);
			});
			cached = lines;
			return lines;
		}

		function handleInput(data: string): void {
			if (matchesKey(data, Key.up)) {
				cursor = Math.max(0, cursor - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				cursor = Math.min(rows.length - 1, cursor + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.space)) {
				const row = rows[cursor];
				if (row) features[row.key] = !features[row.key];
				refresh();
				return;
			}
			if (matchesKey(data, Key.ctrl("s"))) {
				done({ features, saved: true });
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done({ features, saved: false });
				return;
			}
			// Enter and every other key are intentionally ignored; the screen stays open.
		}

		return { render, handleInput, invalidate: refresh };
	});

	return result.saved ? { ...settings, features: { ...result.features } } : settings;
}

async function editUrl(
	settings: HofundSettings,
	ctx: ExtensionCommandContext,
): Promise<HofundSettings> {
	const value = await ctx.ui.input("Bifrost URL", settings.url ?? "https://host/openai/v1");
	if (value === undefined) return settings;
	return { ...settings, url: value.trim() || undefined };
}

async function editTtl(
	settings: HofundSettings,
	ctx: ExtensionCommandContext,
): Promise<HofundSettings> {
	const value = await ctx.ui.input("Model TTL (minutes)", String(settings.modelTtlMinutes ?? 360));
	if (value === undefined) return settings;
	const minutes = Number(value);
	if (!Number.isFinite(minutes) || minutes <= 0) {
		ctx.ui.notify("Model TTL must be a positive number.", "warning");
		return settings;
	}
	return { ...settings, modelTtlMinutes: minutes };
}

async function editZipPrefix(
	settings: HofundSettings,
	ctx: ExtensionCommandContext,
): Promise<HofundSettings> {
	const value = await ctx.ui.input("Skills zip path prefix", settings.zipPathPrefix ?? "/pi/");
	if (value === undefined) return settings;
	return { ...settings, zipPathPrefix: value.trim() || undefined };
}

async function editManagementKey(
	settings: HofundSettings,
	ctx: ExtensionCommandContext,
): Promise<HofundSettings> {
	const value = await ctx.ui.input(
		"Management API key (blank to clear)",
		settings.managementKey ?? "",
	);
	if (value === undefined) return settings;
	return { ...settings, managementKey: value.trim() || undefined };
}

function showStatus(settings: HofundSettings, ctx: ExtensionCommandContext): void {
	const credential = readStoredCredential();
	const hasVirtualKey =
		Boolean(credential?.env?.BIFROST_VIRTUAL_KEY) || Boolean(settings.virtualKey);
	ctx.ui.notify(
		hasVirtualKey
			? "Bifrost virtual key present in the credential store."
			: "No Bifrost virtual key found; run `/login bifrost` to store one in auth.json.",
		hasVirtualKey ? "info" : "warning",
	);
}

async function handleSettingsCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	let settings: HofundSettings = readHofundSettings() ?? {};

	for (;;) {
		const choice = await ctx.ui.select(`Bifrost settings\n\n${describe(settings)}`, [
			"Edit gateway URL",
			"Toggle features",
			"Set model TTL",
			"Set skills zip prefix",
			"Set management key",
			"Show provider status",
			"Save & reload",
			"Cancel",
		]);

		if (choice === undefined || choice === "Cancel") return;
		if (choice === "Save & reload") {
			await writeHofundSettings(settings);
			ctx.ui.notify("pi-hofund settings saved; reloading extensions.", "info");
			await ctx.reload();
			return;
		}
		if (choice === "Edit gateway URL") {
			settings = await editUrl(settings, ctx);
			continue;
		}
		if (choice === "Toggle features") {
			settings = await toggleFeatures(settings, ctx);
			continue;
		}
		if (choice === "Set model TTL") {
			settings = await editTtl(settings, ctx);
			continue;
		}
		if (choice === "Set skills zip prefix") {
			settings = await editZipPrefix(settings, ctx);
			continue;
		}
		if (choice === "Set management key") {
			settings = await editManagementKey(settings, ctx);
			continue;
		}
		if (choice === "Show provider status") {
			showStatus(settings, ctx);
			continue;
		}
	}
}

/**
 * Register the interactive `/bifrost:settings` command.
 *
 * @param pi - The Pi extension API.
 * @remarks Registration only; the handler runs at command time.
 */
export function registerSettingsCommand(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Configure pi-hofund: gateway URL, features, TTL, zip prefix, management key",
		handler: handleSettingsCommand,
	});
}

/** The subset of the controller the reload command drives. */
export interface SyncController {
	/** Refresh the model catalog; `force` bypasses the freshness TTL. */
	syncModels(force?: boolean): Promise<void>;
	/** Register/re-register the MCP surface; resolves to the server count. */
	syncMcp(): Promise<number>;
	/** Materialize skills when the feature is enabled. */
	syncSkills(): Promise<void>;
	/** Materialize prompts when the feature is enabled. */
	syncPrompts(): Promise<void>;
}

/**
 * Register the on-demand `/bifrost:reload` command.
 *
 * @param pi - The Pi extension API.
 * @param getController - Returns the live sync controller, or `undefined` when
 * the extension is unconfigured.
 * @remarks
 * The handler proxies the same sync sequence as `session_start`, forcing a model
 * refresh. Registration only; the handler runs at command time.
 */
export function registerReloadCommand(
	pi: ExtensionAPI,
	getController: () => SyncController | undefined,
): void {
	pi.registerCommand("bifrost:reload", {
		description: "Re-run the Bifrost model, MCP, skills, and prompts sync now",
		handler: async function (_args, ctx) {
			const controller = getController();
			if (!controller) {
				ctx.ui.notify(
					"pi-hofund is not configured; run /bifrost:settings or /login bifrost.",
					"error",
				);
				return;
			}
			// Each sync is independent: one failure must not abort the others.
			function report(label: string): (error: unknown) => void {
				return function (error) {
					const detail = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Bifrost ${label} sync failed: ${detail}`, "error");
				};
			}
			await Promise.all([
				controller.syncModels(true).catch(report("model")),
				controller.syncMcp().catch(report("MCP")),
				controller.syncSkills().catch(report("skills")),
				controller.syncPrompts().catch(report("prompts")),
			]);
			ctx.ui.notify("Bifrost sync complete.", "info");
		},
	});
}
