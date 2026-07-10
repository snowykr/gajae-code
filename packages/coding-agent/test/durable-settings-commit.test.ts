import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { YAML } from "bun";

describe("durable settings commits", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;
	let configPath: string;

	beforeEach(() => {
		resetSettingsForTest();
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "gjc-durable-settings-"));
		agentDir = path.join(testDir, "agent");
		projectDir = path.join(testDir, "project");
		configPath = path.join(agentDir, "config.yml");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		resetSettingsForTest();
		fs.rmSync(testDir, { recursive: true, force: true });
	});

	async function initialize(): Promise<Settings> {
		return Settings.init({ cwd: projectDir, agentDir });
	}

	async function seed(raw: string): Promise<void> {
		await fs.promises.writeFile(configPath, raw, { mode: 0o600 });
	}

	it("fails closed when durable settings YAML is malformed", async () => {
		// Given
		await seed("theme: [unterminated\n");

		// When / Then
		await expect(initialize()).rejects.toThrow();
	});

	it("fails closed when durable settings cannot be read", async () => {
		// Given
		await fs.promises.mkdir(configPath);

		// When / Then
		await expect(initialize()).rejects.toThrow();
	});

	it("fails closed when durable settings have a non-object root", async () => {
		// Given
		await seed("- one\n- two\n");

		// When / Then
		await expect(initialize()).rejects.toThrow();
	});

	it("preserves credentials and unknown keys in a durable replacement", async () => {
		// Given
		await seed(YAML.stringify({ credentials: { token: "secret" }, extensionState: { enabled: true } }, null, 2));
		const settings = await initialize();

		// When
		await settings.commitDurable({ defaultThinkingLevel: "low" });

		// Then
		const persisted: unknown = YAML.parse(await fs.promises.readFile(configPath, "utf8"));
		expect(persisted).toMatchObject({ credentials: { token: "secret" }, extensionState: { enabled: true } });
	});

	it("creates the temporary file exclusively with mode 0600", async () => {
		// Given
		await seed("theme:\n  dark: red-claw\n");
		const settings = await initialize();
		const realOpen = fs.promises.open;
		const tempOpenCalls: Array<{ flags: string | number | undefined; mode: fs.Mode | undefined }> = [];
		const openSpy = spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
			if (String(file).endsWith(".tmp")) tempOpenCalls.push({ flags, mode });
			return realOpen(file, flags, mode);
		});

		// When
		try {
			await settings.commitDurable({ defaultThinkingLevel: "low" });
		} finally {
			openSpy.mockRestore();
		}

		// Then
		expect(tempOpenCalls).toEqual([{ flags: "wx", mode: 0o600 }]);
		expect((await fs.promises.stat(configPath)).mode & 0o777).toBe(0o600);
	});

	it("reports confirmed after file-fsync, rename, and parent-fsync", async () => {
		// Given
		await seed("theme:\n  dark: red-claw\n");
		const settings = await initialize();
		const events: string[] = [];
		const realOpen = fs.promises.open;
		const realRename = fs.promises.rename.bind(fs.promises);
		const openSpy = spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await realOpen(file, flags, mode);
			if (String(file).endsWith(".tmp")) {
				const realSync = handle.sync.bind(handle);
				spyOn(handle, "sync").mockImplementation(async () => {
					events.push("file-fsync");
					await realSync();
				});
			} else if (String(file) === agentDir) {
				const realSync = handle.sync.bind(handle);
				spyOn(handle, "sync").mockImplementation(async () => {
					events.push("parent-fsync");
					await realSync();
				});
			}
			return handle;
		});
		const renameSpy = spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
			events.push("rename");
			await realRename(source, target);
		});

		// When
		let outcome: unknown;
		try {
			outcome = await settings.commitDurable({ defaultThinkingLevel: "low" });
		} finally {
			openSpy.mockRestore();
			renameSpy.mockRestore();
		}

		// Then
		expect(events).toEqual(["file-fsync", "rename", "parent-fsync"]);
		expect(outcome).toEqual({ durability: "confirmed" });
	});

	it("keeps confirmed durability when closing a synced parent handle fails", async () => {
		// Given
		await seed("theme:\n  dark: red-claw\n");
		const settings = await initialize();
		const realOpen = fs.promises.open;
		const openSpy = spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await realOpen(file, flags, mode);
			if (String(file) === agentDir) {
				const realClose = handle.close.bind(handle);
				spyOn(handle, "close").mockImplementation(async () => {
					await realClose();
					throw new Error("forced parent close failure");
				});
			}
			return handle;
		});

		// When
		let outcome: unknown;
		try {
			outcome = await settings.commitDurable({ defaultThinkingLevel: "low" });
		} finally {
			openSpy.mockRestore();
		}

		// Then
		expect(outcome).toEqual({ durability: "confirmed" });
	});

	it("does not follow a hostile temporary-file symlink", async () => {
		// Given
		await seed("theme:\n  dark: red-claw\n");
		const settings = await initialize();
		const victimPath = path.join(testDir, "victim.txt");
		await fs.promises.writeFile(victimPath, "untouched");
		const realOpen = fs.promises.open;
		const openSpy = spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
			if (String(file).endsWith(".tmp")) await fs.promises.symlink(victimPath, file);
			return realOpen(file, flags, mode);
		});

		// When / Then
		try {
			await expect(settings.commitDurable({ defaultThinkingLevel: "low" })).rejects.toThrow();
		} finally {
			openSpy.mockRestore();
		}
		expect(await fs.promises.readFile(victimPath, "utf8")).toBe("untouched");
	});

	it("cleans the temporary file on every pre-rename failure", async () => {
		// Given
		await seed("theme:\n  dark: red-claw\n");
		const original = await fs.promises.readFile(configPath, "utf8");
		const settings = await initialize();
		const realOpen = fs.promises.open;
		const openSpy = spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await realOpen(file, flags, mode);
			if (String(file).endsWith(".tmp")) {
				spyOn(handle, "sync").mockRejectedValue(new Error("forced file fsync failure"));
			}
			return handle;
		});

		// When / Then
		try {
			await expect(settings.commitDurable({ defaultThinkingLevel: "low" })).rejects.toThrow(
				"forced file fsync failure",
			);
		} finally {
			openSpy.mockRestore();
		}
		expect((await fs.promises.readdir(agentDir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
		expect(await fs.promises.readFile(configPath, "utf8")).toBe(original);
	});

	it("reports unknown after rename when parent fsync persistently fails", async () => {
		// Given
		await seed("theme:\n  dark: red-claw\n");
		const settings = await initialize();
		const realOpen = fs.promises.open;
		let parentFsyncAttempts = 0;
		const openSpy = spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await realOpen(file, flags, mode);
			if (String(file) === agentDir) {
				spyOn(handle, "sync").mockImplementation(async () => {
					parentFsyncAttempts += 1;
					throw new Error("forced parent fsync failure");
				});
			}
			return handle;
		});

		// When / Then
		let outcome: unknown;
		try {
			outcome = await settings.commitDurable({
				defaultThinkingLevel: "low",
				modelRoles: { default: "anthropic/claude-sonnet-4-6:low" },
			});
		} finally {
			openSpy.mockRestore();
		}
		expect(outcome).toEqual({ durability: "unknown" });
		expect(parentFsyncAttempts).toBeGreaterThan(0);
		const persisted: unknown = YAML.parse(await fs.promises.readFile(configPath, "utf8"));
		expect(persisted).toMatchObject({
			defaultThinkingLevel: "low",
			modelRoles: { default: "anthropic/claude-sonnet-4-6:low" },
		});
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Low);
		expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-6:low");
		expect((await fs.promises.readdir(agentDir)).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});
});
