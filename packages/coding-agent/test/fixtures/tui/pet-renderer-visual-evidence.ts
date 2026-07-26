import * as path from "node:path";

/** Versioned, fail-closed contracts shared by the Pet visual capture and its verifier. */
export const PET_RENDERER_VISUAL_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const PET_RENDERER_VISUAL_EVIDENCE_SCHEMA =
	`pet-renderer-visual-evidence-v${PET_RENDERER_VISUAL_EVIDENCE_SCHEMA_VERSION}` as const;
export const PET_RENDERER_VISUAL_REQUIRED_FILES = [
	"terminal.txt",
	"terminal-ansi.txt",
	"terminal.html",
	"metadata.json",
] as const;
export type PetRendererVisualRequiredFile = (typeof PET_RENDERER_VISUAL_REQUIRED_FILES)[number];

const FULL_SHA = /^[0-9a-f]{40}$/i;
const HEX_SHA = /^[0-9a-f]{64}$/i;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const ANSI = /\u001b/;
const ABSOLUTE_PATH = /(?:^|[\\/])(?:Users|home|private|var|tmp)[\\/]|^[A-Za-z]:[\\/]|^\\\\/i;
const RAW_PTY_PATH = /(?:^|[\\/])(?:artifacts[\\/]g009-ghostty-pty-capture\.txt|.*pty-capture.*|.*raw-pty.*)/i;
const SECRET_CANARY = /(?:\d{6,}:[A-Za-z0-9_-]{20,}|(?:sk|gh[pousr]|xox[baprs])-[A-Za-z0-9_-]{16,})/;

export interface PetRendererVisualArtifactFile {
	path: string;
	sha256: string;
	byte_length: number;
}
export type ArtifactFile = PetRendererVisualArtifactFile;

export interface PetRendererVisualEntry {
	key: string;
	state_id: string;
	viewport: { id: string; columns: number; rows: number };
	profile: string;
	mode: string;
	capture_mode: "fixture" | "live-pty-summary";
	files: readonly PetRendererVisualArtifactFile[];
}
export type ManifestEntry = PetRendererVisualEntry;

export interface PetRendererVisualProvenance {
	repository_root: string;
	head_sha: string;
	base_sha: string;
	clean: true;
	untracked_files: readonly string[];
	changed_files: readonly string[];
	source_files: readonly { path: string; sha256: string; byte_length: number }[];
}
export type ProvenanceInventory = PetRendererVisualProvenance;

export interface PetRendererVisualManifest {
	schema_version: 1;
	evidence_schema: typeof PET_RENDERER_VISUAL_EVIDENCE_SCHEMA;
	capture_tool: string;
	capture_mode: "fixture";
	command: string;
	head_sha: string;
	base_sha: string;
	provenance: PetRendererVisualProvenance;
	expected_entry_count: number;
	entry_count: number;
	entries: readonly PetRendererVisualEntry[];
}
export type VisualManifest = PetRendererVisualManifest;

export interface PetRendererVisualReviewInput {
	schema_version: 1;
	manifest_sha256: string;
	head_sha: string;
	base_sha: string;
	expected_entry_count: number;
	capture_mode: "fixture";
	review_requirements: readonly string[];
}
export type VisualReviewInput = PetRendererVisualReviewInput;
export const PET_RENDERER_VISUAL_DESCRIPTOR_MEMBER = "visual-qa-descriptor.json" as const;

/** A text-only, reversible representation of terminal control bytes. */
export interface PetRendererVisualSafeWrite {
	sequence: number;
	stream: "stdout" | "stderr" | "terminal";
	data: string;
}
export interface PetRendererVisualSafeWriteLog {
	schema_version: 1;
	encoding: "backslash-x-byte-v1";
	writes: readonly PetRendererVisualSafeWrite[];
}
export type SafeWriteLog = PetRendererVisualSafeWriteLog;

export interface PetRendererVisualPublicationDescriptor {
	schema_version: 1;
	owner: string;
	repo: string;
	pr_number: number;
	pr_node_id: string;
	head_repository: string;
	head_repository_id: number;
	base_repository: string;
	base_repository_id: number;
	readonly workflow_event: "pull_request" | "workflow_dispatch";
	readonly workflow_ref_sha: string;
	readonly head_sha: string;
	readonly base_sha: string;
	manifest_sha256: string;
	manifest_entry_count: number;
	readonly artifact_id: number;
	readonly workflow_run_id: number;
	artifact_name: string;
	workflow_run_attempt: number;
	artifact_sha256: string;
	artifact_byte_length: number;
	archive_sha256: string;
	archive_byte_length: number;
	artifact_url: string;
	run_url: string;
	retention_days: number;
	raw_pty_published: false;
	gjc_published: false;
}
export type PublicationDescriptor = PetRendererVisualPublicationDescriptor;
export const PET_RENDERER_VISUAL_DESCRIPTOR_PROVENANCE_SCHEMA_VERSION = 1 as const;
export const PET_RENDERER_VISUAL_DESCRIPTOR_PROVENANCE_SCHEMA =
	`pet-renderer-visual-descriptor-provenance-v${PET_RENDERER_VISUAL_DESCRIPTOR_PROVENANCE_SCHEMA_VERSION}` as const;

export interface PetRendererVisualDescriptorArtifactProvenance {
	schema_version: typeof PET_RENDERER_VISUAL_DESCRIPTOR_PROVENANCE_SCHEMA_VERSION;
	schema: typeof PET_RENDERER_VISUAL_DESCRIPTOR_PROVENANCE_SCHEMA;
	artifact_id: number;
	artifact_name: string;
	artifact_digest: string;
	workflow_run_id: number;
	workflow_run_attempt: number;
	repository: string;
	pr_number: number;
	pr_node_id: string;
	head_sha: string;
	base_sha: string;
}

export interface PetRendererVisualApiIdentity {
	id: number;
	node_id: string;
	login?: string;
}
export interface PetRendererVisualApiReviewBinding {
	id: number;
	node_id: string;
	commit_id: string | null;
	user: PetRendererVisualApiIdentity | null;
	pull_request: { id: string; number: number; repository: { id: number; node_id: string; full_name: string } };
}

export function sha256Bytes(value: string | Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

export function isFullSha(value: unknown): value is string {
	return typeof value === "string" && FULL_SHA.test(value);
}

export function isSha256(value: unknown): value is string {
	return typeof value === "string" && HEX_SHA.test(value);
}

export function assertFullSha(value: unknown, field: string): asserts value is string {
	if (!isFullSha(value)) throw new Error(`${field} must be a full 40-character SHA-1`);
}

export function assertSha256(value: unknown, field: string): asserts value is string {
	if (!isSha256(value)) throw new Error(`${field} must be a 64-character SHA-256`);
}

/** Encode every terminal C0/C1 byte and backslash without losing Unicode text. */
export function encodeTerminalControls(value: string): string {
	let encoded = "";
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code === 0x5c) encoded += "\\\\";
		else if (code <= 0xff && (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)))
			encoded += `\\x${code.toString(16).padStart(2, "0")}`;
		else encoded += character;
	}
	return encoded;
}

export function decodeTerminalControls(value: string): string {
	let decoded = "";
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] !== "\\") {
			decoded += value[index];
			continue;
		}
		if (value[index + 1] === "\\") {
			decoded += "\\";
			index += 1;
			continue;
		}
		const match = /^\\x([0-9a-f]{2})/i.exec(value.slice(index));
		if (!match) throw new Error(`Invalid terminal control escape at offset ${index}`);
		decoded += String.fromCharCode(Number.parseInt(match[1]!, 16));
		index += 3;
	}
	return decoded;
}

export function stripTerminalControls(value: string): string {
	return value
		.replace(
			/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|P[^\u001b]*(?:\u001b\\)|_[^\u001b]*(?:\u0007|\u001b\\)|[ -/]*[@-~])/g,
			"",
		)
		.replace(CONTROL, "");
}

function fail(message: string): never {
	throw new Error(`Pet visual evidence rejected: ${message}`);
}

function assertSafeRelativePath(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !value || path.posix.isAbsolute(value) || path.win32.isAbsolute(value))
		fail(`${field} must be relative`);
	const normalized = value.replaceAll("\\", "/");
	if (normalized.split("/").some(part => part === "..") || normalized.startsWith("./") || normalized.includes("//"))
		fail(`${field} contains traversal or non-canonical separators`);
	if (ABSOLUTE_PATH.test(normalized) || RAW_PTY_PATH.test(normalized)) fail(`${field} names an unsafe path`);
}

export function assertSafeEvidenceText(value: string, field = "evidence"): void {
	if (CONTROL.test(value) || ANSI.test(value)) fail(`${field} contains terminal control bytes`);
	if (SECRET_CANARY.test(value)) fail(`${field} contains a secret-shaped token`);
	if (RAW_PTY_PATH.test(value)) fail(`${field} mentions a raw PTY path`);
	if (ABSOLUTE_PATH.test(value)) fail(`${field} contains an absolute local path`);
}

export function materializeTerminalHtml(terminalText: string, title = "Pet renderer visual evidence"): string {
	assertSafeEvidenceText(terminalText, "terminal text");
	const escaped = terminalText
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
	return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;background:#111;color:#eee}pre{margin:0;padding:1em;white-space:pre-wrap;font-family:ui-monospace,monospace}</style></head><body><pre>${escaped}</pre></body></html>\n`;
}

export function validateSafeWriteLog(log: PetRendererVisualSafeWriteLog): void {
	if (log.schema_version !== 1 || log.encoding !== "backslash-x-byte-v1" || !Array.isArray(log.writes))
		fail("invalid safe write-log schema");
	log.writes.forEach((write, index) => {
		if (write.sequence !== index || !["stdout", "stderr", "terminal"].includes(write.stream))
			fail(`invalid write ${index}`);
		if (typeof write.data !== "string" || CONTROL.test(write.data)) fail(`write ${index} contains raw control bytes`);
		if (decodeTerminalControls(write.data) === undefined) fail(`write ${index} cannot be decoded`);
	});
}

export function validateManifest(manifest: PetRendererVisualManifest): void {
	if (manifest.schema_version !== 1 || manifest.evidence_schema !== PET_RENDERER_VISUAL_EVIDENCE_SCHEMA)
		fail("unsupported manifest schema");
	if (
		manifest.capture_mode !== "fixture" ||
		!Number.isInteger(manifest.expected_entry_count) ||
		manifest.expected_entry_count < 1
	)
		fail("invalid manifest mode/count");
	assertFullSha(manifest.head_sha, "manifest.head_sha");
	assertFullSha(manifest.base_sha, "manifest.base_sha");
	if (manifest.head_sha === manifest.base_sha) fail("head and base must differ");
	if (manifest.entry_count !== manifest.entries.length || manifest.entry_count !== manifest.expected_entry_count)
		fail("manifest entry count mismatch");
	const keys = new Set<string>();
	for (const entry of manifest.entries) {
		if (!entry.key || keys.has(entry.key)) fail(`duplicate or empty entry key ${entry.key}`);
		keys.add(entry.key);
		if (
			!entry.state_id ||
			!entry.profile ||
			!entry.mode ||
			!entry.viewport ||
			entry.viewport.columns < 1 ||
			entry.viewport.rows < 1
		)
			fail(`invalid entry ${entry.key}`);
		if (entry.capture_mode !== "fixture" || entry.files.length !== PET_RENDERER_VISUAL_REQUIRED_FILES.length)
			fail(`invalid files for ${entry.key}`);
		const names = new Set<string>();
		for (const file of entry.files) {
			assertSafeRelativePath(file.path, `${entry.key}.file.path`);
			if (
				names.has(file.path) ||
				!PET_RENDERER_VISUAL_REQUIRED_FILES.includes(
					path.posix.basename(file.path) as PetRendererVisualRequiredFile,
				)
			)
				fail(`invalid file set for ${entry.key}`);
			names.add(file.path);
			assertSha256(file.sha256, `${entry.key}.${file.path}.sha256`);
			if (!Number.isSafeInteger(file.byte_length) || file.byte_length < 0)
				fail(`invalid byte length for ${entry.key}.${file.path}`);
		}
		for (const required of PET_RENDERER_VISUAL_REQUIRED_FILES)
			if (![...names].some(name => path.posix.basename(name) === required))
				fail(`missing ${required} for ${entry.key}`);
	}
	if (manifest.provenance.clean !== true) fail("manifest provenance is not clean");
	assertFullSha(manifest.provenance.head_sha, "provenance.head_sha");
	assertFullSha(manifest.provenance.base_sha, "provenance.base_sha");
	if (manifest.provenance.head_sha !== manifest.head_sha || manifest.provenance.base_sha !== manifest.base_sha)
		fail("provenance SHA mismatch");
	validateProvenance(manifest.provenance);
}

export function validateProvenance(provenance: PetRendererVisualProvenance): void {
	if (provenance.clean !== true || provenance.untracked_files.length !== 0 || provenance.changed_files.length !== 0)
		fail("provenance is not clean");
	assertFullSha(provenance.head_sha, "provenance.head_sha");
	assertFullSha(provenance.base_sha, "provenance.base_sha");
	if (provenance.head_sha === provenance.base_sha) fail("provenance head and base are identical");
	for (const source of provenance.source_files) {
		assertSafeRelativePath(source.path, "provenance.source_files.path");
		assertSha256(source.sha256, "provenance.source_files.sha256");
		if (!Number.isSafeInteger(source.byte_length) || source.byte_length < 0)
			fail("provenance source byte length is invalid");
	}
}

export function validatePublicationDescriptor(descriptor: PetRendererVisualPublicationDescriptor): void {
	if (
		descriptor.schema_version !== 1 ||
		!descriptor.owner ||
		!descriptor.repo ||
		typeof descriptor.pr_node_id !== "string" ||
		!descriptor.pr_node_id ||
		!Number.isSafeInteger(descriptor.pr_number) ||
		descriptor.pr_number < 1
	)
		fail("invalid publication descriptor");
	if (
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(descriptor.head_repository) ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(descriptor.base_repository) ||
		!Number.isSafeInteger(descriptor.head_repository_id) ||
		descriptor.head_repository_id < 1 ||
		!Number.isSafeInteger(descriptor.base_repository_id) ||
		descriptor.base_repository_id < 1
	)
		fail("descriptor head/base repository identities are invalid");
	assertFullSha(descriptor.head_sha, "descriptor.head_sha");
	assertFullSha(descriptor.workflow_ref_sha, "descriptor.workflow_ref_sha");
	if (!["pull_request", "workflow_dispatch"].includes(descriptor.workflow_event))
		fail("descriptor workflow event is invalid");
	if (descriptor.workflow_event === "pull_request" && descriptor.workflow_ref_sha !== descriptor.head_sha)
		fail("pull-request workflow ref differs from descriptor head");
	assertFullSha(descriptor.base_sha, "descriptor.base_sha");
	assertSha256(descriptor.manifest_sha256, "descriptor.manifest_sha256");
	if (typeof descriptor.artifact_name !== "string" || !descriptor.artifact_name)
		fail("descriptor artifact name is missing");
	assertSafeEvidenceText(descriptor.artifact_name, "descriptor.artifact_name");
	assertSha256(descriptor.artifact_sha256, "descriptor.artifact_sha256");
	assertSha256(descriptor.archive_sha256, "descriptor.archive_sha256");
	if (
		!Number.isSafeInteger(descriptor.artifact_id) ||
		descriptor.artifact_id < 1 ||
		!Number.isSafeInteger(descriptor.workflow_run_id) ||
		descriptor.workflow_run_id < 1 ||
		!Number.isSafeInteger(descriptor.workflow_run_attempt) ||
		descriptor.workflow_run_attempt < 1
	)
		fail("descriptor artifact/workflow run IDs are invalid");
	if (
		!Number.isSafeInteger(descriptor.artifact_byte_length) ||
		descriptor.artifact_byte_length < 1 ||
		!Number.isSafeInteger(descriptor.archive_byte_length) ||
		descriptor.archive_byte_length < 1 ||
		!Number.isSafeInteger(descriptor.retention_days) ||
		descriptor.retention_days < 1 ||
		!Number.isSafeInteger(descriptor.manifest_entry_count) ||
		descriptor.manifest_entry_count < 1
	)
		fail("invalid descriptor lengths/count");
	if (descriptor.raw_pty_published !== false || descriptor.gjc_published !== false)
		fail("descriptor publication flags must be false");
	if (!/^https:\/\//.test(descriptor.artifact_url) || !/^https:\/\//.test(descriptor.run_url))
		fail("descriptor URLs must be HTTPS");
	const expectedArtifactUrl = `https://github.com/${descriptor.owner}/${descriptor.repo}/actions/runs/${descriptor.workflow_run_id}/artifacts/${descriptor.artifact_id}`;
	const expectedRunUrl = `https://github.com/${descriptor.owner}/${descriptor.repo}/actions/runs/${descriptor.workflow_run_id}`;
	if (descriptor.artifact_url !== expectedArtifactUrl || descriptor.run_url !== expectedRunUrl)
		fail("descriptor URLs are not bound to the immutable Actions artifact/run");
}

export function validateDescriptorArtifactProvenance(provenance: PetRendererVisualDescriptorArtifactProvenance): void {
	if (
		provenance.schema_version !== PET_RENDERER_VISUAL_DESCRIPTOR_PROVENANCE_SCHEMA_VERSION ||
		provenance.schema !== PET_RENDERER_VISUAL_DESCRIPTOR_PROVENANCE_SCHEMA
	)
		fail("unsupported descriptor artifact provenance schema");
	if (
		!Number.isSafeInteger(provenance.artifact_id) ||
		provenance.artifact_id < 1 ||
		typeof provenance.artifact_name !== "string" ||
		!provenance.artifact_name
	)
		fail("descriptor artifact provenance identity is invalid");
	assertSafeEvidenceText(provenance.artifact_name, "descriptor artifact provenance.artifact_name");
	if (!/^sha256:[0-9a-f]{64}$/iu.test(provenance.artifact_digest))
		fail("descriptor artifact provenance digest is invalid");
	if (
		!Number.isSafeInteger(provenance.workflow_run_id) ||
		provenance.workflow_run_id < 1 ||
		!Number.isSafeInteger(provenance.workflow_run_attempt) ||
		provenance.workflow_run_attempt < 1
	)
		fail("descriptor artifact provenance workflow run is invalid");
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(provenance.repository))
		fail("descriptor artifact provenance repository is invalid");
	if (!Number.isSafeInteger(provenance.pr_number) || provenance.pr_number < 1 || !provenance.pr_node_id)
		fail("descriptor artifact provenance PR identity is invalid");
	assertFullSha(provenance.head_sha, "descriptor artifact provenance.head_sha");
	assertFullSha(provenance.base_sha, "descriptor artifact provenance.base_sha");
	if (provenance.head_sha === provenance.base_sha) fail("descriptor artifact provenance head/base are identical");
}
export function validateApiReviewBinding(binding: PetRendererVisualApiReviewBinding): void {
	if (
		!Number.isSafeInteger(binding.id) ||
		binding.id < 1 ||
		!binding.node_id ||
		!binding.user ||
		!Number.isSafeInteger(binding.user.id) ||
		!binding.user.node_id
	)
		fail("API review identity is incomplete");
	assertFullSha(binding.commit_id, "authenticated review commit_id");
	if (
		!binding.pull_request?.id ||
		!Number.isInteger(binding.pull_request.number) ||
		!binding.pull_request.repository?.node_id ||
		!binding.pull_request.repository?.full_name
	)
		fail("API review parent is incomplete");
}

export function assertHeadBinding(headSha: string, baseSha: string, ...boundHeads: string[]): void {
	assertFullSha(headSha, "head_sha");
	assertFullSha(baseSha, "base_sha");
	if (headSha === baseSha || boundHeads.some(value => value !== headSha))
		fail("head/base/review commit binding mismatch");
	for (const [index, boundHead] of boundHeads.entries()) assertFullSha(boundHead, `bound_heads[${index}]`);
}

export function assertNoReceiptFile(relativePath: string): void {
	if (
		path.posix.basename(relativePath).toLowerCase().includes("receipt") ||
		path.posix.basename(relativePath) === "independent-review.json"
	)
		fail("receipt files are not capture output");
}

export const validateEvidenceManifest = validateManifest;
export const validatePublication = validatePublicationDescriptor;
export const encodeSafeTerminalAnsi = encodeTerminalControls;
export const decodeSafeTerminalAnsi = decodeTerminalControls;
export const validateSafeTerminalWriteLog = validateSafeWriteLog;
