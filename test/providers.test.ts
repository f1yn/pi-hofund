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
import {
	OPENCODE_SESSION_HEADER,
	processHeaders as opencodeProcessHeaders,
} from "../src/providers/opencode-go.ts";
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
		const headers = function (): void {};
		const incoming = function (event: AssistantMessageEvent): AssistantMessageEvent {
			return event;
		};
		const fakeImport: ImportModule = async function (url) {
			if (url.endsWith("opencode-go.ts")) {
				return { processHeaders: headers, processOutgoing: outgoing, processIncoming: incoming };
			}
			if (url.endsWith("only-outgoing.ts")) return { processOutgoing: outgoing };
			if (url.endsWith("only-headers.ts")) return { processHeaders: headers };
			if (url.endsWith("empty.ts")) return {};
			throw new Error(`unexpected import: ${url}`);
		};

		const loaded = await loadUpstreamOverrides(providersDir, fakeImport);
		expect([...loaded.keys()].sort()).toEqual(["only-headers", "only-outgoing", "opencode-go"]);
		expect(loaded.get("opencode-go")?.processHeaders).toBeTypeOf("function");
		expect(loaded.get("opencode-go")?.processOutgoing).toBeTypeOf("function");
		expect(loaded.get("opencode-go")?.processIncoming).toBeTypeOf("function");
		expect(loaded.get("only-outgoing")?.processHeaders).toBeUndefined();
		expect(loaded.get("only-headers")?.processOutgoing).toBeUndefined();
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

	it("runs the header hook with the session id and bypasses a throwing one", async function () {
		const overrides = new Map<string, UpstreamOverride>([
			[
				"opencode-go",
				{
					processHeaders: function (headers, meta) {
						headers.set("x-upstream", meta.upstream);
						if (meta.sessionId) headers.set("x-session", meta.sessionId);
					},
				},
			],
			[
				"openrouter",
				{
					processHeaders: function () {
						throw new Error("header boom");
					},
				},
			],
		]);
		const notices: string[] = [];
		const dispatch = createUpstreamDispatch(overrides, function (msg) {
			notices.push(msg);
		});

		const hooked = await dispatch.runHeaders(makeModel("opencode-go/x"), new Headers(), "sess-1");
		expect(hooked.get("x-upstream")).toBe("opencode-go");
		expect(hooked.get("x-session")).toBe("sess-1");

		const passthrough = await dispatch.runHeaders(
			makeModel("moonshotai/kimi-k3"),
			new Headers({ existing: "1" }),
			"sess-1",
		);
		expect(passthrough.get("existing")).toBe("1");
		expect([...passthrough.keys()]).toEqual(["existing"]);

		const survived = await dispatch.runHeaders(makeModel("openrouter/x"), new Headers(), "sess-1");
		expect([...survived.keys()]).toEqual([]);
		expect(notices.join(" ")).toContain("processHeaders failed");
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

	it("applies the header hook and keeps the adapter's own headers", async function () {
		const overrides = new Map<string, UpstreamOverride>([
			["opencode-go", { processHeaders: opencodeProcessHeaders }],
		]);
		const dispatch = createUpstreamDispatch(overrides);
		let captured: Headers | undefined;
		const baseFetch: typeof fetch = async function (_input, init) {
			captured = new Headers(init?.headers);
			return new Response("");
		};

		const wrapped = wrapUpstreamFetch(baseFetch, dispatch, makeModel("opencode-go/x"), "sess-42");
		await wrapped("https://host/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messages: [] }),
		});

		expect(captured?.get(OPENCODE_SESSION_HEADER)).toBe("sess-42");
		expect(captured?.get("content-type")).toBe("application/json");
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

	it("hands the session id to the incoming hook", async function () {
		const seen: Array<string | undefined> = [];
		const overrides = new Map<string, UpstreamOverride>([
			[
				"opencode-go",
				{
					processIncoming: function (event, meta) {
						seen.push(meta.sessionId);
						return event;
					},
				},
			],
		]);
		const dispatch = createUpstreamDispatch(overrides);
		const base = createAssistantMessageEventStream();
		const wrapped = wrapIncomingStream(base, dispatch, makeModel("opencode-go/x"), "sess-7");

		base.push(makeEvent("text_delta"));
		base.end();
		for await (const _event of wrapped) {
			// Drain.
		}

		expect(seen).toEqual(["sess-7"]);
	});
});

describe("opencode-go override", function () {
	it("attaches the Bifrost extra header carrying the Pi session id", async function () {
		const headers = new Headers();
		await opencodeProcessHeaders(headers, {
			upstream: "opencode-go",
			model: makeModel("opencode-go/kimi-k3"),
			sessionId: "pi-session-7",
		});

		expect(OPENCODE_SESSION_HEADER).toBe("x-bf-eh-x-opencode-session");
		expect(headers.get("x-bf-eh-x-opencode-session")).toBe("pi-session-7");
	});

	it("leaves headers untouched without a session id", async function () {
		const headers = new Headers({ existing: "1" });
		await opencodeProcessHeaders(headers, {
			upstream: "opencode-go",
			model: makeModel("opencode-go/kimi-k3"),
		});

		expect([...headers.keys()]).toEqual(["existing"]);
	});
});
