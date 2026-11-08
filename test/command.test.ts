import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { type SyncController, registerReloadCommand } from "../src/command.ts";

interface CapturedCommand {
	name: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function captureRegistrations(): { pi: ExtensionAPI; commands: CapturedCommand[] } {
	const commands: CapturedCommand[] = [];
	const pi = {
		registerCommand: function (name: string, options: { handler: CapturedCommand["handler"] }) {
			commands.push({ name, handler: options.handler });
		},
	} as unknown as ExtensionAPI;
	return { pi, commands };
}

function makeContext(): {
	ctx: ExtensionCommandContext;
	notices: string[];
	refreshes: Array<{ providers: readonly string[]; force: boolean | undefined }>;
} {
	const notices: string[] = [];
	const refreshes: Array<{ providers: readonly string[]; force: boolean | undefined }> = [];
	const ctx = {
		mode: "tui",
		ui: {
			notify: function (message: string) {
				notices.push(message);
			},
		},
		modelRegistry: {
			refresh: async function (options: { providers?: readonly string[]; force?: boolean }) {
				refreshes.push({ providers: options.providers ?? [], force: options.force });
				return { aborted: false, errors: new Map() };
			},
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notices, refreshes };
}

describe("registerReloadCommand", function () {
	it("runs every sync with a forced model refresh", async function () {
		const calls: string[] = [];
		const controller: SyncController = {
			syncMcp: async function () {
				calls.push("mcp");
				return 0;
			},
			syncSkills: async function () {
				calls.push("skills");
			},
			syncPrompts: async function () {
				calls.push("prompts");
			},
		};
		const { pi, commands } = captureRegistrations();
		registerReloadCommand(pi, function () {
			return controller;
		});
		const { ctx, notices, refreshes } = makeContext();

		expect(commands[0]?.name).toBe("bifrost:reload");
		await commands[0]?.handler("", ctx);

		expect(calls.sort()).toEqual(["mcp", "prompts", "skills"]);
		expect(refreshes).toEqual([{ providers: ["bifrost"], force: true }]);
		expect(notices.join(" ")).toContain("complete");
	});

	it("reports when the extension is not configured", async function () {
		const { pi, commands } = captureRegistrations();
		registerReloadCommand(pi, function () {
			return undefined;
		});
		const { ctx, notices } = makeContext();

		await commands[0]?.handler("", ctx);

		expect(notices.join(" ")).toContain("not configured");
	});
});
