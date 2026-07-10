import * as path from "node:path";

import { parseTmuxSessionId, type TmuxSessionId } from "./tmux-common";
import {
	type PlatformProcessIdentity,
	parseRestartRecord,
	publishRestartRelease,
	type RestartManifest,
	type RestartOpen,
	type RestartRelease,
} from "./tmux-restart-protocol";

export type RestartProbe = "same" | "different" | "absent" | "unavailable";
export type NativeSessionProbe = "present" | "absent" | "unavailable";

export type StrictTerminalTuple = {
	sessionPath: string;
	headerSessionId: string;
};

export type TmuxRestartCandidate = {
	terminal: StrictTerminalTuple;
	serverAuthority: string;
	nativeSessionId: TmuxSessionId;
	oldPane: {
		pid: string;
		identity: PlatformProcessIdentity;
	};
	held: {
		manifest: RestartManifest;
		open: RestartOpen;
	};
};

export type TmuxRestartCoordinatorOptions = {
	compareOldPane: (candidate: TmuxRestartCandidate) => Promise<RestartProbe>;
	/** Re-check the immutable ID binding immediately before an ID-only kill. */
	probeNativeSessionRebind?: (candidate: TmuxRestartCandidate) => Promise<RestartProbe>;
	finalRebindProbe?: (candidate: TmuxRestartCandidate) => Promise<RestartProbe>;
	/** All native-session destructive operations receive the server-bound candidate. */
	killNativeSession: (candidate: TmuxRestartCandidate) => Promise<void>;
	probeNativeSession: (candidate: TmuxRestartCandidate) => Promise<NativeSessionProbe>;
	compareReleasedPane: (candidate: TmuxRestartCandidate) => Promise<RestartProbe>;
	publishRelease?: (manifestPath: string, release: RestartRelease) => Promise<void>;
};

export type TmuxRestartOutcome =
	| { status: "released" }
	| {
			status: "skipped";
			reason:
				| "duplicate_candidate"
				| "invalid_candidate"
				| "old_identity_not_same"
				| "kill_failed"
				| "native_session_still_present"
				| "native_session_unavailable"
				| "new_identity_not_released"
				| "release_failed";
	  };

function candidateKey(candidate: TmuxRestartCandidate): string | undefined {
	const sessionPath = candidate.terminal.sessionPath;
	const headerSessionId = candidate.terminal.headerSessionId.trim();
	const serverAuthority = candidate.serverAuthority.trim();
	if (!sessionPath || !headerSessionId || !serverAuthority) return undefined;
	try {
		return `${path.normalize(path.resolve(sessionPath))}\u0000${headerSessionId}\u0000${serverAuthority}`;
	} catch {
		return undefined;
	}
}

function sameIdentity(left: PlatformProcessIdentity, right: PlatformProcessIdentity): boolean {
	return left.platform === right.platform && left.value === right.value;
}

function isCoherent(candidate: TmuxRestartCandidate): boolean {
	const { manifest, open } = candidate.held;
	const nativeId = parseTmuxSessionId(candidate.nativeSessionId);
	try {
		const parsedManifest = parseRestartRecord(JSON.stringify(manifest), "manifest") as RestartManifest;
		const parsedOpen = parseRestartRecord(JSON.stringify(open), "open") as RestartOpen;
		const headerSessionId = candidate.terminal.headerSessionId;
		return (
			typeof headerSessionId === "string" &&
			headerSessionId.length > 0 &&
			typeof candidate.serverAuthority === "string" &&
			candidate.serverAuthority.trim().length > 0 &&
			nativeId !== undefined &&
			parsedManifest.serverAuthority === candidate.serverAuthority &&
			parsedOpen.serverAuthority === candidate.serverAuthority &&
			parsedManifest.sessionId === headerSessionId &&
			parsedOpen.sessionId === headerSessionId &&
			candidate.oldPane.pid === parsedManifest.pid &&
			sameIdentity(candidate.oldPane.identity, parsedManifest.processIdentity) &&
			parsedManifest.sessionPath === candidate.terminal.sessionPath &&
			parsedOpen.sessionPath === parsedManifest.sessionPath &&
			parsedOpen.manifestPath === parsedManifest.manifestPath &&
			parsedOpen.nonce === parsedManifest.nonce &&
			parsedOpen.pid === parsedManifest.pid &&
			sameIdentity(parsedOpen.processIdentity, parsedManifest.processIdentity) &&
			parsedOpen.createdAtMs === parsedManifest.createdAtMs &&
			parsedOpen.expiresAtMs === parsedManifest.expiresAtMs &&
			parsedManifest.expiresAtMs >= Date.now()
		);
	} catch {
		return false;
	}
}

function releaseFor(candidate: TmuxRestartCandidate): RestartRelease {
	return { ...candidate.held.manifest, kind: "release", state: "release" };
}

export async function coordinateTmuxRestart(
	candidates: readonly TmuxRestartCandidate[],
	options: TmuxRestartCoordinatorOptions,
): Promise<readonly TmuxRestartOutcome[]> {
	const keys = candidates.map(candidateKey);
	const counts = new Map<string, number>();
	const nativeCounts = new Map<string, number>();
	for (const [index, candidate] of candidates.entries()) {
		const key = keys[index];
		if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
		const nativeId = parseTmuxSessionId(candidate.nativeSessionId);
		const nativeKey =
			nativeId && candidate.serverAuthority.trim() ? `${candidate.serverAuthority}\u0000${nativeId}` : undefined;
		if (nativeKey) nativeCounts.set(nativeKey, (nativeCounts.get(nativeKey) ?? 0) + 1);
	}
	const publish = options.publishRelease ?? publishRestartRelease;
	const outcomes: TmuxRestartOutcome[] = [];
	for (const [index, candidate] of candidates.entries()) {
		const key = keys[index];
		const nativeId = parseTmuxSessionId(candidate.nativeSessionId);
		if (!key || !nativeId || !isCoherent(candidate)) {
			outcomes.push({ status: "skipped", reason: "invalid_candidate" });
			continue;
		}
		const nativeKey = `${candidate.serverAuthority}\u0000${nativeId}`;
		if ((counts.get(key) ?? 0) > 1 || (nativeCounts.get(nativeKey) ?? 0) > 1) {
			outcomes.push({ status: "skipped", reason: "duplicate_candidate" });
			continue;
		}
		let oldComparison: RestartProbe;
		try {
			oldComparison = await options.compareOldPane(candidate);
		} catch {
			outcomes.push({ status: "skipped", reason: "old_identity_not_same" });
			continue;
		}
		if (oldComparison !== "same") {
			outcomes.push({ status: "skipped", reason: "old_identity_not_same" });
			continue;
		}
		if (!isCoherent(candidate)) {
			outcomes.push({ status: "skipped", reason: "invalid_candidate" });
			continue;
		}
		let rebind: RestartProbe;
		try {
			const probe = options.finalRebindProbe ?? options.probeNativeSessionRebind;
			rebind = probe ? await probe(candidate) : "unavailable";
		} catch {
			rebind = "unavailable";
		}
		if (rebind !== "same") {
			outcomes.push({ status: "skipped", reason: "old_identity_not_same" });
			continue;
		}
		// Re-read all immutable candidate bindings after the final native rebind.
		// Expiry is included in isCoherent, so a race into expiry cannot reach kill.
		if (!isCoherent(candidate)) {
			outcomes.push({ status: "skipped", reason: "invalid_candidate" });
			continue;
		}
		try {
			await options.killNativeSession(candidate);
		} catch {
			outcomes.push({ status: "skipped", reason: "kill_failed" });
			continue;
		}
		let nativeState: NativeSessionProbe;
		try {
			nativeState = await options.probeNativeSession(candidate);
		} catch {
			outcomes.push({ status: "skipped", reason: "native_session_unavailable" });
			continue;
		}
		if (nativeState !== "absent") {
			outcomes.push({
				status: "skipped",
				reason: nativeState === "present" ? "native_session_still_present" : "native_session_unavailable",
			});
			continue;
		}
		let releasedComparison: RestartProbe;
		try {
			releasedComparison = await options.compareReleasedPane(candidate);
		} catch {
			outcomes.push({ status: "skipped", reason: "new_identity_not_released" });
			continue;
		}
		if (releasedComparison !== "different" && releasedComparison !== "absent") {
			outcomes.push({ status: "skipped", reason: "new_identity_not_released" });
			continue;
		}
		if (!isCoherent(candidate)) {
			outcomes.push({ status: "skipped", reason: "invalid_candidate" });
			continue;
		}
		try {
			await publish(candidate.held.manifest.manifestPath, releaseFor(candidate));
			outcomes.push({ status: "released" });
		} catch {
			outcomes.push({ status: "skipped", reason: "release_failed" });
		}
	}
	return outcomes;
}
