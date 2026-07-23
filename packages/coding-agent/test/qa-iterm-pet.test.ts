import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const runner = join(import.meta.dir, "../scripts/qa-iterm-pet.ts");
const expectedSha = "a".repeat(40);
const versions = ["3.5.0", "3.6.11"];
const modes = ["direct", "tmux"];
const petIds = [
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
const cjk: Record<string, string[]> = {
	"cjk-ko-composer-idle": ["저장하지 않은 변경 사항이 있습니다.", "Enter로 저장하거나", "Esc로 취소하세요."],
	"cjk-ja-stream-working": ["未保存の変更があります。", "Enter で保存し、", "Esc でキャンセルします。"],
	"cjk-zh-error-recovery": ["存在未保存的更改。", "按 Enter 保存，", "按 Esc 取消。"],
	"cjk-mixed-preview-scroll": [
		"작업 상태: 검토 대기 중입니다.",
		"iTerm2 환경에서",
		"출력 상태를 확인하세요.",
		"Enter로 계속하고 Esc로 취소하세요.",
	],
};
const deterministicCjkBody = (segments: string[], range: number[]): string =>
	Array.from({ length: range[1] - range[0] + 1 }, (_, index) => {
		const line = range[0] + index;
		return `${String(line).padStart(3, "0")}: ${segments[index % segments.length]}`;
	}).join("\n");
type Json = Record<string, unknown>;
const asObject = (value: unknown): Json => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw Error("fixture object is missing");
	return value as Json;
};
const firstObject = (value: unknown): Json => {
	if (!Array.isArray(value) || value.length === 0) throw Error("fixture array is missing");
	return asObject(value[0]);
};
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
function fixture() {
	const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "pet-v2-"));
	const refs: Json[] = [];
	const put = (path: string, bytes: Buffer, format = "rgba8") => {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), bytes);
		const sha256 = hash(bytes);
		refs.push({ path, sha256, format });
		return sha256;
	};
	const rasterByCapture = new Map<string, string[]>();
	const captures: Json[] = [];
	for (const version of versions)
		for (const mode of modes) {
			const key = `${version}/${mode}`;
			const expected = put(`rasters/${version}-${mode}-expected.rgba`, Buffer.alloc(20 * 20 * 4));
			const after = put(`rasters/${version}-${mode}-after.rgba`, Buffer.alloc(20 * 20 * 4));
			const actual: string[] = [];
			for (let n = 0; n < 8; n++) {
				const bytes = Buffer.alloc(20 * 20 * 4);
				bytes[2 * 20 * 4 + 2 * 4] = 220;
				bytes[2 * 20 * 4 + 2 * 4 + 1] = n + 1;
				bytes[2 * 20 * 4 + 2 * 4 + 3] = 255;
				bytes[2 * 20 * 4 + 3 * 4] = 40;
				bytes[2 * 20 * 4 + 3 * 4 + 1] = 220;
				bytes[2 * 20 * 4 + 3 * 4 + 3] = 255;
				actual.push(put(`rasters/${version}-${mode}-actual-${n}.rgba`, bytes));
			}
			rasterByCapture.set(key, [expected, after, ...actual]);
			const bundles: Json[] = [];
			const bundle = (caseId: string, viewport: string, scroll: string, text: string, range?: number[]) => {
				const base = `captures/${version}/${mode}/${caseId}/${viewport}/${scroll}`;
				const metadata: Json = {
					schemaVersion: 2,
					caseId,
					iTermVersion: version,
					transport: mode,
					viewport,
					scroll,
					expectedSha,
					gitRevision: expectedSha,
					classification: "fixture",
					source: { kind: "fixture" },
					producer: "gjc-iterm-live-capture-v1",
					toolVersion: "qa-fixture",
					capturedAt: "2026-01-01T00:00:00Z",
					commandOrReplay: "declared-fixture",
					fontFamily: "Menlo",
					fontSize: 12,
					zoom: 1,
					cellWidthPx: 8,
					cellHeightPx: 16,
					wrappingPolicy: "semantic-segment-boundaries",
					truncationPolicy: "none",
					linkedRasterIdentifiers: rasterByCapture.get(key),
					...(cjk[caseId] ? { semanticSegments: cjk[caseId] } : {}),
					...(caseId === "cjk-mixed-preview-scroll" ? { lineCount: 120, scrollRange: range } : {}),
					...(viewport === "40x12" ? { resizeFrom: "80x24" } : {}),
				};
				const memberBytes: Array<[string, Buffer]> = [
					["terminal.txt", Buffer.from(text)],
					["terminal-ansi.txt", Buffer.from(text)],
					["terminal.html", Buffer.from(`<pre>${text}</pre>`, "utf8")],
					["metadata.json", Buffer.from(`${JSON.stringify(metadata)}\n`)],
				];
				const members = memberBytes.map(([name, bytes]) => ({
					path: `${base}/${name}`,
					sha256: put(`${base}/${name}`, bytes, name === "metadata.json" ? "metadata" : name),
					size: bytes.length,
					kind: name,
				}));
				bundles.push({
					caseId,
					viewport,
					scroll,
					expectedSha,
					gitRevision: expectedSha,
					classification: "fixture",
					source: { kind: "fixture" },
					members,
				});
			};
			for (const id of [...petIds, ...(mode === "tmux" ? ["topology-ineligible"] : [])])
				bundle(id, "80x24", "top", `${id}: pet evidence`);
			for (const id of Object.keys(cjk)) {
				for (const viewport of ["80x24", "40x12"])
					bundle(
						id,
						viewport,
						"top",
						id === "cjk-mixed-preview-scroll" ? deterministicCjkBody(cjk[id], [1, 21]) : cjk[id].join(""),
						id === "cjk-mixed-preview-scroll" ? [1, 21] : undefined,
					);
				if (id === "cjk-mixed-preview-scroll") {
					bundle(id, "80x24", "middle", deterministicCjkBody(cjk[id], [50, 70]), [50, 70]);
					bundle(id, "80x24", "bottom", deterministicCjkBody(cjk[id], [100, 120]), [100, 120]);
				}
			}
			const states = Object.fromEntries(
				["red", "blue"].map((skin, skinIndex) => [
					skin,
					Object.fromEntries(
						["idle", "working", "burst", "preview"].map((state, stateIndex) => {
							const hashValue = actual[skinIndex * 4 + stateIndex];
							const raster = { artifactSha256: hashValue, width: 20, height: 20 };
							return [
								state,
								{
									expected: { artifactSha256: expected, width: 20, height: 20 },
									actual: raster,
									owned: { x: 2, y: 2, width: 2, height: 1 },
									erase: { before: raster, after: { artifactSha256: after, width: 20, height: 20 } },
									telemetryMs: 10,
								},
							];
						}),
					),
				]),
			);
			captures.push({
				version,
				mode,
				expectedSha,
				gitRevision: expectedSha,
				classification: "fixture",
				source: { kind: "fixture" },
				artifacts: refs.filter(ref => String(ref.path).startsWith(`rasters/${version}-${mode}-`)),
				states,
				bundles,
			});
		}
	return {
		dir,
		root: {
			schemaVersion: 2,
			expectedSha,
			gitRevision: expectedSha,
			classification: "fixture",
			source: { kind: "fixture" },
			producer: "gjc-iterm-live-capture-v1",
			provenance: "declared-fixture",
			capturedAt: "2026-01-01T00:00:00Z",
			captures,
		},
	};
}
function run(mutate?: (root: Json, dir: string) => void, sha = expectedSha) {
	const fixtureValue = fixture();
	mutate?.(fixtureValue.root, fixtureValue.dir);
	const input = join(fixtureValue.dir, "capture.json");
	writeFileSync(input, JSON.stringify(fixtureValue.root));
	const output = `${fixtureValue.dir}-published`;
	const result = Bun.spawnSync([
		"bun",
		runner,
		"--versions",
		versions.join(","),
		"--modes",
		modes.join(","),
		"--expected-sha",
		sha,
		"--input",
		input,
		"--output",
		output,
	]);
	rmSync(fixtureValue.dir, { recursive: true, force: true });
	return result;
}
describe("iTerm Pet QA schema v2", () => {
	it("publishes the complete declared fixture matrix", () => expect(run().exitCode).toBe(0));
	it("requires an explicit lowercase expected SHA", () => {
		const result = fixture();
		try {
			const input = join(result.dir, "capture.json");
			writeFileSync(input, JSON.stringify(result.root));
			expect(
				Bun.spawnSync([
					"bun",
					runner,
					"--versions",
					versions.join(","),
					"--modes",
					modes.join(","),
					"--input",
					input,
					"--output",
					join(result.dir, "out"),
				]).exitCode,
			).not.toBe(0);
		} finally {
			rmSync(result.dir, { recursive: true, force: true });
		}
	});
	it("rejects an altered required member", () =>
		expect(
			run((_root, dir) =>
				writeFileSync(
					join(dir, "captures", "3.5.0", "direct", "red-idle", "80x24", "top", "terminal.txt"),
					"altered",
				),
			).exitCode,
		).not.toBe(0));
	it("rejects a root/capture SHA mismatch", () =>
		expect(run(root => (firstObject(root.captures).expectedSha = "b".repeat(40))).exitCode).not.toBe(0));
	it("rejects a classification/source mismatch", () =>
		expect(run(root => (firstObject(root.captures).source = { kind: "live-pty" })).exitCode).not.toBe(0));
	it("rejects a CJK scroll range failure", () =>
		expect(
			run((root, dir) => {
				const capture = firstObject(root.captures);
				const bundle = asObject(
					(Array.isArray(capture.bundles) ? capture.bundles : [])
						.map(asObject)
						.find(
							value =>
								typeof value.caseId === "string" &&
								value.caseId === "cjk-mixed-preview-scroll" &&
								value.scroll === "bottom",
						),
				);
				const metadataMember = asObject(
					(Array.isArray(bundle.members) ? bundle.members : [])
						.map(asObject)
						.find(value => typeof value.path === "string" && value.path.endsWith("metadata.json")),
				);
				if (typeof metadataMember.path !== "string") throw Error("fixture metadata path is invalid");
				const metadataPath = join(dir, metadataMember.path);
				const metadata = asObject(JSON.parse(readFileSync(metadataPath, "utf8")));
				metadata.scrollRange = [99, 120];
				const bytes = Buffer.from(`${JSON.stringify(metadata)}\n`);
				writeFileSync(metadataPath, bytes);
				metadataMember.sha256 = hash(bytes);
				metadataMember.size = bytes.length;
			}).exitCode,
		).not.toBe(0));
	it("rejects a recomputed digest for a short CJK scroll body", () =>
		expect(
			run((_root, dir) => {
				const capture = firstObject((_root as Json).captures);
				const bundle = asObject(
					(Array.isArray(capture.bundles) ? capture.bundles : [])
						.map(asObject)
						.find(value => value.caseId === "cjk-mixed-preview-scroll" && value.scroll === "bottom"),
				);
				for (const name of ["terminal.txt", "terminal-ansi.txt"]) {
					const member = asObject(
						(Array.isArray(bundle.members) ? bundle.members : [])
							.map(asObject)
							.find(value => typeof value.path === "string" && value.path.endsWith(name)),
					);
					if (typeof member.path !== "string") throw Error("fixture terminal path is invalid");
					const path = join(dir, member.path);
					const short = readFileSync(path, "utf8").split("\n").slice(0, -1).join("\n");
					const bytes = Buffer.from(short);
					writeFileSync(path, bytes);
					member.sha256 = hash(bytes);
					member.size = bytes.length;
				}
			}).exitCode,
		).not.toBe(0));
	it("rejects disagreeing mode and transport metadata", () =>
		expect(
			run((_root, dir) => {
				const capture = firstObject((_root as Json).captures);
				const bundle = asObject(
					(Array.isArray(capture.bundles) ? capture.bundles : [])
						.map(asObject)
						.find(value => value.caseId === "red-idle"),
				);
				const member = asObject(
					(Array.isArray(bundle.members) ? bundle.members : [])
						.map(asObject)
						.find(value => typeof value.path === "string" && value.path.endsWith("metadata.json")),
				);
				if (typeof member.path !== "string") throw Error("fixture metadata path is invalid");
				const path = join(dir, member.path);
				const metadata = asObject(JSON.parse(readFileSync(path, "utf8")));
				metadata.mode = "tmux";
				const bytes = Buffer.from(`${JSON.stringify(metadata)}\n`);
				writeFileSync(path, bytes);
				member.sha256 = hash(bytes);
				member.size = bytes.length;
			}).exitCode,
		).not.toBe(0));
});
