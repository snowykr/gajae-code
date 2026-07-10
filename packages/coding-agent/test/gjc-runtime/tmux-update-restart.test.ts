import { describe, expect, test } from "bun:test";
import { parseTmuxSessionId, type TmuxSessionId } from "../../src/gjc-runtime/tmux-common";
import {
	coordinateTmuxRestart,
	type TmuxRestartCandidate,
	type TmuxRestartCoordinatorOptions,
} from "../../src/gjc-runtime/tmux-update-restart";

const identity = {
	platform: process.platform as "linux" | "darwin",
	value: process.platform === "darwin" ? "darwin:1:2" : "linux:1",
};
const nativeId = parseTmuxSessionId("$1") as TmuxSessionId;

function candidate(
	id: TmuxSessionId = nativeId,
	sessionPath = "/tmp/gjc-session/session.jsonl",
	serverAuthority = "server-a",
): TmuxRestartCandidate {
	const now = Date.now();
	const manifest = {
		schemaVersion: 1 as const,
		kind: "manifest" as const,
		state: "held" as const,
		nonce: "a".repeat(64),
		sessionPath,
		manifestPath: "/tmp/gjc-session/manifest.json",
		pid: "42",
		processIdentity: identity,
		createdAtMs: now,
		expiresAtMs: now + 60_000,
		sessionId: "header-1",
		serverAuthority,
	};
	return {
		terminal: { sessionPath, headerSessionId: "header-1" },
		serverAuthority,
		nativeSessionId: id,
		oldPane: { pid: "42", identity },
		held: { manifest, open: { ...manifest, kind: "open", state: "open" } },
	};
}

function options(
	overrides: Partial<TmuxRestartCoordinatorOptions> = {},
): TmuxRestartCoordinatorOptions & { killed: TmuxSessionId[]; published: number } {
	const state = { killed: [] as TmuxSessionId[], published: 0 };
	return {
		compareOldPane: async () => "same",
		probeNativeSessionRebind: async () => "same",
		killNativeSession: async candidate => void state.killed.push(candidate.nativeSessionId),
		probeNativeSession: async () => "absent",
		compareReleasedPane: async () => "different",
		publishRelease: async () => {
			state.published++;
		},
		...overrides,
		killed: state.killed,
		published: state.published,
	};
}

describe("strict tmux restart coordinator", () => {
	test("does not kill when the old identity is not same", async () => {
		const calls: string[] = [];
		const result = await coordinateTmuxRestart([candidate()], {
			...options(),
			compareOldPane: async () => "different",
			killNativeSession: async () => void calls.push("kill"),
		});
		expect(result[0]).toEqual({ status: "skipped", reason: "old_identity_not_same" });
		expect(calls).toEqual([]);
	});

	test("rejects malformed native IDs", async () => {
		const invalid = candidate("raw-id" as TmuxSessionId);
		const calls: string[] = [];
		const result = await coordinateTmuxRestart([invalid], {
			...options(),
			killNativeSession: async () => void calls.push("kill"),
		});
		expect(result[0]).toEqual({ status: "skipped", reason: "invalid_candidate" });
		expect(calls).toEqual([]);
	});
	test("rejects header, manifest, and open session ID mismatches before side effects", async () => {
		const base = candidate();
		const mismatches: TmuxRestartCandidate[] = [
			{
				...base,
				terminal: { ...base.terminal, headerSessionId: "header-2" },
			},
			{
				...base,
				held: {
					...base.held,
					manifest: { ...base.held.manifest, sessionId: "header-2" },
				},
			},
			{
				...base,
				held: {
					...base.held,
					open: { ...base.held.open, sessionId: "header-2" },
				},
			},
		];
		const calls: string[] = [];
		const result = await coordinateTmuxRestart(mismatches, {
			...options(),
			compareOldPane: async () => {
				calls.push("compare");
				return "same";
			},
			killNativeSession: async () => void calls.push("kill"),
			publishRelease: async () => void calls.push("release"),
		});
		expect(result).toEqual([
			{ status: "skipped", reason: "invalid_candidate" },
			{ status: "skipped", reason: "invalid_candidate" },
			{ status: "skipped", reason: "invalid_candidate" },
		]);
		expect(calls).toEqual([]);
	});

	test("rejects a $0 candidate bound to the wrong server without side effects", async () => {
		const calls: string[] = [];
		const wrongServer = { ...candidate(parseTmuxSessionId("$0") as TmuxSessionId), serverAuthority: "server-b" };
		const result = await coordinateTmuxRestart([wrongServer], {
			...options(),
			compareOldPane: async () => {
				calls.push("compare");
				return "same";
			},
			killNativeSession: async () => void calls.push("kill"),
			publishRelease: async () => void calls.push("release"),
		});
		expect(result).toEqual([{ status: "skipped", reason: "invalid_candidate" }]);
		expect(calls).toEqual([]);
	});
	test("skips every duplicate by terminal key or native ID", async () => {
		const calls: string[] = [];
		const sameNative = candidate(nativeId, "/tmp/gjc-session/other.jsonl");
		const result = await coordinateTmuxRestart([candidate(), sameNative], {
			...options(),
			killNativeSession: async () => void calls.push("kill"),
		});
		expect(result).toEqual([
			{ status: "skipped", reason: "duplicate_candidate" },
			{ status: "skipped", reason: "duplicate_candidate" },
		]);
		expect(calls).toEqual([]);
	});
	test("rejects terminal-key collisions even with distinct valid native IDs", async () => {
		const secondNativeId = parseTmuxSessionId("$2") as TmuxSessionId;
		const calls: string[] = [];
		const result = await coordinateTmuxRestart([candidate(), candidate(secondNativeId)], {
			...options(),
			compareOldPane: async () => {
				calls.push("identity");
				return "same";
			},
			killNativeSession: async () => void calls.push("kill"),
			publishRelease: async () => void calls.push("release"),
		});
		expect(result).toEqual([
			{ status: "skipped", reason: "duplicate_candidate" },
			{ status: "skipped", reason: "duplicate_candidate" },
		]);
		expect(calls).toEqual([]);
	});

	test("does not kill when final native rebind mismatches", async () => {
		const calls: string[] = [];
		const result = await coordinateTmuxRestart([candidate()], {
			...options(),
			probeNativeSessionRebind: async () => "different",
			killNativeSession: async () => void calls.push("kill"),
		});
		expect(result[0]).toEqual({ status: "skipped", reason: "old_identity_not_same" });
		expect(calls).toEqual([]);
	});

	test("does not publish after kill failure", async () => {
		let published = false;
		const result = await coordinateTmuxRestart([candidate()], {
			...options(),
			killNativeSession: async () => {
				throw new Error("failure");
			},
			publishRelease: async () => {
				published = true;
			},
		});
		expect(result[0]).toEqual({ status: "skipped", reason: "kill_failed" });
		expect(published).toBe(false);
	});

	test("publishes only after ID disappearance and different or absent identity", async () => {
		for (const comparison of ["different", "absent"] as const) {
			let published = false;
			const result = await coordinateTmuxRestart([candidate()], {
				...options(),
				compareReleasedPane: async () => comparison,
				publishRelease: async () => {
					published = true;
				},
			});
			expect(result[0]).toEqual({ status: "released" });
			expect(published).toBe(true);
		}
	});

	test("never publishes for same or unavailable identity", async () => {
		for (const comparison of ["same", "unavailable"] as const) {
			let published = false;
			const result = await coordinateTmuxRestart([candidate()], {
				...options(),
				compareReleasedPane: async () => comparison,
				publishRelease: async () => {
					published = true;
				},
			});
			expect(result[0]).toEqual({ status: "skipped", reason: "new_identity_not_released" });
			expect(published).toBe(false);
		}
	});

	test("requires the immutable native ID to be absent", async () => {
		let published = false;
		const result = await coordinateTmuxRestart([candidate()], {
			...options(),
			probeNativeSession: async () => "present",
			publishRelease: async () => {
				published = true;
			},
		});
		expect(result[0]).toEqual({ status: "skipped", reason: "native_session_still_present" });
		expect(published).toBe(false);
	});
});
