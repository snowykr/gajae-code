import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StrictHeldSessionCapability } from "../session/session-storage";
import { closeStrictHeldSessionCapability, strictHeldSessionId } from "../session/session-storage";

const strictHeldProtocolGrants = new WeakSet<object>();
const strictHeldProtocolGrantData = new WeakMap<object, StrictHeldSessionCapability>();

declare const strictHeldProtocolGrantBrand: unique symbol;
export interface StrictHeldProtocolAuthorization {
	readonly [strictHeldProtocolGrantBrand]: true;
}

function mintStrictHeldProtocolAuthorization(capability: StrictHeldSessionCapability): StrictHeldProtocolAuthorization {
	const grant = {};
	strictHeldProtocolGrants.add(grant);
	strictHeldProtocolGrantData.set(grant, capability);
	return grant as StrictHeldProtocolAuthorization;
}

export function consumeStrictHeldProtocolAuthorization(
	authorization: StrictHeldProtocolAuthorization,
): StrictHeldSessionCapability {
	if (!strictHeldProtocolGrants.has(authorization)) throw new Error("Invalid strict held protocol authorization");
	strictHeldProtocolGrants.delete(authorization);
	const capability = strictHeldProtocolGrantData.get(authorization);
	if (!capability) throw new Error("Strict held protocol authorization was already consumed");
	strictHeldProtocolGrantData.delete(authorization);
	return capability;
}

export const TMUX_RESTART_PROTOCOL_VERSION = 1;
export const MAX_RECORD_BYTES = 16_384;
const MAX_PATH_BYTES = 4_096;
const MAX_SERVER_AUTHORITY_BYTES = 256;
const NONCE_RE = /^[0-9a-f]{64}$/;
const PID_RE = /^[1-9][0-9]{0,9}$/;
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const LINUX_ID_RE = /^linux:(0|[1-9][0-9]{0,19})$/;
const DARWIN_ID_RE = /^darwin:(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19})$/;

export type RestartState = "held" | "open" | "release";
export type PlatformProcessIdentity = {
	platform: "linux" | "darwin" | "win32";
	value: string;
};
export type RestartManifest = {
	schemaVersion: 1;
	kind: "manifest";
	state: "held";
	nonce: string;
	sessionPath: string;
	manifestPath: string;
	pid: string;
	processIdentity: PlatformProcessIdentity;
	createdAtMs: number;
	expiresAtMs: number;
	sessionId: string;
	serverAuthority: string;
};
export type RestartOpen = Omit<RestartManifest, "kind" | "state"> & {
	kind: "open";
	state: "open";
};
export type RestartRelease = Omit<RestartManifest, "kind" | "state"> & {
	kind: "release";
	state: "release";
};
export type RestartRecord = RestartManifest | RestartOpen | RestartRelease;

export class RestartProtocolError extends Error {
	readonly code = "restart_protocol_invalid";
}

function fail(message: string): never {
	throw new RestartProtocolError(`tmux restart protocol rejected: ${message}`);
}

function absoluteNormalized(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail(`${field} must be a path`);
	const resolved = path.resolve(value);
	if (resolved !== value || path.normalize(value) !== value) fail(`${field} must be absolute and normalized`);
	if (Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES) fail(`${field} is oversized`);
	return value;
}

function finiteTime(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail(`${field} is invalid`);
	return value;
}

function identity(value: unknown): PlatformProcessIdentity {
	if (typeof value !== "object" || value === null) fail("processIdentity is missing");
	const item = value as Record<string, unknown>;
	const platform = item.platform;
	if (platform !== "linux" && platform !== "darwin") fail("process identity platform is invalid");
	if (platform !== process.platform) fail("cross-platform process identity");
	if (typeof item.value !== "string") fail("process identity is invalid");
	if (platform === "linux" && (!LINUX_ID_RE.test(item.value) || !U64_RE.test(item.value.slice(6))))
		fail("process identity is invalid");
	if (
		platform === "darwin" &&
		(!DARWIN_ID_RE.test(item.value) ||
			item.value
				.split(":")
				.slice(1)
				.some(component => !U64_RE.test(component)))
	)
		fail("process identity is invalid");
	const components = item.value.split(":").slice(1);
	if (components.some(component => BigInt(component) > 18_446_744_073_709_551_615n))
		fail("process identity is out of range");
	return { platform, value: item.value };
}

export function parseRestartRecord(raw: string, expectedKind?: RestartRecord["kind"]): RestartRecord {
	if (Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) fail("record is oversized");
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		fail("record is not JSON");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) fail("record must be an object");
	const item = value as Record<string, unknown>;
	if (item.schemaVersion !== 1 || (item.kind !== "manifest" && item.kind !== "open" && item.kind !== "release"))
		fail("schema or kind is invalid");
	if (Object.keys(item).some(key => key.endsWith("StartTicks")))
		fail("legacy process start-ticks fields are forbidden");
	if (expectedKind && item.kind !== expectedKind) fail("unexpected record kind");
	if (item.state !== (item.kind === "manifest" ? "held" : item.kind)) fail("state is invalid");
	if (typeof item.serverAuthority !== "string" || item.serverAuthority.length === 0)
		fail("serverAuthority is invalid");
	if (Buffer.byteLength(item.serverAuthority, "utf8") > MAX_SERVER_AUTHORITY_BYTES)
		fail("serverAuthority is oversized");
	if (typeof item.sessionId !== "string" || item.sessionId.length === 0) fail("sessionId is invalid");
	if (typeof item.nonce !== "string" || !NONCE_RE.test(item.nonce)) fail("nonce is invalid");
	const sessionPath = absoluteNormalized(item.sessionPath, "sessionPath");
	const manifestPath = absoluteNormalized(item.manifestPath, "manifestPath");
	if (typeof item.pid !== "string" || !PID_RE.test(item.pid)) fail("pid is invalid");
	const result = {
		...item,
		schemaVersion: 1 as const,
		kind: item.kind,
		state: item.state,
		nonce: item.nonce,
		sessionPath,
		manifestPath,
		pid: item.pid,
		processIdentity: identity(item.processIdentity),
		createdAtMs: finiteTime(item.createdAtMs, "createdAtMs"),
		expiresAtMs: finiteTime(item.expiresAtMs, "expiresAtMs"),
		sessionId: item.sessionId,
		serverAuthority: item.serverAuthority,
	};
	if (result.expiresAtMs <= result.createdAtMs) fail("record expiry is invalid");
	return result as RestartRecord;
}

export async function readRestartRecord(
	filePath: string,
	expectedKind?: RestartRecord["kind"],
): Promise<RestartRecord> {
	const normalized = absoluteNormalized(filePath, "record path");
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(normalized, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) fail("record is not a bounded regular file");
		const raw = await handle.readFile({ encoding: "utf8" });
		return parseRestartRecord(raw, expectedKind);
	} catch (error) {
		if (error instanceof RestartProtocolError) throw error;
		return fail("record cannot be read safely");
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

export async function publishRestartRecord(filePath: string, record: RestartRecord): Promise<void> {
	const normalized = absoluteNormalized(filePath, "record path");
	const checked = parseRestartRecord(JSON.stringify(record), record.kind);
	const bytes = Buffer.from(`${JSON.stringify(checked)}\n`, "utf8");
	if (bytes.byteLength > MAX_RECORD_BYTES) fail("record is oversized");
	const temporaryPath = path.join(
		path.dirname(normalized),
		`.${path.basename(normalized)}.tmp-${crypto.randomUUID()}`,
	);
	let handle: fs.FileHandle | undefined;
	let temporaryCreated = false;
	try {
		handle = await fs.open(
			temporaryPath,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
			0o600,
		);
		temporaryCreated = true;
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.link(temporaryPath, normalized);
		await fs.unlink(temporaryPath);
		await fsyncDirectory(path.dirname(normalized));
	} catch {
		fail("record was not published without clobbering");
	} finally {
		await handle?.close().catch(() => undefined);
		if (temporaryCreated) await fs.unlink(temporaryPath).catch(() => undefined);
	}
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
	const handle = await fs.open(directoryPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
	try {
		await handle.sync();
	} finally {
		await handle.close().catch(() => undefined);
	}
}
export async function publishRestartRelease(manifestPath: string, release: RestartRelease): Promise<void> {
	const normalized = absoluteNormalized(manifestPath, "manifest path");
	await publishRestartRecord(`${normalized}.release`, release);
}

export type HeldResumeBootstrapOptions = {
	env?: NodeJS.ProcessEnv;
	readRecord?: typeof readRestartRecord;
	publishRecord?: typeof publishRestartRecord;
	waitForRelease?: (path: string, nonce: string) => Promise<RestartRelease>;
	pinSession?: (sessionPath: string) => StrictHeldSessionCapability;
};

export async function validateStrictHeldResumeEnvironment(
	sessionPath: string,
	options: HeldResumeBootstrapOptions = {},
): Promise<RestartOpen & { authorization: StrictHeldProtocolAuthorization }> {
	const env = options.env ?? process.env;
	if (env.GJC_TMUX_RESTART_HELD !== "1" || !env.GJC_TMUX_RESTART_MANIFEST || !env.GJC_TMUX_RESTART_NONCE)
		fail("held environment controls are incomplete");
	const normalizedSession = absoluteNormalized(sessionPath, "sessionPath");
	const manifestPath = absoluteNormalized(env.GJC_TMUX_RESTART_MANIFEST, "manifest path");
	if (!NONCE_RE.test(env.GJC_TMUX_RESTART_NONCE)) fail("nonce is invalid");
	const read = options.readRecord ?? readRestartRecord;
	const pinSession = options.pinSession;
	if (!pinSession) fail("strict held resume requires a pinned session descriptor");
	let pinned: StrictHeldSessionCapability | undefined;
	try {
		pinned = pinSession(normalizedSession);
		const pinnedSessionId = strictHeldSessionId(pinned);
		const manifest = (await read(manifestPath, "manifest")) as RestartManifest;
		if (
			manifest.nonce !== env.GJC_TMUX_RESTART_NONCE ||
			manifest.sessionPath !== normalizedSession ||
			manifest.manifestPath !== manifestPath ||
			!manifest.sessionId ||
			manifest.sessionId !== pinnedSessionId
		)
			fail("manifest does not match held controls");
		if (manifest.expiresAtMs < Date.now()) fail("manifest is expired");
		const open: RestartOpen = { ...manifest, kind: "open", state: "open" };
		const publish = options.publishRecord ?? publishRestartRecord;
		const openPath = `${manifestPath}.open`;
		await publish(openPath, open);
		const releasePath = `${manifestPath}.release`;
		let release: RestartRelease;
		if (options.waitForRelease) {
			release = await options.waitForRelease(releasePath, manifest.nonce);
		} else {
			for (;;) {
				if (Date.now() > manifest.expiresAtMs) fail("release was not received before manifest expiry");
				try {
					release = (await read(releasePath, "release")) as RestartRelease;
					break;
				} catch {
					await Bun.sleep(Math.min(100, Math.max(1, manifest.expiresAtMs - Date.now())));
				}
			}
		}
		if (
			release.nonce !== manifest.nonce ||
			release.sessionPath !== manifest.sessionPath ||
			release.manifestPath !== manifest.manifestPath ||
			release.sessionId !== manifest.sessionId ||
			release.serverAuthority !== manifest.serverAuthority ||
			release.createdAtMs !== manifest.createdAtMs ||
			release.expiresAtMs !== manifest.expiresAtMs ||
			release.pid !== manifest.pid ||
			release.processIdentity.platform !== manifest.processIdentity.platform ||
			release.processIdentity.value !== manifest.processIdentity.value
		)
			fail("release does not match held child identity");
		if (release.expiresAtMs < Date.now()) fail("release arrived after manifest expiry");
		return { ...open, authorization: mintStrictHeldProtocolAuthorization(pinned) };
	} catch (error) {
		if (pinned) await closeStrictHeldSessionCapability(pinned).catch(() => undefined);
		throw error;
	}
}
