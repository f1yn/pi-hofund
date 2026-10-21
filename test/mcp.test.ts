import { describe, expect, it } from "vitest";
import { createHofundConfig } from "../src/config.ts";
import {
	type McpServerConfig,
	type RegisterMcpServer,
	type UnregisterMcpServer,
	createMcpRegistrar,
} from "../src/mcp.ts";

function makeConfig() {
	return createHofundConfig({
		settings: { url: "https://host", virtualKey: "vk" },
		env: {},
		argv: [],
	});
}

function capture(): {
	servers: Map<string, McpServerConfig>;
	registerServer: RegisterMcpServer;
	unregistered: string[];
	unregisterServer: UnregisterMcpServer;
} {
	const servers = new Map<string, McpServerConfig>();
	const unregistered: string[] = [];
	return {
		servers,
		registerServer: function (name, config) {
			servers.set(name, config);
		},
		unregistered,
		unregisterServer: function (name) {
			unregistered.push(name);
		},
	};
}

describe("createMcpRegistrar", function () {
	it("registers one server per virtual MCP slug with vk headers", async function () {
		let requestedUrl: string | undefined;
		const fetchImpl: typeof fetch = async function (input) {
			requestedUrl = String(input);
			return new Response(
				JSON.stringify({ virtual_mcps: [{ slug: "support-tools" }, { endpoint_slug: "docs" }] }),
				{ status: 200 },
			);
		};
		const registrar = createMcpRegistrar(makeConfig(), { fetch: fetchImpl });
		const cap = capture();

		const count = await registrar.register(cap.registerServer);

		expect(requestedUrl).toBe("https://host/api/mcp/virtual-mcps");
		expect(count).toBe(2);
		expect([...cap.servers.keys()].sort()).toEqual(["hofund-docs", "hofund-support-tools"]);
		expect(cap.servers.get("hofund-docs")?.url).toBe("https://host/mcp/docs");
		expect(cap.servers.get("hofund-docs")?.headers["x-bf-vk"]).toBe("vk");
		expect(cap.servers.get("hofund-support-tools")?.url).toBe("https://host/mcp/support-tools");
	});

	it("accepts a bare array of slugs", async function () {
		const fetchImpl: typeof fetch = async function () {
			return new Response(JSON.stringify(["a", "b"]), { status: 200 });
		};
		const registrar = createMcpRegistrar(makeConfig(), { fetch: fetchImpl });
		const cap = capture();

		await registrar.register(cap.registerServer);

		expect([...cap.servers.keys()].sort()).toEqual(["hofund-a", "hofund-b"]);
	});

	it("falls back to the whole-key gateway when enumeration fails or is empty", async function () {
		const cases: Array<() => Response> = [
			function () {
				return new Response("", { status: 401 });
			},
			function () {
				return new Response("", { status: 500 });
			},
			function () {
				return new Response("<html>not json</html>", { status: 200 });
			},
			function () {
				return new Response(JSON.stringify({ virtual_mcps: [] }), { status: 200 });
			},
		];

		for (const makeResponse of cases) {
			const notices: string[] = [];
			const fetchImpl: typeof fetch = async function () {
				return makeResponse();
			};
			const registrar = createMcpRegistrar(makeConfig(), {
				fetch: fetchImpl,
				notify: function (msg) {
					notices.push(msg);
				},
			});
			const cap = capture();

			const count = await registrar.register(cap.registerServer);

			expect(count).toBe(1);
			expect([...cap.servers.keys()]).toEqual(["hofund"]);
			expect(cap.servers.get("hofund")?.url).toBe("https://host/mcp");
			expect(cap.servers.get("hofund")?.headers["x-bf-vk"]).toBe("vk");
			expect(notices).toHaveLength(1);
		}
	});

	it("unregisters registered servers and is idempotent", async function () {
		const fetchImpl: typeof fetch = async function () {
			return new Response(JSON.stringify({ virtual_mcps: [{ slug: "x" }] }), { status: 200 });
		};
		const registrar = createMcpRegistrar(makeConfig(), { fetch: fetchImpl });
		const cap = capture();

		await registrar.register(cap.registerServer);
		registrar.unregisterAll(cap.unregisterServer);
		registrar.unregisterAll(cap.unregisterServer);

		expect(cap.unregistered).toEqual(["hofund-x"]);
	});
});
