import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	consumeStrictHeldProtocolAuthorization,
	parseRestartRecord,
	publishRestartRecord,
	type RestartManifest,
	type RestartRelease,
	readRestartRecord,
	validateStrictHeldResumeEnvironment,
} from "../../src/gjc-runtime/tmux-restart-protocol";
import {
	consumeStrictHeldSessionCapability,
	FileSessionStorage,
	type StrictHeldSessionCapability,
	strictHeldSessionId,
} from "../../src/session/session-storage";

const nonce = "a".repeat(64);
const sessionId = "session-test";
const serverAuthority = "server-a";
function pinSession(record: RestartManifest): StrictHeldSessionCapability {
	fs.writeFileSync(record.sessionPath, `${JSON.stringify({ id: record.sessionId })}\n`);
	const capability = new FileSessionStorage().pinStrictSession(record.sessionPath);
	expect(strictHeldSessionId(capability)).toBe(record.sessionId);
	return capability;
}
function manifest(dir: string): RestartManifest {
	const sessionPath = path.join(dir, "session.jsonl");
	const manifestPath = path.join(dir, "manifest.json");
	return {
		schemaVersion: 1,
		kind: "manifest",
		state: "held",
		nonce,
		sessionPath,
		manifestPath,
		pid: "42",
		processIdentity: {
			platform: process.platform as "linux" | "darwin" | "win32",
			value: process.platform === "darwin" ? "darwin:1:2" : "linux:1",
		},
		createdAtMs: Date.now(),
		expiresAtMs: Date.now() + 10_000,
		sessionId,
		serverAuthority,
	};
}

describe("tmux restart held protocol", () => {
	test("rejects serverless and oversized authorities", () => {
		const value = manifest("/tmp");
		expect(() => parseRestartRecord(JSON.stringify({ ...value, serverAuthority: undefined }))).toThrow();
		expect(() => parseRestartRecord(JSON.stringify({ ...value, serverAuthority: "x".repeat(257) }))).toThrow();
	});
	test("rejects old start-ticks and cross-platform identities", () => {
		const value = manifest("/tmp");
		expect(() => parseRestartRecord(JSON.stringify({ ...value, oldPaneStartTicks: "1" }))).toThrow();
		expect(() =>
			parseRestartRecord(
				JSON.stringify({
					...value,
					processIdentity: { platform: process.platform === "linux" ? "darwin" : "linux", value: "x" },
				}),
			),
		).toThrow();
		expect(() =>
			parseRestartRecord(
				JSON.stringify({
					...value,
					processIdentity: {
						platform: process.platform,
						value: process.platform === "darwin" ? "darwin:01:2" : "linux:01",
					},
				}),
			),
		).toThrow();
	});

	test("publisher fails collision without replacing bytes", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "gjc-restart-"));
		try {
			const record = manifest(dir);
			await publishRestartRecord(record.manifestPath, record);
			const before = await readFile(record.manifestPath, "utf8");
			await expect(publishRestartRecord(record.manifestPath, record)).rejects.toThrow();
			expect((await readdir(dir)).filter(name => name.includes(".tmp-"))).toEqual([]);
			expect(await readFile(record.manifestPath, "utf8")).toBe(before);
			expect((await readRestartRecord(record.manifestPath, "manifest")).nonce).toBe(nonce);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	test("temporary publish does not replace a destination symlink", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "gjc-restart-"));
		try {
			const record = manifest(dir);
			const destination = record.manifestPath;
			const sentinel = path.join(dir, "sentinel");
			await writeFile(sentinel, "original");
			await symlink(sentinel, destination);
			await expect(publishRestartRecord(destination, record)).rejects.toThrow();
			expect(await readlink(destination)).toBe(sentinel);
			expect(await readFile(sentinel, "utf8")).toBe("original");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("held bootstrap publishes open and waits for injected release", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "gjc-restart-"));
		try {
			const record = manifest(dir);
			await writeFile(record.manifestPath, JSON.stringify(record));
			let waited = false;
			const open = await validateStrictHeldResumeEnvironment(record.sessionPath, {
				env: {
					GJC_TMUX_RESTART_HELD: "1",
					GJC_TMUX_RESTART_MANIFEST: record.manifestPath,
					GJC_TMUX_RESTART_NONCE: nonce,
				},
				pinSession: () => pinSession(record),
				waitForRelease: async (_releasePath, releaseNonce) => {
					waited = true;
					return { ...record, kind: "release", state: "release", nonce: releaseNonce };
				},
			});
			expect(waited).toBe(true);
			expect(open?.state).toBe("open");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	test("default missing release fails closed at deadline", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "gjc-restart-"));
		try {
			const record = { ...manifest(dir), expiresAtMs: Date.now() + 1_000 };
			await writeFile(record.manifestPath, JSON.stringify(record));
			await expect(
				validateStrictHeldResumeEnvironment(record.sessionPath, {
					env: {
						GJC_TMUX_RESTART_HELD: "1",
						GJC_TMUX_RESTART_MANIFEST: record.manifestPath,
						GJC_TMUX_RESTART_NONCE: nonce,
					},
					pinSession: () => pinSession(record),
				}),
			).rejects.toThrow(/release was not received before manifest expiry/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	test("rejects every release correlation mismatch and closes exactly once", async () => {
		const fields = [
			"nonce",
			"sessionPath",
			"manifestPath",
			"sessionId",
			"createdAtMs",
			"expiresAtMs",
			"pid",
			"processIdentity",
			"serverAuthority",
		] as const;
		for (const field of fields) {
			const dir = await mkdtemp(path.join(os.tmpdir(), "gjc-restart-"));
			try {
				const record = manifest(dir);
				await writeFile(record.manifestPath, JSON.stringify(record));
				let pinned: StrictHeldSessionCapability | undefined;
				await expect(
					validateStrictHeldResumeEnvironment(record.sessionPath, {
						env: {
							GJC_TMUX_RESTART_HELD: "1",
							GJC_TMUX_RESTART_MANIFEST: record.manifestPath,
							GJC_TMUX_RESTART_NONCE: nonce,
						},
						pinSession: () => {
							pinned = pinSession(record);
							return pinned;
						},
						waitForRelease: async () => {
							const mismatch: RestartRelease =
								field === "serverAuthority"
									? { ...record, kind: "release", state: "release", serverAuthority: "server-b" }
									: field === "nonce"
										? { ...record, kind: "release", state: "release", nonce: "b".repeat(64) }
										: field === "sessionPath"
											? {
													...record,
													kind: "release",
													state: "release",
													sessionPath: path.join(dir, "other.jsonl"),
												}
											: field === "manifestPath"
												? {
														...record,
														kind: "release",
														state: "release",
														manifestPath: path.join(dir, "other-manifest.json"),
													}
												: field === "sessionId"
													? { ...record, kind: "release", state: "release", sessionId: "other-session" }
													: field === "createdAtMs"
														? {
																...record,
																kind: "release",
																state: "release",
																createdAtMs: record.createdAtMs + 1,
															}
														: field === "expiresAtMs"
															? {
																	...record,
																	kind: "release",
																	state: "release",
																	expiresAtMs: record.expiresAtMs + 1,
																}
															: field === "pid"
																? { ...record, kind: "release", state: "release", pid: "43" }
																: {
																		...record,
																		kind: "release",
																		state: "release",
																		processIdentity: { ...record.processIdentity, value: "linux:2" },
																	};
							return mismatch;
						},
					}),
				).rejects.toThrow(/release does not match held child identity/);
				expect(() => strictHeldSessionId(pinned!)).toThrow(/already consumed/);
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}
	});
	test("rejects a release that arrives after manifest expiry", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "gjc-restart-"));
		try {
			const record = { ...manifest(dir), expiresAtMs: Date.now() + 20 };
			await writeFile(record.manifestPath, JSON.stringify(record));
			await expect(
				validateStrictHeldResumeEnvironment(record.sessionPath, {
					env: {
						GJC_TMUX_RESTART_HELD: "1",
						GJC_TMUX_RESTART_MANIFEST: record.manifestPath,
						GJC_TMUX_RESTART_NONCE: nonce,
					},
					pinSession: () => pinSession(record),
					waitForRelease: async () => {
						await Bun.sleep(30);
						return { ...record, kind: "release", state: "release" };
					},
				}),
			).rejects.toThrow(/release arrived after manifest expiry/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	test("replacement after pinning preserves descriptor", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "gjc-restart-"));
		try {
			const record = manifest(dir);
			await writeFile(record.manifestPath, JSON.stringify(record));
			await writeFile(record.sessionPath, `${JSON.stringify({ id: sessionId })}\noriginal\n`);
			const storage = new FileSessionStorage();
			const backupPath = `${record.sessionPath}.original`;
			const open = await validateStrictHeldResumeEnvironment(record.sessionPath, {
				env: {
					GJC_TMUX_RESTART_HELD: "1",
					GJC_TMUX_RESTART_MANIFEST: record.manifestPath,
					GJC_TMUX_RESTART_NONCE: nonce,
				},
				pinSession: sessionPath => storage.pinStrictSession(sessionPath),
				waitForRelease: async () => {
					await rename(record.sessionPath, backupPath);
					await writeFile(record.sessionPath, "replacement\n");
					return { ...record, kind: "release", state: "release" };
				},
			});
			const retained = consumeStrictHeldSessionCapability(
				consumeStrictHeldProtocolAuthorization(open.authorization),
			);
			retained.writer.writeLineSync("original-write\n");
			await retained.writer.close();
			expect(await readFile(backupPath, "utf8")).toContain("original-write\n");
			expect(await readFile(record.sessionPath, "utf8")).toBe("replacement\n");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	test("invalid manifest closes pinned writer", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "gjc-restart-"));
		try {
			const record = manifest(dir);
			await writeFile(record.manifestPath, JSON.stringify({ ...record, sessionId: undefined }));
			let pinned: StrictHeldSessionCapability | undefined;
			await expect(
				validateStrictHeldResumeEnvironment(record.sessionPath, {
					env: {
						GJC_TMUX_RESTART_HELD: "1",
						GJC_TMUX_RESTART_MANIFEST: record.manifestPath,
						GJC_TMUX_RESTART_NONCE: nonce,
					},
					pinSession: () => {
						pinned = pinSession(record);
						return pinned;
					},
				}),
			).rejects.toThrow();
			expect(() => strictHeldSessionId(pinned!)).toThrow(/already consumed/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	test("missing release closes pinned writer", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "gjc-restart-"));
		try {
			const record = manifest(dir);
			await writeFile(record.manifestPath, JSON.stringify(record));
			let pinned: StrictHeldSessionCapability | undefined;
			await expect(
				validateStrictHeldResumeEnvironment(record.sessionPath, {
					env: {
						GJC_TMUX_RESTART_HELD: "1",
						GJC_TMUX_RESTART_MANIFEST: record.manifestPath,
						GJC_TMUX_RESTART_NONCE: nonce,
					},
					pinSession: () => {
						pinned = pinSession(record);
						return pinned;
					},
					waitForRelease: async () => {
						throw new Error("missing release");
					},
				}),
			).rejects.toThrow("missing release");
			expect(() => strictHeldSessionId(pinned!)).toThrow(/already consumed/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
