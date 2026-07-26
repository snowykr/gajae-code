import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@gajae-code/tui";
import { zipSync } from "fflate";
import {
	createGitHubApiAdapterForTest,
	extractSanitizedArchive,
	type GitHubApi,
	type VerifyPublicationOptions,
	validatePublicationArchive,
	verifyPetRendererVisualPublication,
	verifyPetRendererVisualPublicationForTest,
} from "../scripts/verify-pet-renderer-visual-publication";
import {
	assertHeadBinding,
	assertNoReceiptFile,
	assertSafeEvidenceText,
	byteLength,
	decodeTerminalControls,
	encodeTerminalControls,
	materializeTerminalHtml,
	PET_RENDERER_VISUAL_EVIDENCE_SCHEMA,
	type PetRendererVisualManifest,
	type PetRendererVisualPublicationDescriptor,
	sha256Bytes,
	stripTerminalControls,
	validateApiReviewBinding,
	validateManifest,
	validatePublicationDescriptor,
	validateSafeWriteLog,
} from "./fixtures/tui/pet-renderer-visual-evidence";
import {
	PET_RENDERER_VISUAL_SHOWCASE_CAPABILITIES,
	PET_RENDERER_VISUAL_SHOWCASE_CAPABILITY_KEYS,
	PET_RENDERER_VISUAL_SHOWCASE_CJK_CORPUS,
	PET_RENDERER_VISUAL_SHOWCASE_ENTRIES,
	PET_RENDERER_VISUAL_SHOWCASE_EXPECTED_ENTRY_COUNT,
	PET_RENDERER_VISUAL_SHOWCASE_PROFILE_KEYS,
	PET_RENDERER_VISUAL_SHOWCASE_PROFILES,
	PET_RENDERER_VISUAL_SHOWCASE_STATE_KEYS,
	PET_RENDERER_VISUAL_SHOWCASE_VIEWPORTS,
	renderPetRendererVisualShowcase,
} from "./fixtures/tui/pet-renderer-visual-showcase";

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const BASE = "3".repeat(40);
const HASH = "4".repeat(64);

function validManifest(headSha = H1): PetRendererVisualManifest {
	const content = "fixture evidence\n";
	const files = ["terminal.txt", "terminal-ansi.txt", "terminal.html", "metadata.json"].map(path => ({
		path: `pet-off/80x24/${path}`,
		sha256: sha256Bytes(path === "terminal.html" ? materializeTerminalHtml(content) : content),
		byte_length: byteLength(path === "terminal.html" ? materializeTerminalHtml(content) : content),
	}));
	return {
		schema_version: 1,
		evidence_schema: PET_RENDERER_VISUAL_EVIDENCE_SCHEMA,
		capture_tool: "test-fixture",
		capture_mode: "fixture",
		command: "fixture capture",
		head_sha: headSha,
		base_sha: BASE,
		provenance: {
			repository_root: "repository-root-redacted",
			head_sha: headSha,
			base_sha: BASE,
			clean: true,
			untracked_files: [],
			changed_files: [],
			source_files: [{ path: "fixture.ts", sha256: HASH, byte_length: content.length }],
		},
		expected_entry_count: 1,
		entry_count: 1,
		entries: [
			{
				key: "pet-off/off/none/80x24/unicode-color",
				state_id: "pet-off",
				viewport: { id: "80x24", columns: 80, rows: 24 },
				profile: "off",
				mode: "unicode-color",
				capture_mode: "fixture",
				files,
			},
		],
	};
}

function copyManifest(): PetRendererVisualManifest {
	return structuredClone(validManifest());
}

type VerifierFixtureOptions = {
	descriptorHead?: string;
	workflowEvent?: "pull_request" | "workflow_dispatch";
	workflowRefSha?: string;
	finalHead?: string;
	reviewId?: number;
	reviewCommitId?: string;
	reviewBody?: string;
	reviewSubmittedAt?: string;
	reviewer?: { id: number; node_id: string; login?: string; type?: string };
	triggeringActor?: { id: number; node_id: string; login?: string; type?: string };
	descriptorArtifactCreatedAt?: string;
	performedViaGithubApp?: unknown;
	prAuthor?: { id: number; node_id: string; login?: string };
	commitAuthors?: Array<{ id: number; node_id: string; login?: string } | null>;
	commitCommitters?: Array<{ id: number; node_id: string; login?: string } | null>;
};

function verifierFixture(options: VerifierFixtureOptions = {}) {
	const descriptorHead = options.descriptorHead ?? H1;
	const manifest = validManifest(descriptorHead);
	const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
	const manifestSha = sha256Bytes(manifestBytes);
	const reviewInput = new TextEncoder().encode(
		JSON.stringify({
			schema_version: 1,
			manifest_sha256: manifestSha,
			head_sha: descriptorHead,
			base_sha: BASE,
			expected_entry_count: manifest.entry_count,
			capture_mode: "fixture",
			review_requirements: ["Inspect every production-shaped visual evidence entry."],
		}),
	);
	const evidence = new TextEncoder().encode("fixture evidence\n");
	const htmlEvidence = new TextEncoder().encode(materializeTerminalHtml("fixture evidence\n"));
	const boundArchive = zipSync({
		"meta/manifest.json": manifestBytes,
		"meta/visual-review-input.json": reviewInput,
		"pet-off/80x24/terminal.txt": evidence,
		"pet-off/80x24/terminal-ansi.txt": evidence,
		"pet-off/80x24/terminal.html": htmlEvidence,
		"pet-off/80x24/metadata.json": evidence,
	});
	const archive = zipSync({
		"meta/manifest.json": manifestBytes,
		"meta/visual-review-input.json": reviewInput,
		"pet-off/80x24/terminal.txt": evidence,
		"pet-off/80x24/terminal-ansi.txt": evidence,
		"pet-off/80x24/terminal.html": htmlEvidence,
		"pet-off/80x24/metadata.json": evidence,
		"pet-renderer-visual-qa.tar.gz": boundArchive,
	});
	const descriptor: PetRendererVisualPublicationDescriptor = {
		schema_version: 1 as const,
		owner: "acme",
		repo: "repo",
		pr_number: 11,
		pr_node_id: "PR_11",
		head_repository: "fork/repo",
		head_repository_id: 88,
		base_repository: "acme/repo",
		base_repository_id: 99,
		head_sha: descriptorHead,
		base_sha: BASE,
		workflow_event: options.workflowEvent ?? "pull_request",
		workflow_ref_sha: options.workflowRefSha ?? descriptorHead,
		manifest_sha256: manifestSha,
		manifest_entry_count: manifest.entry_count,
		artifact_id: 11,
		workflow_run_id: 11,
		artifact_name: "visual-qa-capture-run-11-attempt-1",
		workflow_run_attempt: 1,
		artifact_sha256: sha256Bytes(archive),
		artifact_byte_length: archive.byteLength,
		archive_sha256: sha256Bytes(boundArchive),
		archive_byte_length: boundArchive.byteLength,
		artifact_url: "https://github.com/acme/repo/actions/runs/11/artifacts/11",
		run_url: "https://github.com/acme/repo/actions/runs/11",
		retention_days: 7,
		raw_pty_published: false,
		gjc_published: false,
	};
	const descriptorArtifactId = 99;
	const descriptorArchive = zipSync({
		"visual-qa-descriptor.json": new TextEncoder().encode(JSON.stringify(descriptor)),
	});
	const descriptorArtifactEndpoint = `/repos/acme/repo/actions/artifacts/${descriptorArtifactId}`;
	const descriptorArchiveUrl = `https://api.github.com/repos/acme/repo/actions/artifacts/${descriptorArtifactId}/zip`;
	const reviewId = options.reviewId ?? 11;
	const endpoint = "/repos/acme/repo/pulls/11";
	const reviewEndpoint = `${endpoint}/reviews/${reviewId}`;
	const commitsEndpoint = `${endpoint}/commits?per_page=100&page=1`;
	const artifactEndpoint = "/repos/acme/repo/actions/artifacts/11";
	const runEndpoint = "/repos/acme/repo/actions/runs/11";
	const requests: string[] = [];
	let prReads = 0;
	const canonicalPr = (headSha: string) => ({
		id: "PR_DATABASE_11",
		node_id: "PR_11",
		number: 11,
		user: options.prAuthor ?? { id: 33, node_id: "U_author", login: "author" },
		head: { sha: headSha, repo: { id: 88, node_id: "R_head", full_name: "fork/repo" } },
		base: { sha: BASE, repo: { id: 99, node_id: "R_repo", full_name: "acme/repo" } },
	});
	const reviewUrl = `https://github.com/acme/repo/pull/11#pullrequestreview-${reviewId}`;
	const review = {
		id: reviewId,
		node_id: `PRR_review_${reviewId}`,
		commit_id: options.reviewCommitId ?? descriptorHead,
		body: options.reviewBody ?? `Approved visual evidence for ${descriptorHead}`,
		state: "APPROVED",
		submitted_at: options.reviewSubmittedAt ?? "2025-01-01T00:00:01.000Z",
		html_url: reviewUrl,
		user: options.reviewer ?? { id: 22, node_id: "U_reviewer_22", login: "independent-reviewer", type: "User" },
		performed_via_github_app: options.performedViaGithubApp ?? null,
		pull_request: {
			id: "PR_DATABASE_11",
			number: 11,
			repository: { id: 99, node_id: "R_repo", full_name: "acme/repo" },
		},
	};
	const api: GitHubApi = {
		get: async requestPath => {
			requests.push(requestPath);
			if (requestPath === descriptorArtifactEndpoint)
				return {
					id: descriptorArtifactId,
					name: "visual-qa-descriptor-run-11-attempt-1",
					expired: false,
					created_at: options.descriptorArtifactCreatedAt ?? "2025-01-01T00:00:00.000Z",
					size_in_bytes: descriptorArchive.byteLength,
					digest: `sha256:${sha256Bytes(descriptorArchive)}`,
					archive_download_url: descriptorArchiveUrl,
					workflow_run: {
						id: 11,
						repository_id: 99,
						head_repository_id: descriptor.workflow_event === "pull_request" ? 88 : 99,
						head_sha: descriptor.workflow_ref_sha,
					},
				};
			if (requestPath === endpoint)
				return canonicalPr(prReads++ === 0 ? descriptorHead : (options.finalHead ?? descriptorHead));
			if (requestPath === commitsEndpoint)
				return (options.commitAuthors ?? [{ id: 55, node_id: "U_commit_author", login: "contributor" }]).map(
					(author, index) => ({
						author,
						committer: options.commitCommitters?.[index] ?? null,
					}),
				);
			if (requestPath === artifactEndpoint)
				return {
					id: descriptor.artifact_id,
					name: descriptor.artifact_name,
					expired: false,
					size_in_bytes: descriptor.artifact_byte_length,
					digest: `sha256:${descriptor.artifact_sha256}`,
					archive_download_url: "https://api.github.com/repos/acme/repo/actions/artifacts/11/zip",
					workflow_run: {
						id: descriptor.workflow_run_id,
						repository_id: 99,
						head_repository_id: descriptor.workflow_event === "pull_request" ? 88 : 99,
						head_sha: descriptor.workflow_ref_sha,
					},
				};
			if (requestPath === runEndpoint)
				return {
					id: descriptor.workflow_run_id,
					run_attempt: 1,
					html_url: descriptor.run_url,
					event: descriptor.workflow_event,
					head_sha: descriptor.workflow_ref_sha,
					repository: { id: 99, node_id: "R_repo", full_name: "acme/repo" },
					actor: { id: 44, node_id: "U_executor_44", login: "executor", type: "User" },
					triggering_actor: options.triggeringActor ?? {
						id: 45,
						node_id: "U_triggering_actor_45",
						login: "triggering-actor",
						type: "User",
					},
					pull_requests: [
						{
							id: "PR_DATABASE_11",
							node_id: "PR_11",
							number: descriptor.pr_number,
							head: {
								sha: descriptor.head_sha,
								repo: { id: 88, node_id: "R_head", full_name: "fork/repo" },
							},
							base: { sha: descriptor.base_sha, repo: { id: 99, node_id: "R_repo", full_name: "acme/repo" } },
							repository: { id: 99, node_id: "R_repo", full_name: "acme/repo" },
						},
					],
				};
			if (requestPath === reviewEndpoint) return review;
			throw new Error(`unexpected API path ${requestPath}`);
		},
		download: async url => {
			if (url === descriptorArchiveUrl) return descriptorArchive;
			if (url === "https://api.github.com/repos/acme/repo/actions/artifacts/11/zip") return archive;
			throw new Error(`unexpected artifact URL ${url}`);
		},
	};
	return {
		archive,
		descriptor,
		descriptorLocator: "https://github.com/acme/repo/actions/runs/11/artifacts/99",
		descriptorArchive,
		descriptorArtifactEndpoint,
		descriptorArtifactId,
		descriptorArchiveUrl,
		artifactEndpoint,
		runEndpoint,
		api,
		endpoint,
		reviewEndpoint,
		commitsEndpoint,
		requests,
		review,
		manifestBytes,
		reviewInput,
		boundArchive,
		evidence,
	};
}

describe("Pet renderer visual showcase matrix", () => {
	it("exports a complete, ordered state/profile/capability/viewport matrix", () => {
		expect(PET_RENDERER_VISUAL_SHOWCASE_ENTRIES).toHaveLength(PET_RENDERER_VISUAL_SHOWCASE_EXPECTED_ENTRY_COUNT);
		expect(new Set(PET_RENDERER_VISUAL_SHOWCASE_STATE_KEYS).size).toBe(
			PET_RENDERER_VISUAL_SHOWCASE_STATE_KEYS.length,
		);
		expect(new Set(PET_RENDERER_VISUAL_SHOWCASE_PROFILE_KEYS).size).toBe(
			PET_RENDERER_VISUAL_SHOWCASE_PROFILES.length,
		);
		expect(new Set(PET_RENDERER_VISUAL_SHOWCASE_CAPABILITY_KEYS).size).toBe(
			PET_RENDERER_VISUAL_SHOWCASE_CAPABILITIES.length,
		);
		expect(new Set(PET_RENDERER_VISUAL_SHOWCASE_VIEWPORTS.map(viewport => viewport.key)).size).toBe(
			PET_RENDERER_VISUAL_SHOWCASE_VIEWPORTS.length,
		);
		for (const state of PET_RENDERER_VISUAL_SHOWCASE_STATE_KEYS) {
			const entries = PET_RENDERER_VISUAL_SHOWCASE_ENTRIES.filter(entry => entry.stateKey === state);
			expect(entries).toHaveLength(PET_RENDERER_VISUAL_SHOWCASE_VIEWPORTS.length);
			expect(new Set(entries.map(entry => entry.viewportKey))).toEqual(
				new Set(PET_RENDERER_VISUAL_SHOWCASE_VIEWPORTS.map(viewport => viewport.key)),
			);
		}
		for (const profile of PET_RENDERER_VISUAL_SHOWCASE_PROFILES)
			expect(PET_RENDERER_VISUAL_SHOWCASE_ENTRIES.some(entry => entry.profileKey === profile.key)).toBe(true);
		for (const capability of PET_RENDERER_VISUAL_SHOWCASE_CAPABILITIES)
			expect(PET_RENDERER_VISUAL_SHOWCASE_ENTRIES.some(entry => entry.capabilityKey === capability.key)).toBe(true);
	});

	it("captures every matrix entry from the real VirtualTerminal/TUI renderer", async () => {
		for (const entry of PET_RENDERER_VISUAL_SHOWCASE_ENTRIES) {
			const rendered = await renderPetRendererVisualShowcase(entry);
			expect(rendered.captureMode).toBe("live-tui-xterm");
			expect(rendered.rawPtyPublished).toBe(false);
			expect(rendered.entry.key).toBe(entry.key);
			expect(rendered.viewport).toHaveLength(entry.viewport.rows);
			expect(rendered.terminalText.length).toBeGreaterThan(0);
			for (const line of rendered.viewport) expect(visibleWidth(line)).toBeLessThanOrEqual(entry.viewport.columns);
			if (entry.capabilityKey === "sixel") expect(rendered.terminalAnsiText).toContain("\x1bP0;1;0q");
			if (entry.capabilityKey === "kitty") expect(rendered.terminalAnsiText).toContain("\x1b_G");
			if (entry.renderMode === "ascii-no-color") expect(rendered.terminalAnsiText).not.toContain("\x1b");
			if (entry.stateKey === "durable-history-replay" || entry.stateKey === "tool-running") {
				expect(rendered.durableHistory?.identity).toContain("pet-showcase/");
				expect(rendered.durableHistory?.revision).toBeGreaterThan(0);
				expect(rendered.durableHistory?.acknowledged).toBe(true);
			}
		}
	});

	it("runs Pet cleanup through the renderer lifecycle and remains reusable", async () => {
		const entry = PET_RENDERER_VISUAL_SHOWCASE_ENTRIES.find(candidate => candidate.stateKey === "pet-idle-red");
		expect(entry).toBeDefined();
		const first = await renderPetRendererVisualShowcase(entry!);
		const second = await renderPetRendererVisualShowcase(entry!);
		expect(first.terminalAnsiText).toContain("\x1bP0;1;0q");
		expect(second.terminalAnsiText).toContain("\x1bP0;1;0q");
		expect(second.viewport).toHaveLength(entry!.viewport.rows);
	});
});

describe("Pet visual CJK and terminal safety", () => {
	it("keeps every declared CJK semantic break and protected span cell-safe", () => {
		for (const corpus of PET_RENDERER_VISUAL_SHOWCASE_CJK_CORPUS) {
			expect(corpus.text).toContain(corpus.allowedSemanticBreaks[0]!);
			for (const span of corpus.protectedSpans) expect(corpus.text).toContain(span.text);
			for (const boundary of corpus.allowedSemanticBreaks) {
				const offset = corpus.text.indexOf(boundary);
				expect(offset).toBeGreaterThanOrEqual(0);
				expect(visibleWidth(boundary)).toBeLessThanOrEqual(80);
				const end = offset + boundary.length;
				for (const span of corpus.protectedSpans) {
					const start = corpus.text.indexOf(span.text);
					if (start >= 0) expect(!(start < end && start + span.text.length > end)).toBe(true);
				}
			}
		}
	});

	it("round-trips SGR, CSI, DCS, Kitty, and Sixel bytes without placeholders", () => {
		const raw = "\x1b[31mSGR\x1b[2JCSI\x1bP1;1;0qDCS\x1b\\\x1b_Ga=T,f=32;KITTY\x1b\\\x1bPqSIXEL\x1b\\";
		const encoded = encodeTerminalControls(raw);
		expect(encoded).not.toContain("\x1b");
		expect(decodeTerminalControls(encoded)).toBe(raw);
		expect(stripTerminalControls(raw)).toBe("SGRCSI");
		validateSafeWriteLog({
			schema_version: 1,
			encoding: "backslash-x-byte-v1",
			writes: [{ sequence: 0, stream: "terminal", data: encoded }],
		});
		expect(() =>
			validateSafeWriteLog({
				schema_version: 1,
				encoding: "backslash-x-byte-v1",
				writes: [{ sequence: 0, stream: "terminal", data: raw }],
			}),
		).toThrow();
	});

	it("materializes control-free HTML and rejects unsafe evidence text", () => {
		const html = materializeTerminalHtml('CJK 한국어 日本語 中文 <safe> & "quoted"\n');
		expect(html).toContain("&lt;safe&gt;");
		expect(html).toContain("&amp;");
		expect(html).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u001b]/u);
		expect(html).not.toMatch(/<(?:img|svg|canvas)\b|data:image\//i);
		expect(() => materializeTerminalHtml("bad\x1b[31mcontrol")).toThrow();
		expect(() => assertSafeEvidenceText("/Users/private/secret.txt", "path")).toThrow();
		expect(() => assertSafeEvidenceText("token 123456:ABCDEFGHIJKLMNOPQRSTUV", "secret")).toThrow();
	});
});

describe("Pet visual evidence provenance and review bindings", () => {
	it("accepts manifest counts and hashes only when provenance is clean and contained", () => {
		const manifest = validManifest();
		validateManifest(manifest);
		expect(manifest.entry_count).toBe(manifest.expected_entry_count);
		for (const file of manifest.entries[0]!.files) {
			const content = file.path.endsWith("terminal.html")
				? materializeTerminalHtml("fixture evidence\n")
				: "fixture evidence\n";
			expect(file.sha256).toBe(sha256Bytes(content));
			expect(file.byte_length).toBe(byteLength(content));
		}
		expect(() => assertNoReceiptFile("pet-off/80x24/independent-review.json")).toThrow();
	});
	it("rejects absent and tampered full publication provenance fields", () => {
		const fixture = verifierFixture();
		const cases: Array<[string, unknown]> = [
			["artifact_name", undefined],
			["workflow_run_attempt", undefined],
			["retention_days", undefined],
			["retention_days", 0],
			["archive_sha256", undefined],
			["archive_sha256", "not-a-sha256"],
			["archive_byte_length", undefined],
			["archive_byte_length", 0],
			["raw_pty_published", undefined],
			["raw_pty_published", true],
			["gjc_published", undefined],
			["gjc_published", true],
		];
		for (const [field, value] of cases) {
			const descriptor = { ...fixture.descriptor } as Record<string, unknown>;
			if (value === undefined) delete descriptor[field];
			else descriptor[field] = value;
			expect(() => validatePublicationDescriptor(descriptor as never)).toThrow();
		}
	});
	it("rejects an independent review artifact instead of requiring capture-time mutation", () => {
		const fixture = verifierFixture();
		const archive = zipSync({
			"meta/manifest.json": fixture.manifestBytes,
			"meta/visual-review-input.json": fixture.reviewInput,
			"pet-off/80x24/terminal.txt": fixture.evidence,
			"pet-off/80x24/terminal-ansi.txt": fixture.evidence,
			"pet-off/80x24/terminal.html": new TextEncoder().encode(materializeTerminalHtml("fixture evidence\n")),
			"pet-off/80x24/metadata.json": fixture.evidence,
			"review/independent-review.json": new TextEncoder().encode("{}"),
		});
		const descriptor = {
			...fixture.descriptor,
			artifact_sha256: sha256Bytes(archive),
			artifact_byte_length: archive.byteLength,
		};
		expect(() => validatePublicationArchive(archive, descriptor)).toThrow("receipt files are not capture output");
	});
	it("requires exactly one visual review input before validating capture files", () => {
		const fixture = verifierFixture();
		const html = new TextEncoder().encode(materializeTerminalHtml("fixture evidence\n"));
		const makeArchive = (inputs: Record<string, Uint8Array>) =>
			zipSync({
				"meta/manifest.json": fixture.manifestBytes,
				...inputs,
				"pet-off/80x24/terminal.txt": fixture.evidence,
				"pet-off/80x24/terminal-ansi.txt": fixture.evidence,
				"pet-off/80x24/terminal.html": html,
				"pet-off/80x24/metadata.json": fixture.evidence,
			});
		const inputSets: Array<Record<string, Uint8Array>> = [
			{},
			{
				"meta/visual-review-input.json": fixture.reviewInput,
				"other/visual-review-input.json": fixture.reviewInput,
			},
		];
		for (const inputs of inputSets) {
			const archive = makeArchive(inputs);
			const descriptor = {
				...fixture.descriptor,
				artifact_sha256: sha256Bytes(archive),
				artifact_byte_length: archive.byteLength,
			};
			expect(() => validatePublicationArchive(archive, descriptor)).toThrow(
				"archive must contain exactly one visual review input",
			);
		}
	});
	it("rejects active, external, raster, and malformed terminal HTML at the archive boundary", () => {
		const fixture = verifierFixture();
		const makeArchive = (html: string) => {
			const manifest = copyManifest();
			const htmlFile = manifest.entries[0]!.files.find(file => file.path.endsWith("terminal.html"))!;
			const htmlBytes = new TextEncoder().encode(html);
			htmlFile.sha256 = sha256Bytes(htmlBytes);
			htmlFile.byte_length = htmlBytes.byteLength;
			const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
			const manifestSha = sha256Bytes(manifestBytes);
			const reviewInput = new TextEncoder().encode(
				JSON.stringify({
					schema_version: 1,
					manifest_sha256: manifestSha,
					head_sha: H1,
					base_sha: BASE,
					expected_entry_count: manifest.entry_count,
					capture_mode: "fixture",
					review_requirements: ["Inspect every production-shaped visual evidence entry."],
				}),
			);
			const archive = zipSync({
				"meta/manifest.json": manifestBytes,
				"meta/visual-review-input.json": reviewInput,
				"pet-off/80x24/terminal.txt": fixture.evidence,
				"pet-off/80x24/terminal-ansi.txt": fixture.evidence,
				"pet-off/80x24/terminal.html": htmlBytes,
				"pet-off/80x24/metadata.json": fixture.evidence,
			});
			return {
				archive,
				descriptor: {
					...fixture.descriptor,
					manifest_sha256: manifestSha,
					artifact_sha256: sha256Bytes(archive),
					artifact_byte_length: archive.byteLength,
				},
			};
		};
		for (const html of [
			"<script>alert(1)</script>",
			'<div onclick="alert(1)">terminal</div>',
			'<img src="data:image/png;base64,AA==" />',
			"<pre>https://external.example/asset</pre>",
			"<pre>\x1b[31mterminal</pre>",
			"<canvas>terminal</canvas>",
			"<style>@\\69 mport url(https://external.example/asset);</style>",
			'<style>body{background:\\75 rl("https://external.example/asset")}</style>',
			'<pre style="background:\\75 rl(https://external.example/asset)">terminal</pre>',
		]) {
			const { archive, descriptor } = makeArchive(html);
			expect(() => validatePublicationArchive(archive, descriptor)).toThrow();
		}
	});

	it("rejects traversal, absolute/raw-PTY containment escapes, dirty state, and head/base drift", () => {
		for (const unsafePath of ["../terminal.txt", "/Users/me/terminal.txt", "artifacts/raw-pty-capture.txt"]) {
			const manifest = copyManifest();
			(manifest.entries[0]!.files[0]!.path as string) = unsafePath;
			expect(() => validateManifest(manifest)).toThrow();
		}
		const dirty = copyManifest();
		(dirty.provenance as { clean: boolean }).clean = false;
		expect(() => validateManifest(dirty)).toThrow();
		const headDrift = copyManifest();
		(headDrift.provenance as { head_sha: string }).head_sha = H2;
		expect(() => validateManifest(headDrift)).toThrow();
		const baseDrift = copyManifest();
		(baseDrift.provenance as { base_sha: string }).base_sha = H2;
		expect(() => validateManifest(baseDrift)).toThrow();
		const sameCommit = copyManifest();
		sameCommit.base_sha = H1;
		expect(() => validateManifest(sameCommit)).toThrow();
	});

	it("requires authenticated API identity and rejects an H1 review body claiming H2", () => {
		const apiReview = {
			id: 11,
			node_id: "PRR_review_11",
			commit_id: H1,
			user: { id: 22, node_id: "U_reviewer_22", login: "independent-reviewer" },
			pull_request: { id: "PR_11", number: 11, repository: { id: 99, node_id: "R_repo", full_name: "acme/repo" } },
		};
		validateApiReviewBinding(apiReview);
		const h1BodyClaimsH2 = { ...apiReview, body: `Approved visual evidence for ${H2}` };
		expect(() => assertHeadBinding(H2, BASE, h1BodyClaimsH2.commit_id)).toThrow();
		expect(() => validateApiReviewBinding({ ...apiReview, commit_id: null })).toThrow();
		expect(() => validateApiReviewBinding({ ...apiReview, user: null })).toThrow();
	});
	it("bounds archive bytes and central-directory expansion before decompression", async () => {
		const oversized = new Uint8Array(100 * 1024 * 1024 + 1);
		expect(() => extractSanitizedArchive(oversized)).toThrow("archive size is outside safe bounds");

		const archive = zipSync({ first: new Uint8Array([1]), second: new Uint8Array([2]) });
		const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
		const centralEntries: number[] = [];
		for (let offset = 0; offset + 4 <= archive.byteLength; offset += 1)
			if (view.getUint32(offset, true) === 0x02014b50) centralEntries.push(offset);
		expect(centralEntries).toHaveLength(2);
		for (const offset of centralEntries) view.setUint32(offset + 24, 150 * 1024 * 1024, true);
		expect(() => extractSanitizedArchive(archive)).toThrow("central directory expands beyond safe bounds");

		const fetchImpl = (async () =>
			new Response(new Uint8Array([1]), {
				status: 200,
				headers: { "content-length": String(100 * 1024 * 1024 + 1) },
			})) as unknown as typeof fetch;
		const api = createGitHubApiAdapterForTest("test-token", fetchImpl);
		await expect(api.download("https://api.github.com/repos/acme/repo/actions/artifacts/11/zip")).rejects.toThrow(
			"Content-Length exceeds safe bounds",
		);

		for (const contentLength of [undefined, "1"]) {
			let cancelled = 0;
			let chunks = 0;
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (chunks++ < 1600) controller.enqueue(new Uint8Array(64 * 1024));
					else controller.enqueue(new Uint8Array([1]));
				},
				cancel() {
					cancelled += 1;
				},
			});
			const streamingFetch = (async () =>
				new Response(stream, {
					status: 200,
					...(contentLength === undefined ? {} : { headers: { "content-length": contentLength } }),
				}) as Response) as unknown as typeof fetch;
			const streamingApi = createGitHubApiAdapterForTest("test-token", streamingFetch);
			await expect(
				streamingApi.download("https://api.github.com/repos/acme/repo/actions/artifacts/11/zip"),
			).rejects.toThrow("artifact download exceeds safe bounds");
			expect(cancelled).toBe(1);
		}
	});
});
describe("Pet visual publication verifier owner gate", () => {
	const executor = { id: 44, node_id: "U_executor_44", login: "executor", type: "User" };

	it("production verifier ignores a fake injected API and uses canonical transport", async () => {
		const fixture = verifierFixture();
		let fakeCalls = 0;
		const fakeApi: GitHubApi = {
			get: async () => {
				fakeCalls += 1;
				return fixture.descriptor;
			},
			download: async () => fixture.archive,
		};
		let requests = 0;
		const fetchImpl = (async () => {
			requests += 1;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch;
		const previousFetch = globalThis.fetch;
		globalThis.fetch = fetchImpl;
		try {
			await expect(
				verifyPetRendererVisualPublication({
					descriptor: fixture.descriptorLocator,
					reviewId: 11,
					token: "test-token",
					api: fakeApi,
					executor: { id: 999, node_id: "U_attacker", login: "attacker" },
				} as VerifyPublicationOptions & { api: GitHubApi; executor: typeof executor }),
			).rejects.toThrow("descriptor Actions artifact.id is not a positive integer");
		} finally {
			globalThis.fetch = previousFetch;
		}
		expect(fakeCalls).toBe(0);
		expect(requests).toBe(1);
	});
	it("keeps caller-controlled executor identity confined to the fixture-only verifier seam", async () => {
		const fixture = verifierFixture({ reviewer: executor });
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api: fixture.api,
				executor,
			}),
		).rejects.toThrow("reviewer overlaps an excluded immutable identity");

		const productionOptionsAllowExecutor: "executor" extends keyof VerifyPublicationOptions ? true : false = false;
		expect(productionOptionsAllowExecutor).toBe(false);

		const child = Bun.spawn(
			[
				process.execPath,
				"packages/coding-agent/scripts/verify-pet-renderer-visual-publication.ts",
				"--executor",
				"attacker",
			],
			{ cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode).not.toBe(0);
	});

	it("uses the exact descriptor-scoped REST review endpoint and binds a passing review to the final head", async () => {
		const fixture = verifierFixture({ reviewId: 73 });
		const verified = await verifyPetRendererVisualPublicationForTest({
			descriptor: fixture.descriptorLocator,
			reviewId: 73,
			api: fixture.api,
			executor,
		});

		expect(verified.initialHeadSha).toBe(H1);
		expect([fixture.descriptor.head_sha, verified.review.commit_id, verified.finalHeadSha]).toEqual([H1, H1, H1]);
		expect(verified.reviewId).toBe(73);
		expect(verified.review.commit_id).toBe(H1);
		expect(fixture.requests).toEqual([
			fixture.descriptorArtifactEndpoint,
			"/repos/acme/repo/actions/runs/11",
			fixture.endpoint,
			"/repos/acme/repo/actions/artifacts/11",
			"/repos/acme/repo/actions/runs/11",
			fixture.commitsEndpoint,
			fixture.reviewEndpoint,
			fixture.endpoint,
		]);
	});
	it("rejects an approval submitted before immutable descriptor artifact publication", async () => {
		const fixture = verifierFixture({
			descriptorArtifactCreatedAt: "2025-01-01T00:00:01.000Z",
			reviewSubmittedAt: "2025-01-01T00:00:00.000Z",
		});
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api: fixture.api,
				executor,
			}),
		).rejects.toThrow("before immutable descriptor artifact publication");
	});
	it("accepts an approval submitted after immutable descriptor artifact publication", async () => {
		const fixture = verifierFixture({
			descriptorArtifactCreatedAt: "2025-01-01T00:00:00.000Z",
			reviewSubmittedAt: "2025-01-01T00:00:01.000Z",
		});
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api: fixture.api,
				executor,
			}),
		).resolves.toBeDefined();
	});
	it("binds a manual dispatch descriptor to its dispatch ref without weakening the PR head binding", async () => {
		const fixture = verifierFixture({ workflowEvent: "workflow_dispatch", workflowRefSha: H2 });
		const verified = await verifyPetRendererVisualPublicationForTest({
			descriptor: fixture.descriptorLocator,
			reviewId: 11,
			api: fixture.api,
			executor,
		});
		expect(verified.initialHeadSha).toBe(H1);
		expect(verified.descriptor.workflow_ref_sha).toBe(H2);

		const originalGet = fixture.api.get;
		const api: GitHubApi = {
			...fixture.api,
			get: async requestPath => {
				const value = await originalGet(requestPath);
				if (requestPath !== fixture.runEndpoint) return value;
				return { ...(value as Record<string, unknown>), head_sha: H1 };
			},
		};
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api,
				executor,
			}),
		).rejects.toThrow("descriptor Actions workflow run ref differs from descriptor");
	});
	it("accepts a manual dispatch descriptor when the workflow run omits its pull-request list", async () => {
		const fixture = verifierFixture({ workflowEvent: "workflow_dispatch", workflowRefSha: H2 });
		const originalGet = fixture.api.get;
		const api: GitHubApi = {
			...fixture.api,
			get: async requestPath => {
				const value = await originalGet(requestPath);
				if (requestPath !== fixture.runEndpoint) return value;
				const run = { ...(value as Record<string, unknown>) };
				delete run.pull_requests;
				return run;
			},
		};
		const verified = await verifyPetRendererVisualPublicationForTest({
			descriptor: fixture.descriptorLocator,
			reviewId: 11,
			api,
			executor,
		});
		expect(verified.initialHeadSha).toBe(H1);
		expect(verified.descriptor.workflow_event).toBe("workflow_dispatch");
	});
	it("rejects a manual dispatch artifact attributed to the fork instead of the base dispatch repository", async () => {
		const fixture = verifierFixture({ workflowEvent: "workflow_dispatch", workflowRefSha: H2 });
		const originalGet = fixture.api.get;
		const api: GitHubApi = {
			...fixture.api,
			get: async requestPath => {
				const value = await originalGet(requestPath);
				if (requestPath !== fixture.descriptorArtifactEndpoint) return value;
				const artifact = value as Record<string, unknown>;
				return {
					...artifact,
					workflow_run: {
						...(artifact.workflow_run as Record<string, unknown>),
						head_repository_id: 88,
					},
				};
			},
		};
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api,
				executor,
			}),
		).rejects.toThrow("descriptor Actions artifact workflow run head repository differs from descriptor");
	});
	it("requires a workflow-run PR binding for pull-request descriptors", async () => {
		const fixture = verifierFixture();
		const originalGet = fixture.api.get;
		const api: GitHubApi = {
			...fixture.api,
			get: async requestPath => {
				const value = await originalGet(requestPath);
				if (requestPath !== fixture.runEndpoint) return value;
				return { ...(value as Record<string, unknown>), pull_requests: [] };
			},
		};
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api,
				executor,
			}),
		).rejects.toThrow("descriptor Actions workflow run PR binding is ambiguous or missing");
	});
	it("accepts the lightweight workflow-run PR payload and defers nested repository identity to the canonical PR", async () => {
		const fixture = verifierFixture();
		const originalGet = fixture.api.get;
		const api: GitHubApi = {
			...fixture.api,
			get: async requestPath => {
				const value = await originalGet(requestPath);
				if (requestPath !== fixture.runEndpoint) return value;
				const run = value as Record<string, unknown>;
				return {
					...run,
					pull_requests: [{ number: 11, head: { sha: H1 }, base: { sha: BASE } }],
				};
			},
		};
		const verified = await verifyPetRendererVisualPublicationForTest({
			descriptor: fixture.descriptorLocator,
			reviewId: 11,
			api,
			executor,
		});
		expect(verified.finalHeadSha).toBe(H1);
	});

	it("uses the bound workflow-run actor instead of GITHUB_ACTOR for executor exclusion", async () => {
		const fixture = verifierFixture();
		const previousActor = process.env.GITHUB_ACTOR;
		process.env.GITHUB_ACTOR = "unbound-actor";
		try {
			const verified = await verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api: fixture.api,
			});
			expect(verified.reviewer.id).toBe(22);
		} finally {
			if (previousActor === undefined) delete process.env.GITHUB_ACTOR;
			else process.env.GITHUB_ACTOR = previousActor;
		}
	});
	it("rejects an approval from the workflow run triggering actor by immutable ID", async () => {
		const fixture = verifierFixture({
			reviewer: { id: 45, node_id: "U_reviewer_45", login: "renamed-triggering-actor", type: "User" },
		});
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api: fixture.api,
				executor,
			}),
		).rejects.toThrow("reviewer overlaps an excluded immutable identity");
	});
	it("accepts an explicitly human REST reviewer", async () => {
		const fixture = verifierFixture({
			reviewer: { id: 22, node_id: "U_reviewer_22", login: "independent-reviewer", type: "User" },
		});
		const verified = await verifyPetRendererVisualPublicationForTest({
			descriptor: fixture.descriptorLocator,
			reviewId: 11,
			api: fixture.api,
			executor,
		});
		expect(verified.reviewer).toEqual({
			id: 22,
			node_id: "U_reviewer_22",
			login: "independent-reviewer",
		});
	});
	it("rejects Bot REST reviewers even when their approval is otherwise valid", async () => {
		const fixture = verifierFixture({
			reviewer: { id: 22, node_id: "U_reviewer_22", login: "automation", type: "Bot" },
		});
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api: fixture.api,
				executor,
			}),
		).rejects.toThrow("authenticated review author must be a human user");
	});
	it("rejects approvals performed via a GitHub App", async () => {
		const fixture = verifierFixture({ performedViaGithubApp: { id: 101, slug: "review-app" } });
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api: fixture.api,
				executor,
			}),
		).rejects.toThrow("authenticated review must not be performed via a GitHub App");
	});
	it("rejects cross-run and cross-repository Actions artifact substitution before archive validation", async () => {
		const crossRun = verifierFixture();
		const crossRunGet = crossRun.api.get;
		const crossRunApi: GitHubApi = {
			...crossRun.api,
			get: async requestPath => {
				const value = await crossRunGet(requestPath);
				if (requestPath.endsWith("/actions/artifacts/11"))
					return { ...(value as Record<string, unknown>), workflow_run: { id: 12 } };
				return value;
			},
		};
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: crossRun.descriptorLocator,
				reviewId: 11,
				api: crossRunApi,
				executor,
			}),
		).rejects.toThrow("Actions artifact workflow run differs from descriptor");

		const crossRepository = verifierFixture();
		const crossRepositoryGet = crossRepository.api.get;
		const crossRepositoryApi: GitHubApi = {
			...crossRepository.api,
			get: async requestPath => {
				const value = await crossRepositoryGet(requestPath);
				if (requestPath.endsWith("/actions/runs/11"))
					return {
						...(value as Record<string, unknown>),
						repository: { id: 100, node_id: "R_other", full_name: "other/repo" },
					};
				return value;
			},
		};
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: crossRepository.descriptorLocator,
				reviewId: 11,
				api: crossRepositoryApi,
				executor,
			}),
		).rejects.toThrow("descriptor Actions workflow run repository differs from requested route");
	});
	it("rejects a capture artifact whose bound sanitized archive is mismatched or unavailable", async () => {
		const fixture = verifierFixture();
		const mismatchDescriptor = { ...fixture.descriptor, archive_sha256: HASH };
		const mismatchDescriptorArchive = zipSync({
			"visual-qa-descriptor.json": new TextEncoder().encode(JSON.stringify(mismatchDescriptor)),
		});
		const originalGet = fixture.api.get;
		const mismatchApi: GitHubApi = {
			...fixture.api,
			get: async requestPath => {
				const value = await originalGet(requestPath);
				if (requestPath === fixture.descriptorArtifactEndpoint)
					return {
						...(value as Record<string, unknown>),
						size_in_bytes: mismatchDescriptorArchive.byteLength,
						digest: `sha256:${sha256Bytes(mismatchDescriptorArchive)}`,
					};
				return value;
			},
			download: async url =>
				url === fixture.descriptorArchiveUrl ? mismatchDescriptorArchive : fixture.api.download(url),
		};
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api: mismatchApi,
				executor,
			}),
		).rejects.toThrow("bound sanitized archive SHA-256 differs from descriptor");

		const extracted = extractSanitizedArchive(fixture.archive).files;
		const unavailableArchive = zipSync(
			Object.fromEntries([...extracted.entries()].filter(([name]) => name !== "pet-renderer-visual-qa.tar.gz")),
		);
		const unavailableDescriptor = {
			...fixture.descriptor,
			artifact_sha256: sha256Bytes(unavailableArchive),
			artifact_byte_length: unavailableArchive.byteLength,
		};
		const unavailableDescriptorArchive = zipSync({
			"visual-qa-descriptor.json": new TextEncoder().encode(JSON.stringify(unavailableDescriptor)),
		});
		const unavailableApi: GitHubApi = {
			...fixture.api,
			get: async requestPath => {
				const value = await originalGet(requestPath);
				if (requestPath === fixture.descriptorArtifactEndpoint)
					return {
						...(value as Record<string, unknown>),
						size_in_bytes: unavailableDescriptorArchive.byteLength,
						digest: `sha256:${sha256Bytes(unavailableDescriptorArchive)}`,
					};
				if (requestPath === fixture.artifactEndpoint)
					return {
						...(value as Record<string, unknown>),
						size_in_bytes: unavailableArchive.byteLength,
						digest: `sha256:${sha256Bytes(unavailableArchive)}`,
					};
				return value;
			},
			download: async url => {
				if (url === fixture.descriptorArchiveUrl) return unavailableDescriptorArchive;
				if (url === "https://api.github.com/repos/acme/repo/actions/artifacts/11/zip") return unavailableArchive;
				return fixture.api.download(url);
			},
		};
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api: unavailableApi,
				executor,
			}),
		).rejects.toThrow("bound sanitized archive pet-renderer-visual-qa.tar.gz is unavailable");
	});
	it("binds capture artifact name and workflow attempt before capture download", async () => {
		for (const [field, value, message] of [
			["artifact_name", "visual-qa-capture-run-12-attempt-1", "Actions artifact name differs from descriptor"],
			["workflow_run_attempt", 2, "Actions workflow run attempt differs from descriptor"],
		] as const) {
			const fixture = verifierFixture();
			const substitutedDescriptor = { ...fixture.descriptor, [field]: value };
			const substitutedArchive = zipSync({
				"visual-qa-descriptor.json": new TextEncoder().encode(JSON.stringify(substitutedDescriptor)),
			});
			const originalGet = fixture.api.get;
			let captureDownloads = 0;
			const api: GitHubApi = {
				...fixture.api,
				get: async requestPath => {
					const result = await originalGet(requestPath);
					if (requestPath !== fixture.descriptorArtifactEndpoint) return result;
					return {
						...(result as Record<string, unknown>),
						size_in_bytes: substitutedArchive.byteLength,
						digest: `sha256:${sha256Bytes(substitutedArchive)}`,
					};
				},
				download: async url => {
					if (url === fixture.descriptorArchiveUrl) return substitutedArchive;
					captureDownloads += 1;
					return fixture.archive;
				},
			};
			await expect(
				verifyPetRendererVisualPublicationForTest({
					descriptor: fixture.descriptorLocator,
					reviewId: 11,
					api,
					executor,
				}),
			).rejects.toThrow(message);
			expect(captureDownloads).toBe(0);
		}
	});

	it("rejects expired or replaced artifact metadata", async () => {
		const expired = verifierFixture();
		const expiredGet = expired.api.get;
		const expiredApi: GitHubApi = {
			...expired.api,
			get: async requestPath => {
				const value = await expiredGet(requestPath);
				if (requestPath.endsWith("/actions/artifacts/11"))
					return { ...(value as Record<string, unknown>), expired: true };
				return value;
			},
		};
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: expired.descriptorLocator,
				reviewId: 11,
				api: expiredApi,
				executor,
			}),
		).rejects.toThrow("Actions artifact is expired");

		const replaced = verifierFixture();
		const replacedGet = replaced.api.get;
		const replacedApi: GitHubApi = {
			...replaced.api,
			get: async requestPath => {
				const value = await replacedGet(requestPath);
				if (requestPath.endsWith("/actions/artifacts/11"))
					return {
						...(value as Record<string, unknown>),
						archive_download_url: "https://github.com/acme/repo/actions/runs/12/artifacts/11",
					};
				return value;
			},
		};
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: replaced.descriptorLocator,
				reviewId: 11,
				api: replacedApi,
				executor,
			}),
		).rejects.toThrow("Actions artifact archive URL differs from descriptor");
	});

	it("resolves a descriptor only from its exact repository-bound Actions artifact route", async () => {
		const fixture = verifierFixture();
		const descriptorUrl = "https://github.com/acme/repo/actions/runs/11/artifacts/99";
		const verified = await verifyPetRendererVisualPublicationForTest({
			descriptor: descriptorUrl,
			reviewId: 11,
			api: fixture.api,
			executor,
		});
		expect(verified.descriptor).toEqual(fixture.descriptor);
		expect(fixture.requests.slice(0, 2)).toEqual([
			fixture.descriptorArtifactEndpoint,
			"/repos/acme/repo/actions/runs/11",
		]);
		expect(verified.descriptor_artifact_provenance).toEqual({
			schema_version: 1,
			schema: "pet-renderer-visual-descriptor-provenance-v1",
			artifact_id: fixture.descriptorArtifactId,
			artifact_name: "visual-qa-descriptor-run-11-attempt-1",
			artifact_digest: `sha256:${sha256Bytes(fixture.descriptorArchive)}`,
			workflow_run_id: 11,
			workflow_run_attempt: 1,
			repository: "acme/repo",
			pr_number: 11,
			pr_node_id: "PR_11",
			head_sha: H1,
			base_sha: BASE,
		});
	});
	it("rejects local, inline, and object descriptor bypass inputs", async () => {
		const fixture = verifierFixture();
		let requests = 0;
		let downloads = 0;
		const api: GitHubApi = {
			...fixture.api,
			get: async path => {
				requests += 1;
				return fixture.api.get(path);
			},
			download: async url => {
				downloads += 1;
				throw new Error(`unexpected descriptor download: ${url}`);
			},
		};
		for (const descriptor of [
			"/tmp/visual-qa-descriptor.json",
			JSON.stringify(fixture.descriptor),
			fixture.descriptor as unknown as string,
		]) {
			await expect(
				verifyPetRendererVisualPublicationForTest({
					descriptor,
					reviewId: 11,
					api,
					executor,
				}),
			).rejects.toThrow("descriptor must be a canonical run-scoped GitHub Actions artifact URL or ID");
		}
		expect(requests).toBe(0);
		expect(downloads).toBe(0);
	});

	it("rejects a descriptor artifact substituted from another workflow run before download", async () => {
		const fixture = verifierFixture();
		let downloads = 0;
		const originalGet = fixture.api.get;
		const api: GitHubApi = {
			...fixture.api,
			get: async requestPath => {
				const value = await originalGet(requestPath);
				if (requestPath === fixture.descriptorArtifactEndpoint)
					return { ...(value as Record<string, unknown>), workflow_run: { id: 12, repository_id: 99 } };
				return value;
			},
			download: async url => {
				downloads += 1;
				return fixture.api.download(url);
			},
		};
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: "https://github.com/acme/repo/actions/runs/11/artifacts/99",
				reviewId: 11,
				api,
				executor,
			}),
		).rejects.toThrow("descriptor Actions artifact workflow run differs from requested route");
		expect(downloads).toBe(0);
	});
	it("rejects descriptor head/base substitutions before capture download", async () => {
		const fixture = verifierFixture();
		for (const [field, value, message] of [
			["head_sha", H2, "pull-request workflow ref differs from descriptor head"],
			["base_sha", H2, "descriptor Actions workflow run pull request base differs from descriptor"],
			["head_repository", "other/repo", "canonical PR head repository differs from descriptor"],
			["base_repository_id", 88, "canonical PR base repository ID differs from descriptor"],
		] as const) {
			const substitutedDescriptor = { ...fixture.descriptor, [field]: value };
			const substitutedArchive = zipSync({
				"visual-qa-descriptor.json": new TextEncoder().encode(JSON.stringify(substitutedDescriptor)),
			});
			let captureDownloads = 0;
			const originalGet = fixture.api.get;
			const api: GitHubApi = {
				...fixture.api,
				get: async requestPath => {
					const result = await originalGet(requestPath);
					if (requestPath !== fixture.descriptorArtifactEndpoint) return result;
					return {
						...(result as Record<string, unknown>),
						size_in_bytes: substitutedArchive.byteLength,
						digest: `sha256:${sha256Bytes(substitutedArchive)}`,
					};
				},
				download: async url => {
					if (url === fixture.descriptorArchiveUrl) return substitutedArchive;
					captureDownloads += 1;
					return fixture.archive;
				},
			};
			await expect(
				verifyPetRendererVisualPublicationForTest({
					descriptor: "https://github.com/acme/repo/actions/runs/11/artifacts/99",
					reviewId: 11,
					api,
					executor,
				}),
			).rejects.toThrow(message);
			expect(captureDownloads).toBe(0);
		}
	});
	it("rejects canonical PR head/base repository substitutions before capture download", async () => {
		const fixture = verifierFixture();
		for (const [side, repository, message] of [
			[
				"head",
				{ id: 88, node_id: "R_other", full_name: "other/repo" },
				"canonical PR head repository differs from descriptor",
			],
			[
				"base",
				{ id: 88, node_id: "R_repo", full_name: "acme/repo" },
				"canonical PR base repository ID differs from descriptor",
			],
		] as const) {
			let captureDownloads = 0;
			const api: GitHubApi = {
				...fixture.api,
				get: async requestPath => {
					const value = await fixture.api.get(requestPath);
					if (requestPath !== fixture.endpoint) return value;
					const pr = value as Record<string, unknown>;
					return {
						...pr,
						[side]: {
							...(pr[side] as Record<string, unknown>),
							repo: repository,
						},
					};
				},
				download: async url => {
					if (url === fixture.descriptorArchiveUrl) return fixture.descriptorArchive;
					captureDownloads += 1;
					return fixture.archive;
				},
			};
			await expect(
				verifyPetRendererVisualPublicationForTest({
					descriptor: fixture.descriptorLocator,
					reviewId: 11,
					api,
					executor,
				}),
			).rejects.toThrow(message);
			expect(captureDownloads).toBe(0);
		}
	});

	it("requires one valid visual-qa descriptor member in the descriptor artifact", async () => {
		const fixture = verifierFixture();
		for (const descriptorArchive of [
			new Uint8Array([1, 2, 3]),
			zipSync({
				"visual-qa-descriptor.json": new TextEncoder().encode(JSON.stringify(fixture.descriptor)),
				"unexpected.json": new TextEncoder().encode("{}"),
			}),
		]) {
			const api: GitHubApi = {
				...fixture.api,
				get: async requestPath =>
					requestPath === fixture.descriptorArtifactEndpoint
						? {
								id: fixture.descriptorArtifactId,
								name: "visual-qa-descriptor-run-11-attempt-1",
								expired: false,
								size_in_bytes: descriptorArchive.byteLength,
								digest: `sha256:${sha256Bytes(descriptorArchive)}`,
								archive_download_url: fixture.descriptorArchiveUrl,
								workflow_run: { id: 11, repository_id: 99 },
							}
						: fixture.api.get(requestPath),
				download: async () => descriptorArchive,
			};
			await expect(
				verifyPetRendererVisualPublicationForTest({
					descriptor: fixture.descriptorArtifactId,
					repository: "acme/repo",
					reviewId: 11,
					api,
					executor,
				}),
			).rejects.toThrow();
		}
	});

	it("rejects off-origin descriptor URLs without making a request", async () => {
		let requests = 0;
		const previousFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: string | URL | Request, _init?: RequestInit) => {
			requests += 1;
			return new Response("unexpected", { status: 200 });
		}) as unknown as typeof fetch;
		try {
			await expect(
				verifyPetRendererVisualPublication({
					descriptor: "https://evil.example/acme/repo/actions/runs/11/artifacts/99",
					reviewId: 11,
					token: "test-token",
				}),
			).rejects.toThrow("descriptor URL must be canonical GitHub HTTPS");
		} finally {
			globalThis.fetch = previousFetch;
		}
		expect(requests).toBe(0);
	});

	it("rejects a canonical PR head race between the initial and final reads", async () => {
		const fixture = verifierFixture({ finalHead: H2 });
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api: fixture.api,
				executor,
			}),
		).rejects.toThrow("canonical PR head/base changed");
		expect(fixture.requests).toEqual([
			fixture.descriptorArtifactEndpoint,
			"/repos/acme/repo/actions/runs/11",
			fixture.endpoint,
			"/repos/acme/repo/actions/artifacts/11",
			"/repos/acme/repo/actions/runs/11",
			fixture.commitsEndpoint,
			fixture.reviewEndpoint,
			fixture.endpoint,
		]);
	});
	it("rejects a final canonical PR head repository identity change even when the head SHA is unchanged", async () => {
		const fixture = verifierFixture();
		let canonicalReads = 0;
		const originalGet = fixture.api.get;
		const api: GitHubApi = {
			...fixture.api,
			get: async requestPath => {
				const value = await originalGet(requestPath);
				if (requestPath !== fixture.endpoint || canonicalReads++ === 0) return value;
				const pr = value as Record<string, unknown>;
				return {
					...pr,
					head: {
						...(pr.head as Record<string, unknown>),
						sha: H1,
						repo: { id: 100, node_id: "R_other", full_name: "other/repo" },
					},
				};
			},
		};
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api,
				executor,
			}),
		).rejects.toThrow("final canonical PR head repository differs from descriptor");
	});

	it("rejects an H1 authenticated review whose cosmetic body claims H2", async () => {
		const fixture = verifierFixture({
			descriptorHead: H2,
			reviewCommitId: H1,
			reviewBody: `Approved visual evidence for ${H2}`,
		});
		expect(fixture.review.body).toContain(H2);
		expect(fixture.review.commit_id).toBe(H1);
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api: fixture.api,
				executor,
			}),
		).rejects.toThrow("review/final-head SHA binding mismatch");
	});

	it("skips unresolved null commit authors while preserving known author exclusions", async () => {
		const fixture = verifierFixture({
			commitAuthors: [null, { id: 55, node_id: "U_commit_author", login: "contributor" }],
		});
		const verified = await verifyPetRendererVisualPublicationForTest({
			descriptor: fixture.descriptorLocator,
			reviewId: 11,
			api: fixture.api,
			executor,
		});
		expect(verified.reviewer.id).toBe(22);
	});
	it("excludes a commit committer even when the commit author is different", async () => {
		const committer = { id: 22, node_id: "U_reviewer_22", login: "independent-reviewer", type: "User" };
		const fixture = verifierFixture({
			reviewer: committer,
			commitAuthors: [{ id: 55, node_id: "U_commit_author", login: "contributor" }],
			commitCommitters: [committer],
		});
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api: fixture.api,
				executor,
			}),
		).rejects.toThrow("reviewer overlaps an excluded immutable identity");
	});
	it("excludes the immutable PR author even when that author has no PR commits", async () => {
		const prAuthor = { id: 33, node_id: "U_author", login: "author", type: "User" };
		const fixture = verifierFixture({ prAuthor, reviewer: prAuthor });
		await expect(
			verifyPetRendererVisualPublicationForTest({
				descriptor: fixture.descriptorLocator,
				reviewId: 11,
				api: fixture.api,
				executor,
			}),
		).rejects.toThrow("reviewer overlaps an excluded immutable identity");
		expect(fixture.requests).toContain(fixture.commitsEndpoint);
	});
});
