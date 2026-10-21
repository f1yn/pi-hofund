/**
 * Configuration, credentials, and Bifrost endpoint derivation.
 *
 * One module owns everything the extension must resolve before it can talk to
 * Bifrost: settings/env/argv/credential resolution, feature gating, request
 * headers, load-safe reads and writes of Pi's on-disk stores (`auth.json`,
 * `settings.json`), and URL derivation. All of it is pure or filesystem-only —
 * nothing here touches the network or a Pi action method.
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ApiKeyCredential } from "@earendil-works/pi-ai/compat";

/** Default catalog refresh cadence: six hours. */
export const DEFAULT_MODEL_TTL_MS = 6 * 60 * 60 * 1000;

/** User-facing notice sink, decoupled from any UI so modules stay testable. */
export type DiscoveryNotifier = (message: string, type?: "info" | "warning" | "error") => void;

/** Feature toggles. `models` is the core runtime and always on. */
export interface HofundFeatures {
	/** Always on; the provider is the extension's core. */
	models: true;
	/** Register the virtual key's MCP surface with Pi. */
	mcp: boolean;
	/** Sync the public skills bundle to disk. */
	skills: boolean;
	/** Sync the prompt repository to disk (management key required). */
	prompts: boolean;
}

/** Fully resolved runtime configuration. */
export interface HofundConfig {
	/** Normalized OpenAI-compatible Bifrost mount (`…/openai/v1`). */
	url: string;
	/** Optional API/auth key; the virtual key is separate. */
	apiKey?: string;
	/** Bifrost virtual key resolved from the credential store. */
	virtualKey: string;
	/** Management API key, when a management surface is enabled. */
	managementKey?: string;
	/** Feature toggles. */
	features: HofundFeatures;
	/** Catalog refresh cadence in milliseconds. */
	modelTtlMs: number;
	/** Restrict skills sync to this path inside the upstream zip, e.g. "pi". */
	zipPathPrefix?: string;
}

/** The `hofund` key shape in settings.json. */
export interface HofundSettings {
	/** Bifrost instance or OpenAI-compatible base URL. */
	url?: string;
	/** Optional API/auth key. */
	apiKey?: string;
	/** Last-resort virtual key; normally read from `auth.json`. */
	virtualKey?: string;
	/** Management API key for the prompt repository. */
	managementKey?: string;
	/** Opt-in feature toggles; all default OFF. */
	features?: {
		mcp?: boolean;
		skills?: boolean;
		prompts?: boolean;
	};
	/** Catalog refresh cadence in minutes (default 360). */
	modelTtlMinutes?: number;
	/** Restrict skills sync to assets under this zip path, e.g. "/pi/". */
	zipPathPrefix?: string;
}

/** Raw inputs to resolution; all optional so tests can inject each source. */
export interface ConfigInput {
	/** The `hofund` settings block. */
	settings?: HofundSettings;
	/** Process environment. */
	env?: NodeJS.ProcessEnv;
	/** CLI arguments. */
	argv?: readonly string[];
	/** Pi's stored `bifrost` credential (auth.json); the only VK source. */
	credential?: ApiKeyCredential;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

// Trimmed value, or undefined for empty/whitespace input.
function nonEmpty(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

// Normalize a zip path prefix: trim, strip surrounding slashes, empty → undefined.
function normalizePrefix(value: string | undefined): string | undefined {
	const trimmed = nonEmpty(value);
	if (!trimmed) return undefined;
	const normalized = trimmed.replace(/^\/+|\/+$/gu, "");
	return normalized.length > 0 ? normalized : undefined;
}

// Most-specific source wins.
function resolve3(
	argvValue: string | undefined,
	envValue: string | undefined,
	settingValue: string | undefined,
): string | undefined {
	return argvValue ?? envValue ?? settingValue;
}

/**
 * Read a CLI flag from argv, in either `--name value` or `--name=value` form.
 *
 * @param name - Flag name without the leading dashes.
 * @param argv - Arguments to scan; defaults to `process.argv.slice(2)`.
 * @returns The trimmed flag value, or `undefined` when absent or empty.
 * @remarks
 * A space-separated value beginning with `--` is treated as the next flag and
 * ignored, so such values must use the `--name=value` form.
 */
export function flagFromArgv(
	name: string,
	argv: readonly string[] = process.argv.slice(2),
): string | undefined {
	const flag = `--${name}`;
	let result: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument.startsWith(`${flag}=`)) {
			result = nonEmpty(argument.slice(flag.length + 1));
		} else if (argument === flag) {
			const next = argv[index + 1];
			if (next && !next.startsWith("--")) result = nonEmpty(next);
		}
	}
	return result;
}

/**
 * Resolve settings, environment, argv, and the stored credential into one
 * validated configuration.
 *
 * @param input - Optional source overrides; all default to live process state.
 * @returns The fully resolved {@link HofundConfig}.
 * @throws When no Bifrost URL or virtual key can be resolved, or the TTL is invalid.
 * @remarks
 * The virtual key is read from the credential store (or the settings/flag
 * fallback) and is never read from the environment.
 */
export function createHofundConfig(input: ConfigInput = {}): HofundConfig {
	const settings = input.settings ?? {};
	const env = input.env ?? process.env;
	const argv = input.argv ?? process.argv.slice(2);

	const credentialUrl = nonEmpty(input.credential?.env?.BIFROST_URL);
	const rawUrl =
		credentialUrl ??
		flagFromArgv("hofund-url", argv) ??
		nonEmpty(env.BIFROST_URL) ??
		nonEmpty(settings.url);
	if (!rawUrl) {
		throw new Error(
			"pi-hofund: no Bifrost URL configured (set hofund.url, BIFROST_URL, or --hofund-url)",
		);
	}

	// The virtual key comes from Pi's credential store (auth.json) after
	// `/login bifrost`. It is intentionally NOT read from the environment or
	// written to settings.json, so it never lands in a tracked file or a process
	// listing. A settings/flag value is accepted only as a last-resort fallback.
	const virtualKey =
		nonEmpty(input.credential?.env?.BIFROST_VIRTUAL_KEY) ??
		nonEmpty(settings.virtualKey) ??
		flagFromArgv("hofund-virtual-key", argv);
	if (!virtualKey) {
		throw new Error(
			"pi-hofund: no virtual key found (run `/login bifrost` to store it in auth.json)",
		);
	}

	const ttlMinutes = settings.modelTtlMinutes;
	if (ttlMinutes !== undefined && (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0)) {
		throw new Error("pi-hofund: modelTtlMinutes must be a positive number");
	}

	return {
		url: normalizeBifrostUrl(rawUrl),
		apiKey: resolve3(
			flagFromArgv("hofund-api-key", argv),
			nonEmpty(env.BIFROST_API_KEY),
			nonEmpty(settings.apiKey),
		),
		virtualKey,
		managementKey: nonEmpty(env.HOFUND_MANAGEMENT_KEY) ?? nonEmpty(settings.managementKey),
		features: {
			models: true,
			mcp: settings.features?.mcp === true,
			skills: settings.features?.skills === true,
			prompts: settings.features?.prompts === true,
		},
		modelTtlMs: ttlMinutes === undefined ? DEFAULT_MODEL_TTL_MS : ttlMinutes * 60 * 1000,
		zipPathPrefix: normalizePrefix(settings.zipPathPrefix),
	};
}

/**
 * Build the headers for the inference and MCP data plane.
 *
 * @param config - Resolved configuration.
 * @returns The `x-bf-vk` and `Authorization` headers.
 * @remarks
 * The placeholder Bearer keeps Pi from injecting a foreign default
 * Authorization; the virtual key is carried in `x-bf-vk`.
 */
export function bifrostHeaders(config: HofundConfig): Record<string, string> {
	return {
		"x-bf-vk": config.virtualKey,
		Authorization: `Bearer ${config.apiKey ?? "pi-hofund-keyless"}`,
	};
}

/**
 * Build the headers for management endpoints.
 *
 * @param config - Resolved configuration.
 * @returns The `Authorization` header carrying the management key.
 * @throws When no management key is configured.
 */
export function managementHeaders(config: HofundConfig): Record<string, string> {
	if (!config.managementKey) {
		throw new Error(
			"pi-hofund: this feature needs a management API key (set hofund.managementKey or HOFUND_MANAGEMENT_KEY)",
		);
	}
	return { Authorization: `Bearer ${config.managementKey}` };
}

// ---------------------------------------------------------------------------
// On-disk sources (load-safe)
// ---------------------------------------------------------------------------

/**
 * Resolve Pi's agent directory.
 *
 * @returns `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`.
 */
export function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	return override && override.length > 0 ? override : join(homedir(), ".pi", "agent");
}

/**
 * Read the `bifrost` API-key credential from Pi's credential store.
 *
 * @param dir - Agent directory holding `auth.json`; defaults to {@link agentDir}.
 * @returns The stored credential, or `undefined` when absent or malformed.
 */
export function readStoredCredential(dir: string = agentDir()): ApiKeyCredential | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")) as Record<
			string,
			unknown
		>;
		const entry = parsed["bifrost"];
		if (entry && typeof entry === "object" && (entry as { type?: unknown }).type === "api_key") {
			return entry as ApiKeyCredential;
		}
	} catch {
		// Missing or malformed store: treat as unconfigured and let the caller report.
	}
	return undefined;
}

/**
 * Read the `hofund` block from the user settings file.
 *
 * @param options - Optional agent directory override.
 * @returns The parsed `hofund` block, or `undefined` when absent or malformed.
 * @remarks
 * Only the user-level settings file is read; project `.pi/settings.json` is
 * intentionally ignored so project trust is never bypassed.
 */
export function readHofundSettings(options: { dir?: string } = {}): HofundSettings | undefined {
	const dir = options.dir ?? agentDir();
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as Record<
			string,
			unknown
		>;
		const hofund = parsed["hofund"];
		if (hofund && typeof hofund === "object" && !Array.isArray(hofund)) {
			return hofund as HofundSettings;
		}
	} catch {
		// Missing or malformed settings: treat as unconfigured.
	}
	return undefined;
}

/**
 * Persist a `hofund` patch to the user settings file.
 *
 * @param patch - Keys to merge into the existing `hofund` block.
 * @param options - Optional agent directory override.
 * @returns The merged `hofund` block that was written.
 * @remarks
 * Every other settings key is preserved and the file is written atomically
 * (temp + rename). Pi exposes no API for arbitrary settings keys, so the
 * `/bifrost:settings` command uses this direct read-modify-write.
 */
export async function writeHofundSettings(
	patch: Partial<HofundSettings>,
	options: { dir?: string } = {},
): Promise<HofundSettings> {
	const dir = options.dir ?? agentDir();
	const path = join(dir, "settings.json");
	let current: Record<string, unknown> = {};
	try {
		current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	} catch {
		current = {};
	}
	const existing = current["hofund"];
	const base =
		existing && typeof existing === "object" && !Array.isArray(existing)
			? (existing as HofundSettings)
			: {};
	const merged: HofundSettings = { ...base, ...patch };
	current["hofund"] = merged;
	await mkdir(dir, { recursive: true });
	const temporary = `${path}.tmp`;
	await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`);
	await rename(temporary, path);
	return merged;
}

// ---------------------------------------------------------------------------
// Bifrost endpoints
// ---------------------------------------------------------------------------

// Trim, validate, and parse a user-supplied Bifrost URL. Internal helper.
function parseInstanceUrl(value: string): URL {
	const input = value.trim();
	if (!input) throw new Error("BIFROST_URL is required");

	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new Error(`Invalid BIFROST_URL: ${value}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("BIFROST_URL must use http:// or https://");
	}
	if (parsed.search || parsed.hash) {
		throw new Error("BIFROST_URL must not contain a query string or fragment");
	}
	return parsed;
}

/**
 * Normalize any accepted Bifrost URL into the OpenAI-compatible mount.
 *
 * @param value - User-supplied Bifrost URL.
 * @returns The URL ending in `/openai/v1` (or `/v1` when already present).
 * @throws When the URL is empty, malformed, non-HTTP, or carries a query/fragment.
 * @remarks
 * Deep links such as `/models` or `/chat/completions` are trimmed back to the mount.
 */
export function normalizeBifrostUrl(value: string): string {
	const parsed = parseInstanceUrl(value);
	let path = parsed.pathname.replace(/\/+$/u, "");
	path = path.replace(/\/(?:chat\/completions|models)$/u, "");
	if (!/\/v1$/u.test(path)) {
		path = /\/openai$/u.test(path) ? `${path}/v1` : `${path}/openai/v1`;
	}
	parsed.pathname = path;
	return parsed.toString().replace(/\/$/u, "");
}

/**
 * Derive the rich OpenRouter-style catalog base from a Bifrost URL.
 *
 * @param url - Any accepted Bifrost URL.
 * @returns The catalog base ending in `/v1`.
 * @remarks
 * Given `https://host/openai/v1` this returns `https://host/v1`.
 */
export function richCatalogUrl(url: string): string {
	return normalizeBifrostUrl(url).replace(/\/openai\/v1$/u, "/v1");
}

/**
 * Derive the Bifrost instance root from a Bifrost URL.
 *
 * @param url - Any accepted Bifrost URL.
 * @returns The instance root with any API mount stripped.
 */
export function gatewayRootUrl(url: string): string {
	return normalizeBifrostUrl(url)
		.replace(/\/openai\/v1$/u, "")
		.replace(/\/v1$/u, "")
		.replace(/\/openai$/u, "");
}

/**
 * Build the MCP gateway endpoint exposing the virtual key's whole tool union.
 *
 * @param url - Any accepted Bifrost URL.
 * @returns The `/mcp` gateway URL.
 */
export function mcpGatewayUrl(url: string): string {
	return `${gatewayRootUrl(url)}/mcp`;
}

/**
 * Build a Virtual MCP endpoint for a curated tool bundle.
 *
 * @param url - Any accepted Bifrost URL.
 * @param slug - Virtual MCP slug.
 * @returns The `/mcp/<slug>` endpoint URL.
 */
export function virtualMcpUrl(url: string, slug: string): string {
	return `${gatewayRootUrl(url)}/mcp/${encodeURIComponent(slug)}`;
}

/**
 * Build the public skills archive URL.
 *
 * @param url - Any accepted Bifrost URL.
 * @param skill - Skill name, or omitted for the bundle of every skill.
 * @returns The download URL for the ZIP archive.
 */
export function skillsZipUrl(url: string, skill?: string): string {
	const target = skill === undefined ? "all" : encodeURIComponent(skill);
	return `${gatewayRootUrl(url)}/api/skills/serve/${target}/download.zip`;
}

/**
 * Build a management prompt-repository endpoint.
 *
 * @param url - Any accepted Bifrost URL.
 * @param parts - Path segments appended after `/api/prompt-repo/`.
 * @returns The management endpoint URL.
 */
export function promptRepoUrl(url: string, ...parts: string[]): string {
	return `${gatewayRootUrl(url)}/api/prompt-repo/${parts.join("/")}`;
}
