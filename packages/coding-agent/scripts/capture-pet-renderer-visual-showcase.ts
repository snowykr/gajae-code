import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	assertNoReceiptFile,
	assertSafeEvidenceText,
	byteLength,
	encodeTerminalControls,
	materializeTerminalHtml,
	PET_RENDERER_VISUAL_EVIDENCE_SCHEMA,
	PET_RENDERER_VISUAL_EVIDENCE_SCHEMA_VERSION,
	type PetRendererVisualArtifactFile,
	type PetRendererVisualEntry,
	type PetRendererVisualManifest,
	type PetRendererVisualProvenance,
	sha256Bytes,
	stripTerminalControls,
	validateManifest,
} from "../test/fixtures/tui/pet-renderer-visual-evidence";
import {
	PET_RENDERER_VISUAL_SHOWCASE_ENTRIES,
	PET_RENDERER_VISUAL_SHOWCASE_EXPECTED_ENTRY_COUNT,
	type PetRendererVisualShowcaseEntry,
	renderPetRendererVisualShowcase,
} from "../test/fixtures/tui/pet-renderer-visual-showcase";

const CAPTURE_TOOL_VERSION = "pet-renderer-visual-showcase-capture-v1";
const REPOSITORY_ROOT = path.resolve(import.meta.dir, "../../..");
const QA_ROOT = path.join(REPOSITORY_ROOT, ".gjc", "qa");
const FIXTURE_PATH = "packages/coding-agent/test/fixtures/tui/pet-renderer-visual-showcase.ts";
const COMMAND_PREFIX = "bun packages/coding-agent/scripts/capture-pet-renderer-visual-showcase.ts";

interface RenderedSurface {
	terminalText?: string;
	terminalAnsiText?: string;
	terminalHtml?: string;
	captureMode?: string;
	state?: unknown;
	eventLog?: unknown;
	navigation?: unknown;
	transactions?: unknown;
	petProtocol?: unknown;
	durableHistory?: unknown;
	rawPtyPublished?: boolean;
}

function die(message: string): never {
	throw new Error(`Pet visual capture rejected: ${message}`);
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function runGit(args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", REPOSITORY_ROOT, ...args]);
	if (result.exitCode !== 0) die(`git ${args.join(" ")} failed`);
	return result.stdout.toString().trim();
}

function parseArgs(args: string[]): { head: string; base: string; output?: string } {
	let head: string | undefined;
	let base: string | undefined;
	let output: string | undefined;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--head") head = args[++index];
		else if (argument === "--base") base = args[++index];
		else if (argument === "--output") output = args[++index];
		else die(`unknown argument ${argument}`);
	}
	if (!head || !base || !/^[0-9a-f]{40}$/i.test(head) || !/^[0-9a-f]{40}$/i.test(base))
		die("--head and --base require full 40-character SHA values");
	return { head: head.toLowerCase(), base: base.toLowerCase(), output };
}

async function assertDirectoryNotSymlink(directory: string, label: string): Promise<void> {
	let stat: Stats;
	try {
		stat = await fs.lstat(directory);
	} catch {
		die(`${label} does not exist`);
	}
	if (!stat.isDirectory() || stat.isSymbolicLink()) die(`${label} must be a real directory`);
}

async function containedOutput(outputArgument: string | undefined, head: string): Promise<string> {
	await assertDirectoryNotSymlink(path.join(REPOSITORY_ROOT, ".gjc"), ".gjc");
	try {
		await fs.mkdir(QA_ROOT, { recursive: false });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	await assertDirectoryNotSymlink(QA_ROOT, ".gjc/qa");
	const output = path.resolve(REPOSITORY_ROOT, outputArgument ?? path.join(".gjc", "qa", "pr-11-visual-qa", head));
	const relative = path.relative(QA_ROOT, output);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
		die("output must be contained below .gjc/qa");
	async function assertNoSymlinkComponents(root: string, relative: string): Promise<void> {
		let current = root;
		for (const part of relative.split(path.sep).filter(Boolean)) {
			current = path.join(current, part);
			try {
				const stat = await fs.lstat(current);
				if (stat.isSymbolicLink()) die(`output component is a symlink: ${current}`);
				if (!stat.isDirectory()) die(`output component is not a directory: ${current}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
				throw error;
			}
		}
	}
	await assertNoSymlinkComponents(QA_ROOT, path.dirname(relative));
	await fs.mkdir(path.dirname(output), { recursive: true });
	if (path.basename(output) !== head) die("output basename must equal --head");
	try {
		const stat = await fs.lstat(output);
		if (stat.isSymbolicLink() || !stat.isDirectory()) die("output already exists and is unsafe");
		const children = await fs.readdir(output);
		if (children.length) die("output already exists and is non-empty");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return output;
}

function assertCleanSource(): void {
	const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
	const unsafeLines = status
		.split("\n")
		.filter(Boolean)
		.filter(line => !line.slice(3).replaceAll("\\", "/").startsWith(".gjc/qa/"));
	if (unsafeLines.length) die(`working tree is not clean: ${unsafeLines.join(", ")}`);
}

async function sourceProvenance(head: string, base: string): Promise<PetRendererVisualProvenance> {
	const resolvedHead = runGit(["rev-parse", "HEAD"]).toLowerCase();
	const resolvedBase = runGit(["rev-parse", `${base}^{commit}`]).toLowerCase();
	if (resolvedHead !== head) die(`HEAD ${resolvedHead} does not equal --head ${head}`);
	if (resolvedBase !== base) die(`resolved base ${resolvedBase} does not equal --base ${base}`);
	assertCleanSource();
	const sourcePaths = [FIXTURE_PATH, "packages/coding-agent/scripts/capture-pet-renderer-visual-showcase.ts"];
	const sourceFiles = [];
	for (const relative of sourcePaths) {
		const content = await fs.readFile(path.join(REPOSITORY_ROOT, relative));
		sourceFiles.push({ path: relative, sha256: sha256Bytes(content), byte_length: content.byteLength });
	}
	return {
		repository_root: "repository-root-redacted",
		head_sha: head,
		base_sha: base,
		clean: true,
		untracked_files: [],
		changed_files: [],
		source_files: sourceFiles,
	};
}

function fixtureEntries(): readonly PetRendererVisualShowcaseEntry[] {
	const value: unknown = PET_RENDERER_VISUAL_SHOWCASE_ENTRIES;
	if (!Array.isArray(value) || value.length === 0) die("fixture does not export a non-empty explicit entry matrix");
	return value as readonly PetRendererVisualShowcaseEntry[];
}

function expectedCount(): number {
	const value = PET_RENDERER_VISUAL_SHOWCASE_EXPECTED_ENTRY_COUNT;
	if (!Number.isSafeInteger(value) || value < 1) die("fixture does not export an expected entry count");
	return value;
}

async function renderEntry(entry: PetRendererVisualShowcaseEntry): Promise<RenderedSurface> {
	const rendered = await renderPetRendererVisualShowcase(entry);
	if (!rendered || typeof rendered.terminalAnsiText !== "string")
		die(`entry ${String(entry.key)} has no terminal ANSI surface`);
	return rendered;
}

async function writeArtifact(
	filePath: string,
	content: string,
	outputRoot: string,
): Promise<PetRendererVisualArtifactFile> {
	assertNoReceiptFile(path.relative(outputRoot, filePath));
	assertSafeEvidenceText(content, path.relative(outputRoot, filePath));
	await fs.writeFile(filePath, content, "utf8");
	return {
		path: path.relative(outputRoot, filePath).split(path.sep).join("/"),
		sha256: sha256Bytes(content),
		byte_length: byteLength(content),
	};
}

function safeMetadataValue(value: unknown): unknown {
	if (typeof value === "string") return encodeTerminalControls(value);
	if (Array.isArray(value)) return value.map(safeMetadataValue);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeMetadataValue(item)]));
	}
	return value;
}

async function captureEntry(
	rawEntry: PetRendererVisualShowcaseEntry,
	stageRoot: string,
): Promise<PetRendererVisualEntry> {
	const entry = rawEntry as unknown as Record<string, unknown>;
	const key = String(entry.key ?? "");
	const stateId = String(entry.stateKey ?? entry.stateId ?? entry.state_id ?? "");
	const viewport = (entry.viewport ?? {}) as Record<string, unknown>;
	const viewportId = String(viewport.id ?? viewport.key ?? "");
	const profile = String(
		entry.profileKey ?? entry.profile ?? entry.capabilityProfile ?? entry.capability_profile ?? "default",
	);
	const mode = String(entry.renderMode ?? entry.mode ?? entry.render_mode ?? "unicode-color");
	const capability = String(entry.capabilityKey ?? entry.capability ?? "");
	if (!key || !stateId || !viewportId || !Number.isInteger(viewport.columns) || !Number.isInteger(viewport.rows))
		die("fixture entry is missing key/state/viewport");
	const rendered = await renderEntry(rawEntry);
	if (rendered.rawPtyPublished === true) die(`${key} claims raw PTY publication`);
	const terminalAnsiSource = rendered.terminalAnsiText ?? rendered.terminalText;
	if (typeof terminalAnsiSource !== "string") die(`${key} has no terminal ANSI output`);
	const terminalText =
		typeof rendered.terminalText === "string"
			? rendered.terminalText.replaceAll("\r", "")
			: stripTerminalControls(terminalAnsiSource).replaceAll("\r", "");
	const terminalAnsiText = encodeTerminalControls(terminalAnsiSource);
	assertSafeEvidenceText(terminalText, `${key}/terminal.txt`);
	if (terminalAnsiText.includes("\u001b")) die(`${key}/terminal-ansi.txt contains a raw control byte`);
	const terminalHtml = rendered.terminalHtml ?? materializeTerminalHtml(terminalText);
	assertSafeEvidenceText(terminalHtml, `${key}/terminal.html`);
	if (/<(?:img|svg|canvas)\b|data:image\//i.test(terminalHtml)) die(`${key}/terminal.html makes a raster claim`);
	const directory = path.join(stageRoot, stateId, viewportId, mode);
	await fs.mkdir(directory, { recursive: true });
	const terminalFiles = [
		{ name: "terminal.txt", content: terminalText },
		{ name: "terminal-ansi.txt", content: terminalAnsiText },
		{ name: "terminal.html", content: terminalHtml },
	];
	const metadata = json({
		schema_version: PET_RENDERER_VISUAL_EVIDENCE_SCHEMA_VERSION,
		evidence_schema: PET_RENDERER_VISUAL_EVIDENCE_SCHEMA,
		entry_key: key,
		state_id: stateId,
		viewport: { id: viewportId, columns: viewport.columns, rows: viewport.rows },
		profile,
		mode,
		capability,
		capture_mode: "fixture",
		capture_timestamp: "1970-01-01T00:00:00.000Z",
		fixture_source: FIXTURE_PATH,
		tool_version: CAPTURE_TOOL_VERSION,
		terminal: {
			columns: viewport.columns,
			rows: viewport.rows,
			html_claim: "materialized terminal cells only; no raster claim",
		},
		artifact_integrity: terminalFiles.map(file => ({
			path: file.name,
			sha256: sha256Bytes(file.content),
			byte_length: byteLength(file.content),
		})),
		navigation: safeMetadataValue(rendered.navigation ?? []),
		event_log: safeMetadataValue(rendered.eventLog ?? rendered.transactions ?? []),
		state: safeMetadataValue(rendered.state ?? null),
		durable_history: safeMetadataValue(rendered.durableHistory ?? null),
	});
	const files = await Promise.all([
		...terminalFiles.map(file => writeArtifact(path.join(directory, file.name), file.content, stageRoot)),
		writeArtifact(path.join(directory, "metadata.json"), metadata, stageRoot),
	]);
	return {
		key,
		state_id: stateId,
		viewport: { id: viewportId, columns: viewport.columns as number, rows: viewport.rows as number },
		profile,
		mode,
		capture_mode: "fixture",
		files,
	};
}

async function main(): Promise<void> {
	const { head, base, output } = parseArgs(process.argv.slice(2));
	const provenance = await sourceProvenance(head, base);
	const outputRoot = await containedOutput(output, head);
	const stageRoot = `${outputRoot}.staging-${process.pid}-${Math.random().toString(16).slice(2)}`;
	const sourceEntries = fixtureEntries();
	const expected = expectedCount();
	try {
		await fs.mkdir(stageRoot, { recursive: false });
		const entries: PetRendererVisualEntry[] = [];
		const keys = new Set<string>();
		for (const sourceEntry of sourceEntries) {
			const entry = await captureEntry(sourceEntry, stageRoot);
			if (keys.has(entry.key)) die(`duplicate fixture entry key ${entry.key}`);
			keys.add(entry.key);
			entries.push(entry);
		}
		if (entries.length !== expected) die(`captured ${entries.length} entries; fixture declares ${expected}`);
		const manifest: PetRendererVisualManifest = {
			schema_version: 1,
			evidence_schema: PET_RENDERER_VISUAL_EVIDENCE_SCHEMA,
			capture_tool: CAPTURE_TOOL_VERSION,
			capture_mode: "fixture",
			command: `${COMMAND_PREFIX} --head ${head} --base ${base}`,
			head_sha: head,
			base_sha: base,
			provenance,
			expected_entry_count: expected,
			entry_count: entries.length,
			entries,
		};
		validateManifest(manifest);
		const manifestText = json(manifest);
		const reviewInput = json({
			schema_version: 1,
			manifest_sha256: sha256Bytes(manifestText),
			head_sha: head,
			base_sha: base,
			expected_entry_count: expected,
			capture_mode: "fixture",
			reviewer_output_file: "independent-review.json",
			review_requirements: [
				"Inspect every matrix entry and its profile/mode.",
				"Inspect CJK wrapping and Pet reservation at every declared viewport.",
				"Confirm HTML is materialized cells only and contains no terminal controls or raster claim.",
				"Confirm this bundle contains no raw PTY bytes or receipt.",
			],
		});
		await fs.writeFile(path.join(stageRoot, "manifest.json"), manifestText, "utf8");
		await fs.writeFile(path.join(stageRoot, "visual-review-input.json"), reviewInput, "utf8");
		if ((await fs.readdir(stageRoot)).some(name => name.toLowerCase().includes("receipt")))
			die("capture attempted to create a receipt");
		await fs.rename(stageRoot, outputRoot);
		process.stdout.write(
			`Captured ${entries.length} Pet renderer entries to ${outputRoot}\nmanifest.json sha256: ${sha256Bytes(manifestText)}\n`,
		);
	} catch (error) {
		await fs.rm(stageRoot, { recursive: true, force: true });
		throw error;
	}
}

await main();
