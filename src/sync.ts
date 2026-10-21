/**
 * Bifrost asset sync — skills and prompts.
 *
 * Pi discovers skills and prompt templates from disk, so this module
 * materializes Bifrost's surfaces locally:
 *
 * - **skills**: downloads the public ZIP bundle and writes each skill atomically
 *   as a flat directory under `~/.pi/agent/skills/`;
 * - **prompts**: projects the prompt repository's latest versions into
 *   `~/.pi/agent/prompts/bifrost/` (one-way, lossy; `model_params` are metadata
 *   only and never injected into requests).
 *
 * Every generated file carries a `managed-by: pi-hofund` front-matter marker; an
 * existing file without the marker is treated as user-defined and is never
 * overwritten or removed. Orphan cleanup is manifest-driven and never touches
 * files it did not write. Generic text/archive helpers live in `src/shared/`.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	type DiscoveryNotifier,
	type HofundConfig,
	managementHeaders,
	promptRepoUrl,
	skillsZipUrl,
} from "./config.ts";
import { MANAGED_MARKER, ensureManagedFrontMatter, isManaged } from "./shared/frontmatter.ts";
import { readZipEntries } from "./shared/zip.ts";

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** Outcome of one skills sync. */
export interface SkillsSyncResult {
	/** Skills written this run. */
	synced: number;
	/** Previously-managed skills removed because the payload dropped them. */
	removed: number;
	/** User-defined skills left untouched. */
	preserved: number;
}

/** Skills sync contract returned by {@link createSkillsSyncer}. */
export interface SkillsSyncer {
	/** Download and materialize skills, or `undefined` when the feature is off. */
	sync(): Promise<SkillsSyncResult | undefined>;
}

/** Injectable dependencies for {@link createSkillsSyncer}. */
export interface SkillsSyncerOptions {
	fetch?: typeof fetch;
	skillsRoot?: string;
	notify?: DiscoveryNotifier;
}

interface SkillsManifest {
	version: string;
	syncedAt: number;
	skills: string[];
	preserved?: string[];
}

interface SkillFile {
	path: string;
	data: Uint8Array;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

// Keep only entries under `<prefix>/`, stripping the prefix, when configured.
function scopeToPrefix(
	files: Map<string, Uint8Array>,
	prefix: string | undefined,
): Map<string, Uint8Array> {
	if (prefix === undefined) return files;
	const scoped = new Map<string, Uint8Array>();
	for (const [entryPath, data] of files) {
		if (entryPath.startsWith(`${prefix}/`)) {
			scoped.set(entryPath.slice(prefix.length + 1), data);
		}
	}
	return scoped;
}

// Group archive entries into skills by the directory holding each `SKILL.md`.
function groupSkills(files: Map<string, Uint8Array>): Map<string, SkillFile[]> {
	const dirs = new Map<string, string>();
	for (const entryPath of files.keys()) {
		if (!entryPath.endsWith("SKILL.md")) continue;
		const skillDir = entryPath.slice(0, entryPath.length - "SKILL.md".length).replace(/\/$/u, "");
		if (!skillDir) continue; // a root-level SKILL.md names no skill directory
		const name = skillDir.split("/").pop();
		if (name) dirs.set(skillDir, name);
	}

	const skills = new Map<string, SkillFile[]>();
	for (const [skillDir, name] of dirs) {
		const prefix = `${skillDir}/`;
		const entries: SkillFile[] = [];
		for (const [entryPath, data] of files) {
			if (entryPath.startsWith(prefix)) {
				entries.push({ path: entryPath.slice(prefix.length), data });
			}
		}
		skills.set(name, entries);
	}
	return skills;
}

// Inject the managed marker into a skill's `SKILL.md`; other files pass through.
function withManagedMarker(entries: SkillFile[]): SkillFile[] {
	return entries.map((entry) => {
		if (entry.path !== "SKILL.md") return entry;
		const text = new TextDecoder().decode(entry.data);
		return { path: entry.path, data: new TextEncoder().encode(ensureManagedFrontMatter(text)) };
	});
}

/**
 * Create the opt-in skills syncer.
 *
 * @param config - Resolved configuration; the `skills` feature must be enabled.
 * @param options - Optional transport, root directory, and notice sink.
 * @returns A syncer whose `sync()` returns `undefined` when the feature is off.
 */
export function createSkillsSyncer(
	config: HofundConfig,
	options: SkillsSyncerOptions = {},
): SkillsSyncer {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const skillsRoot = options.skillsRoot ?? join(homedir(), ".pi", "agent", "skills");
	const managedRoot = skillsRoot;
	const legacyRoot = join(skillsRoot, "bifrost");
	const stagingRoot = join(skillsRoot, ".hofund-staging");
	const manifestPath = join(managedRoot, ".hofund-manifest.json");

	async function readManifest(): Promise<SkillsManifest | undefined> {
		try {
			return JSON.parse(await readFile(manifestPath, "utf8")) as SkillsManifest;
		} catch {
			return undefined;
		}
	}

	async function writeManifest(manifest: SkillsManifest): Promise<void> {
		await mkdir(managedRoot, { recursive: true });
		const temporary = `${manifestPath}.tmp`;
		await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
		await rename(temporary, manifestPath);
	}

	// The existing `SKILL.md` for a skill, or undefined when the skill is new.
	async function readExistingSkill(name: string): Promise<string | undefined> {
		try {
			return await readFile(join(managedRoot, name, "SKILL.md"), "utf8");
		} catch {
			return undefined;
		}
	}

	// Stage one skill, then swap it into place so readers never see a partial skill.
	async function materialize(name: string, entries: SkillFile[]): Promise<void> {
		const staging = join(stagingRoot, name);
		await rm(staging, { recursive: true, force: true });
		for (const entry of entries) {
			const destination = join(staging, entry.path);
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, entry.data);
		}
		await mkdir(managedRoot, { recursive: true });
		const target = join(managedRoot, name);
		await rm(target, { recursive: true, force: true });
		await rename(staging, target);
	}

	// Remove the pre-flat `skills/bifrost/` layout, but only managed skills.
	async function retireLegacyRoot(): Promise<void> {
		const legacyManifestPath = join(legacyRoot, ".hofund-manifest.json");
		let legacy: SkillsManifest;
		try {
			legacy = JSON.parse(await readFile(legacyManifestPath, "utf8")) as SkillsManifest;
		} catch {
			return;
		}

		let kept = false;
		for (const name of legacy.skills ?? []) {
			let existing: string | undefined;
			try {
				existing = await readFile(join(legacyRoot, name, "SKILL.md"), "utf8");
			} catch {
				existing = undefined;
			}
			if (existing !== undefined && !isManaged(existing)) {
				kept = true;
				continue;
			}
			await rm(join(legacyRoot, name), { recursive: true, force: true });
		}

		if (kept) return;
		await rm(legacyManifestPath, { force: true });
		await rmdir(legacyRoot).catch(() => undefined);
	}

	async function sync(): Promise<SkillsSyncResult | undefined> {
		if (!config.features.skills) return undefined;

		const response = await fetchImpl(skillsZipUrl(config.url));
		if (!response.ok) {
			options.notify?.(`Bifrost skills download failed (${response.status})`, "warning");
			return undefined;
		}

		const zipBytes = new Uint8Array(await response.arrayBuffer());
		const version = sha256(zipBytes).slice(0, 16);
		const previous = await readManifest();
		if (previous?.version === version) {
			await retireLegacyRoot();
			return { synced: 0, removed: 0, preserved: 0 };
		}

		const skills = groupSkills(scopeToPrefix(readZipEntries(zipBytes), config.zipPathPrefix));

		// A skill whose existing SKILL.md lacks the marker is user-defined: keep it.
		const writable = new Map<string, SkillFile[]>();
		const preserved: string[] = [];
		for (const [name, entries] of skills) {
			const existing = await readExistingSkill(name);
			if (existing !== undefined && !isManaged(existing)) {
				preserved.push(name);
				continue;
			}
			writable.set(name, entries);
		}

		await mkdir(stagingRoot, { recursive: true });
		let synced = 0;
		try {
			for (const [name, entries] of writable) {
				await materialize(name, withManagedMarker(entries));
				synced += 1;
			}
		} finally {
			await rm(stagingRoot, { recursive: true, force: true });
		}

		// Remove only what a previous run of ours wrote and this payload dropped.
		// A dropped skill the user has since edited (no marker) is preserved.
		let removed = 0;
		for (const name of previous?.skills ?? []) {
			if (skills.has(name) || preserved.includes(name)) continue;
			const existing = await readExistingSkill(name);
			if (existing !== undefined && !isManaged(existing)) {
				preserved.push(name);
				continue;
			}
			await rm(join(managedRoot, name), { recursive: true, force: true });
			removed += 1;
		}

		await retireLegacyRoot();
		await writeManifest({
			version,
			syncedAt: Date.now(),
			skills: [...writable.keys()],
			preserved,
		});
		return { synced, removed, preserved: preserved.length };
	}

	return { sync };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** Outcome of one prompts sync. */
export interface PromptsSyncResult {
	/** Prompts written this run. */
	synced: number;
	/** Previously-managed prompts removed because the payload dropped them. */
	removed: number;
	/** User-defined prompts left untouched. */
	preserved: number;
}

/** Prompts sync contract returned by {@link createPromptsSyncer}. */
export interface PromptsSyncer {
	/** Download and materialize prompts, or `undefined` when off/unkeyed. */
	sync(): Promise<PromptsSyncResult | undefined>;
}

/** Injectable dependencies for {@link createPromptsSyncer}. */
export interface PromptsSyncerOptions {
	fetch?: typeof fetch;
	promptsRoot?: string;
	notify?: DiscoveryNotifier;
}

// One entry from `GET /api/prompt-repo/prompts`.
interface PromptVersionMessage {
	id?: number;
	order_index?: number;
	message?: Record<string, unknown>;
}

interface PromptVersion {
	id?: number;
	version_number?: number;
	commit_message?: string;
	model_params?: Record<string, unknown>;
	provider?: string;
	model?: string;
	is_latest?: boolean;
	messages?: PromptVersionMessage[];
}

interface Prompt {
	id?: string;
	name?: string;
	latest_version?: PromptVersion;
}

interface PromptsManifest {
	syncedAt: number;
	prompts: string[];
	preserved?: string[];
}

// Kebab-case a prompt name into a stable file name.
function slugify(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	return slug || "prompt";
}

// Double-quoted YAML scalar that is always valid, regardless of content.
function yamlString(value: string): string {
	return JSON.stringify(value);
}

function messageRole(message: Record<string, unknown> | undefined): string {
	const role = message?.role;
	return typeof role === "string" ? role : "message";
}

// Extract text from a message whose `content` is a string or text parts.
function messageText(message: Record<string, unknown> | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
					? (part as { text: string }).text
					: "",
			)
			.join("");
	}
	return "";
}

// Render one prompt's latest version as a markdown prompt template.
function renderPrompt(prompt: Prompt): string {
	const version = prompt.latest_version;
	const messages = [...(version?.messages ?? [])].sort(
		(left, right) => (left.order_index ?? 0) - (right.order_index ?? 0),
	);
	const description = [prompt.name, version?.commit_message].filter(Boolean).join(" — ");

	const frontmatter = [
		"---",
		`description: ${yamlString(description)}`,
		`version: ${version?.version_number ?? 0}`,
		`provider: ${yamlString(version?.provider ?? "")}`,
		`model: ${yamlString(version?.model ?? "")}`,
		MANAGED_MARKER,
		"---",
		"",
	];

	const singleSystem = messages.length === 1 && messageRole(messages[0]?.message) === "system";
	const body = singleSystem
		? messageText(messages[0]?.message)
		: messages
				.map((entry) => `## ${messageRole(entry.message)}\n\n${messageText(entry.message)}`)
				.join("\n\n");

	return `${frontmatter.join("\n")}${body}\n`;
}

/**
 * Create the opt-in prompts syncer.
 *
 * @param config - Resolved configuration; the `prompts` feature and management key must be set.
 * @param options - Optional transport, root directory, and notice sink.
 * @returns A syncer whose `sync()` returns `undefined` when off or unkeyed.
 */
export function createPromptsSyncer(
	config: HofundConfig,
	options: PromptsSyncerOptions = {},
): PromptsSyncer {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const promptsRoot = options.promptsRoot ?? join(homedir(), ".pi", "agent", "prompts");
	const managedRoot = join(promptsRoot, "bifrost");
	const manifestPath = join(managedRoot, ".hofund-manifest.json");

	async function readManifest(): Promise<PromptsManifest | undefined> {
		try {
			return JSON.parse(await readFile(manifestPath, "utf8")) as PromptsManifest;
		} catch {
			return undefined;
		}
	}

	async function writeManifest(manifest: PromptsManifest): Promise<void> {
		await mkdir(managedRoot, { recursive: true });
		const temporary = `${manifestPath}.tmp`;
		await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
		await rename(temporary, manifestPath);
	}

	async function readExistingPrompt(name: string): Promise<string | undefined> {
		try {
			return await readFile(join(managedRoot, `${name}.md`), "utf8");
		} catch {
			return undefined;
		}
	}

	async function writePrompt(name: string, content: string): Promise<void> {
		const temporary = join(managedRoot, `.${name}.md.tmp`);
		await writeFile(temporary, content);
		await rename(temporary, join(managedRoot, `${name}.md`));
	}

	async function sync(): Promise<PromptsSyncResult | undefined> {
		if (!config.features.prompts) return undefined;
		if (!config.managementKey) {
			options.notify?.(
				"Bifrost prompts sync needs a management API key (managementKey/HOFUND_MANAGEMENT_KEY); skipping.",
				"warning",
			);
			return undefined;
		}

		const response = await fetchImpl(promptRepoUrl(config.url, "prompts"), {
			headers: managementHeaders(config),
		});
		if (!response.ok) {
			options.notify?.(`Bifrost prompt repository request failed (${response.status})`, "warning");
			return undefined;
		}

		const body = (await response.json().catch(() => undefined)) as
			| { prompts?: Prompt[] }
			| undefined;
		const prompts = Array.isArray(body?.prompts) ? body.prompts : [];

		await mkdir(managedRoot, { recursive: true });
		const written = new Set<string>();
		const preserved: string[] = [];
		for (const prompt of prompts) {
			const name = slugify(prompt.name ?? "prompt");
			const existing = await readExistingPrompt(name);
			if (existing !== undefined && !isManaged(existing)) {
				preserved.push(name);
				continue;
			}
			await writePrompt(name, renderPrompt(prompt));
			written.add(name);
		}

		// Remove only files this module previously wrote and this payload dropped.
		// A dropped prompt the user has since edited (no marker) is preserved.
		let removed = 0;
		const previous = await readManifest();
		for (const name of previous?.prompts ?? []) {
			if (written.has(name) || preserved.includes(name)) continue;
			const existing = await readExistingPrompt(name);
			if (existing !== undefined && !isManaged(existing)) {
				preserved.push(name);
				continue;
			}
			await rm(join(managedRoot, `${name}.md`), { force: true });
			removed += 1;
		}

		await writeManifest({ syncedAt: Date.now(), prompts: [...written], preserved });
		options.notify?.(
			"Bifrost prompts synced as one-way, lossy markdown templates (model parameters are metadata only).",
			"info",
		);
		return { synced: written.size, removed, preserved: preserved.length };
	}

	return { sync };
}
