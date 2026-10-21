import { describe, expect, it } from "vitest";
import {
	gatewayRootUrl,
	mcpGatewayUrl,
	normalizeBifrostUrl,
	promptRepoUrl,
	richCatalogUrl,
	skillsZipUrl,
	virtualMcpUrl,
} from "../src/config.ts";

describe("normalizeBifrostUrl", function () {
	it("preserves an OpenAI mount and a bare /v1", function () {
		expect(normalizeBifrostUrl("https://ai.home.rutledge.ltd/openai/v1")).toBe(
			"https://ai.home.rutledge.ltd/openai/v1",
		);
		expect(normalizeBifrostUrl("https://host/v1")).toBe("https://host/v1");
	});

	it("appends the OpenAI mount to a bare host, trailing slash, or /openai", function () {
		expect(normalizeBifrostUrl("https://host")).toBe("https://host/openai/v1");
		expect(normalizeBifrostUrl("https://host/")).toBe("https://host/openai/v1");
		expect(normalizeBifrostUrl("https://host/openai")).toBe("https://host/openai/v1");
	});

	it("trims deep links back to the mount", function () {
		expect(normalizeBifrostUrl("https://host/openai/v1/models")).toBe("https://host/openai/v1");
		expect(normalizeBifrostUrl("https://host/openai/v1/chat/completions")).toBe(
			"https://host/openai/v1",
		);
	});

	it("rejects unsupported schemes, query strings, fragments, and empty input", function () {
		expect(function () {
			normalizeBifrostUrl("ftp://host");
		}).toThrow(/http/);
		expect(function () {
			normalizeBifrostUrl("https://host?x=1");
		}).toThrow(/query string/);
		expect(function () {
			normalizeBifrostUrl("https://host#frag");
		}).toThrow(/query string/);
		expect(function () {
			normalizeBifrostUrl("   ");
		}).toThrow(/required/);
	});
});

describe("derived endpoints", function () {
	const base = "https://ai.home.rutledge.ltd/openai/v1";

	it("derives the rich catalog, root, and MCP URLs", function () {
		expect(richCatalogUrl(base)).toBe("https://ai.home.rutledge.ltd/v1");
		expect(gatewayRootUrl(base)).toBe("https://ai.home.rutledge.ltd");
		expect(mcpGatewayUrl(base)).toBe("https://ai.home.rutledge.ltd/mcp");
		expect(virtualMcpUrl(base, "support-tools")).toBe(
			"https://ai.home.rutledge.ltd/mcp/support-tools",
		);
	});

	it("keeps paths when the mount sits behind a prefix", function () {
		const prefixed = "https://example.com/gateway/openai/v1";
		expect(richCatalogUrl(prefixed)).toBe("https://example.com/gateway/v1");
		expect(gatewayRootUrl(prefixed)).toBe("https://example.com/gateway");
		expect(richCatalogUrl("https://host/v1")).toBe("https://host/v1");
		expect(gatewayRootUrl("https://host/v1")).toBe("https://host");
	});

	it("derives skills and prompt-repository URLs", function () {
		expect(skillsZipUrl(base)).toBe(
			"https://ai.home.rutledge.ltd/api/skills/serve/all/download.zip",
		);
		expect(skillsZipUrl(base, "pdf-tools")).toBe(
			"https://ai.home.rutledge.ltd/api/skills/serve/pdf-tools/download.zip",
		);
		expect(promptRepoUrl(base, "prompts")).toBe(
			"https://ai.home.rutledge.ltd/api/prompt-repo/prompts",
		);
		expect(promptRepoUrl(base, "prompts", "abc")).toBe(
			"https://ai.home.rutledge.ltd/api/prompt-repo/prompts/abc",
		);
	});
});
