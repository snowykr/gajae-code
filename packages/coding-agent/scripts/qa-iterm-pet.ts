#!/usr/bin/env bun
/**
 * Declared-schema/integrity-only iTerm Pet QA bundle validator.
 *
 * This tool validates declarations and bytes.  It does not establish that a
 * bundle was produced by a live PTY; that classification is an external
 * review concern.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { logger } from "@gajae-code/utils";

type Json = Record<string, unknown>;
type SourceKind = "live-pty" | "replay" | "fixture";
type Member = { path: string; sha256: string; size: number; kind?: string; caseId?: string };
type Artifact = {
	path: string;
	sha256: string;
	format?: string;
	role?: string;
	provenance?: string;
	classification?: "current" | "regression";
	observedResult?: string;
};
type Bundle = {
	[key: string]: unknown;
	caseId: string;
	viewport: string;
	scroll: string;
	members: Member[];
	metadata: Json;
};
type RasterEvidence = { artifactSha256: string; width: number; height: number };
type OwnedRectangle = { x: number; y: number; width: number; height: number };
type EraseEvidence = { before: RasterEvidence; after: RasterEvidence };
type StateScenario = {
	expected: RasterEvidence;
	actual: RasterEvidence;
	owned: OwnedRectangle;
	erase: EraseEvidence;
	telemetryMs: number;
};
const requestedVersions = ["3.5.0", "3.6.11"];
const requestedModes = ["direct", "tmux"];
const REQUIRED_PRODUCER = "gjc-iterm-live-capture-v1";
const EXPECTED_CJK: Record<string, string[]> = {
	"cjk-ko-composer-idle": ["저장하지 않은 변경 사항이 있습니다.", "Enter로 저장하거나", "Esc로 취소하세요."],
	"cjk-ja-stream-working": ["未保存の変更があります。", "Enter で保存し、", "Esc でキャンセルします。"],
	"cjk-zh-error-recovery": ["存在未保存的更改。", "按 Enter 保存，", "按 Esc 取消。"],
	"cjk-mixed-preview-scroll": [
		"작업 상태: 준비 중입니다.",
		"iTerm2 환경에서",
		"출력 상태를 확인하세요.",
		"Enter로 계속하고 Esc로 취소하세요.",
	],
};
const PET_IDS = [
	"red-idle",
	"red-working",
	"red-burst",
	"red-preview",
	"blue-idle",
	"blue-working",
	"blue-burst",
	"blue-preview",
	"missing-f",
	"invalid-f",
	"probe-timeout",
	"erase",
];
const cjkRangeFor = (scroll: string): [number, number] | undefined =>
	scroll === "top" ? [1, 21] : scroll === "middle" ? [50, 70] : scroll === "bottom" ? [100, 120] : undefined;
const deterministicCjkBody = (segments: string[], range: [number, number]): string =>
	Array.from({ length: range[1] - range[0] + 1 }, (_, index) => {
		const line = range[0] + index;
		return `${String(line).padStart(3, "0")}: ${segments[index % segments.length]}`;
	}).join("\n");
const petAnchorCases = new Set(PET_IDS);
petAnchorCases.add("topology-ineligible");
const composerAnchorCases = new Set(Object.keys(EXPECTED_CJK));
function die(message: string): never {
	logger.error("iTerm Pet QA failed", { error: message });
	process.exit(2);
	throw Error(message);
}
const args = process.argv.slice(2);
const values = (name: string): string[] => {
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) if (args[i] === `--${name}`) result.push(args[i + 1] ?? "");
	return result;
};
const one = (name: string): string | undefined => values(name)[0];
const inputName = one("input");
const outputName = one("output");
const versionArg = one("versions");
const modeArg = one("modes");
const versions = (versionArg ?? "").split(",").filter(Boolean);
const modes = (modeArg ?? "").split(",").filter(Boolean);
const expectedValues = values("expected-sha");
const expectedSha = expectedValues.length === 1 ? expectedValues[0] : "";
if (
	!outputName ||
	versions.join() !== requestedVersions.join() ||
	modes.join() !== requestedModes.join() ||
	expectedValues.length !== 1 ||
	!/^[a-f0-9]{40}$/.test(expectedSha) ||
	/^0{40}$/.test(expectedSha)
)
	die(
		"usage: --versions 3.5.0,3.6.11 --modes direct,tmux --expected-sha <40 lowercase hex> [--input <capture manifest|root>] --output <controlled root>",
	);
const output = outputName ?? die("output is required");
const inputNameValue = inputName ?? join(output, "manifest.json");
const asJson = (value: unknown): Json | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
const hasString = <K extends string>(value: Json, key: K): value is Json & Record<K, string> =>
	typeof value[key] === "string";
const hasNumber = <K extends string>(value: Json, key: K): value is Json & Record<K, number> =>
	typeof value[key] === "number" && Number.isFinite(value[key]);
const hasStringArray = <K extends string>(value: Json, key: K): value is Json & Record<K, string[]> =>
	Array.isArray(value[key]) && value[key].every(item => typeof item === "string");
const isRasterEvidence = (value: unknown): value is RasterEvidence => {
	const item = asJson(value);
	return (
		!!item &&
		hasString(item, "artifactSha256") &&
		/^[a-f0-9]{64}$/.test(item.artifactSha256) &&
		hasNumber(item, "width") &&
		Number.isInteger(item.width) &&
		item.width > 0 &&
		hasNumber(item, "height") &&
		Number.isInteger(item.height) &&
		item.height > 0
	);
};
const isOwnedRectangle = (value: unknown): value is OwnedRectangle => {
	const item = asJson(value);
	return (
		!!item &&
		hasNumber(item, "x") &&
		Number.isInteger(item.x) &&
		item.x >= 0 &&
		hasNumber(item, "y") &&
		Number.isInteger(item.y) &&
		item.y >= 0 &&
		hasNumber(item, "width") &&
		Number.isInteger(item.width) &&
		item.width > 0 &&
		hasNumber(item, "height") &&
		Number.isInteger(item.height) &&
		item.height > 0
	);
};
const asStateScenario = (value: unknown): StateScenario | undefined => {
	const item = asJson(value);
	if (!item) return undefined;
	const expected = isRasterEvidence(item.expected) ? item.expected : undefined;
	const actual = isRasterEvidence(item.actual) ? item.actual : undefined;
	const owned = isOwnedRectangle(item.owned) ? item.owned : undefined;
	const erase = asJson(item.erase);
	const before = erase && isRasterEvidence(erase.before) ? erase.before : undefined;
	const after = erase && isRasterEvidence(erase.after) ? erase.after : undefined;
	return expected && actual && owned && before && after && hasNumber(item, "telemetryMs")
		? { expected, actual, owned, erase: { before, after }, telemetryMs: item.telemetryMs }
		: undefined;
};
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const canonicalPath = (path: string): string => {
	const absolute = resolve(path);
	let existing = absolute;
	const suffix: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) die(`path has no existing ancestor: ${path}`);
		suffix.unshift(existing.slice(parent.length + 1));
		existing = parent;
	}
	return suffix.reduce((current, part) => join(current, part), realpathSync(existing));
};
const safePath = (root: string, declared: string): string => {
	if (!declared || isAbsolute(declared)) die(`member path is unsafe: ${declared}`);
	const path = resolve(root, declared);
	const rel = relative(root, path);
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) die(`member path escapes root: ${declared}`);
	if (!existsSync(path)) die(`member unavailable: ${declared}`);
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isFile()) die(`member is not a regular file: ${declared}`);
	const canonical = realpathSync(path);
	const canonicalRel = relative(realpathSync(root), canonical);
	if (!canonicalRel || canonicalRel.startsWith("..") || isAbsolute(canonicalRel))
		die(`member path escapes root: ${declared}`);
	return canonical;
};
const parseJsonFile = (path: string, message: string): Json => {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return asJson(value) ?? die(message);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("iTerm Pet QA failed:")) throw error;
		die(message);
	}
};
const validSha = (value: unknown): value is string =>
	typeof value === "string" && /^[a-f0-9]{40}$/.test(value) && !/^0{40}$/.test(value);
const sourceKind = (value: unknown): SourceKind | undefined =>
	value === "fixture" || value === "replay" || value === "live-pty" ? value : undefined;
const declaredSource = (value: Json, label: string): SourceKind => {
	const classification = sourceKind(value.classification);
	const source = asJson(value.source);
	if (!classification || !source || source.kind !== classification)
		die(`${label}: classification/source declaration is invalid`);
	return classification;
};
const requireRevision = (value: Json, label: string): void => {
	if (
		value.expectedSha !== expectedSha ||
		value.gitRevision !== expectedSha ||
		!validSha(value.expectedSha) ||
		!validSha(value.gitRevision)
	)
		die(`${label}: expected SHA declaration is invalid`);
};
const digestMember = (root: string, value: unknown, label: string, caseId?: string): Member => {
	const object = asJson(value);
	if (
		!object ||
		!hasString(object, "path") ||
		!hasString(object, "sha256") ||
		!/^[a-f0-9]{64}$/.test(object.sha256) ||
		!hasNumber(object, "size") ||
		!Number.isInteger(object.size) ||
		object.size < 0
	)
		die(`${label}: member declaration is invalid`);
	const path = safePath(root, object.path);
	const bytes = readFileSync(path);
	if (bytes.length !== object.size || sha256(bytes) !== object.sha256) die(`${label}: member digest/size mismatch`);
	return {
		path: object.path,
		sha256: object.sha256,
		size: object.size,
		...(typeof object.kind === "string" ? { kind: object.kind } : {}),
		...(caseId ? { caseId } : {}),
	};
};
const visibleWidth = (text: string): number => {
	let width = 0;
	for (const char of text.normalize("NFC")) {
		const code = char.codePointAt(0) ?? 0;
		width +=
			code >= 0x1100 &&
			(code <= 0x115f ||
				code === 0x2329 ||
				code === 0x232a ||
				(code >= 0x2e80 && code <= 0xa4cf) ||
				(code >= 0xac00 && code <= 0xd7a3) ||
				(code >= 0xf900 && code <= 0xfaff) ||
				(code >= 0xfe10 && code <= 0xfe19) ||
				(code >= 0xfe30 && code <= 0xfe6f) ||
				(code >= 0xff00 && code <= 0xff60) ||
				(code >= 0xffe0 && code <= 0xffe6))
				? 2
				: 1;
	}
	return width;
};
const stripAnsi = (value: string): string =>
	value.replace(
		/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
		"",
	);
const declaredMode = (value: Json, label: string): string | undefined => {
	const mode = typeof value.mode === "string" ? value.mode : undefined;
	const transport = typeof value.transport === "string" ? value.transport : undefined;
	if (mode && transport && mode !== transport) die(`${label}: mode/transport declarations disagree`);
	return mode ?? transport;
};
const validateTerminalContent = (
	rootDir: string,
	textPath: string,
	ansiPath: string,
	bundle: Bundle,
	metadata: Json,
	label: string,
): void => {
	const text = readFileSync(safePath(rootDir, textPath), "utf8").normalize("NFC");
	const ansi = readFileSync(safePath(rootDir, ansiPath), "utf8");
	if (stripAnsi(ansi).normalize("NFC") !== text) die(`${label}: ANSI/text content differs`);
	if (petAnchorCases.has(bundle.caseId) && !text.includes(bundle.caseId)) die(`${label}: pet anchor is missing`);
	if (composerAnchorCases.has(bundle.caseId) && (!text.includes("Enter") || !text.includes("Esc")))
		die(`${label}: composer anchor is missing`);
	const segments = EXPECTED_CJK[bundle.caseId];
	if (!segments) return;
	let cursor = 0;
	for (const segment of segments) {
		const position = text.indexOf(segment, cursor);
		if (position < cursor) die(`${label}: semantic content is missing`);
		cursor = position + segment.length;
	}
	if (bundle.caseId !== "cjk-mixed-preview-scroll") return;
	const expectedRange = cjkRangeFor(bundle.scroll);
	const range: unknown[] = Array.isArray(metadata.scrollRange) ? metadata.scrollRange : [];
	const rangeNumbers =
		range.length === 2 &&
		typeof range[0] === "number" &&
		Number.isInteger(range[0]) &&
		typeof range[1] === "number" &&
		Number.isInteger(range[1])
			? ([range[0], range[1]] as [number, number])
			: undefined;
	if (
		!hasNumber(metadata, "lineCount") ||
		!Number.isInteger(metadata.lineCount) ||
		metadata.lineCount !== 120 ||
		!rangeNumbers ||
		!expectedRange ||
		JSON.stringify(range) !== JSON.stringify(expectedRange) ||
		rangeNumbers[0] < 1 ||
		rangeNumbers[1] > metadata.lineCount ||
		rangeNumbers[0] > rangeNumbers[1] ||
		text !== deterministicCjkBody(segments, expectedRange) ||
		stripAnsi(ansi).normalize("NFC") !== deterministicCjkBody(segments, expectedRange)
	)
		die(`${label}: deterministic CJK body/range is invalid`);
};
const validateMetadata = (
	metadata: Json,
	version: string,
	mode: string,
	bundle: Bundle,
	classification: SourceKind,
	label: string,
): void => {
	if (
		metadata.schemaVersion !== 2 ||
		metadata.caseId !== bundle.caseId ||
		metadata.iTermVersion !== version ||
		declaredMode(metadata, label) !== mode ||
		metadata.viewport !== bundle.viewport ||
		metadata.scroll !== bundle.scroll ||
		!validSha(metadata.expectedSha) ||
		metadata.expectedSha !== expectedSha ||
		!validSha(metadata.gitRevision) ||
		metadata.gitRevision !== expectedSha ||
		sourceKind(metadata.classification) !== classification ||
		asJson(metadata.source)?.kind !== classification ||
		typeof metadata.producer !== "string" ||
		!String(metadata.producer).trim() ||
		typeof metadata.toolVersion !== "string" ||
		!String(metadata.toolVersion).trim() ||
		typeof metadata.capturedAt !== "string" ||
		!String(metadata.capturedAt).trim() ||
		typeof metadata.commandOrReplay !== "string" ||
		!String(metadata.commandOrReplay).trim() ||
		typeof metadata.fontFamily !== "string" ||
		!String(metadata.fontFamily).trim() ||
		!["fontSize", "zoom", "cellWidthPx", "cellHeightPx"].every(
			key => hasNumber(metadata, key) && metadata[key] > 0,
		) ||
		typeof metadata.wrappingPolicy !== "string" ||
		typeof metadata.truncationPolicy !== "string" ||
		!hasStringArray(metadata, "linkedRasterIdentifiers")
	)
		die(`${label}: metadata declaration is invalid`);
	const segments = EXPECTED_CJK[bundle.caseId];
	if (segments) {
		if (
			!Array.isArray(metadata.semanticSegments) ||
			JSON.stringify(metadata.semanticSegments) !== JSON.stringify(segments) ||
			segments.some(segment => visibleWidth(segment) > 40)
		)
			die(`${label}: semantic CJK segments are invalid`);
		if (
			bundle.caseId === "cjk-mixed-preview-scroll" &&
			(!hasNumber(metadata, "lineCount") ||
				!Number.isInteger(metadata.lineCount) ||
				metadata.lineCount !== 120 ||
				JSON.stringify(metadata.scrollRange) !== JSON.stringify(cjkRangeFor(bundle.scroll)))
		)
			die(`${label}: deterministic scroll range is invalid`);
		if (bundle.caseId !== "cjk-mixed-preview-scroll" && bundle.scroll !== "top")
			die(`${label}: non-scroll CJK case has an invalid range`);
		if (bundle.viewport === "40x12" && metadata.resizeFrom !== "80x24") die(`${label}: resize transition is missing`);
	}
};
const memberNames = ["terminal.txt", "terminal-ansi.txt", "terminal.html", "metadata.json"];
const normalizeBundle = (
	rootDir: string,
	value: unknown,
	version: string,
	mode: string,
	classification: SourceKind,
): Bundle => {
	const item = asJson(value);
	if (!item || typeof item.caseId !== "string" || typeof item.viewport !== "string" || typeof item.scroll !== "string")
		die(`${version}/${mode}: bundle declaration is invalid`);
	const caseId = item.caseId;
	requireRevision(item, `${version}/${mode}/${item.caseId}`);
	if (declaredSource(item, `${version}/${mode}/${item.caseId}`) !== classification)
		die(`${version}/${mode}/${item.caseId}: source differs from capture`);
	if (!["80x24", "40x12"].includes(item.viewport) || !["top", "middle", "bottom"].includes(item.scroll))
		die(`${version}/${mode}: bundle viewport/scroll is invalid`);
	const raw = Array.isArray(item.members) ? item.members : Array.isArray(item.files) ? item.files : undefined;
	const membersRaw = raw ?? die(`${version}/${mode}/${item.caseId}: required evidence members are missing`);
	if (membersRaw.length !== 4) die(`${version}/${mode}/${item.caseId}: required evidence members are missing`);
	const members = membersRaw.map((member, index) =>
		digestMember(rootDir, member, `${version}/${mode}/${caseId}/${index}`, caseId),
	);
	const names = new Set(members.map(member => basename(member.path)));
	if (names.size !== 4 || memberNames.some(name => !names.has(name)))
		die(`${version}/${mode}/${item.caseId}: required evidence members are missing`);
	const metadataMember = members.find(member => basename(member.path) === "metadata.json");
	if (!metadataMember) die(`${version}/${mode}/${caseId}: required metadata member is missing`);
	const metadata = parseJsonFile(
		safePath(rootDir, metadataMember.path),
		`${version}/${mode}/${caseId}: metadata is invalid`,
	);
	const bundle: Bundle = {
		...item,
		caseId,
		viewport: item.viewport,
		scroll: item.scroll,
		members,
		metadata,
	};
	const textMember = members.find(member => basename(member.path) === "terminal.txt");
	const ansiMember = members.find(member => basename(member.path) === "terminal-ansi.txt");
	if (!textMember || !ansiMember) die(`${version}/${mode}/${caseId}: required terminal members are missing`);
	validateTerminalContent(rootDir, textMember.path, ansiMember.path, bundle, metadata, `${version}/${mode}/${caseId}`);
	validateMetadata(metadata, version, mode, bundle, classification, `${version}/${mode}/${item.caseId}`);
	if (
		!hasStringArray(metadata, "linkedRasterIdentifiers") ||
		metadata.linkedRasterIdentifiers.some(value => !/^[a-f0-9]{64}$/.test(value))
	)
		die(`${version}/${mode}/${item.caseId}: raster linkage is invalid`);
	return bundle;
};
const journalPathFor = (outputPath: string): string => `${outputPath}.transaction-journal`;
const writeJournal = (path: string, value: Json): void => {
	const fd = openSync(path, "w");
	try {
		writeFileSync(fd, `${JSON.stringify(value)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
};
const parseRoot = (path: string): Json => parseJsonFile(path, "capture input is not valid JSON");
const resolveEvidencePointer = (document: Json, reference: unknown): Json | undefined => {
	if (typeof reference !== "string" || !reference.startsWith("evidence.json#/")) return undefined;
	let pointer: string;
	try {
		pointer = decodeURIComponent(reference.slice("evidence.json#".length));
	} catch {
		return undefined;
	}
	if (!pointer.startsWith("/")) return undefined;
	let current: unknown = document;
	for (const rawToken of pointer.slice(1).split("/")) {
		if (/~(?!0|1)/.test(rawToken)) return undefined;
		const token = rawToken.replace(/~1/g, "/").replace(/~0/g, "~");
		if (Array.isArray(current)) {
			if (!/^(0|[1-9]\d*)$/.test(token)) return undefined;
			current = current[Number(token)];
		} else {
			const object = asJson(current);
			if (!object || !(token in object)) return undefined;
			current = object[token];
		}
	}
	return asJson(current);
};
const expectedPublishedCaseIds = (mode: string): Set<string> =>
	new Set([...PET_IDS, ...(mode === "tmux" ? ["topology-ineligible"] : []), ...Object.keys(EXPECTED_CJK)]);
const expectedPublishedBundleKeys = (mode: string): Set<string> => {
	const keys = [...PET_IDS, ...(mode === "tmux" ? ["topology-ineligible"] : [])].map(caseId => `${caseId}/80x24/top`);
	for (const caseId of Object.keys(EXPECTED_CJK)) {
		keys.push(`${caseId}/80x24/top`, `${caseId}/40x12/top`);
		if (caseId === "cjk-mixed-preview-scroll") keys.push(`${caseId}/80x24/middle`, `${caseId}/80x24/bottom`);
	}
	return new Set(keys);
};
const validatePublished = (outputPath: string): void => {
	if (!existsSync(outputPath) || readdirSync(outputPath).sort().join() !== requestedVersions.join())
		die("published output hierarchy is invalid");
	for (const version of requestedVersions)
		for (const mode of requestedModes) {
			const dir = join(outputPath, version, mode);
			if (!existsSync(dir) || readdirSync(dir).sort().join() !== "captures,evidence.json,manifest.json,rasters")
				die(`published hierarchy is invalid: ${version}/${mode}`);
			const manifest = parseRoot(join(dir, "manifest.json"));
			const evidence = parseRoot(join(dir, "evidence.json"));
			if (
				manifest.schemaVersion !== 2 ||
				manifest.expectedSha !== expectedSha ||
				manifest.gitRevision !== expectedSha ||
				manifest.iTermVersion !== version ||
				manifest.mode !== mode
			)
				die(`published manifest is invalid: ${version}/${mode}`);
			const classification = declaredSource(manifest, `${version}/${mode}/manifest`);
			if (
				manifest.producer !== REQUIRED_PRODUCER ||
				typeof manifest.provenance !== "string" ||
				!manifest.provenance.trim() ||
				typeof manifest.capturedAt !== "string" ||
				!manifest.capturedAt.trim()
			)
				die(`published manifest is invalid: ${version}/${mode}`);
			if (
				evidence.schemaVersion !== 2 ||
				evidence.expectedSha !== expectedSha ||
				evidence.gitRevision !== expectedSha ||
				sourceKind(evidence.classification) !== classification ||
				asJson(evidence.source)?.kind !== classification
			)
				die(`published evidence is invalid: ${version}/${mode}`);
			const files = Array.isArray(manifest.files) ? manifest.files : [];
			const listed = new Set<string>();
			for (const entry of files) {
				const member = asJson(entry);
				if (
					!member ||
					typeof member.path !== "string" ||
					listed.has(member.path) ||
					member.path === "manifest.json" ||
					member.path === "evidence.json"
				)
					die(`published file table is invalid: ${version}/${mode}`);
				listed.add(member.path);
				const path = safePath(dir, member.path);
				const bytes = readFileSync(path);
				if (member.size !== bytes.length || member.sha256 !== sha256(bytes))
					die(`published file digest is invalid: ${version}/${mode}`);
			}
			const actual: string[] = [];
			const walk = (base: string, prefix: string): void => {
				for (const name of readdirSync(base)) {
					const path = join(base, name),
						rel = prefix ? `${prefix}/${name}` : name;
					if (lstatSync(path).isDirectory()) walk(path, rel);
					else actual.push(rel);
				}
			};
			walk(join(dir, "captures"), "captures");
			walk(join(dir, "rasters"), "rasters");
			if (actual.sort().join() !== [...listed].sort().join())
				die(`published file table is incomplete: ${version}/${mode}`);
			const bundles = Array.isArray(manifest.bundles) ? manifest.bundles : [];
			const seen = new Set<string>();
			const expectedBundleKeys = expectedPublishedBundleKeys(mode);
			if (bundles.length !== expectedBundleKeys.size) die(`published bundle matrix is invalid: ${version}/${mode}`);
			for (const value of bundles) {
				const b = asJson(value);
				if (!b || typeof b.caseId !== "string" || typeof b.viewport !== "string" || typeof b.scroll !== "string")
					die(`published bundle is invalid: ${version}/${mode}`);
				if (
					b.expectedSha !== expectedSha ||
					b.gitRevision !== expectedSha ||
					sourceKind(b.classification) !== classification ||
					asJson(b.source)?.kind !== classification
				)
					die(`published bundle declaration is invalid: ${version}/${mode}`);
				const key = `${b.caseId}/${b.viewport}/${b.scroll}`;
				if (seen.has(key)) die(`published bundle is duplicated: ${version}/${mode}`);
				seen.add(key);
				if (!expectedBundleKeys.has(key)) die(`published bundle matrix is invalid: ${version}/${mode}`);
				const metadataPath = typeof b.metadataPath === "string" ? b.metadataPath : "";
				if (!listed.has(metadataPath)) die(`published metadata is unbound: ${version}/${mode}`);
				const metadata = parseJsonFile(
					join(dir, metadataPath),
					`published metadata is invalid: ${version}/${mode}`,
				);
				const bundle: Bundle = {
					caseId: b.caseId,
					viewport: b.viewport,
					scroll: b.scroll,
					members: [],
					metadata,
				};
				validateMetadata(metadata, version, mode, bundle, classification, `${version}/${mode}/${key}`);
				if (!hasStringArray(metadata, "linkedRasterIdentifiers"))
					die(`published metadata is invalid: ${version}/${mode}`);
				for (const hash of metadata.linkedRasterIdentifiers)
					if (!listed.has(`rasters/${hash}.rgba`) && !listed.has(`rasters/${hash}.png`))
						die(`published raster linkage is unbound: ${version}/${mode}`);
				let textPath = "";
				let ansiPath = "";
				for (const name of memberNames) {
					const path =
						typeof b[`${name.replace(".", "_")}Path`] === "string"
							? String(b[`${name.replace(".", "_")}Path`])
							: `${dirname(metadataPath)}/${name}`;
					if (path !== `${dirname(metadataPath)}/${name}` || !listed.has(path))
						die(`published bundle member is unbound: ${version}/${mode}`);
					if (name === "terminal.txt") textPath = path;
					if (name === "terminal-ansi.txt") ansiPath = path;
				}
				validateTerminalContent(dir, textPath, ansiPath, bundle, metadata, `${version}/${mode}/${key}`);
			}
			if (seen.size !== expectedBundleKeys.size || [...expectedBundleKeys].some(key => !seen.has(key)))
				die(`published bundle matrix is incomplete: ${version}/${mode}`);
			const records = Array.isArray(evidence.records) ? evidence.records : [];
			const cases = Array.isArray(manifest.cases) ? manifest.cases : [];
			const expectedCaseIds = expectedPublishedCaseIds(mode);
			const bundleCaseIds = new Set([...seen].map(key => key.split("/")[0]));
			if (
				bundleCaseIds.size !== expectedCaseIds.size ||
				[...expectedCaseIds].some(caseId => !bundleCaseIds.has(caseId))
			)
				die(`published case-to-bundle relationship is invalid: ${version}/${mode}`);
			const recordIds = records.map(value => asJson(value)?.caseId);
			const caseIds = cases.map(value => asJson(value)?.caseId);
			if (
				records.length !== expectedCaseIds.size ||
				cases.length !== expectedCaseIds.size ||
				recordIds.some(value => typeof value !== "string") ||
				caseIds.some(value => typeof value !== "string") ||
				new Set(recordIds).size !== expectedCaseIds.size ||
				new Set(caseIds).size !== expectedCaseIds.size ||
				[...expectedCaseIds].some(id => !recordIds.includes(id) || !caseIds.includes(id))
			)
				die(`published case evidence is invalid: ${version}/${mode}`);
			for (const value of [...records, ...cases]) {
				const record = asJson(value);
				if (
					!record ||
					record.expectedSha !== expectedSha ||
					record.gitRevision !== expectedSha ||
					sourceKind(record.classification) !== classification ||
					asJson(record.source)?.kind !== classification
				)
					die(`published case declaration is invalid: ${version}/${mode}`);
			}
			for (const value of cases) {
				const record = asJson(value);
				const linked = record && resolveEvidencePointer(evidence, record.evidence);
				if (!record || !linked || linked.caseId !== record.caseId)
					die(`published evidence pointer is invalid: ${version}/${mode}`);
			}
			const successCases = cases.filter(value => typeof asJson(value)?.actualCapture === "string");
			if (
				successCases.length !== 8 ||
				new Set(successCases.map(value => String(asJson(value)?.actualCapture))).size !== 8 ||
				successCases.some(value => !listed.has(String(asJson(value)?.actualCapture)))
			)
				die(`published raster cases are invalid: ${version}/${mode}`);
			validateMatrix(seen, version, mode);
		}
};
const validateMatrix = (seen: Set<string>, version: string, mode: string): void => {
	for (const id of Object.keys(EXPECTED_CJK)) {
		for (const key of [`${id}/80x24/top`, `${id}/40x12/top`])
			if (!seen.has(key)) die(`CJK matrix is incomplete: ${version}/${mode}`);
		if (id === "cjk-mixed-preview-scroll")
			for (const scroll of ["middle", "bottom"])
				if (!seen.has(`${id}/80x24/${scroll}`)) die(`CJK matrix is incomplete: ${version}/${mode}`);
	}
};
const recoverPublication = (outputPath: string): void => {
	const journal = journalPathFor(outputPath);
	if (!existsSync(journal)) return;
	const journalStat = lstatSync(journal);
	if (journalStat.isSymbolicLink() || !journalStat.isFile()) die("publication journal is invalid");
	const declaration = parseRoot(journal);
	const backup = typeof declaration.backup === "string" ? declaration.backup : "";
	const validSibling = (value: string): boolean => {
		if (!isAbsolute(value) || resolve(value) !== value || dirname(value) !== dirname(outputPath)) return false;
		if (value === outputPath || value === journal) return false;
		const name = basename(value);
		if (!name.startsWith(`${basename(outputPath)}.backup-`) || !existsSync(value)) return false;
		const stat = lstatSync(value);
		return (
			stat.isDirectory() &&
			!stat.isSymbolicLink() &&
			canonicalPath(dirname(value)) === canonicalPath(dirname(outputPath))
		);
	};
	if (declaration.output !== outputPath || (backup && !validSibling(backup))) die("publication journal is invalid");
	if (!existsSync(outputPath) && backup) {
		validatePublished(backup);
		renameSync(backup, outputPath);
	}
	if (existsSync(outputPath)) {
		validatePublished(outputPath);
		rmSync(journal, { force: true });
	}
};
const compareRaster = (scenario: StateScenario, artifacts: Artifact[], rootDir: string): void => {
	const refs = new Map(artifacts.map(ref => [ref.sha256, ref]));
	const raster = (value: RasterEvidence): { width: number; height: number; bytes: Buffer } => {
		const ref = refs.get(value.artifactSha256);
		if (ref?.format !== "rgba8") throw Error("raster must reference rgba8 sidecar");
		const bytes = readFileSync(safePath(rootDir, ref.path));
		if (bytes.length !== value.width * value.height * 4 || sha256(bytes) !== value.artifactSha256)
			throw Error("raster geometry or digest mismatch");
		return { width: value.width, height: value.height, bytes };
	};
	const ex = raster(scenario.expected);
	const ac = raster(scenario.actual);
	const before = raster(scenario.erase.before);
	const after = raster(scenario.erase.after);
	if ([ac, before, after].some(item => item.width !== ex.width || item.height !== ex.height))
		throw Error("exact geometry mismatch");
	const { x, y, width, height } = scenario.owned;
	if (x + width > ex.width || y + height > ex.height) throw Error("owned rectangle is invalid");
	let shown = 0;
	const colors = new Set<string>();
	for (let row = y; row < y + height; row++)
		for (let col = x; col < x + width; col++) {
			const pixel = ac.bytes.subarray((row * ex.width + col) * 4, (row * ex.width + col + 1) * 4);
			if (pixel[3] !== 0) {
				shown++;
				colors.add(pixel.toString("hex"));
			}
		}
	if (shown < 2 || colors.size < 2) throw Error("actual owned raster lacks meaningful variation");
	let changed = 0;
	for (let i = 0; i < ex.width * ex.height; i++)
		if (!ex.bytes.subarray(i * 4, i * 4 + 4).equals(ac.bytes.subarray(i * 4, i * 4 + 4))) changed++;
	if (changed > ex.width * ex.height * 0.005) throw Error("pixel mismatch exceeds 0.5%");
	if (!before.bytes.equals(ac.bytes) || !after.bytes.equals(ex.bytes)) throw Error("erase evidence is invalid");
	for (let i = 0; i < ex.width * ex.height; i++) {
		const col = i % ex.width,
			row = Math.floor(i / ex.width);
		if (
			(col < x || col >= x + width || row < y || row >= y + height) &&
			!before.bytes.subarray(i * 4, i * 4 + 4).equals(after.bytes.subarray(i * 4, i * 4 + 4))
		)
			throw Error("exterior pixels changed after erase");
	}
	if (scenario.telemetryMs < 0 || scenario.telemetryMs > 250) throw Error("semantic telemetry delta is invalid");
};
const validatePng = (bytes: Buffer, label: string): void => {
	const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) die(`artifact is not a PNG: ${label}`);
	let offset = 8,
		hasIHDR = false,
		hasIDAT = false,
		hasIEND = false;
	while (offset < bytes.length) {
		if (offset + 12 > bytes.length) die(`artifact PNG framing invalid: ${label}`);
		const length = bytes.readUInt32BE(offset),
			type = bytes.toString("ascii", offset + 4, offset + 8),
			end = offset + 12 + length;
		if (end > bytes.length) die(`artifact PNG framing invalid: ${label}`);
		const crcOffset = offset + 8 + length;
		let crc = 0xffffffff;
		for (let i = offset + 4; i < crcOffset; i++) {
			crc ^= bytes[i];
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		if ((crc ^ 0xffffffff) >>> 0 !== bytes.readUInt32BE(crcOffset)) die(`artifact PNG CRC invalid: ${label}`);
		if (type === "IHDR") {
			if (
				hasIHDR ||
				length !== 13 ||
				offset !== 8 ||
				!bytes.readUInt32BE(offset + 8) ||
				!bytes.readUInt32BE(offset + 12)
			)
				die(`artifact PNG IHDR invalid: ${label}`);
			hasIHDR = true;
		} else if (type === "IDAT") hasIDAT = true;
		else if (type === "IEND") {
			if (length !== 0 || !hasIHDR || !hasIDAT || end !== bytes.length) die(`artifact PNG IEND invalid: ${label}`);
			hasIEND = true;
		}
		offset = end;
	}
	if (!hasIHDR || !hasIDAT || !hasIEND) die(`artifact PNG chunks incomplete: ${label}`);
};
const validateArtifacts = (capture: Json, rootDir: string): Artifact[] => {
	const raw = Array.isArray(capture.artifacts) ? capture.artifacts : [];
	const result: Artifact[] = [];
	const seen = new Set<string>();
	for (const value of raw) {
		const item = asJson(value);
		if (
			!item ||
			typeof item.path !== "string" ||
			typeof item.sha256 !== "string" ||
			!/^[a-f0-9]{64}$/.test(item.sha256) ||
			seen.has(item.path)
		)
			die("artifact declaration is invalid");
		seen.add(item.path);
		const path = safePath(rootDir, item.path),
			bytes = readFileSync(path);
		if (sha256(bytes) !== item.sha256) die(`artifact digest mismatch: ${item.path}`);
		if (item.format !== "rgba8") {
			if (!item.role || !item.provenance || !item.classification || !item.observedResult)
				die(`PNG artifact metadata is invalid: ${item.path}`);
			validatePng(bytes, item.path);
		}
		result.push({
			path: item.path,
			sha256: item.sha256,
			...(typeof item.format === "string" ? { format: item.format } : {}),
			...(typeof item.role === "string" ? { role: item.role } : {}),
			...(typeof item.provenance === "string" ? { provenance: item.provenance } : {}),
			...(item.classification === "current" || item.classification === "regression"
				? { classification: item.classification }
				: {}),
			...(typeof item.observedResult === "string" ? { observedResult: item.observedResult } : {}),
		});
	}
	return result;
};
const rootInput = resolve(inputNameValue);
const inputFile = existsSync(rootInput) && !rootInput.endsWith(".json") ? join(rootInput, "manifest.json") : rootInput;
if (!inputName && !existsSync(inputFile)) {
	recoverPublication(resolve(output));
	validatePublished(resolve(output));
	process.exit(0);
}
if (!existsSync(inputFile)) die(`required capture input unavailable: ${inputFile}`);
const captureRoot = inputFile.endsWith(".json") ? dirname(inputFile) : inputFile;
const canonicalCaptureRoot = canonicalPath(captureRoot);
const canonicalOutput = canonicalPath(output);
const relativeOutput = relative(canonicalCaptureRoot, canonicalOutput);
const relativeCapture = relative(canonicalOutput, canonicalCaptureRoot);
if (
	inputName &&
	(!relativeOutput ||
		(!relativeOutput.startsWith("..") && !isAbsolute(relativeOutput)) ||
		!relativeCapture.startsWith(".."))
)
	die("input and output paths overlap");
const root = parseRoot(inputFile);
if (
	root.schemaVersion !== 2 ||
	!validSha(root.expectedSha) ||
	root.expectedSha !== expectedSha ||
	!validSha(root.gitRevision) ||
	root.gitRevision !== expectedSha
)
	die("input expected SHA declaration is invalid");
const classification = declaredSource(root, "input");
if (
	root.producer !== REQUIRED_PRODUCER ||
	typeof root.provenance !== "string" ||
	!root.provenance.trim() ||
	typeof root.capturedAt !== "string" ||
	!root.capturedAt.trim()
)
	die("input producer/provenance declaration is invalid");
const captures = Array.isArray(root.captures) ? root.captures : [];
if (captures.length !== 4) die("input must declare four captures");
const evidence: Array<{ version: string; mode: string; capture: Json; bundles: Bundle[]; artifacts: Artifact[] }> = [];
for (const version of requestedVersions)
	for (const mode of requestedModes) {
		const capture = captures.map(asJson).find(item => {
			if (!item || item.version !== version) return false;
			return declaredMode(item, `${version}/${mode}/capture`) === mode;
		});
		if (!capture) die(`missing capture for ${version}/${mode}`);
		requireRevision(capture, `${version}/${mode}`);
		if (declaredSource(capture, `${version}/${mode}`) !== classification)
			die(`${version}/${mode}: source differs from root`);
		const rawBundles = Array.isArray(capture.bundles) ? capture.bundles : [];
		const bundles = rawBundles.map(value => normalizeBundle(captureRoot, value, version, mode, classification));
		if (!bundles.length) die(`${version}/${mode}: bundles are missing`);
		const bundleKeys = new Set<string>();
		const bundlePaths = new Set<string>();
		for (const bundle of bundles) {
			const key = `${bundle.caseId}/${bundle.viewport}/${bundle.scroll}`;
			if (bundleKeys.has(key)) die(`${version}/${mode}: duplicate bundle declaration`);
			bundleKeys.add(key);
			for (const member of bundle.members) {
				if (bundlePaths.has(member.path)) die(`${version}/${mode}: overlapping bundle member`);
				bundlePaths.add(member.path);
			}
			if (
				(EXPECTED_CJK[bundle.caseId] &&
					bundle.caseId !== "cjk-mixed-preview-scroll" &&
					(bundle.scroll !== "top" || !["80x24", "40x12"].includes(bundle.viewport))) ||
				(bundle.caseId === "cjk-mixed-preview-scroll" &&
					(bundle.scroll !== "top" ? bundle.viewport !== "80x24" : !["80x24", "40x12"].includes(bundle.viewport)))
			)
				die(`${version}/${mode}: CJK viewport/scroll matrix is invalid`);
		}
		const requiredPetIds = [...PET_IDS, ...(mode === "tmux" ? ["topology-ineligible"] : [])];
		for (const id of requiredPetIds)
			if (!bundles.some(bundle => bundle.caseId === id && bundle.viewport === "80x24" && bundle.scroll === "top"))
				die(`${version}/${mode}: pet matrix is incomplete`);
		const artifacts = validateArtifacts(capture, captureRoot);
		const artifactHashes = new Set(artifacts.map(artifact => artifact.sha256));
		for (const bundle of bundles) {
			if (!hasStringArray(bundle.metadata, "linkedRasterIdentifiers"))
				die(`${version}/${mode}/${bundle.caseId}: raster linkage is invalid`);
			for (const hash of bundle.metadata.linkedRasterIdentifiers)
				if (!artifactHashes.has(hash)) die(`${version}/${mode}/${bundle.caseId}: raster linkage is unbound`);
		}
		const cjkSeen = new Set(
			bundles
				.filter(bundle => EXPECTED_CJK[bundle.caseId])
				.map(bundle => `${bundle.caseId}/${bundle.viewport}/${bundle.scroll}`),
		);
		validateMatrix(cjkSeen, version, mode);
		const stateRoot = asJson(capture.states);
		if (!stateRoot) die(`${version}/${mode}: pet states are missing`);
		for (const skin of ["red", "blue"])
			for (const state of ["idle", "working", "burst", "preview"]) {
				const scenario = asStateScenario(asJson(asJson(stateRoot[skin])?.[state]));
				if (!scenario) die(`${version}/${mode}/${skin}-${state}: state evidence is missing`);
				try {
					compareRaster(scenario, artifacts, captureRoot);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					die(`${version}/${mode}/${skin}-${state}: ${message}`);
				}
			}
		evidence.push({ version, mode, capture, bundles, artifacts });
	}
const outputPath = resolve(output);
recoverPublication(outputPath);
const stage = mkdtempSync(`${outputPath}.staging-`);
try {
	for (const item of evidence) {
		const out = join(stage, item.version, item.mode);
		mkdirSync(join(out, "captures"), { recursive: true });
		mkdirSync(join(out, "rasters"), { recursive: true });
		const files: Json[] = [],
			manifestBundles: Json[] = [];
		const addFile = (source: string, target: string, kind: string, caseId?: string): void => {
			const bytes = readFileSync(source);
			writeFileSync(join(out, target), bytes);
			files.push({ path: target, sha256: sha256(bytes), size: bytes.length, kind, ...(caseId ? { caseId } : {}) });
		};
		const copied = new Map<string, string>();
		for (const ref of item.artifacts) {
			const target = `rasters/${ref.sha256}.${ref.format === "rgba8" ? "rgba" : "png"}`;
			if (!copied.has(target)) {
				copyFileSync(safePath(captureRoot, ref.path), join(out, target));
				files.push({
					path: target,
					sha256: ref.sha256,
					size: readFileSync(join(out, target)).length,
					kind: ref.format === "rgba8" ? "rgba8" : "png",
				});
				copied.set(target, target);
			}
		}
		for (const bundle of item.bundles) {
			const base = `captures/${bundle.caseId}/${bundle.viewport}/${bundle.scroll}`;
			mkdirSync(join(out, base), { recursive: true });
			const paths: Record<string, string> = {};
			for (const member of bundle.members) {
				const name = basename(member.path);
				const target = `${base}/${name}`;
				addFile(
					safePath(captureRoot, member.path),
					target,
					name === "metadata.json"
						? "metadata"
						: name === "terminal-ansi.txt"
							? "ansi"
							: name === "terminal.html"
								? "html"
								: "text",
					bundle.caseId,
				);
				paths[name] = target;
			}
			manifestBundles.push({
				caseId: bundle.caseId,
				viewport: bundle.viewport,
				scroll: bundle.scroll,
				expectedSha,
				gitRevision: expectedSha,
				classification,
				source: { kind: classification },
				metadataPath: paths["metadata.json"],
				terminal_txtPath: paths["terminal.txt"],
				terminal_ansi_txtPath: paths["terminal-ansi.txt"],
				terminal_htmlPath: paths["terminal.html"],
			});
		}
		const capture = item.capture;
		const records = [
			...new Set([
				...PET_IDS,
				...(item.mode === "tmux" ? ["topology-ineligible"] : []),
				...item.bundles.map(bundle => bundle.caseId),
			]),
		].map(caseId => ({
			caseId,
			expectedSha,
			gitRevision: expectedSha,
			classification,
			source: { kind: classification },
			status: "declared",
			provenance: root.provenance,
			capturedAt: root.capturedAt,
		}));
		const states = asJson(capture.states);
		const cases = records.map((record, index) => {
			const stateName = record.caseId.startsWith("red-")
				? record.caseId.slice("red-".length)
				: record.caseId.startsWith("blue-")
					? record.caseId.slice("blue-".length)
					: "";
			const skin = record.caseId.startsWith("red-") ? "red" : record.caseId.startsWith("blue-") ? "blue" : "";
			const scenario = skin && states ? asJson(asJson(states[skin])?.[stateName]) : undefined;
			const actual = asJson(scenario?.actual)?.artifactSha256;
			const expected = asJson(scenario?.expected)?.artifactSha256;
			return {
				...record,
				...(typeof actual === "string"
					? { actualCapture: `rasters/${actual}.rgba`, expectedLogicalRaster: `rasters/${expected}.rgba` }
					: {}),
				evidence: `evidence.json#/records/${index}`,
			};
		});
		const evidenceJson = {
			schemaVersion: 2,
			expectedSha,
			gitRevision: expectedSha,
			classification,
			source: { kind: classification },
			records,
		};
		writeFileSync(join(out, "evidence.json"), `${JSON.stringify(evidenceJson, null, 2)}\n`);
		const manifest = {
			schemaVersion: 2,
			expectedSha,
			gitRevision: expectedSha,
			version: item.version,
			iTermVersion: item.version,
			mode: item.mode,
			classification,
			source: { kind: classification },
			producer: REQUIRED_PRODUCER,
			provenance: root.provenance,
			capturedAt: root.capturedAt,
			cases,
			bundles: manifestBundles,
			files,
		};
		writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	}
	validatePublished(stage);
} catch (error) {
	rmSync(stage, { recursive: true, force: true });
	throw error;
}
const backup = `${outputPath}.backup-${process.pid}-${Date.now()}`;
const journalPath = journalPathFor(outputPath);
writeJournal(journalPath, { output: outputPath, backup });
let moved = false;
try {
	if (existsSync(outputPath)) {
		renameSync(outputPath, backup);
		moved = true;
	}
	renameSync(stage, outputPath);
	if (moved) rmSync(backup, { recursive: true, force: true });
	rmSync(journalPath, { force: true });
} catch (error) {
	if (existsSync(outputPath)) rmSync(outputPath, { recursive: true, force: true });
	if (moved && existsSync(backup)) renameSync(backup, outputPath);
	if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
	die(`unable to publish evidence: ${error instanceof Error ? error.message : String(error)}`);
}
