import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@gajae-code/agent-core";
import { Effort, type Model } from "@gajae-code/ai";
import { AssistantMessageEventStream } from "@gajae-code/ai/utils/event-stream";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import { SessionManager } from "@gajae-code/coding-agent/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const INITIAL_MODEL: Model = {
	id: "initial",
	name: "Initial",
	api: "anthropic-messages",
	provider: "initial-provider",
	baseUrl: "https://example.invalid",
	reasoning: true,
	thinking: { mode: "effort", minLevel: Effort.Low, maxLevel: Effort.High },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8_192,
	maxTokens: 2_048,
};

function targetModel(options?: { reasoning?: boolean; minLevel?: Effort; maxLevel?: Effort }): Model {
	return {
		...INITIAL_MODEL,
		id: options?.reasoning === false ? "plain" : "reasoning",
		name: "Target",
		provider: "target-provider",
		reasoning: options?.reasoning ?? true,
		thinking:
			options?.reasoning === false
				? undefined
				: { mode: "effort", minLevel: options?.minLevel ?? Effort.Low, maxLevel: options?.maxLevel ?? Effort.High },
	};
}

describe("AgentSession durable default model selection", () => {
	let tempRoot: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let settings: Settings;
	let activeStream: AssistantMessageEventStream | undefined;
	let streamCreated: PromiseWithResolvers<void>;

	beforeEach(async () => {
		streamCreated = Promise.withResolvers<void>();
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-default-model-session-"));
		authStorage = await AuthStorage.create(path.join(tempRoot, "auth.db"));
		authStorage.setRuntimeApiKey(INITIAL_MODEL.provider, "initial-key");
		authStorage.setRuntimeApiKey("target-provider", "target-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempRoot, "models.yml"));
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: INITIAL_MODEL, systemPrompt: ["Test"], tools: [] },
			streamFn: () => {
				activeStream = new AssistantMessageEventStream();
				streamCreated.resolve();
				return activeStream;
			},
		});
		sessionManager = SessionManager.inMemory(tempRoot);
		settings = Settings.isolated({ defaultThinkingLevel: Effort.XHigh });
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			thinkingLevel: Effort.Low,
		});
		sessionManager.appendMessage({ role: "user", content: "existing transcript", timestamp: Date.now() });
	});

	afterEach(async () => {
		if (activeStream) {
			const message = createAssistantMessage("released during cleanup");
			activeStream.push({ type: "done", reason: "stop", message });
			activeStream.end(message);
			activeStream = undefined;
		}
		await session.dispose();
		authStorage.close();
		vi.restoreAllMocks();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("waits for an in-flight response before any durable or session mutation", async () => {
		// Given
		const model = targetModel({ minLevel: Effort.Medium, maxLevel: Effort.High });
		const preflightComplete = Promise.withResolvers<void>();
		const originalGetApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (...args) => {
			const apiKey = await originalGetApiKey(...args);
			preflightComplete.resolve();
			return apiKey;
		});
		const prompt = session.prompt("in flight");
		await streamCreated.promise;
		const entriesBeforeSelection = sessionManager.getEntries();
		const idleBarrierEntered = Promise.withResolvers<"idle">();
		const originalWaitForIdle = session.waitForIdle.bind(session);
		vi.spyOn(session, "waitForIdle").mockImplementation(async () => {
			idleBarrierEntered.resolve("idle");
			await originalWaitForIdle();
		});
		const durableAttempted = Promise.withResolvers<"durable">();
		const originalDurableCommit = settings.setGlobalModelRoleAndFlush.bind(settings);
		const durableCommit = vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockImplementation(async (...args) => {
			durableAttempted.resolve("durable");
			await originalDurableCommit(...args);
		});

		// When
		const selection = session.setDefaultModelSelection(model, Effort.XHigh);
		await preflightComplete.promise;
		const firstMutationBoundary = await Promise.race([idleBarrierEntered.promise, durableAttempted.promise]);
		const durableCallsBeforeIdle = durableCommit.mock.calls.length;
		const modelBeforeIdle = session.model;
		const entriesWhileStreaming = sessionManager.getEntries();

		// Then
		const message = createAssistantMessage("complete");
		activeStream?.push({ type: "done", reason: "stop", message });
		activeStream?.end(message);
		activeStream = undefined;
		await prompt;
		const result = await selection;
		expect(firstMutationBoundary).toBe("idle");
		expect(durableCallsBeforeIdle).toBe(0);
		expect(modelBeforeIdle).toBe(INITIAL_MODEL);
		expect(entriesWhileStreaming).toEqual(entriesBeforeSelection);
		expect(result).toEqual({
			provider: "target-provider",
			modelId: "reasoning",
			thinkingLevel: Effort.High,
		});
		expect(session.model).toBe(model);
		expect(session.thinkingLevel).toBe(Effort.High);
		const entriesAfterSelection = sessionManager.getEntries();
		expect(entriesAfterSelection.slice(0, entriesBeforeSelection.length)).toEqual(entriesBeforeSelection);
		expect(entriesAfterSelection.filter(entry => entry.type === "model_change" && entry.role === "default")).toEqual([
			expect.objectContaining({ model: "target-provider/reasoning" }),
		]);
		expect(entriesAfterSelection.filter(entry => entry.type === "thinking_level_change")).toEqual([
			expect.objectContaining({ thinkingLevel: Effort.High }),
		]);
		const completedAssistantIndex = entriesAfterSelection.findIndex(
			(entry, index) =>
				index >= entriesBeforeSelection.length && entry.type === "message" && entry.message.role === "assistant",
		);
		const defaultModelMarkerIndex = entriesAfterSelection.findIndex(
			entry => entry.type === "model_change" && entry.role === "default",
		);
		const thinkingMarkerIndex = entriesAfterSelection.findIndex(entry => entry.type === "thinking_level_change");
		expect(completedAssistantIndex).toBeGreaterThanOrEqual(entriesBeforeSelection.length);
		expect(defaultModelMarkerIndex).toBeGreaterThan(completedAssistantIndex);
		expect(thinkingMarkerIndex).toBeGreaterThan(defaultModelMarkerIndex);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/reasoning:high" });
	});

	it("preserves explicit off for a reasoning model", async () => {
		// Given
		const model = targetModel();
		session.setThinkingLevel(ThinkingLevel.Off);
		const entriesBeforeSelection = sessionManager.getEntries();

		// When
		const result = await session.setDefaultModelSelection(model, ThinkingLevel.Off);

		// Then
		expect(result.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(session.model).toBe(model);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Off);
		const selectionEntries = sessionManager.getEntries().slice(entriesBeforeSelection.length);
		expect(selectionEntries.filter(entry => entry.type === "model_change" && entry.role === "default")).toEqual([
			expect.objectContaining({ model: "target-provider/reasoning" }),
		]);
		expect(selectionEntries.filter(entry => entry.type === "thinking_level_change")).toEqual([]);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/reasoning:off" });
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.XHigh);
	});

	it("normalizes an unspecified level to off for a non-reasoning model", async () => {
		// Given
		const model = targetModel({ reasoning: false });

		// When
		const result = await session.setDefaultModelSelection(model, undefined);

		// Then
		expect(result.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(session.model).toBe(model);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Off);
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/plain:off" });
	});

	it("rejects inherit before settings or session mutation", async () => {
		// Given
		const entriesBefore = sessionManager.getEntries();

		// When
		const selection = session.setDefaultModelSelection(targetModel(), ThinkingLevel.Inherit);

		// Then
		await expect(selection).rejects.toThrow(/inherit/i);
		expect(settings.getGlobal("modelRoles")).toBeUndefined();
		expect(session.model).toBe(INITIAL_MODEL);
		expect(sessionManager.getEntries()).toEqual(entriesBefore);
	});

	it("rejects missing credentials before waiting or mutation", async () => {
		// Given
		const waitForIdle = vi.spyOn(session, "waitForIdle");
		const entriesBefore = sessionManager.getEntries();
		const model = { ...targetModel(), provider: "missing-provider" };

		// When
		const selection = session.setDefaultModelSelection(model, Effort.Medium);

		// Then
		await expect(selection).rejects.toThrow("No API key for missing-provider/reasoning");
		expect(waitForIdle).not.toHaveBeenCalled();
		expect(settings.getGlobal("modelRoles")).toBeUndefined();
		expect(sessionManager.getEntries()).toEqual(entriesBefore);
	});

	it("does not apply the live selection when the durable commit fails", async () => {
		// Given
		vi.spyOn(settings, "setGlobalModelRoleAndFlush").mockRejectedValue(new Error("durable write failed"));
		const liveApply = vi.spyOn(session, "setModelTemporary");

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.Medium);

		// Then
		await expect(selection).rejects.toThrow("durable write failed");
		expect(liveApply).not.toHaveBeenCalled();
		expect(session.model).toBe(INITIAL_MODEL);
	});

	it("keeps the durable selector and rejects when post-commit live apply fails", async () => {
		// Given
		vi.spyOn(session, "setModelTemporary").mockRejectedValue(new Error("live apply failed"));

		// When
		const selection = session.setDefaultModelSelection(targetModel(), Effort.High);

		// Then
		await expect(selection).rejects.toThrow("live apply failed");
		expect(settings.getGlobal("modelRoles")).toEqual({ default: "target-provider/reasoning:high" });
		expect(session.model).toBe(INITIAL_MODEL);
	});
});
