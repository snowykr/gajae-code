import * as path from "node:path";
import { logger } from "@gajae-code/utils";
import { unzipSync } from "fflate";
import {
	assertFullSha,
	assertHeadBinding,
	assertNoReceiptFile,
	assertSafeEvidenceText,
	decodeTerminalControls,
	PET_RENDERER_VISUAL_DESCRIPTOR_MEMBER,
	PET_RENDERER_VISUAL_DESCRIPTOR_PROVENANCE_SCHEMA,
	PET_RENDERER_VISUAL_DESCRIPTOR_PROVENANCE_SCHEMA_VERSION,
	type PetRendererVisualApiIdentity,
	type PetRendererVisualDescriptorArtifactProvenance,
	type PetRendererVisualManifest,
	type PetRendererVisualPublicationDescriptor,
	type PetRendererVisualReviewInput,
	sha256Bytes,
	validateDescriptorArtifactProvenance,
	validateManifest,
	validatePublicationDescriptor,
} from "../test/fixtures/tui/pet-renderer-visual-evidence";

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 4096;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const PAGE_SIZE = 100;
const PET_RENDERER_VISUAL_ARCHIVE_MEMBER = "pet-renderer-visual-qa.tar.gz";

type JsonObject = Record<string, unknown>;

export interface GitHubApi {
	/** Paths are GitHub REST paths, including the leading slash. */
	get(path: string): Promise<unknown>;
	download(url: string): Promise<Uint8Array>;
	/** Optional seam. The default adapter always provides this. */
	graphql?(query: string, variables: Record<string, unknown>): Promise<unknown>;
}

export interface VerifyPublicationOptions {
	descriptor: string | number;
	repository?: string;
	pr?: number;
	reviewId: number;
	token?: string;
}

export interface VerifiedPublication {
	descriptor: PetRendererVisualPublicationDescriptor;
	descriptor_artifact_provenance: PetRendererVisualDescriptorArtifactProvenance;
	manifest: PetRendererVisualManifest;
	reviewId: number;
	review: JsonObject;
	initialHeadSha: string;
	finalHeadSha: string;
	reviewer: PetRendererVisualApiIdentity;
}

function fail(message: string): never {
	throw new Error(`Pet visual publication rejected: ${message}`);
}

function object(value: unknown, field: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
	return value as JsonObject;
}

function stringField(value: unknown, field: string): string {
	if (typeof value !== "string" || !value) fail(`${field} is missing`);
	return value;
}
function timestampField(value: unknown, field: string): number {
	const text = stringField(value, field);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text))
		fail(`${field} is malformed`);
	const timestamp = Date.parse(text);
	if (!Number.isFinite(timestamp)) fail(`${field} is malformed`);
	return timestamp;
}

function integerField(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${field} is not a positive integer`);
	return value as number;
}

function fullSha(value: unknown, field: string): string {
	assertFullSha(value, field);
	return value.toLowerCase();
}

function sameSha(...values: string[]): boolean {
	return values.every(value => value.toLowerCase() === values[0]!.toLowerCase());
}

function parseJson(value: string, field: string): unknown {
	try {
		return JSON.parse(value.replace(/^\uFEFF/u, ""));
	} catch (error) {
		fail(`${field} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
}

interface DescriptorArtifactReference {
	owner: string;
	repo: string;
	artifactId: number;
	workflowRunId?: number;
}

interface LoadedDescriptor {
	descriptor: PetRendererVisualPublicationDescriptor;
	provenance: PetRendererVisualDescriptorArtifactProvenance;
	artifactCreatedAt: number;
}

function repositoryParts(value: string, field: string): { owner: string; repo: string } {
	const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(value);
	if (!match) fail(`${field} must be owner/repo`);
	return { owner: match[1]!, repo: match[2]! };
}

function expectedWorkflowRunHeadRepositoryId(descriptor: PetRendererVisualPublicationDescriptor): number {
	return descriptor.workflow_event === "pull_request" ? descriptor.head_repository_id : descriptor.base_repository_id;
}

function assertPrRepositoryBindings(
	parent: JsonObject,
	descriptor: PetRendererVisualPublicationDescriptor,
	field: string,
): void {
	const binding = (side: "head" | "base"): JsonObject => {
		const endpoint = object(object(parent[side], `${field}.${side}`).repo, `${field}.${side}.repo`);
		const expectedName = descriptor[`${side}_repository`];
		const expectedId = descriptor[`${side}_repository_id`];
		if (
			stringField(
				endpoint.full_name ?? endpoint.full_name_with_owner ?? endpoint.nameWithOwner,
				`${field}.${side}.repo.full_name`,
			).toLowerCase() !== expectedName.toLowerCase()
		)
			fail(`${field} ${side} repository differs from descriptor`);
		if (integerField(endpoint.id, `${field}.${side}.repo.id`) !== expectedId)
			fail(`${field} ${side} repository ID differs from descriptor`);
		return endpoint;
	};
	binding("head");
	binding("base");
}

function actionsArtifactUrl(owner: string, repo: string, workflowRunId: number, artifactId: number): string {
	return `https://github.com/${owner}/${repo}/actions/runs/${workflowRunId}/artifacts/${artifactId}`;
}

function actionsRunUrl(owner: string, repo: string, workflowRunId: number): string {
	return `https://github.com/${owner}/${repo}/actions/runs/${workflowRunId}`;
}

function actionsArchiveUrl(owner: string, repo: string, artifactId: number): string {
	return `https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`;
}

function descriptorArtifactReference(
	input: string | number,
	repository: string | undefined,
): DescriptorArtifactReference | undefined {
	if (typeof input === "number") {
		const { owner, repo } = repositoryParts(repository ?? "", "descriptor repository");
		return { owner, repo, artifactId: integerField(input, "descriptor artifact ID") };
	}
	const text = input.trim();
	if (!text || text.startsWith("{")) return undefined;
	if (/^[1-9]\d*$/u.test(text)) {
		const { owner, repo } = repositoryParts(repository ?? "", "descriptor repository");
		return { owner, repo, artifactId: integerField(Number(text), "descriptor artifact ID") };
	}
	if (/^[A-Za-z][A-Za-z\d+.-]*:/u.test(text)) {
		let parsed: URL;
		try {
			parsed = new URL(text);
		} catch {
			fail("descriptor URL is malformed");
		}
		if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || parsed.port)
			fail("descriptor URL must be canonical GitHub HTTPS");
		if (parsed.username || parsed.password || parsed.search || parsed.hash)
			fail("descriptor URL must not contain credentials, query, or fragment");
		const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/runs\/([1-9]\d*)\/artifacts\/([1-9]\d*)$/u.exec(
			parsed.pathname,
		);
		if (!match) fail("descriptor URL must be a canonical Actions artifact route");
		const owner = match[1]!;
		const repo = match[2]!;
		const workflowRunId = integerField(Number(match[3]), "descriptor workflow run ID");
		const artifactId = integerField(Number(match[4]), "descriptor artifact ID");
		if (text !== actionsArtifactUrl(owner, repo, workflowRunId, artifactId)) fail("descriptor URL is not canonical");
		if (repository) {
			const requested = repositoryParts(repository, "repository");
			if (`${owner}/${repo}`.toLowerCase() !== `${requested.owner}/${requested.repo}`.toLowerCase())
				fail("descriptor repository differs from CLI repository");
		}
		return { owner, repo, workflowRunId, artifactId };
	}
	return undefined;
}

async function loadDescriptorArtifact(
	reference: DescriptorArtifactReference,
	api: GitHubApi,
): Promise<LoadedDescriptor> {
	const artifactPath = `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}/actions/artifacts/${reference.artifactId}`;
	const artifact = object(await api.get(artifactPath), "descriptor Actions artifact");
	if (integerField(artifact.id, "descriptor Actions artifact.id") !== reference.artifactId)
		fail("descriptor Actions artifact ID differs from requested artifact");
	const descriptorArtifactCreatedAt = timestampField(artifact.created_at, "descriptor Actions artifact.created_at");
	if (artifact.expired !== false) fail("descriptor Actions artifact is expired or expiration metadata is unavailable");
	const size = integerField(artifact.size_in_bytes, "descriptor Actions artifact.size_in_bytes");
	const digest = stringField(artifact.digest, "descriptor Actions artifact.digest");
	const digestMatch = /^sha256:([0-9a-f]{64})$/iu.exec(digest);
	if (!digestMatch) fail("descriptor Actions artifact digest is unavailable");
	const artifactName = stringField(artifact.name, "descriptor Actions artifact.name");
	const artifactRun = object(artifact.workflow_run, "descriptor Actions artifact.workflow_run");
	const workflowRunId = integerField(artifactRun.id, "descriptor Actions artifact.workflow_run.id");
	if (reference.workflowRunId !== undefined && workflowRunId !== reference.workflowRunId)
		fail("descriptor Actions artifact workflow run differs from requested route");
	const expectedArchiveUrl = actionsArchiveUrl(reference.owner, reference.repo, reference.artifactId);
	if (
		stringField(artifact.archive_download_url, "descriptor Actions artifact.archive_download_url") !==
		expectedArchiveUrl
	)
		fail("descriptor Actions artifact archive URL is not the canonical API route");
	const runPath = `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}/actions/runs/${workflowRunId}`;
	const run = object(await api.get(runPath), "descriptor Actions workflow run");
	if (integerField(run.id, "descriptor Actions workflow run.id") !== workflowRunId)
		fail("descriptor Actions workflow run ID differs from artifact metadata");
	if (
		stringField(run.html_url, "descriptor Actions workflow run.html_url") !==
		actionsRunUrl(reference.owner, reference.repo, workflowRunId)
	)
		fail("descriptor Actions workflow run URL differs from repository binding");
	const runRepository = object(run.repository, "descriptor Actions workflow run.repository");
	const runRepositoryId = integerField(runRepository.id, "descriptor Actions workflow run.repository.id");
	if (
		stringField(runRepository.full_name, "descriptor Actions workflow run.repository.full_name").toLowerCase() !==
		`${reference.owner}/${reference.repo}`.toLowerCase()
	)
		fail("descriptor Actions workflow run repository differs from requested route");
	if (
		integerField(artifactRun.repository_id, "descriptor Actions artifact.workflow_run.repository_id") !==
		runRepositoryId
	)
		fail("descriptor Actions artifact workflow run repository identity differs from run");
	const runAttempt = integerField(run.run_attempt, "descriptor Actions workflow run.run_attempt");
	const archive = await api.download(expectedArchiveUrl);
	if (archive.byteLength !== size) fail("descriptor artifact download byte length differs from Actions metadata");
	if (sha256Bytes(archive).toLowerCase() !== digestMatch[1]!.toLowerCase())
		fail("descriptor artifact download SHA-256 differs from Actions metadata");
	const extracted = extractSanitizedArchive(archive);
	if (extracted.files.size !== 1 || !extracted.files.has(PET_RENDERER_VISUAL_DESCRIPTOR_MEMBER))
		fail(`descriptor archive must contain exactly ${PET_RENDERER_VISUAL_DESCRIPTOR_MEMBER}`);
	const descriptorBytes = extracted.files.get(PET_RENDERER_VISUAL_DESCRIPTOR_MEMBER)!;
	const descriptorText = decodeFile(descriptorBytes, PET_RENDERER_VISUAL_DESCRIPTOR_MEMBER);
	assertSafeEvidenceText(descriptorText, PET_RENDERER_VISUAL_DESCRIPTOR_MEMBER);
	const descriptor = object(
		parseJson(descriptorText, PET_RENDERER_VISUAL_DESCRIPTOR_MEMBER),
		"descriptor",
	) as unknown as PetRendererVisualPublicationDescriptor;
	validatePublicationDescriptor(descriptor);
	if (
		descriptor.owner.toLowerCase() !== reference.owner.toLowerCase() ||
		descriptor.repo.toLowerCase() !== reference.repo.toLowerCase() ||
		descriptor.workflow_run_id !== workflowRunId
	)
		fail("descriptor identity differs from descriptor artifact route");
	if (stringField(run.event, "descriptor Actions workflow run.event") !== descriptor.workflow_event)
		fail("descriptor Actions workflow run event differs from descriptor");
	const expectedWorkflowHeadRepositoryId = expectedWorkflowRunHeadRepositoryId(descriptor);
	if (fullSha(run.head_sha, "descriptor Actions workflow run.head_sha") !== descriptor.workflow_ref_sha.toLowerCase())
		fail("descriptor Actions workflow run ref differs from descriptor");
	if (descriptor.workflow_event === "pull_request") {
		if (!Array.isArray(run.pull_requests))
			fail("descriptor Actions workflow run pull request binding is unavailable");
		const matchingPullRequests = run.pull_requests.filter(value => {
			const pullRequest = object(value, "descriptor Actions workflow run pull request");
			return (
				integerField(pullRequest.number, "descriptor Actions workflow run pull request.number") ===
				descriptor.pr_number
			);
		});
		if (matchingPullRequests.length !== 1) fail("descriptor Actions workflow run PR binding is ambiguous or missing");
		const runPullRequest = object(matchingPullRequests[0], "descriptor Actions workflow run pull request");
		const runHead = object(runPullRequest.head, "descriptor Actions workflow run pull request.head");
		const runBase = object(runPullRequest.base, "descriptor Actions workflow run pull request.base");
		if (
			fullSha(runHead.sha, "descriptor Actions workflow run pull request.head.sha") !==
			descriptor.head_sha.toLowerCase()
		)
			fail("descriptor Actions workflow run pull request head differs from descriptor");
		if (
			fullSha(runBase.sha, "descriptor Actions workflow run pull request.base.sha") !==
			descriptor.base_sha.toLowerCase()
		)
			fail("descriptor Actions workflow run pull request base differs from descriptor");
	}
	if (
		integerField(artifactRun.head_repository_id, "descriptor Actions artifact.workflow_run.head_repository_id") !==
		expectedWorkflowHeadRepositoryId
	)
		fail("descriptor Actions artifact workflow run head repository differs from descriptor");
	const provenance: PetRendererVisualDescriptorArtifactProvenance = {
		schema_version: PET_RENDERER_VISUAL_DESCRIPTOR_PROVENANCE_SCHEMA_VERSION,
		schema: PET_RENDERER_VISUAL_DESCRIPTOR_PROVENANCE_SCHEMA,
		artifact_id: reference.artifactId,
		artifact_name: artifactName,
		artifact_digest: digest.toLowerCase(),
		workflow_run_id: workflowRunId,
		workflow_run_attempt: runAttempt,
		repository: `${reference.owner}/${reference.repo}`,
		pr_number: descriptor.pr_number,
		pr_node_id: descriptor.pr_node_id,
		head_sha: descriptor.head_sha.toLowerCase(),
		base_sha: descriptor.base_sha.toLowerCase(),
	};
	validateDescriptorArtifactProvenance(provenance);
	return { descriptor, provenance, artifactCreatedAt: descriptorArtifactCreatedAt };
}

async function loadDescriptor(
	input: string | number,
	api: GitHubApi,
	repository: string | undefined,
): Promise<LoadedDescriptor> {
	const reference = descriptorArtifactReference(input, repository);
	if (!reference) fail("descriptor must be a canonical run-scoped GitHub Actions artifact URL or ID");
	return loadDescriptorArtifact(reference, api);
}

function safeArchivePath(value: string): void {
	if (!value || value.includes("\\") || value.startsWith("/") || value.includes("//"))
		fail(`unsafe archive path ${value}`);
	const parts = value.split("/");
	if (parts.some(part => part === "" || part === "." || part === "..") || /^[A-Za-z]:/u.test(value))
		fail(`unsafe archive path ${value}`);
	if (/^(?:.*(?:^|\/))(?:raw-pty|.*pty-capture|\.gjc)(?:\/|$)/iu.test(value)) fail(`unsafe archive path ${value}`);
}

interface ZipMeta {
	name: string;
	compressedSize: number;
	uncompressedSize: number;
	externalAttributes: number;
}

function readU16(view: DataView, offset: number): number {
	return view.getUint16(offset, true);
}
function readU32(view: DataView, offset: number): number {
	return view.getUint32(offset, true);
}

function inspectZip(bytes: Uint8Array): ZipMeta[] {
	if (bytes.byteLength < 22 || bytes.byteLength > MAX_ARCHIVE_BYTES) fail("archive size is outside safe bounds");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let eocd = -1;
	for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 22 - 0xffff); offset -= 1) {
		if (readU32(view, offset) === 0x06054b50) {
			eocd = offset;
			break;
		}
	}
	if (eocd < 0) fail("archive is not a ZIP or has no end record");
	const count = readU16(view, eocd + 10);
	const centralSize = readU32(view, eocd + 12);
	const centralOffset = readU32(view, eocd + 16);
	if (count < 1 || count > MAX_ARCHIVE_FILES || centralOffset + centralSize > eocd)
		fail("invalid ZIP central directory");
	const entries: ZipMeta[] = [];
	let totalUncompressed = 0;
	let offset = centralOffset;
	for (let index = 0; index < count; index += 1) {
		if (offset + 46 > bytes.byteLength || readU32(view, offset) !== 0x02014b50) fail("invalid ZIP central entry");
		const compressedSize = readU32(view, offset + 20);
		const uncompressedSize = readU32(view, offset + 24);
		const nameLength = readU16(view, offset + 28);
		const extraLength = readU16(view, offset + 30);
		const commentLength = readU16(view, offset + 32);
		const nameStart = offset + 46;
		if (nameStart + nameLength + extraLength + commentLength > bytes.byteLength) fail("truncated ZIP entry");
		const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(nameStart, nameStart + nameLength));
		safeArchivePath(name);
		const externalAttributes = readU32(view, offset + 38);
		const mode = (externalAttributes >>> 16) & 0xf000;
		if (mode === 0xa000) fail(`symlink entry ${name} is not allowed`);
		if (name.endsWith("/")) fail(`directory entry ${name} is not allowed`);
		if (uncompressedSize > MAX_UNCOMPRESSED_BYTES || compressedSize > MAX_ARCHIVE_BYTES)
			fail(`oversized ZIP entry ${name}`);
		totalUncompressed += uncompressedSize;
		if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) fail("archive central directory expands beyond safe bounds");
		entries.push({ name, compressedSize, uncompressedSize, externalAttributes });
		offset = nameStart + nameLength + extraLength + commentLength;
	}
	return entries;
}

export interface ExtractedArchive {
	bytes: Uint8Array;
	files: ReadonlyMap<string, Uint8Array>;
}

export function extractSanitizedArchive(bytes: Uint8Array): ExtractedArchive {
	const metadata = inspectZip(bytes);
	const names = new Set<string>();
	for (const entry of metadata) {
		if (names.has(entry.name)) fail(`duplicate archive entry ${entry.name}`);
		names.add(entry.name);
	}
	let files: Record<string, Uint8Array>;
	try {
		files = unzipSync(bytes);
	} catch (error) {
		fail(`archive decompression failed (${error instanceof Error ? error.message : String(error)})`);
	}
	let total = 0;
	const result = new Map<string, Uint8Array>();
	for (const entry of metadata) {
		const data = files[entry.name];
		if (!data || data.byteLength !== entry.uncompressedSize) fail(`archive entry size mismatch for ${entry.name}`);
		total += data.byteLength;
		if (total > MAX_UNCOMPRESSED_BYTES) fail("archive expands beyond safe bounds");
		result.set(entry.name, data);
	}
	if (result.size !== metadata.length) fail("archive contains unrecognized entries");
	return { bytes, files: result };
}

function decodeFile(data: Uint8Array, field: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(data);
	} catch {
		fail(`${field} is not valid UTF-8`);
	}
}

function findUnique(files: ReadonlyMap<string, Uint8Array>, basename: string): [string, Uint8Array] {
	const found = [...files.entries()].filter(([name]) => path.posix.basename(name) === basename);
	if (found.length !== 1) fail(`archive must contain exactly one ${basename}`);
	return found[0]!;
}
function validateBoundArchiveMember(
	extracted: ExtractedArchive,
	descriptor: PetRendererVisualPublicationDescriptor,
	required: boolean,
): void {
	const archive = extracted.files.get(PET_RENDERER_VISUAL_ARCHIVE_MEMBER);
	if (!archive) {
		if (required) fail(`bound sanitized archive ${PET_RENDERER_VISUAL_ARCHIVE_MEMBER} is unavailable`);
		return;
	}
	if (archive.byteLength !== descriptor.archive_byte_length)
		fail("bound sanitized archive byte length differs from descriptor");
	if (sha256Bytes(archive).toLowerCase() !== descriptor.archive_sha256.toLowerCase())
		fail("bound sanitized archive SHA-256 differs from descriptor");
}
function validateManifestSafety(manifest: PetRendererVisualManifest): void {
	const safeText = (value: unknown, field: string): void => {
		if (typeof value !== "string") fail(`${field} is malformed`);
		assertSafeEvidenceText(value, field);
	};
	safeText(manifest.capture_tool, "manifest.capture_tool");
	safeText(manifest.command, "manifest.command");
	safeText(manifest.provenance.repository_root, "manifest.provenance.repository_root");
	for (const entry of manifest.entries) {
		for (const value of [entry.key, entry.state_id, entry.profile, entry.mode])
			safeText(value, `manifest entry ${entry.key}`);
		for (const file of entry.files) safeText(file.path, `manifest file ${file.path}`);
	}
	for (const value of [
		...manifest.provenance.untracked_files,
		...manifest.provenance.changed_files,
		...manifest.provenance.source_files.map(file => file.path),
	]) {
		safeText(value, "manifest provenance path");
	}
}
function validateReviewInput(
	value: unknown,
	descriptor: PetRendererVisualPublicationDescriptor,
	manifest: PetRendererVisualManifest,
): void {
	const input = object(value, "visual-review-input.json") as unknown as PetRendererVisualReviewInput;
	if (input.schema_version !== 1 || input.capture_mode !== "fixture") fail("invalid visual review input");
	if (
		typeof input.manifest_sha256 !== "string" ||
		typeof input.head_sha !== "string" ||
		typeof input.base_sha !== "string" ||
		input.manifest_sha256.toLowerCase() !== descriptor.manifest_sha256.toLowerCase() ||
		input.head_sha.toLowerCase() !== descriptor.head_sha.toLowerCase() ||
		input.base_sha.toLowerCase() !== descriptor.base_sha.toLowerCase() ||
		input.expected_entry_count !== manifest.entry_count
	)
		fail("visual review input binding mismatch");
	if (!Array.isArray(input.review_requirements) || input.review_requirements.length < 1)
		fail("visual review requirements are missing");
	for (const requirement of input.review_requirements) {
		if (typeof requirement !== "string") fail("visual review requirement is malformed");
		assertSafeEvidenceText(requirement, "visual review requirement");
	}
}
const CANONICAL_TERMINAL_STYLE =
	"body{margin:0;background:#111;color:#eee}pre{margin:0;padding:1em;white-space:pre-wrap;font-family:ui-monospace,monospace}";
const CANONICAL_TERMINAL_PREFIX = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Pet renderer visual evidence</title><style>${CANONICAL_TERMINAL_STYLE}</style></head><body><pre>`;
const CANONICAL_TERMINAL_SUFFIX = "</pre></body></html>\n";
const CANONICAL_TERMINAL_TEXT =
	/^(?:[^&<>"\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|&amp;|&lt;|&gt;|&quot;)*$/u;

function validateTerminalHtml(value: string, field: string): void {
	assertSafeEvidenceText(value, field);
	if (!value.startsWith(CANONICAL_TERMINAL_PREFIX) || !value.endsWith(CANONICAL_TERMINAL_SUFFIX))
		fail(`${field} is not a canonical terminal representation`);
	const escapedTerminalText = value.slice(CANONICAL_TERMINAL_PREFIX.length, -CANONICAL_TERMINAL_SUFFIX.length);
	if (!CANONICAL_TERMINAL_TEXT.test(escapedTerminalText)) fail(`${field} contains non-canonical terminal text`);
	const canonical = `${CANONICAL_TERMINAL_PREFIX}${escapedTerminalText}${CANONICAL_TERMINAL_SUFFIX}`;
	if (canonical !== value) fail(`${field} is not a canonical terminal representation`);
}

function validateEvidenceFile(pathname: string, value: string): void {
	const basename = path.posix.basename(pathname);
	if (basename === "terminal.html") {
		validateTerminalHtml(value, pathname);
		return;
	}
	assertSafeEvidenceText(value, pathname);
	if (basename === "terminal-ansi.txt") {
		try {
			decodeTerminalControls(value);
		} catch (error) {
			fail(
				`${pathname} has invalid terminal control encoding (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}
}

export function validatePublicationArchive(
	archive: Uint8Array,
	descriptor: PetRendererVisualPublicationDescriptor,
): { manifest: PetRendererVisualManifest } {
	if (archive.byteLength !== descriptor.artifact_byte_length)
		fail("downloaded archive byte length differs from descriptor");
	const digest = sha256Bytes(archive);
	if (digest.toLowerCase() !== descriptor.artifact_sha256.toLowerCase())
		fail("downloaded archive SHA-256 differs from descriptor");
	const extracted = extractSanitizedArchive(archive);
	validateBoundArchiveMember(extracted, descriptor, false);
	const [manifestPath, manifestBytes] = findUnique(extracted.files, "manifest.json");
	const manifestText = decodeFile(manifestBytes, "manifest.json");
	assertSafeEvidenceText(manifestText, "manifest.json");
	const manifest = parseJson(manifestText, "manifest.json") as PetRendererVisualManifest;
	validateManifest(manifest);
	validateManifestSafety(manifest);
	if (sha256Bytes(manifestBytes).toLowerCase() !== descriptor.manifest_sha256.toLowerCase())
		fail("manifest SHA-256 differs from descriptor");
	if (manifest.entry_count !== descriptor.manifest_entry_count) fail("manifest entry count differs from descriptor");
	const inputCandidates = [...extracted.files.entries()].filter(
		([name]) => path.posix.basename(name) === "visual-review-input.json",
	);
	if (inputCandidates.length !== 1) fail("archive must contain exactly one visual review input");
	const inputText = decodeFile(inputCandidates[0]![1], "visual-review-input.json");
	assertSafeEvidenceText(inputText, "visual-review-input.json");
	validateReviewInput(parseJson(inputText, "visual-review-input.json"), descriptor, manifest);
	const expected = new Set<string>([manifestPath, ...(inputCandidates.length === 1 ? [inputCandidates[0]![0]] : [])]);
	for (const entry of manifest.entries) {
		for (const file of entry.files) {
			if (expected.has(file.path)) fail(`duplicate manifest archive path ${file.path}`);
			expected.add(file.path);
			const bytes = extracted.files.get(file.path);
			if (!bytes) fail(`manifest file is absent from archive: ${file.path}`);
			if (bytes.byteLength !== file.byte_length || sha256Bytes(bytes).toLowerCase() !== file.sha256.toLowerCase())
				fail(`manifest file digest mismatch: ${file.path}`);
			assertNoReceiptFile(file.path);
			validateEvidenceFile(file.path, decodeFile(bytes, file.path));
		}
	}
	for (const name of extracted.files.keys()) {
		assertNoReceiptFile(name);
		if (name === PET_RENDERER_VISUAL_ARCHIVE_MEMBER) continue;
		if (!expected.has(name)) fail(`archive contains non-allowlisted file ${name}`);
	}
	if (expected.size + (extracted.files.has(PET_RENDERER_VISUAL_ARCHIVE_MEMBER) ? 1 : 0) !== extracted.files.size)
		fail("archive file allowlist mismatch");
	return { manifest };
}

function identity(value: unknown, field: string): PetRendererVisualApiIdentity {
	const record = object(value, field);
	const id = integerField(record.id, `${field}.id`);
	const nodeId = stringField(record.node_id, `${field}.node_id`);
	return { id, node_id: nodeId, ...(typeof record.login === "string" ? { login: record.login } : {}) };
}
function assertHumanIndependentReviewer(review: JsonObject): void {
	const reviewerType = object(review.user, "authenticated review author").type;
	if (reviewerType !== "User") fail("authenticated review author must be a human user");
	if (review.performed_via_github_app !== undefined && review.performed_via_github_app !== null)
		fail("authenticated review must not be performed via a GitHub App");
}

function assertIdentityNotExcluded(
	reviewer: PetRendererVisualApiIdentity,
	excluded: PetRendererVisualApiIdentity[],
): void {
	for (const candidate of excluded) {
		if (reviewer.id === candidate.id || reviewer.node_id === candidate.node_id)
			fail("reviewer overlaps an excluded immutable identity");
	}
}

function reviewUrlMatches(url: string, owner: string, repo: string, pr: number, reviewId: number): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		fail("review URL is not an absolute URL");
	}
	if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com")
		fail("review URL is not canonical GitHub HTTPS");
	if (
		parsed.pathname.toLowerCase() !== `/${owner}/${repo}/pull/${pr}` ||
		parsed.hash.toLowerCase() !== `#pullrequestreview-${reviewId}`
	)
		fail("review URL does not identify descriptor PR/review");
}

function assertRepository(
	parent: JsonObject,
	descriptor: PetRendererVisualPublicationDescriptor,
	canonical: JsonObject,
	field: string,
): void {
	const repository = object(parent.repository, `${field}.repository`);
	const fullName = stringField(
		repository.full_name ?? repository.full_name_with_owner ?? repository.nameWithOwner,
		`${field}.repository.full_name`,
	);
	if (fullName.toLowerCase() !== `${descriptor.owner}/${descriptor.repo}`.toLowerCase())
		fail(`${field} repository mismatch`);
	const canonicalRepo = object(object(canonical.base, "PR.base").repo, "PR.base.repo");
	const canonicalId = integerField(canonicalRepo.id, "PR.base.repo.id");
	const canonicalNode = stringField(canonicalRepo.node_id, "PR.base.repo.node_id");
	if (repository.id !== canonicalId || repository.node_id !== canonicalNode)
		fail(`${field} repository identity mismatch`);
}

function assertPrParent(
	parent: JsonObject,
	descriptor: PetRendererVisualPublicationDescriptor,
	canonical: JsonObject,
	field: string,
): void {
	const number = integerField(parent.number, `${field}.number`);
	if (number !== descriptor.pr_number || number !== integerField(canonical.number, "PR.number"))
		fail(`${field} PR number mismatch`);
	const id = parent.id ?? parent.node_id;
	const canonicalId = canonical.id ?? canonical.node_id;
	if (id !== canonicalId && parent.node_id !== canonical.node_id) fail(`${field} PR identity mismatch`);
	assertRepository(parent, descriptor, canonical, field);
}
function assertWorkflowRunPrParent(
	parent: JsonObject,
	descriptor: PetRendererVisualPublicationDescriptor,
	canonical: JsonObject,
	field: string,
): void {
	const number = integerField(parent.number, `${field}.number`);
	if (number !== descriptor.pr_number || number !== integerField(canonical.number, "PR.number"))
		fail(`${field} PR number mismatch`);
	const canonicalId = canonical.id ?? canonical.node_id;
	if (parent.id !== undefined && parent.id !== null && parent.id !== canonicalId)
		fail(`${field} PR identity mismatch`);
	if (parent.node_id !== undefined && parent.node_id !== null && parent.node_id !== canonical.node_id)
		fail(`${field} PR identity mismatch`);

	const canonicalRepo = object(object(canonical.base, "PR.base").repo, "PR.base.repo");
	const bindOptionalRepository = (side: "head" | "base"): void => {
		const sideValue = parent[side];
		if (sideValue === undefined || sideValue === null) return;
		const sideObject = object(sideValue, `${field}.${side}`);
		const repoValue = sideObject.repo;
		if (repoValue === undefined || repoValue === null) return;
		const repository = object(repoValue, `${field}.${side}.repo`);
		const expectedName = descriptor[`${side}_repository`];
		const expectedId = descriptor[`${side}_repository_id`];
		const fullName = repository.full_name ?? repository.full_name_with_owner ?? repository.nameWithOwner;
		if (
			fullName !== undefined &&
			fullName !== null &&
			stringField(fullName, `${field}.${side}.repo.full_name`).toLowerCase() !== expectedName.toLowerCase()
		)
			fail(`${field} ${side} repository differs from descriptor`);
		if (
			repository.id !== undefined &&
			repository.id !== null &&
			integerField(repository.id, `${field}.${side}.repo.id`) !== expectedId
		)
			fail(`${field} ${side} repository ID differs from descriptor`);
	};
	bindOptionalRepository("head");
	bindOptionalRepository("base");

	const repositoryValue = parent.repository;
	if (repositoryValue !== undefined && repositoryValue !== null) {
		const repository = object(repositoryValue, `${field}.repository`);
		const fullName = repository.full_name ?? repository.full_name_with_owner ?? repository.nameWithOwner;
		if (
			fullName !== undefined &&
			fullName !== null &&
			stringField(fullName, `${field}.repository.full_name`).toLowerCase() !==
				`${descriptor.owner}/${descriptor.repo}`.toLowerCase()
		)
			fail(`${field} repository mismatch`);
		if (
			repository.id !== undefined &&
			repository.id !== null &&
			integerField(repository.id, `${field}.repository.id`) !== integerField(canonicalRepo.id, "PR.base.repo.id")
		)
			fail(`${field} repository identity mismatch`);
		if (
			repository.node_id !== undefined &&
			repository.node_id !== null &&
			stringField(repository.node_id, `${field}.repository.node_id`) !==
				stringField(canonicalRepo.node_id, "PR.base.repo.node_id")
		)
			fail(`${field} repository identity mismatch`);
	}
}
async function validateActionsArtifactBinding(
	api: GitHubApi,
	descriptor: PetRendererVisualPublicationDescriptor,
	canonical: JsonObject,
): Promise<{
	archiveUrl: string;
	executor: PetRendererVisualApiIdentity;
	triggeringActor: PetRendererVisualApiIdentity;
}> {
	const artifactPath = `/repos/${encodeURIComponent(descriptor.owner)}/${encodeURIComponent(descriptor.repo)}/actions/artifacts/${descriptor.artifact_id}`;
	const artifact = object(await api.get(artifactPath), "Actions artifact");
	if (integerField(artifact.id, "Actions artifact.id") !== descriptor.artifact_id)
		fail("Actions artifact ID differs from descriptor");
	const artifactName = stringField(artifact.name, "Actions artifact.name");
	if (artifactName !== descriptor.artifact_name) fail("Actions artifact name differs from descriptor");
	if (artifact.expired !== false) fail("Actions artifact is expired or expiration metadata is unavailable");
	if (integerField(artifact.size_in_bytes, "Actions artifact.size_in_bytes") !== descriptor.artifact_byte_length)
		fail("Actions artifact size differs from descriptor");
	const digest = stringField(artifact.digest, "Actions artifact.digest");
	const digestMatch = /^sha256:([0-9a-f]{64})$/iu.exec(digest);
	if (!digestMatch || digestMatch[1]!.toLowerCase() !== descriptor.artifact_sha256.toLowerCase())
		fail("Actions artifact digest differs from descriptor");
	const archiveDownloadUrl = stringField(artifact.archive_download_url, "Actions artifact.archive_download_url");
	const expectedApiArchiveUrl = actionsArchiveUrl(descriptor.owner, descriptor.repo, descriptor.artifact_id);
	if (archiveDownloadUrl !== expectedApiArchiveUrl)
		fail("Actions artifact archive URL differs from descriptor binding");
	const artifactRun = object(artifact.workflow_run, "Actions artifact.workflow_run");
	if (integerField(artifactRun.id, "Actions artifact.workflow_run.id") !== descriptor.workflow_run_id)
		fail("Actions artifact workflow run differs from descriptor");
	const canonicalRepo = object(object(canonical.base, "PR.base").repo, "PR.base.repo");
	const canonicalRepositoryId = integerField(canonicalRepo.id, "PR.base.repo.id");
	if (integerField(artifactRun.repository_id, "Actions artifact.workflow_run.repository_id") !== canonicalRepositoryId)
		fail("Actions artifact workflow run repository differs from canonical PR");
	const expectedWorkflowHeadRepositoryId = expectedWorkflowRunHeadRepositoryId(descriptor);
	if (
		integerField(artifactRun.head_repository_id, "Actions artifact.workflow_run.head_repository_id") !==
		expectedWorkflowHeadRepositoryId
	)
		fail("Actions artifact workflow run head repository differs from descriptor");
	if (
		fullSha(artifactRun.head_sha, "Actions artifact.workflow_run.head_sha") !==
		descriptor.workflow_ref_sha.toLowerCase()
	)
		fail("Actions artifact workflow run ref differs from descriptor");

	const runPath = `/repos/${encodeURIComponent(descriptor.owner)}/${encodeURIComponent(descriptor.repo)}/actions/runs/${descriptor.workflow_run_id}`;
	const run = object(await api.get(runPath), "Actions workflow run");
	if (integerField(run.id, "Actions workflow run.id") !== descriptor.workflow_run_id)
		fail("Actions workflow run ID differs from descriptor");
	const runAttempt = integerField(run.run_attempt, "Actions workflow run.run_attempt");
	if (runAttempt !== descriptor.workflow_run_attempt) fail("Actions workflow run attempt differs from descriptor");
	if (stringField(run.html_url, "Actions workflow run.html_url") !== descriptor.run_url)
		fail("Actions workflow run URL differs from descriptor");
	assertRepository({ repository: run.repository }, descriptor, canonical, "Actions workflow run");
	if (stringField(run.event, "Actions workflow run.event") !== descriptor.workflow_event)
		fail("Actions workflow run event differs from descriptor");
	if (fullSha(run.head_sha, "Actions workflow run.head_sha") !== descriptor.workflow_ref_sha.toLowerCase())
		fail("Actions workflow run ref differs from descriptor");

	if (descriptor.workflow_event === "pull_request") {
		if (!Array.isArray(run.pull_requests) || run.pull_requests.length < 1)
			fail("Actions workflow run pull request binding is unavailable");
		const matchingPullRequests = run.pull_requests.filter(value => {
			const pullRequest = object(value, "Actions workflow run pull request");
			return integerField(pullRequest.number, "Actions workflow run pull request.number") === descriptor.pr_number;
		});
		if (matchingPullRequests.length !== 1) fail("Actions workflow run PR binding is ambiguous or missing");
		const runPullRequest = object(matchingPullRequests[0], "Actions workflow run pull request");
		const runHead = object(runPullRequest.head, "Actions workflow run pull request.head");
		const runBase = object(runPullRequest.base, "Actions workflow run pull request.base");
		if (fullSha(runHead.sha, "Actions workflow run pull request.head.sha") !== descriptor.head_sha.toLowerCase())
			fail("Actions workflow run pull request head differs from descriptor");
		assertWorkflowRunPrParent(runPullRequest, descriptor, canonical, "Actions workflow run pull request");
		if (fullSha(runBase.sha, "Actions workflow run pull request.base.sha") !== descriptor.base_sha.toLowerCase())
			fail("Actions workflow run pull request base differs from descriptor");
	}
	const executor = identity(run.actor, "Actions workflow run actor");
	const triggeringActor = identity(run.triggering_actor, "Actions workflow run triggering actor");
	return { archiveUrl: expectedApiArchiveUrl, executor, triggeringActor };
}

function restPath(owner: string, repo: string, pr: number): string {
	return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr}`;
}
function assertCanonicalApiArchiveUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		fail("artifact download URL is malformed");
	}
	if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "api.github.com" || parsed.port)
		fail("artifact download URL must use the GitHub API origin");
	if (parsed.username || parsed.password || parsed.search || parsed.hash)
		fail("artifact download URL must not contain credentials, query, or fragment");
	const match = /^\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/artifacts\/([1-9]\d*)\/zip$/u.exec(
		parsed.pathname,
	);
	if (!match || url !== actionsArchiveUrl(match[1]!, match[2]!, integerField(Number(match[3]), "artifact ID")))
		fail("artifact download URL is not a canonical Actions API route");
}

async function readResponseBytes(response: Response, limit: number, field: string): Promise<Uint8Array> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null && (!/^\d+$/u.test(contentLength) || Number(contentLength) > limit))
		fail(`${field} Content-Length exceeds safe bounds`);
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	let buffer = new Uint8Array(Math.min(limit, 64 * 1024));
	let total = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value.length === 0) continue;
			if (value.length > limit - total) {
				try {
					await reader.cancel();
				} catch {}
				fail(`${field} exceeds safe bounds`);
			}
			if (total + value.length > buffer.length) {
				const grown = new Uint8Array(Math.min(limit, Math.max(total + value.length, buffer.length * 2)));
				grown.set(buffer);
				buffer = grown;
			}
			buffer.set(value, total);
			total += value.length;
		}
		return buffer.slice(0, total);
	} catch (error) {
		try {
			await reader.cancel();
		} catch {}
		throw error;
	} finally {
		reader.releaseLock();
	}
}

async function readResponseJson(response: Response, field: string): Promise<unknown> {
	const bytes = await readResponseBytes(response, MAX_JSON_BYTES, field);
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch (error) {
		fail(`${field} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
}

function createGitHubApiAdapterWithFetch(token: string, fetcher: typeof fetch): GitHubApi {
	if (!token.trim()) fail("GitHub token is required");
	const headers = {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"x-github-api-version": "2022-11-28",
	};
	const json = async (url: string): Promise<unknown> => {
		const response = await fetcher(url, { method: "GET", headers });
		if (!response.ok) fail(`GitHub API request failed (${response.status})`);
		return readResponseJson(response, "GitHub API response");
	};
	return {
		get: requestPath => json(`https://api.github.com${requestPath}`),
		download: async url => {
			assertCanonicalApiArchiveUrl(url);
			const response = await fetcher(url, { method: "GET", headers });
			if (!response.ok) fail(`artifact download failed (${response.status})`);
			return readResponseBytes(response, MAX_ARCHIVE_BYTES, "artifact download");
		},
		graphql: async (query, variables) => {
			const response = await fetcher("https://api.github.com/graphql", {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({ query, variables }),
			});
			if (!response.ok) fail(`GitHub GraphQL request failed (${response.status})`);
			const payload = object(await readResponseJson(response, "GitHub GraphQL response"), "GraphQL response");
			if (payload.errors) fail("GitHub GraphQL returned errors");
			return payload.data;
		},
	};
}

/** Production transport adapter; it always uses the global fetch implementation. */
export function createGitHubApiAdapter(token: string): GitHubApi {
	return createGitHubApiAdapterWithFetch(token, globalThis.fetch);
}

/** Test-only transport seam; production verification always uses the global fetch adapter. */
export function createGitHubApiAdapterForTest(token: string, fetcher: typeof fetch): GitHubApi {
	return createGitHubApiAdapterWithFetch(token, fetcher);
}

async function loadCommits(
	api: GitHubApi,
	owner: string,
	repo: string,
	pr: number,
): Promise<PetRendererVisualApiIdentity[]> {
	const identities: PetRendererVisualApiIdentity[] = [];
	for (let page = 1; page <= 100; page += 1) {
		const value = await api.get(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr}/commits?per_page=${PAGE_SIZE}&page=${page}`,
		);
		if (!Array.isArray(value) || (value.length === 0 && page === 1))
			fail("PR commits API response is unavailable or empty");
		if (!Array.isArray(value)) fail("PR commits API response is malformed");
		for (const commit of value) {
			const record = object(commit, "PR commit");
			if (record.author !== null && record.author !== undefined)
				identities.push(identity(record.author, "PR commit author"));
			if (record.committer !== null && record.committer !== undefined)
				identities.push(identity(record.committer, "PR commit committer"));
		}
		if (value.length < PAGE_SIZE) return identities;
	}
	fail("PR commits pagination exceeded safe bounds");
}

const REVIEW_GRAPHQL = `query($id: ID!) { node(id: $id) { ... on PullRequestReview { id databaseId commit { oid } submittedAt author { id databaseId } pullRequest { id number repository { id databaseId nameWithOwner } } } } }`;

async function verifyPetRendererVisualPublicationInternal(
	options: VerifyPublicationOptions,
	api: GitHubApi,
	executorOverride?: PetRendererVisualApiIdentity,
): Promise<VerifiedPublication> {
	if (typeof options.descriptor !== "string" && typeof options.descriptor !== "number")
		fail("descriptor must be a canonical run-scoped GitHub Actions artifact URL or ID");
	const descriptorReference = descriptorArtifactReference(options.descriptor, options.repository);
	if (!descriptorReference) fail("descriptor must be a canonical run-scoped GitHub Actions artifact URL or ID");
	const loadedDescriptor = await loadDescriptor(options.descriptor, api, options.repository);
	const descriptor = loadedDescriptor.descriptor;
	const requestedReviewId = integerField(options.reviewId, "review-id");
	if (!/^[A-Za-z0-9_.-]+$/u.test(descriptor.owner) || !/^[A-Za-z0-9_.-]+$/u.test(descriptor.repo))
		fail("descriptor repository identity is malformed");
	if (
		options.repository &&
		options.repository.toLowerCase() !== `${descriptor.owner}/${descriptor.repo}`.toLowerCase()
	)
		fail("CLI repository differs from descriptor");
	if (options.pr !== undefined && options.pr !== descriptor.pr_number) fail("CLI PR differs from descriptor");
	const endpoint = restPath(descriptor.owner, descriptor.repo, descriptor.pr_number);
	const initial = object(await api.get(endpoint), "canonical PR");
	const canonicalNumber = integerField(initial.number, "PR.number");
	const canonicalNode = stringField(initial.node_id, "PR.node_id");
	if (canonicalNumber !== descriptor.pr_number || canonicalNode !== descriptor.pr_node_id)
		fail("canonical PR identity differs from descriptor");
	assertPrRepositoryBindings(initial, descriptor, "canonical PR");
	const initialHead = fullSha(object(initial.head, "PR.head").sha, "PR.head.sha");
	const initialBase = fullSha(object(initial.base, "PR.base").sha, "PR.base.sha");
	assertRepository(
		{ repository: object(object(initial.base, "PR.base").repo, "PR.base.repo") },
		descriptor,
		initial,
		"canonical PR",
	);
	assertHeadBinding(descriptor.head_sha, descriptor.base_sha, initialHead);
	if (initialBase !== descriptor.base_sha.toLowerCase()) fail("canonical PR base differs from descriptor");
	const artifactBinding = await validateActionsArtifactBinding(api, descriptor, initial);
	const archive = await api.download(artifactBinding.archiveUrl);
	validateBoundArchiveMember(extractSanitizedArchive(archive), descriptor, true);
	const { manifest } = validatePublicationArchive(archive, descriptor);
	const executor = executorOverride ?? artifactBinding.executor;
	const prAuthor = identity(initial.user, "canonical PR author");
	const commitAuthors = await loadCommits(api, descriptor.owner, descriptor.repo, descriptor.pr_number);
	const excluded = [executor, artifactBinding.triggeringActor, prAuthor, ...commitAuthors];
	const reviewEndpoint = `${endpoint}/reviews/${requestedReviewId}`;
	const review = object(await api.get(reviewEndpoint), "authenticated review");
	const reviewId = integerField(review.id, "review.id");
	const reviewSubmittedAt = timestampField(review.submitted_at, "authenticated review.submitted_at");
	if (reviewSubmittedAt <= loadedDescriptor.artifactCreatedAt)
		fail("authenticated review was submitted before immutable descriptor artifact publication");
	if (reviewId !== requestedReviewId) fail("authenticated review identity differs from requested review ID");
	const reviewNode = stringField(review.node_id, "review.node_id");
	const reviewCommit = fullSha(review.commit_id, "authenticated review.commit_id");
	const reviewer = identity(review.user, "authenticated review author");
	assertHumanIndependentReviewer(review);
	if (String(review.state).toUpperCase() !== "APPROVED") fail("authenticated review is not approved");
	const authenticatedReviewUrl =
		typeof review.html_url === "string"
			? review.html_url
			: typeof review.url === "string"
				? review.url
				: fail("authenticated review URL is unavailable");
	reviewUrlMatches(authenticatedReviewUrl, descriptor.owner, descriptor.repo, descriptor.pr_number, requestedReviewId);
	const restParent = review.pull_request;
	if (
		restParent &&
		typeof restParent === "object" &&
		object(restParent, "authenticated review.pull_request").repository
	)
		assertPrParent(
			object(restParent, "authenticated review.pull_request"),
			descriptor,
			initial,
			"authenticated review.pull_request",
		);
	else if (!api.graphql) fail("authenticated review has no parent relation");
	if (api.graphql) {
		const payload = object(await api.graphql(REVIEW_GRAPHQL, { id: reviewNode }), "GraphQL response");
		const node = object(payload.node, "GraphQL review");
		if (node.id !== reviewNode || integerField(node.databaseId, "GraphQL review.databaseId") !== requestedReviewId)
			fail("GraphQL review identity mismatch");
		const gqlSubmittedAt = timestampField(node.submittedAt, "GraphQL review.submittedAt");
		if (gqlSubmittedAt !== reviewSubmittedAt) fail("REST and GraphQL review submission timestamp mismatch");
		const gqlCommit = fullSha(object(node.commit, "GraphQL review.commit").oid, "GraphQL review.commit.oid");
		if (gqlCommit !== reviewCommit) fail("REST and GraphQL review commit mismatch");
		const gqlAuthor = object(node.author, "GraphQL review.author");
		if (gqlAuthor.databaseId !== reviewer.id || gqlAuthor.id !== reviewer.node_id)
			fail("GraphQL reviewer identity mismatch");
		const parent = object(node.pullRequest, "GraphQL review.pullRequest");
		if (parent.id !== descriptor.pr_node_id) fail("GraphQL review parent node mismatch");
		if (integerField(parent.number, "GraphQL review.pullRequest.number") !== descriptor.pr_number)
			fail("GraphQL review parent number mismatch");
		const repository = object(parent.repository, "GraphQL review.pullRequest.repository");
		if (
			stringField(repository.nameWithOwner, "GraphQL review.pullRequest.repository.nameWithOwner").toLowerCase() !==
			`${descriptor.owner}/${descriptor.repo}`.toLowerCase()
		)
			fail("GraphQL review repository mismatch");
		const canonicalRepo = object(object(initial.base, "PR.base").repo, "PR.base.repo");
		if (repository.databaseId !== canonicalRepo.id || repository.id !== canonicalRepo.node_id)
			fail("GraphQL review repository identity mismatch");
	}
	assertIdentityNotExcluded(reviewer, excluded);
	if (!sameSha(descriptor.head_sha, reviewCommit, initialHead)) fail("review/final-head SHA binding mismatch");
	const final = object(await api.get(endpoint), "final canonical PR");
	const finalHead = fullSha(object(final.head, "final PR.head").sha, "final PR.head.sha");
	const finalBase = fullSha(object(final.base, "final PR.base").sha, "final PR.base.sha");
	if (
		final.node_id !== descriptor.pr_node_id ||
		integerField(final.number, "final PR.number") !== descriptor.pr_number
	)
		fail("final canonical PR identity changed");
	assertPrRepositoryBindings(final, descriptor, "final canonical PR");
	if (!sameSha(initialHead, finalHead) || !sameSha(initialBase, finalBase) || !sameSha(descriptor.head_sha, finalHead))
		fail("canonical PR head/base changed during verification");
	return {
		descriptor,
		descriptor_artifact_provenance: loadedDescriptor.provenance,
		manifest,
		reviewId: requestedReviewId,
		review,
		initialHeadSha: initialHead,
		finalHeadSha: finalHead,
		reviewer,
	};
}

/** Production verifier; transport is always created by the authenticated canonical adapter. */
export async function verifyPetRendererVisualPublication(
	options: VerifyPublicationOptions,
): Promise<VerifiedPublication> {
	const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	const api = createGitHubApiAdapter(token ?? "");
	return verifyPetRendererVisualPublicationInternal(options, api);
}

/** Test-only seam for fixture-backed verifier tests; never used by the CLI or production verifier. */
export type VerifyPublicationTestOptions = VerifyPublicationOptions & {
	api: GitHubApi;
	executor?: PetRendererVisualApiIdentity;
};

export async function verifyPetRendererVisualPublicationForTest(
	options: VerifyPublicationTestOptions,
): Promise<VerifiedPublication> {
	const { api, executor, ...productionOptions } = options;
	return verifyPetRendererVisualPublicationInternal(productionOptions, api, executor);
}

function parseArgs(args: string[]): Record<string, string> {
	const result: Record<string, string> = {};
	const allowed = new Set(["descriptor", "repository", "pr", "review-id"]);
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		if (!arg.startsWith("--") || !args[index + 1] || args[index + 1]!.startsWith("--"))
			fail(`invalid CLI argument ${arg}`);
		const name = arg.slice(2);
		if (!allowed.has(name)) fail(`unknown CLI argument ${arg}`);
		result[name] = args[index + 1]!;
		index += 1;
	}
	return result;
}

async function main(): Promise<void> {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (!args.descriptor || !args["review-id"]) fail("--descriptor and --review-id are required");
		const descriptorReference = descriptorArtifactReference(args.descriptor, args.repository);
		if (!descriptorReference) fail("--descriptor must be a canonical run-scoped GitHub Actions artifact URL or ID");
		const verified = await verifyPetRendererVisualPublication({
			descriptor: args.descriptor,
			reviewId: Number(args["review-id"]),
			repository: args.repository,
			pr: args.pr ? Number(args.pr) : undefined,
		});
		process.stdout.write(
			`${JSON.stringify({ ...verified.descriptor, descriptor_artifact_provenance: verified.descriptor_artifact_provenance, verified: true, final_head_sha: verified.finalHeadSha, review_id: verified.reviewId, review_node_id: verified.review.node_id }, null, 2)}\n`,
		);
	} catch (error) {
		logger.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

if (import.meta.main) await main();
