import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	buildGjcTmuxIdOptionTarget,
	buildGjcTmuxIdSessionTarget,
	parseTmuxSessionId,
	type TmuxSessionId,
} from "../../src/gjc-runtime/tmux-common";

const STRICT_FIXTURE_ENV = "GJC_TMUX_NATIVE_ID_STRICT";
const strictFixture = process.env[STRICT_FIXTURE_ENV] === "1";
const tmuxCommand = Bun.which("tmux");
const skipUnavailable = !strictFixture && !tmuxCommand;
const runTmuxOnServer = (server: string, args: string[]): TmuxResult => runTmux(["-L", server, ...args]);

type TmuxResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

function runTmux(args: string[]): TmuxResult {
	if (!tmuxCommand) throw new Error("tmux is unavailable");
	const result = Bun.spawnSync({ cmd: [tmuxCommand, ...args], stdout: "pipe", stderr: "pipe" });
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function runTmuxChecked(args: string[]): string {
	const result = runTmux(args);
	if (result.exitCode !== 0) {
		throw new Error(`tmux ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

const nativeIdRestartTest = it.skipIf(skipUnavailable);

describe("native tmux session-ID restart safety", () => {
	nativeIdRestartTest("destroys only the generated session by immutable native ID", () => {
		if (strictFixture) {
			const version = runTmuxChecked(["-V"]);
			expect(version).toBe("tmux 3.4");
		}

		const server = `gjc-native-id-fixture-${process.pid}-${randomUUID()}`;
		const targetName = `${server}-target`;
		const sentinelName = `${server}-sentinel`;
		let sessionId: TmuxSessionId | undefined;
		try {
			const tmux = (args: string[]) => runTmuxOnServer(server, args);
			const checked = (args: string[]) => {
				const result = tmux(args);
				if (result.exitCode !== 0) {
					throw new Error(`tmux ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
				}
				return result.stdout.trim();
			};
			if (strictFixture) expect(checked(["-V"])).toBe("tmux 3.4");
			checked(["new-session", "-d", "-s", targetName, "sleep", "30"]);
			checked(["new-session", "-d", "-s", sentinelName, "sleep", "30"]);
			const sessions = checked(["list-sessions", "-F", "#{session_name}\t#{session_id}"]);
			const matchingSession = sessions.split("\n").find(session => session.startsWith(`${targetName}\t`));
			expect(matchingSession).toBeDefined();
			if (!matchingSession) throw new Error(`tmux did not list generated session: ${targetName}`);

			const [, rawSessionId] = matchingSession.split("\t");
			sessionId = parseTmuxSessionId(rawSessionId);
			expect(sessionId).toBeDefined();
			if (!sessionId) throw new Error(`tmux returned invalid session id: ${rawSessionId}`);

			const optionTargetSessionId = checked([
				"display-message",
				"-p",
				"-t",
				buildGjcTmuxIdOptionTarget(sessionId),
				"#{session_id}",
			]);
			expect(parseTmuxSessionId(optionTargetSessionId)).toBe(sessionId);
			expect(buildGjcTmuxIdOptionTarget(sessionId)).toBe(`${sessionId}:`);
			expect(buildGjcTmuxIdSessionTarget(sessionId)).toBe(sessionId);
			checked(["kill-session", "-t", buildGjcTmuxIdSessionTarget(sessionId)]);
			const remaining = checked(["list-sessions", "-F", "#{session_name}\t#{session_id}"]);
			expect(remaining).not.toContain(`${targetName}\t`);
			expect(remaining).toContain(`${sentinelName}\t`);
		} finally {
			runTmuxOnServer(server, ["kill-server"]);
		}
	});
});
