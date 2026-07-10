import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { Effort, getBundledModel } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

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

	async function createSession(settings: Settings): Promise<AgentSession> {
		const initialModel = model("claude-sonnet-4-5");
		settings.setModelRole("default", `${initialModel.provider}/${initialModel.id}:high`);
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
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.setThinkingLevel(Effort.High);
		return session;
	}

	it("persists and applies one canonical model/thinking tuple", async () => {
		const settings = Settings.isolated();
		const activeSession = await createSession(settings);
		const selected = model("claude-sonnet-4-6");

		const result = await activeSession.setDefaultModelSelection(selected, Effort.Low);

		expect(result).toEqual({ provider: selected.provider, modelId: selected.id, thinkingLevel: Effort.Low });
		expect(activeSession.model).toEqual(selected);
		expect(activeSession.thinkingLevel).toBe(Effort.Low);
		expect(settings.getModelRole("default")).toBe(`${selected.provider}/${selected.id}:low`);
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.Low);
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
		const writeSpy = spyOn(Bun, "write").mockImplementation(async () => {
			throw new Error("forced durable write failure");
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
});
