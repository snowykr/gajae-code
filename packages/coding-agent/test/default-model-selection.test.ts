import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { Effort, getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { applyStartupModelProfiles } from "@gajae-code/coding-agent/main";
import type { RpcResponse } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import { dispatchRpcCommand } from "@gajae-code/coding-agent/modes/shared/agent-wire/command-dispatch";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";
import { YAML } from "bun";

describe("durable default model selection", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let modelRegistry: ModelRegistry | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@gjc-default-selection-");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		resetSettingsForTest();
		tempDir.removeSync();
	});

	function model(id: string) {
		const result = getBundledModel("anthropic", id);
		if (!result) throw new Error(`Expected bundled model anthropic/${id}`);
		return result;
	}

	async function createSession(settings: Settings, initializeDefault: boolean = true): Promise<AgentSession> {
		const initialModel = model("claude-sonnet-4-5");
		if (initializeDefault) {
			settings.setModelRole("default", `${initialModel.provider}/${initialModel.id}:high`);
		}
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setThinkingLevel(Effort.High);
		return session;
	}

	function requireModelRegistry(): ModelRegistry {
		if (!modelRegistry) throw new Error("Expected model registry");
		return modelRegistry;
	}

	it("persists and applies one canonical model/thinking tuple", async () => {
		const settings = Settings.isolated();
		const activeSession = await createSession(settings);
		const selected = model("claude-sonnet-4-6");

		const result = await activeSession.setDefaultModelSelection(selected, Effort.Low);

		expect(result).toEqual({
			provider: selected.provider,
			modelId: selected.id,
			thinkingLevel: Effort.Low,
			durability: "confirmed",
		});
		expect(activeSession.model).toEqual(selected);
		expect(activeSession.thinkingLevel).toBe(Effort.Low);
		expect(settings.getModelRole("default")).toBe(`${selected.provider}/${selected.id}:low`);
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Low);
	});

	it("publishes a coherent tuple with unknown durability after parent fsync fails", async () => {
		// Given
		const selected = model("claude-sonnet-4-6");
		const settings = await Settings.init({ cwd: tempDir.path(), agentDir: tempDir.path() });
		const activeSession = await createSession(settings);
		await settings.flushOrThrow();
		const realOpen = fs.promises.open;
		const openSpy = spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
			const handle = await realOpen(file, flags, mode);
			if (String(file) === tempDir.path()) {
				spyOn(handle, "sync").mockRejectedValue(new Error("forced parent fsync failure"));
			}
			return handle;
		});

		// When
		let result: RpcResponse;
		try {
			result = await dispatchRpcCommand(
				{
					id: "durability-fault",
					type: "set_default_model_selection",
					provider: selected.provider,
					modelId: selected.id,
					thinkingLevel: "off",
				},
				{
					session: activeSession,
					output: () => {},
					hostToolRegistry: { setTools: () => [] },
					hostUriRegistry: { setSchemes: () => [] },
					createUiContext: () => ({ notify: () => {} }),
				},
			);
		} finally {
			openSpy.mockRestore();
		}

		// Then
		expect(result).toEqual({
			id: "durability-fault",
			type: "response",
			command: "set_default_model_selection",
			success: true,
			data: {
				provider: selected.provider,
				modelId: selected.id,
				thinkingLevel: "off",
				durability: "unknown",
			},
		});
		expect(activeSession.model).toEqual(selected);
		expect(activeSession.thinkingLevel).toBe("off");
		resetSettingsForTest();
		const freshSettings = await Settings.init({ cwd: tempDir.path(), agentDir: tempDir.path() });
		expect(freshSettings.getModelRole("default")).toBe(`${selected.provider}/${selected.id}:off`);
		expect(freshSettings.get("defaultThinkingLevel")).toBe("off");
		expect((await fs.promises.readdir(tempDir.path())).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it("rejects a cwd-disallowed model before mutating live state", async () => {
		const initial = model("claude-sonnet-4-5");
		const selected = model("claude-sonnet-4-6");
		const settings = Settings.isolated({ enabledModels: [`${initial.provider}/${initial.id}`] });
		const activeSession = await createSession(settings);

		await expect(activeSession.setDefaultModelSelection(selected, Effort.Low)).rejects.toThrow(
			"Model unavailable for default selection",
		);
		expect(activeSession.model).toEqual(initial);
		expect(activeSession.thinkingLevel).toBe(Effort.High);
		expect(settings.getModelRole("default")).toBe(`${initial.provider}/${initial.id}:high`);
	});

	it("keeps live and durable defaults unchanged when the durable write fails", async () => {
		const initial = model("claude-sonnet-4-5");
		const selected = model("claude-sonnet-4-6");
		const settings = await Settings.init({ cwd: tempDir.path(), agentDir: tempDir.path() });
		const activeSession = await createSession(settings);
		await settings.flushOrThrow();
		const realOpen = fs.promises.open;
		const writeSpy = spyOn(fs.promises, "open").mockImplementation(async (file, flags, mode) => {
			if (String(file).endsWith(".tmp")) throw new Error("forced durable write failure");
			return realOpen(file, flags, mode);
		});

		try {
			await expect(activeSession.setDefaultModelSelection(selected, Effort.Low)).rejects.toThrow(
				"forced durable write failure",
			);
		} finally {
			writeSpy.mockRestore();
		}

		expect(activeSession.model).toEqual(initial);
		expect(activeSession.thinkingLevel).toBe(Effort.High);
		resetSettingsForTest();
		const freshSettings = await Settings.init({ cwd: tempDir.path(), agentDir: tempDir.path() });
		expect(freshSettings.getModelRole("default")).toBe(`${initial.provider}/${initial.id}:high`);
		expect(freshSettings.has("defaultThinkingLevel")).toBe(false);
	});

	it("publishes a coherent live tuple when the post-commit session append fails", async () => {
		const selected = model("claude-sonnet-4-6");
		const settings = await Settings.init({ cwd: tempDir.path(), agentDir: tempDir.path() });
		const activeSession = await createSession(settings);
		await settings.flushOrThrow();
		const appendSpy = spyOn(activeSession.sessionManager, "appendModelChange").mockImplementation(() => {
			throw new Error("forced session append failure");
		});

		try {
			await expect(activeSession.setDefaultModelSelection(selected, "off")).resolves.toEqual({
				provider: selected.provider,
				modelId: selected.id,
				thinkingLevel: "off",
				durability: "confirmed",
			});
		} finally {
			appendSpy.mockRestore();
		}

		expect(activeSession.model).toEqual(selected);
		expect(activeSession.thinkingLevel).toBe("off");
		resetSettingsForTest();
		const freshSettings = await Settings.init({ cwd: tempDir.path(), agentDir: tempDir.path() });
		expect(freshSettings.getModelRole("default")).toBe(`${selected.provider}/${selected.id}:off`);
		expect(freshSettings.get("defaultThinkingLevel")).toBe("off");
	});

	it("materializes an active model profile into durable settings", async () => {
		const selected = model("claude-sonnet-4-6");
		const settings = Settings.isolated();
		const activeSession = await createSession(settings);
		settings.set("modelProfile.default", "managed-profile");
		activeSession.setActiveModelProfile("managed-profile");

		await activeSession.setDefaultModelSelection(selected, "off");

		expect(settings.get("modelProfile.default")).toBeUndefined();
		expect(activeSession.getActiveModelProfile()).toBeUndefined();
		expect(settings.getModelRole("default")).toBe(`${selected.provider}/${selected.id}:off`);
	});

	it("materializes only trusted bindings from an active runtime profile", async () => {
		// Given
		const settings = Settings.isolated();
		settings.set("task.agentModelOverrides", { critic: "global/critic" });
		const activeSession = await createSession(settings);
		settings.override("task.agentModelOverrides", {
			executor: "profile/executor:medium",
			repositoryOnly: "repository/poison",
		});
		activeSession.setActiveModelProfile("codex-medium");
		const selected = model("claude-sonnet-4-6");

		// When
		await activeSession.setDefaultModelSelection(selected, Effort.Low);

		// Then
		expect(settings.get("task.agentModelOverrides")).toEqual({
			critic: "global/critic",
			executor: "profile/executor:medium",
		});
		expect(activeSession.getActiveModelProfile()).toBeUndefined();
	});

	it("rejects a project-owned default role without mutating session or global settings", async () => {
		// Given
		const projectDir = path.join(tempDir.path(), "project");
		const agentDir = path.join(tempDir.path(), "agent");
		await fs.promises.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.promises.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({
				modelRoles: { default: "anthropic/claude-sonnet-4-5:high", smol: "global/smol" },
				task: { agentModelOverrides: { critic: "global/critic" } },
			}),
		);
		await Bun.write(
			path.join(projectDir, ".gjc", "settings.json"),
			JSON.stringify({
				modelRoles: { default: "anthropic/claude-sonnet-4-5:high", smol: "repository/smol" },
				task: { agentModelOverrides: { executor: "repository/executor" } },
			}),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const activeSession = await createSession(settings, false);
		const selected = model("claude-sonnet-4-6");
		const globalBefore = await Bun.file(path.join(agentDir, "config.yml")).text();

		// When
		await expect(activeSession.setDefaultModelSelection(selected, Effort.Low)).rejects.toThrow(
			"project settings define authoritative defaults: modelRoles.default",
		);

		// Then
		expect(activeSession.model).toEqual(model("claude-sonnet-4-5"));
		expect(activeSession.thinkingLevel).toBe(Effort.High);
		expect(await Bun.file(path.join(agentDir, "config.yml")).text()).toBe(globalBefore);
		expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-5:high");
	});

	it("rejects a project-owned default profile that would override the tuple on same-project restart", async () => {
		// Given: normal startup applies the project-owned profile in this cwd.
		const projectDir = path.join(tempDir.path(), "project");
		const agentDir = path.join(tempDir.path(), "agent");
		await fs.promises.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.promises.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ modelRoles: { default: "anthropic/claude-sonnet-4-5:high" } }),
		);
		await Bun.write(
			path.join(projectDir, ".gjc", "settings.json"),
			JSON.stringify({ modelProfile: { default: "claude-opus" } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const activeSession = await createSession(settings, false);
		const startupRegistry = requireModelRegistry();
		const refreshSpy = spyOn(startupRegistry, "refresh").mockImplementation(async () => {});
		try {
			await applyStartupModelProfiles({
				session: activeSession,
				settings,
				modelRegistry: startupRegistry,
				parsedArgs: {},
			});
		} finally {
			refreshSpy.mockRestore();
		}
		expect(activeSession.model).toEqual(model("claude-opus-4-8"));
		const globalBefore = await Bun.file(path.join(agentDir, "config.yml")).text();

		// When: the durable command must not report success for a tuple the project will replace.
		await expect(activeSession.setDefaultModelSelection(model("claude-sonnet-4-6"), Effort.Low)).rejects.toThrow(
			"project settings define authoritative defaults: modelProfile.default",
		);

		// Then: no state changed, and a real same-cwd restart still applies the authoritative profile.
		expect(activeSession.model).toEqual(model("claude-opus-4-8"));
		expect(activeSession.thinkingLevel).toBe(Effort.XHigh);
		expect(activeSession.getActiveModelProfile()).toBe("claude-opus");
		expect(await Bun.file(path.join(agentDir, "config.yml")).text()).toBe(globalBefore);
		await activeSession.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		resetSettingsForTest();

		const restartedSettings = await Settings.init({ cwd: projectDir, agentDir });
		const restartedSession = await createSession(restartedSettings, false);
		const restartedRegistry = requireModelRegistry();
		const restartRefreshSpy = spyOn(restartedRegistry, "refresh").mockImplementation(async () => {});
		try {
			await applyStartupModelProfiles({
				session: restartedSession,
				settings: restartedSettings,
				modelRegistry: restartedRegistry,
				parsedArgs: {},
			});
		} finally {
			restartRefreshSpy.mockRestore();
		}
		expect(restartedSession.model).toEqual(model("claude-opus-4-8"));
		expect(restartedSession.thinkingLevel).toBe(Effort.XHigh);
	});
});
