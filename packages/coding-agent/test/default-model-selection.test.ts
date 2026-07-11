import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { Effort, getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
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
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		session.setThinkingLevel(Effort.High);
		return session;
	}

	it("persists one canonical global future-session tuple without changing the active session", async () => {
		const settings = Settings.isolated();
		const activeSession = await createSession(settings);
		const selected = model("claude-sonnet-4-6");
		const initial = model("claude-sonnet-4-5");

		const result = await activeSession.setDefaultModelSelection(selected, Effort.Low);

		expect(result).toEqual({
			provider: selected.provider,
			modelId: selected.id,
			thinkingLevel: Effort.Low,
			durability: "confirmed",
		});
		expect(settings.getGlobal("modelRoles")?.default).toBe(`${selected.provider}/${selected.id}:low`);
		expect(settings.getGlobal("defaultThinkingLevel")).toBe(Effort.Low);
		expect(activeSession.model).toEqual(initial);
		expect(activeSession.thinkingLevel).toBe(Effort.High);
	});

	it("returns unknown only after the renamed global tuple survives parent fsync failure", async () => {
		const selected = model("claude-sonnet-4-6");
		const initial = model("claude-sonnet-4-5");
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
		expect(activeSession.model).toEqual(initial);
		expect(activeSession.thinkingLevel).toBe(Effort.High);
		resetSettingsForTest();
		const freshSettings = await Settings.init({ cwd: tempDir.path(), agentDir: tempDir.path() });
		expect(freshSettings.getGlobal("modelRoles")?.default).toBe(`${selected.provider}/${selected.id}:off`);
		expect(freshSettings.getGlobal("defaultThinkingLevel")).toBe("off");
		expect((await fs.promises.readdir(tempDir.path())).filter(name => name.endsWith(".tmp"))).toEqual([]);
	});

	it("leaves global and active state unchanged when the pre-rename durable write fails", async () => {
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
		expect(freshSettings.getGlobal("modelRoles")?.default).toBe(`${initial.provider}/${initial.id}:high`);
		expect(freshSettings.has("defaultThinkingLevel")).toBe(false);
	});

	it("replaces only a persisted global default profile and preserves runtime bindings", async () => {
		const settings = Settings.isolated();
		settings.set("modelProfile.default", "codex-medium");
		settings.set("task.agentModelOverrides", { critic: "global/critic" });
		const activeSession = await createSession(settings);
		activeSession.setActiveModelProfile("codex-medium");
		settings.override("modelRoles", { default: "runtime/default" });
		settings.override("task.agentModelOverrides", { executor: "runtime/executor" });
		const selected = model("claude-sonnet-4-6");

		await activeSession.setDefaultModelSelection(selected, "off");

		expect(settings.getGlobal("modelProfile.default")).toBeUndefined();
		expect(settings.getGlobal("modelRoles")?.default).toBe(`${selected.provider}/${selected.id}:off`);
		expect(settings.getGlobal("task.agentModelOverrides")).toEqual({ critic: "global/critic" });
		expect(settings.get("modelRoles")).toEqual({ default: "runtime/default" });
		expect(settings.get("task.agentModelOverrides")).toEqual({
			critic: "global/critic",
			executor: "runtime/executor",
		});
		expect(activeSession.getActiveModelProfile()).toBe("codex-medium");
	});

	it("accepts a global write beneath a project overlay while an unoverridden cwd uses it", async () => {
		const projectDir = path.join(tempDir.path(), "project");
		const cleanDir = path.join(tempDir.path(), "clean");
		const agentDir = path.join(tempDir.path(), "agent");
		await fs.promises.mkdir(path.join(projectDir, ".gjc"), { recursive: true });
		await fs.promises.mkdir(cleanDir, { recursive: true });
		await fs.promises.mkdir(agentDir, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ modelRoles: { default: "anthropic/claude-sonnet-4-5:high" } }),
		);
		await Bun.write(
			path.join(projectDir, ".gjc", "settings.json"),
			JSON.stringify({ modelRoles: { default: "anthropic/claude-opus-4-8:xhigh" } }),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const activeSession = await createSession(settings, false);
		const selected = model("claude-sonnet-4-6");

		await activeSession.setDefaultModelSelection(selected, Effort.Low);

		expect(settings.getGlobal("modelRoles")?.default).toBe(`${selected.provider}/${selected.id}:low`);
		expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-8:xhigh");
		resetSettingsForTest();
		const cleanSettings = await Settings.init({ cwd: cleanDir, agentDir });
		expect(cleanSettings.getModelRole("default")).toBe(`${selected.provider}/${selected.id}:low`);
	});

	it("rejects unavailable models before changing the global candidate or active session", async () => {
		const initial = model("claude-sonnet-4-5");
		const selected = model("claude-sonnet-4-6");
		const settings = Settings.isolated({ enabledModels: [`${initial.provider}/${initial.id}`] });
		const activeSession = await createSession(settings);

		await expect(activeSession.setDefaultModelSelection(selected, Effort.Low)).rejects.toThrow(
			"Model unavailable for default selection",
		);
		expect(activeSession.model).toEqual(initial);
		expect(activeSession.thinkingLevel).toBe(Effort.High);
		expect(settings.getGlobal("modelRoles")?.default).toBe(`${initial.provider}/${initial.id}:high`);
	});
});
