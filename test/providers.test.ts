import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAssistantMessageEventStream,
	type AssistantMessageEvent,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	createUpstreamDispatch,
	type ImportModule,
	loadUpstreamOverrides,
	wrapIncomingStream,
	wrapUpstreamFetch,
} from "../src/providers/registry.ts";
import type { UpstreamOverride } from "../src/providers/registry.ts";

const providersDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "providers");

function makeModel(id: string): Model<"openai-completions"> {
	return { id, provider: "bifrost" } as unknown as Model<"openai-completions">;
}

/** Minimal typed event for tests that only care about identity. */
function makeEvent(type: string): AssistantMessageEvent {
	return { type, contentIndex: 0, delta: "x" } as unknown as AssistantMessageEvent;
}

describe("loadUpstreamOverrides", function () {
	it("discovers both-hook and single-hook files, skipping shared/ and .d.ts", async function () {
		const outgoing = function (): void {};
		const incoming = function (event: AssistantMessageEvent): AssistantMessageEvent {
			return event;
		};
		const fakeImport: ImportModule = async function (url) {
			if (url.endsWith("opencode-go.ts")) {
				return { processOutgoing: outgoing, processIncoming: incoming };
			}
			if (url.endsWith("only-outgoing.ts")) return { processOutgoing: outgoing };
			if (url.endsWith("empty.ts")) return {};
			throw new Error(`unexpected import: ${url}`);
		};

		const loaded = await loadUpstreamOverrides(providersDir, fakeImport);
		expect([...loaded.keys()].sort()).toEqual(["only-outgoing", "opencode-go"]);
		expect(loaded.get("opencode-go")?.processOutgoing).toBeTypeOf("function");
		expect(loaded.get("opencode-go")?.processIncoming).toBeTypeOf("function");
		expect(loaded.get("only-outgoing")?.processIncoming).toBeUndefined();
		expect(loaded.has("types")).toBe(false);
		expect(loaded.has("shared")).toBe(false);
	});
});

describe("createUpstreamDispatch", function () {
	it("selects by the first path segment and passes through unknown upstreams", async function () {
		const calls: string[] = [];
		const overrides = new Map<string, UpstreamOverride>([
			[
				"opencode-go",
				{
					processOutgoing: function (body) {
						calls.push("out");
						body.touched = true;
					},
					processIncoming: function () {
						calls.push("in");
					},
				},
			],
		]);
		const dispatch = createUpstreamDispatch(overrides);

		const outgoing = await dispatch.runOutgoing(makeModel("opencode-go/deepseek-v4.1-flash"), {
			model: "x",
		});
		expect(outgoing.touched).toBe(true);

		const passthrough = await dispatch.runOutgoing(makeModel("openrouter/moonshotai/kimi-k3"), {
			model: "x",
		});
		expect(passthrough).toEqual({ model: "x" });

		const event = makeEvent("text_delta");
		expect(await dispatch.runIncoming(makeModel("opencode-go/x"), event)).toBe(event);
		expect(calls.filter((call) => call === "out")).toHaveLength(1);
		expect(calls).toContain("in");
	});

	it("honors a returned replacement and catches a throwing hook", async function () {
		const notices: string[] = [];
		const overrides = new Map<string, UpstreamOverride>([
			[
				"opencode-go",
				{
					processOutgoing: function () {
						return { replaced: true };
					},
				},
			],
			[
				"openrouter",
				{
					processOutgoing: function () {
						throw new Error("boom");
					},
				},
			],
		]);
		const dispatch = createUpstreamDispatch(overrides, function (msg, type) {
			notices.push(`${type ?? "info"}:${msg}`);
		});

		expect(await dispatch.runOutgoing(makeModel("opencode-go/x"), { a: 1 })).toEqual({
			replaced: true,
		});
		expect(await dispatch.runOutgoing(makeModel("openrouter/x"), { a: 1 })).toEqual({ a: 1 });
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("warning");
		expect(notices[0]).toContain("boom");
	});
});

describe("wrapUpstreamFetch", function () {
	it("round-trips a JSON body through processOutgoing and forwards the response", async function () {
		const overrides = new Map<string, UpstreamOverride>([
			[
				"opencode-go",
				{
					processOutgoing: function (body) {
						body.messages = ["changed"];
					},
				},
			],
		]);
		const dispatch = createUpstreamDispatch(overrides);

		let captured: unknown;
		const baseFetch: typeof fetch = async function (_input, init) {
			captured = JSON.parse(String(init?.body));
			return new Response("ok", { status: 200 });
		};

		const wrapped = wrapUpstreamFetch(baseFetch, dispatch, makeModel("opencode-go/x"));
		const response = await wrapped("https://host/chat/completions", {
			method: "POST",
			body: JSON.stringify({ messages: ["orig"] }),
		});
		expect(await response.text()).toBe("ok");
		expect(captured).toEqual({ messages: ["changed"] });
	});

	it("passes a non-JSON body through untouched", async function () {
		const seen: string[] = [];
		const baseFetch: typeof fetch = async function (_input, init) {
			seen.push(String(init?.body));
			return new Response("");
		};
		const wrapped = wrapUpstreamFetch(
			baseFetch,
			createUpstreamDispatch(new Map()),
			makeModel("opencode-go/x"),
		);
		await wrapped("https://host", { method: "POST", body: "plain" });
		expect(seen).toEqual(["plain"]);
	});
});

describe("wrapIncomingStream", function () {
	it("applies processIncoming to every event and ends the wrapper", async function () {
		const overrides = new Map<string, UpstreamOverride>([
			[
				"opencode-go",
				{
					processIncoming: function (event) {
						return { ...event, marker: true } as unknown as AssistantMessageEvent;
					},
				},
			],
		]);
		const dispatch = createUpstreamDispatch(overrides);
		const base = createAssistantMessageEventStream();
		const wrapped = wrapIncomingStream(base, dispatch, makeModel("opencode-go/x"));

		base.push(makeEvent("text_delta"));
		base.push({ type: "done", reason: "stop", message: {} } as unknown as AssistantMessageEvent);
		base.end();

		const events: AssistantMessageEvent[] = [];
		for await (const event of wrapped) events.push(event);

		expect(events).toHaveLength(2);
		expect((events[0] as { marker?: boolean }).marker).toBe(true);
		expect((events[1] as { marker?: boolean }).marker).toBe(true);
	});
});
