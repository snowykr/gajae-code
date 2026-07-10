import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type RestartManifest,
	type RestartRelease,
	validateStrictHeldResumeEnvironment,
} from "../src/gjc-runtime/tmux-restart-protocol";
import type { SessionManager, SessionMessageEntry } from "../src/session/session-manager";
import {
	openStrictSessionForMain as bootstrapStrictSession,
	CURRENT_SESSION_VERSION,
} from "../src/session/session-manager";
import { closeStrictHeldSessionCapability, FileSessionStorage } from "../src/session/session-storage";

const protocolNonce = "b".repeat(64);
const sessionId = "0192a2f4-9e2d-7c11-8e4a-123456789abc";

async function authorizeStrictSession(filePath: string, storage: FileSessionStorage, id = sessionId) {
	const manifestPath = `${filePath}.manifest.json`;
	const manifest: RestartManifest = {
		schemaVersion: 1,
		kind: "manifest",
		state: "held",
		nonce: protocolNonce,
		sessionPath: path.resolve(filePath),
		manifestPath: path.resolve(manifestPath),
		pid: "42",
		processIdentity: {
			platform: process.platform as "linux" | "darwin" | "win32",
			value: process.platform === "darwin" ? "darwin:1:2" : "linux:1",
		},
		createdAtMs: Date.now(),
		expiresAtMs: Date.now() + 10_000,
		sessionId: id,
		serverAuthority: "test-server",
	};
	const release: RestartRelease = { ...manifest, kind: "release", state: "release" };
	return validateStrictHeldResumeEnvironment(filePath, {
		env: {
			GJC_TMUX_RESTART_HELD: "1",
			GJC_TMUX_RESTART_MANIFEST: manifest.manifestPath,
			GJC_TMUX_RESTART_NONCE: protocolNonce,
		},
		readRecord: async (_filePath, kind) => (kind === "manifest" ? manifest : release),
		publishRecord: async () => undefined,
		pinSession: sessionPath => storage.pinStrictSession(sessionPath),
		waitForRelease: async () => release,
	});
}

async function openStrictSessionForMain(filePath: string, storage = new FileSessionStorage(), id = sessionId) {
	const open = await authorizeStrictSession(filePath, storage, id);
	const manager = await bootstrapStrictSession(filePath, storage, open.authorization);
	strictSessions.push(manager);
	return manager;
}
const strictSessions: SessionManager[] = [];
const tempDirs: string[] = [];

async function makeSession(id = sessionId): Promise<{ dir: string; file: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-strict-resume-"));
	tempDirs.push(dir);
	const file = path.join(dir, "session.jsonl");
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: new Date().toISOString(),
		cwd: dir,
	};
	await Bun.write(file, `${JSON.stringify(header)}\n`);
	return { dir, file };
}

afterEach(async () => {
	for (const session of strictSessions.splice(0)) {
		await session.close();
	}
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("strict session resume", () => {
	it("rejects a missing path without creating it", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-strict-missing-"));
		tempDirs.push(dir);
		const file = path.join(dir, "missing.jsonl");
		await expect(openStrictSessionForMain(file, new FileSessionStorage())).rejects.toThrow();
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("rejects symlinks and malformed headers", async () => {
		const { dir, file } = await makeSession();
		const link = path.join(dir, "link.jsonl");
		await fs.symlink(file, link);
		await expect(openStrictSessionForMain(link)).rejects.toThrow();
		await Bun.write(file, '{"type":"session","version":3,"id":"bad","cwd":"relative"}\n');
		await expect(openStrictSessionForMain(file)).rejects.toThrow();
	});
	it("rejects unsafe canonical session ids before resident cache setup", async () => {
		for (const id of ["../escape", "a/b", `nul\u0000id`, "a".repeat(100)]) {
			const { file } = await makeSession(id);
			await expect(openStrictSessionForMain(file, new FileSessionStorage(), id)).rejects.toThrow();
			await expect(openStrictSessionForMain(file)).rejects.toThrow();
		}
	});

	it("appends through the retained descriptor after pathname replacement", async () => {
		const { dir, file } = await makeSession();
		const manager = await openStrictSessionForMain(file);
		const original = path.join(dir, "original.jsonl");
		await fs.rename(file, original);
		await Bun.write(file, "replacement\n");
		manager.appendCustomEntry("strict-test");
		const originalContent = await Bun.file(original).text();
		expect(originalContent).toContain('"customType":"strict-test"');
		expect(await Bun.file(file).text()).toBe("replacement\n");
	});
	it("fails closed after pathname replacement without touching the replacement", async () => {
		const { dir, file } = await makeSession();
		const storage = new FileSessionStorage();
		const openWriter = spyOn(storage, "openWriter");
		const manager = await openStrictSessionForMain(file, storage);
		openWriter.mockClear();
		await fs.rename(file, path.join(dir, "original.jsonl"));
		await Bun.write(file, "replacement\n");

		await manager.close();
		expect(() => manager.appendCustomEntry("after-close")).toThrow(/closed/);
		expect(openWriter).not.toHaveBeenCalled();
		expect(await Bun.file(file).text()).toBe("replacement\n");
	});
	it("closes strictly once under concurrent close calls", async () => {
		const { file } = await makeSession();
		const manager = await openStrictSessionForMain(file);
		await Promise.all([manager.close(), manager.close(), manager.close()]);
		expect(() => manager.appendCustomEntry("after-concurrent-close")).toThrow(/closed/);
	});

	it("admits Darwin strict resume only for APFS", async () => {
		const { file } = await makeSession();
		let calls = 0;
		const storage = new FileSessionStorage({
			platform: "darwin",
			classifyStrictFs: () => {
				calls++;
				return { state: "classified", platform: "darwin", f_fstypename: "apfs" };
			},
		});
		await expect(openStrictSessionForMain(file, storage)).resolves.toBeDefined();
		expect(calls).toBe(1);
	});

	it("rejects Darwin strict resume for HFS and unavailable filesystems", async () => {
		for (const result of [{ state: "available", f_fstypename: "hfs" }, { state: "unavailable" }]) {
			const { file } = await makeSession();
			const storage = new FileSessionStorage({ platform: "darwin", classifyStrictFs: () => result });
			await expect(openStrictSessionForMain(file, storage)).rejects.toThrow(/APFS/);
		}
	});
	it("rejects unsupported platforms before strict resume admission", async () => {
		const { file } = await makeSession();
		let calls = 0;
		const storage = new FileSessionStorage({
			platform: "win32",
			classifyStrictFs: () => {
				calls++;
				throw new Error("classifier must not run on unsupported platforms");
			},
		});
		await expect(openStrictSessionForMain(file, storage)).rejects.toThrow(/Linux or Darwin/);
		expect(calls).toBe(0);
	});

	it("rejects incoherent Darwin filesystem classification", async () => {
		const { file } = await makeSession();
		const storage = new FileSessionStorage({
			platform: "darwin",
			classifyStrictFs: () => ({ state: "classified", platform: "linux", f_fstypename: "apfs" }),
		});
		await expect(openStrictSessionForMain(file, storage)).rejects.toThrow(/APFS/);
	});

	it("does not classify non-Darwin strict resumes", async () => {
		const { file } = await makeSession();
		const storage = new FileSessionStorage({
			platform: "linux",
			classifyStrictFs: () => {
				throw new Error("classifier must not run on Linux");
			},
		});
		await expect(openStrictSessionForMain(file, storage)).resolves.toBeDefined();
	});
	it("rejects lifecycle mutation boundaries", async () => {
		const { file } = await makeSession();
		const manager = await openStrictSessionForMain(file);
		await expect(manager.setSessionFile(file)).rejects.toThrow();
		await expect(manager.newSession()).rejects.toThrow();
		await expect(manager.fork()).rejects.toThrow();
		await expect(manager.moveTo(path.dirname(file))).rejects.toThrow();
		await expect(manager.dropSession(file)).rejects.toThrow();
	});

	it("rejects branching before touching a replacement pathname", async () => {
		const { file } = await makeSession();
		const manager = await openStrictSessionForMain(file);
		await fs.rename(file, `${file}.original`);
		await Bun.write(file, "replacement\n");
		expect(() => manager.createBranchedSession("missing")).toThrow();
		expect(await Bun.file(file).text()).toBe("replacement\n");
	});

	it("rejects synchronous rewrite after pathname replacement", async () => {
		const { file } = await makeSession();
		const manager = await openStrictSessionForMain(file);
		const beforeHeader = structuredClone(manager.getHeader());
		const beforeEntries = manager.getEntries();
		const beforeFile = await Bun.file(file).text();
		await expect(manager.setSessionName("strict-rewrite")).rejects.toThrow(/rewrite/);
		expect(manager.getSessionName()).toBeUndefined();
		expect(manager.getHeader()).toEqual(beforeHeader);
		expect(manager.getEntries()).toEqual(beforeEntries);
		expect(await Bun.file(file).text()).toBe(beforeFile);
	});
	it("rejects historical mutations without side effects and keeps the descriptor appendable", async () => {
		const { file } = await makeSession();
		const manager = await openStrictSessionForMain(file);
		const oldMessageId = manager.appendMessage({
			role: "user",
			content: `historical ${"x".repeat(5_000)}`,
			timestamp: Date.now(),
		});
		const firstKeptEntryId = manager.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
		const compactionEntryId = manager.appendCompaction("summary", "short", firstKeptEntryId, 123);
		const beforeEntries = manager.getEntries();
		const message = beforeEntries.find(
			(entry): entry is SessionMessageEntry => entry.type === "message" && entry.id === oldMessageId,
		)!;
		const beforeStats = manager.getObservabilityStatsForTests();

		await expect(
			Promise.resolve().then(() =>
				manager.applyEntryMessageUpdates([
					{
						...message,
						message: { role: "user", content: "changed", timestamp: Date.now() },
					},
				]),
			),
		).rejects.toThrow(/rewrite/);
		expect(manager.getEntries()).toEqual(beforeEntries);

		expect(() => manager.evictCompactedContent(firstKeptEntryId, compactionEntryId)).toThrow(/rewrite/);
		expect(manager.getEntries()).toEqual(beforeEntries);
		expect(manager.getObservabilityStatsForTests().coldSpillWriteCount).toBe(beforeStats.coldSpillWriteCount);

		manager.appendCustomEntry("after-rejected-history");
		expect(await Bun.file(file).text()).toContain('"customType":"after-rejected-history"');
	});
	it("rejects branching and leaf reset after strict close without changing state", async () => {
		const { file } = await makeSession();
		const manager = await openStrictSessionForMain(file);
		manager.appendCustomEntry("before-close");
		const beforeEntries = manager.getEntries();
		const beforeRevisions = manager.revisionSnapshot();
		await manager.close();
		expect(() => manager.branch(beforeEntries[0]?.id ?? "")).toThrow(/closed/);
		expect(() => manager.resetLeaf()).toThrow(/closed/);
		expect(() => manager.branchWithSummary(null, "rejected")).toThrow(/closed/);
		expect(manager.getEntries()).toEqual(beforeEntries);
		expect(manager.revisionSnapshot()).toEqual(beforeRevisions);
	});
	it("rejects a forged non-snapshot before rebinding strict identity", async () => {
		const first = await makeSession();
		const second = await makeSession();
		const firstManager = await openStrictSessionForMain(first.file);
		const secondManager = await openStrictSessionForMain(second.file);
		const replacement = "replacement\n";
		await fs.rename(second.file, `${second.file}.original`);
		await Bun.write(second.file, replacement);

		expect(() => secondManager.restoreState({} as never)).toThrow(/Strict resume cannot restore state/);
		expect(secondManager.getSessionFile()).toBe(path.resolve(second.file));
		expect(secondManager.getSessionId()).toBeTruthy();
		expect(await Bun.file(second.file).text()).toBe(replacement);
		expect(firstManager.getSessionFile()).toBe(path.resolve(first.file));
	});

	it("rejects a non-snapshot before inspecting forged properties", async () => {
		const { file } = await makeSession();
		const manager = await openStrictSessionForMain(file);
		const originalSessionId = manager.getSessionId();
		const beforeEntries = manager.getEntries();
		const forgedSnapshot = Object.defineProperty({}, "materializedFileEntries", {
			get: () => {
				throw new Error("snapshot inspected");
			},
		});

		expect(() => manager.restoreState(forgedSnapshot as never)).toThrow(/Strict resume cannot restore state/);
		expect(manager.getSessionFile()).toBe(path.resolve(file));
		expect(manager.getSessionId()).toBe(originalSessionId);
		expect(manager.getEntries()).toEqual(beforeEntries);
	});

	it("rejects captureState for an open strict manager without exposing aliases", async () => {
		const { file } = await makeSession();
		const manager = await openStrictSessionForMain(file);
		const originalSessionId = manager.getSessionId();
		const beforeEntries = manager.getEntries();
		const beforeRevisions = manager.revisionSnapshot();

		expect(() => manager.captureState()).toThrow(/Strict resume cannot capture state/);
		expect(manager.getSessionFile()).toBe(path.resolve(file));
		expect(manager.getSessionId()).toBe(originalSessionId);
		expect(manager.getEntries()).toEqual(beforeEntries);
		expect(manager.revisionSnapshot()).toEqual(beforeRevisions);
	});

	it("rejects raw descriptor possession at strict bootstrap and consumes authorization once", async () => {
		const { file } = await makeSession();
		const storage = new FileSessionStorage();
		const rawCapability = storage.pinStrictSession(file);
		await expect(bootstrapStrictSession(file, storage, rawCapability as never)).rejects.toThrow(
			/validated protocol authorization/,
		);
		await closeStrictHeldSessionCapability(rawCapability);

		const open = await authorizeStrictSession(file, storage);
		await expect(
			bootstrapStrictSession(file, storage, open.authorization).then(manager => {
				strictSessions.push(manager);
				return manager;
			}),
		).resolves.toBeDefined();
		await expect(bootstrapStrictSession(file, storage, open.authorization)).rejects.toThrow(
			/validated protocol authorization/,
		);
	});

	it("rejects captureState after strict close before exposing aliases", async () => {
		const { file } = await makeSession();
		const manager = await openStrictSessionForMain(file);
		await manager.close();

		expect(() => manager.captureState()).toThrow(/Strict resume cannot capture state/);
		expect(manager.getEntries()).toEqual([]);
	});

	it("rejects every representative mutable path after strict close without effects", async () => {
		const { file } = await makeSession();
		const manager = await openStrictSessionForMain(file);
		const targetId = manager.appendCustomEntry("before-close");
		await manager.close();
		const beforeEntries = manager.getEntries();
		const beforeFile = await Bun.file(file).text();

		const cases: Array<{ name: string; invoke: () => unknown }> = [
			{ name: "blob put", invoke: () => manager.putBlob(Buffer.from("after-close")) },
			{ name: "artifact allocation", invoke: () => manager.allocateArtifactPath("strict-test") },
			{ name: "artifact save", invoke: () => manager.saveArtifact("after-close", "strict-test") },
			{ name: "artifact lookup", invoke: () => manager.getArtifactPath("0") },
			{ name: "draft save", invoke: () => manager.saveDraft("after-close") },
			{ name: "draft consume", invoke: () => manager.consumeDraft() },
			{ name: "label", invoke: () => manager.appendLabelChange(targetId, "after-close") },
			{ name: "branch", invoke: () => manager.branch(targetId) },
			{ name: "leaf reset", invoke: () => manager.resetLeaf() },
			{ name: "rename", invoke: () => manager.setSessionName("after-close", "user") },
			{ name: "history rewrite", invoke: () => manager.rewriteEntries() },
			{ name: "ensure on disk", invoke: () => manager.ensureOnDisk() },
			{ name: "flush", invoke: () => manager.flush() },
		];

		for (const testCase of cases) {
			await expect(Promise.resolve().then(testCase.invoke), testCase.name).rejects.toThrow(/closed/);
		}
		expect(manager.getEntries()).toEqual(beforeEntries);
		expect(await Bun.file(file).text()).toBe(beforeFile);
	});
	it("does not expose strict bootstrap from the SDK root", async () => {
		const sdk = await import("../src/index");
		expect("openStrictSessionForMain" in sdk).toBe(false);
	});
});
