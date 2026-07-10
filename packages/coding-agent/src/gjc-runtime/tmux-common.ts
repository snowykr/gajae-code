import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedTmuxBinary } from "./psmux-detect";
import { resolveGjcTmuxBinary } from "./psmux-detect";

export const GJC_DEFAULT_TMUX_SESSION = "gajae_code";
export const GJC_TMUX_SESSION_PREFIX = `${GJC_DEFAULT_TMUX_SESSION}_`;
export const GJC_TMUX_COMMAND_ENV = "GJC_TMUX_COMMAND";
export const GJC_TMUX_ACTIVE_SESSION_ENV = "GJC_TMUX_ACTIVE_SESSION";
export const GJC_TMUX_PROFILE_ENV = "GJC_TMUX_PROFILE";
export const GJC_TMUX_MOUSE_ENV = "GJC_MOUSE";
export const GJC_TMUX_PROFILE_OPTION = "@gjc-profile";
export const GJC_TMUX_PROFILE_VALUE = "1";
export const GJC_TMUX_BRANCH_OPTION = "@gjc-branch";
export const GJC_TMUX_BRANCH_SLUG_OPTION = "@gjc-branch-slug";
export const GJC_TMUX_PROJECT_OPTION = "@gjc-project";
export const GJC_TMUX_SESSION_ID_OPTION = "@gjc-session-id";
export const GJC_TMUX_SESSION_STATE_FILE_OPTION = "@gjc-session-state-file";
export const GJC_TMUX_VERSION_OPTION = "@gjc-version";
export const GJC_PSMUX_PROFILE_FORCE_ENV = "GJC_PSMUX_PROFILE_FORCE";
export const GJC_TMUX_RESTART_HELD_ENV = "GJC_TMUX_RESTART_HELD";
export const GJC_TMUX_RESTART_MANIFEST_ENV = "GJC_TMUX_RESTART_MANIFEST";
export const GJC_TMUX_RESTART_NONCE_ENV = "GJC_TMUX_RESTART_NONCE";

export interface StrictNativeTmuxRuntime {
	command: string;
	version: string;
	restartBinding?: {
		sessionPath: string;
		manifestPath: string;
	};
}

export type StrictNativeTmuxAdmission =
	| { state: "available"; runtime: StrictNativeTmuxRuntime }
	| { state: "unavailable"; reason: string };

export interface StrictNativeTmuxOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	resolveBinary?: (candidate: string) => string | null;
	run?: (command: string, args: string[]) => TmuxCommandResult;
	isExecutable?: (command: string) => boolean;
	handshake?: (command: string) => boolean;
	wslProbe?: () => boolean;
	sessionPath?: string;
	manifestPath?: string;
	classifyFilesystem?: (location: string) => unknown;
}

const STRICT_TMUX_VERSION = /^tmux\s+(\d+)\.(\d+)(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?$/;

function strictTmuxVersion(output: string): string | undefined {
	const match = STRICT_TMUX_VERSION.exec(output.trim());
	if (!match) return undefined;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	if (major < 3 || (major === 3 && minor < 4)) return undefined;
	return match[0].slice("tmux ".length);
}

function defaultStrictBinaryResolver(candidate: string): string | null {
	const resolved = Bun.which(candidate);
	return resolved && path.isAbsolute(resolved) ? resolved : null;
}

function defaultStrictExecutable(command: string): boolean {
	try {
		if (!fs.statSync(command).isFile()) return false;
		fs.accessSync(command, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function defaultStrictRunner(command: string, args: string[]): TmuxCommandResult {
	try {
		const result = Bun.spawnSync({ cmd: [command, ...args], stdout: "pipe", stderr: "pipe", env: process.env });
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	} catch {
		return { exitCode: -1 };
	}
}
function defaultWslProbe(platform: NodeJS.Platform): boolean {
	if (platform !== "linux") return false;
	try {
		const release = fs.readFileSync("/proc/sys/kernel/osrelease", "utf8").trim().toLowerCase();
		const version = fs.readFileSync("/proc/version", "utf8").trim().toLowerCase();
		if (!release || !version) throw new Error("missing kernel evidence");
		return (
			release.includes("microsoft") ||
			release.includes("wsl") ||
			version.includes("microsoft") ||
			version.includes("wsl")
		);
	} catch {
		return true;
	}
}

/**
 * Admit only a real, executable native tmux provider for restart operations.
 * This deliberately does not discover sessions or honor the legacy command
 * overrides; callers can therefore fail closed before any lifecycle work.
 */
export function resolveStrictNativeTmuxRuntime(options: StrictNativeTmuxOptions = {}): StrictNativeTmuxAdmission {
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const wslProbe = options.wslProbe ?? (() => defaultWslProbe(platform));
	try {
		if (wslProbe()) return { state: "unavailable", reason: "unsupported-wsl" };
	} catch {
		return { state: "unavailable", reason: "wsl-probe-failed" };
	}
	if (platform !== "linux" && platform !== "darwin") return { state: "unavailable", reason: "unsupported-platform" };
	if (env.GJC_TMUX_COMMAND?.trim() || env.GJC_TEAM_TMUX_COMMAND?.trim())
		return { state: "unavailable", reason: "command-override" };

	let command: string | null;
	try {
		command = (options.resolveBinary ?? defaultStrictBinaryResolver)("tmux");
	} catch {
		return { state: "unavailable", reason: "unresolved-command" };
	}
	if (!command || !path.isAbsolute(command)) return { state: "unavailable", reason: "unresolved-command" };
	const basename = path
		.basename(command)
		.toLowerCase()
		.replace(/\.exe$/, "");
	if (basename !== "tmux") return { state: "unavailable", reason: "unsupported-provider" };
	try {
		if (!(options.isExecutable ?? defaultStrictExecutable)(command))
			return { state: "unavailable", reason: "non-executable-command" };
	} catch {
		return { state: "unavailable", reason: "non-executable-command" };
	}

	let result: TmuxCommandResult;
	try {
		result = (options.run ?? defaultStrictRunner)(command, ["-V"]);
	} catch {
		return { state: "unavailable", reason: "version-probe-failed" };
	}
	if (result.exitCode !== 0) return { state: "unavailable", reason: "version-probe-failed" };
	const version = strictTmuxVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
	if (!version) return { state: "unavailable", reason: "unsupported-version" };

	const handshake =
		options.handshake ??
		((candidate: string) => {
			const serverName = `gjc-probe-${randomTmuxSessionSuffix()}`;
			const run = options.run ?? defaultStrictRunner;
			let probeId: TmuxSessionId | undefined;
			let sentinelId: TmuxSessionId | undefined;
			let probeKilled = false;
			const createSession = (sessionName: string): TmuxSessionId | undefined => {
				const create = run(candidate, [
					"-L",
					serverName,
					"new-session",
					"-d",
					"-P",
					"-F",
					"#{session_id}",
					"-s",
					sessionName,
				]);
				return create.exitCode === 0 ? parseTmuxSessionId((create.stdout ?? "").trim()) : undefined;
			};
			const listIds = (): TmuxSessionId[] | undefined => {
				const listed = run(candidate, ["-L", serverName, "list-sessions", "-F", "#{session_id}"]);
				if (listed.exitCode !== 0) return undefined;
				const ids = (listed.stdout ?? "")
					.split(/\r?\n/)
					.map(line => parseTmuxSessionId(line.trim()))
					.filter((id): id is TmuxSessionId => id !== undefined);
				return ids.length === (listed.stdout ?? "").split(/\r?\n/).filter(line => line.trim()).length
					? ids
					: undefined;
			};
			const killSession = (id: TmuxSessionId): boolean =>
				run(candidate, ["-L", serverName, "kill-session", "-t", buildGjcTmuxIdSessionTarget(id)]).exitCode === 0;
			try {
				probeId = createSession(`gjc-probe-${randomTmuxSessionSuffix()}`);
				sentinelId = createSession(`gjc-sentinel-${randomTmuxSessionSuffix()}`);
				if (!probeId || !sentinelId || probeId === sentinelId) return false;
				const created = listIds();
				if (created?.length !== 2 || !created.includes(probeId) || !created.includes(sentinelId)) return false;
				if (!killSession(probeId)) return false;
				probeKilled = true;
				const remaining = listIds();
				if (remaining?.length !== 1 || remaining[0] !== sentinelId) return false;
				if (!killSession(sentinelId)) return false;
				sentinelId = undefined;
				return true;
			} catch {
				return false;
			} finally {
				if (probeId && !probeKilled) {
					try {
						killSession(probeId);
					} catch {
						// Best-effort cleanup; admission already fails.
					}
				}
				if (sentinelId) {
					try {
						killSession(sentinelId);
					} catch {
						// Best-effort cleanup; admission already fails.
					}
				}
			}
		});
	try {
		if (!handshake(command)) return { state: "unavailable", reason: "handshake-failed" };
	} catch {
		return { state: "unavailable", reason: "handshake-failed" };
	}
	if (platform === "darwin") {
		const sessionPath = options.sessionPath;
		const restartPath = options.manifestPath;
		if (!sessionPath || !restartPath) return { state: "unavailable", reason: "missing-restart-paths" };
		const classify = options.classifyFilesystem;
		if (!classify) return { state: "unavailable", reason: "filesystem-classification-failed" };
		const locations = [sessionPath, restartPath];
		for (const location of locations) {
			let classification: unknown;
			try {
				classification = classify(location);
			} catch {
				return { state: "unavailable", reason: "filesystem-classification-failed" };
			}
			const filesystem =
				typeof classification === "string"
					? classification
					: classification && typeof classification === "object"
						? (classification as { filesystem?: unknown }).filesystem
						: undefined;
			const exists =
				typeof classification === "object" &&
				classification !== null &&
				"exists" in classification &&
				(classification as { exists?: unknown }).exists === true;
			if (!exists || filesystem !== "apfs") return { state: "unavailable", reason: "filesystem-admission-failed" };
		}
	}
	return {
		state: "available",
		runtime: {
			command,
			version,
			...(platform === "darwin"
				? { restartBinding: { sessionPath: options.sessionPath!, manifestPath: options.manifestPath! } }
				: {}),
		},
	};
}
/**
 * Native tmux session IDs are immutable server-assigned identifiers. Keep the
 * grammar deliberately narrow so a malformed value can never become a target.
 */
export type TmuxSessionId = string & { readonly __tmuxSessionId: unique symbol };

const TMUX_SESSION_ID_PATTERN = /^\$(?:0|[1-9]\d{0,18})$/;

export function isTmuxSessionId(value: string): value is TmuxSessionId {
	return TMUX_SESSION_ID_PATTERN.test(value);
}

export function parseTmuxSessionId(value: string): TmuxSessionId | undefined {
	return isTmuxSessionId(value) ? value : undefined;
}

export interface GjcTmuxProfileCommand {
	description: string;
	args: string[];
}

export interface TmuxCommandResult {
	exitCode: number | null;
	stdout?: string;
	stderr?: string;
	signalCode?: string | null;
}

export type TmuxCommandRunner = (args: string[]) => TmuxCommandResult;

export function envDisabled(value: string | undefined): boolean {
	const normalized = value?.trim().toLowerCase();
	return normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no";
}

/**
 * Resolve the tmux (or tmux-compatible multiplexer) command GJC should invoke.
 *
 * This is the shared entry point used by every GJC code path that needs to talk
 * to a multiplexer: `gjc --tmux` planning, `gjc session ...`, `gjc team ...`,
 * the lifecycle controller, and the harness resident owner. Routing all of
 * them through the same resolver means a single `GJC_TMUX_COMMAND` override or
 * a single Windows psmux / pmux detection wins for the whole process — the
 * failure mode where `gjc --tmux` creates a psmux-backed session and then
 * `gjc session status` fails because it queries literal `tmux` is closed off.
 *
 * Explicit `GJC_TMUX_COMMAND` / `GJC_TEAM_TMUX_COMMAND` overrides are honored on
 * every platform. On native Windows without an override the resolver walks
 * `psmux`, then `pmux`, then `tmux` and uses the first binary present on PATH.
 * On POSIX the resolver returns `tmux` (the historical default) and only
 * falls through to the platform-aware walker if the caller opts in.
 */
export function resolveGjcTmuxCommand(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	return resolveGjcTmuxBinary({ env, platform }).command;
}

export type { PsmuxProbe, ResolvedTmuxBinary, ResolveGjcTmuxBinaryOptions } from "./psmux-detect";
export { clearPsmuxDetectionCache, detectPsmux, probePsmux, resolveGjcTmuxBinary } from "./psmux-detect";

/**
 * Build the exact-session target for tmux *option* commands
 * (`show-options` / `set-option`) and `display-message -t`.
 *
 * Session-scoped commands such as `kill-session` / `attach-session` resolve a
 * bare exact target (`=NAME`), but tmux 3.6a refuses to resolve a bare `=NAME`
 * for option/display commands. Appending the empty window separator (`=NAME:`)
 * keeps the exact-session match while giving tmux the window-qualified target
 * those commands require. See gajae-code#580.
 */
export function buildGjcTmuxExactOptionTarget(
	sessionName: string,
	opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; binary?: ResolvedTmuxBinary } = {},
): string {
	const binary = opts.binary ?? resolveGjcTmuxBinary({ env: opts.env, platform: opts.platform });
	// psmux 3.3.0 rejects the tmux `=NAME` exact-session prefix for option
	// commands ("no server running on session '=NAME'"); bare `NAME` and
	// window-qualified `NAME:` both work. tmux 3.6a needs the
	// window-qualified `=NAME:` to resolve the session for option
	// commands (gajae-code#580).
	if (binary.isPsmux) return sessionName;
	return `=${sessionName}:`;
}

/**
 * Build the exact-session target for tmux *session-scoped* commands such as
 * `attach-session` and `kill-session`. Native tmux accepts `=NAME` for an
 * exact session match, but Windows psmux 3.3.x rejects that target form for
 * session commands even though the bare `NAME` resolves. Keep native tmux on
 * exact targets and intentionally use the bare session name for psmux.
 */
export function buildGjcTmuxExactSessionTarget(
	sessionName: string,
	opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; binary?: ResolvedTmuxBinary } = {},
): string {
	const binary = opts.binary ?? resolveGjcTmuxBinary({ env: opts.env, platform: opts.platform });
	if (binary.isPsmux) return sessionName;
	return `=${sessionName}`;
}
/**
 * Build a native tmux session-ID target for restart-only option commands.
 * Unlike name targets this is intentionally not psmux-compatible.
 */
export function buildGjcTmuxIdOptionTarget(sessionId: string): string {
	const parsed = parseTmuxSessionId(sessionId);
	if (!parsed) throw new Error("invalid tmux session ID");
	return `${parsed}:`;
}

/**
 * Build a native tmux session-ID target for restart-only session commands.
 * Unlike name targets this is intentionally not psmux-compatible.
 */
export function buildGjcTmuxIdSessionTarget(sessionId: string): string {
	const parsed = parseTmuxSessionId(sessionId);
	if (!parsed) throw new Error("invalid tmux session ID");
	return parsed;
}

export const GJC_TMUX_UNTAGGED_REASON = "gjc_tmux_session_untagged";

export function buildGjcTmuxUntaggedSessionHint(tmuxCommand: string): string {
	return (
		`the active multiplexer "${tmuxCommand}" lists this session but did not return GJC's ${GJC_TMUX_PROFILE_OPTION} ownership tag; ` +
		"GJC-managed sessions and `gjc team` require a tmux provider that round-trips tmux user options. " +
		"For psmux on Windows, cwd/start-directory flags such as `-c` do not isolate the server namespace; psmux uses the tmux-compatible global `-L <namespace>` flag for that. " +
		"GJC_TMUX_COMMAND and GJC_TEAM_TMUX_COMMAND are binary overrides, not shell command lines, so `psmux -L name` is not a supported value. " +
		"Alternative multiplexers such as psmux on Windows do not reliably persist user options yet, so the Windows-native psmux path is not fully supported; " +
		"use real tmux for GJC-managed session and team flows."
	);
}

export function buildGjcTmuxUntaggedSessionError(sessionName: string, tmuxCommand: string): string {
	return `${GJC_TMUX_UNTAGGED_REASON}:${sessionName} — ${buildGjcTmuxUntaggedSessionHint(tmuxCommand)}`;
}

export function sanitizeTmuxToken(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "default"
	);
}

export function buildGjcTmuxSessionSlug(value: string): string {
	return sanitizeTmuxToken(value);
}

function randomTmuxSessionSuffix(): string {
	return Math.random().toString(36).slice(2, 10);
}

export function buildGjcTmuxSessionName(
	env: NodeJS.ProcessEnv = process.env,
	context: { branch?: string | null; now?: number; id?: string } = {},
): string {
	const explicit = env.GJC_TMUX_SESSION?.trim();
	if (explicit) return explicit;
	const timestamp = (context.now ?? Date.now()).toString(36);
	const id = context.id ?? randomTmuxSessionSuffix();
	const branchSlug = context.branch ? `${buildGjcTmuxSessionSlug(context.branch)}_` : "";
	return `${GJC_TMUX_SESSION_PREFIX}${branchSlug}${timestamp}_${id}`;
}

export function buildGjcTmuxRequiredProfileCommands(
	target: string,
	metadata: {
		branch?: string | null;
		branchSlug?: string | null;
		project?: string | null;
		sessionId?: string | null;
		sessionStateFile?: string | null;
		version?: string | null;
	} = {},
): GjcTmuxProfileCommand[] {
	const commands: GjcTmuxProfileCommand[] = [
		{
			description: "mark GJC tmux ownership",
			args: ["set-option", "-t", target, GJC_TMUX_PROFILE_OPTION, GJC_TMUX_PROFILE_VALUE],
		},
	];
	if (metadata.branch)
		commands.push({
			description: "record GJC branch identity",
			args: ["set-option", "-t", target, GJC_TMUX_BRANCH_OPTION, metadata.branch],
		});
	if (metadata.branchSlug)
		commands.push({
			description: "record GJC branch slug",
			args: ["set-option", "-t", target, GJC_TMUX_BRANCH_SLUG_OPTION, metadata.branchSlug],
		});
	if (metadata.project)
		commands.push({
			description: "record GJC project identity",
			args: ["set-option", "-t", target, GJC_TMUX_PROJECT_OPTION, metadata.project],
		});
	if (metadata.sessionId)
		commands.push({
			description: "record GJC session identity",
			args: ["set-option", "-t", target, GJC_TMUX_SESSION_ID_OPTION, metadata.sessionId],
		});
	if (metadata.sessionStateFile)
		commands.push({
			description: "record GJC session state marker",
			args: ["set-option", "-t", target, GJC_TMUX_SESSION_STATE_FILE_OPTION, metadata.sessionStateFile],
		});
	if (metadata.version)
		commands.push({
			description: "record GJC version identity",
			args: ["set-option", "-t", target, GJC_TMUX_VERSION_OPTION, metadata.version],
		});
	return commands;
}

/**
 * Keys whose set-option / set-window-option round-trip is unreliable on psmux
 * 3.3.0. psmux does not support the tmux `set-window-option` command at all
 * (it reports "unknown command: set-window-option") and silently drops several
 * `set-option` keys. The list lives here so every code path that tags a tmux
 * session (gjc --tmux planning, gjc session create, gjc team bootstrap)
 * applies the same filter.
 */
const PSMUX_UNSUPPORTED_PROFILE_KEYS = new Set(["mouse", "set-clipboard", "mode-style"]);

export function buildGjcTmuxProfileCommands(
	target: string,
	env: NodeJS.ProcessEnv = process.env,
	metadata: {
		branch?: string | null;
		branchSlug?: string | null;
		project?: string | null;
		sessionId?: string | null;
		sessionStateFile?: string | null;
		version?: string | null;
	} = {},
	opts: { platform?: NodeJS.Platform; tmuxCommand?: string } = {},
): GjcTmuxProfileCommand[] {
	const commands = buildGjcTmuxRequiredProfileCommands(target, metadata);
	if (envDisabled(env[GJC_TMUX_PROFILE_ENV])) return commands;
	commands.push(
		{ description: "enable tmux clipboard integration", args: ["set-option", "-t", target, "set-clipboard", "on"] },
		{
			description: "make copy-mode selection readable",
			args: ["set-window-option", "-t", target, "mode-style", "fg=colour231,bg=colour60"],
		},
	);
	if (!envDisabled(env[GJC_TMUX_MOUSE_ENV]))
		commands.unshift({
			description: "enable tmux mouse scrolling",
			args: ["set-option", "-t", target, "mouse", "on"],
		});
	// psmux does not implement set-window-option and historically drops
	// mouse / set-clipboard / mode-style. Filter the UX profile commands
	// centrally so every code path that tags a session (gjc --tmux planning,
	// gjc session create, gjc team bootstrap) drops the same set. The
	// GJC_PSMUX_PROFILE_FORCE override lets the operator opt back in when
	// running on a psmux build that has caught up. The ownership-tag
	// round-trip (set-option @gjc-*) is never filtered, since gjc session /
	// gjc team rely on it.
	// The filter is opt-in: callers that explicitly pass `opts.tmuxCommand`
	// name a psmux-class multiplexer (psmux / pmux) when they want the UX
	// profile filtered. Auto-detect on Windows hosts where psmux happens
	// to be on PATH would silently change the test output for every caller
	// that does not pin the multiplexer, so we require the caller to opt
	// in by naming the multiplexer. GJC_PSMUX_PROFILE_FORCE re-enables
	// the UX profile commands when a psmux build catches up.
	const tmuxName = (opts.tmuxCommand ?? "").toLowerCase();
	const isPsmuxClass =
		tmuxName === "psmux" ||
		tmuxName === "pmux" ||
		tmuxName.endsWith("/psmux") ||
		tmuxName.endsWith("/pmux") ||
		tmuxName.endsWith("\\psmux") ||
		tmuxName.endsWith("\\pmux");
	const dropUx = isPsmuxClass && !envDisabled(env[GJC_PSMUX_PROFILE_FORCE_ENV]);
	if (dropUx) {
		return commands.filter(command => {
			const flag = command.args[0];
			const key = command.args[command.args.length - 2];
			return !(
				PSMUX_UNSUPPORTED_PROFILE_KEYS.has(String(key)) &&
				(flag === "set-option" || flag === "set-window-option")
			);
		});
	}
	return commands;
}

export function normalizeTmuxCreatedAt(raw: string): string {
	const seconds = Number.parseInt(raw, 10);
	if (!Number.isFinite(seconds) || seconds <= 0) return raw;
	return new Date(seconds * 1000).toISOString();
}
