import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@gajae-code/agent-core";
import { Effort, getBundledModel, type Model } from "@gajae-code/ai";
import { ModelRegistry } from "@gajae-code/coding-agent/config/model-registry";
import { Settings } from "@gajae-code/coding-agent/config/settings";
import { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import {
	buildSessionContext,
	type ModelChangeEntry,
	type SessionContext,
	type SessionEntry,
	SessionManager,
} from "@gajae-code/coding-agent/session/session-manager";
import { TempDir } from "@gajae-code/utils";

type ModelThinkingTuple = {
	readonly model: string;
	readonly thinkingLevel: string;
};

function bundledModel(id: string): Model {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected bundled model anthropic/${id}`);
	return model;
}

function expectTuple(context: SessionContext, expected: ModelThinkingTuple): void {
	expect({ model: context.models.default, thinkingLevel: context.thinkingLevel }).toEqual(expected);
}

describe("default model session tuple", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@gjc-model-session-tuple-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(settings: Settings = Settings.isolated()): AgentSession {
		const initialModel = bundledModel("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.High,
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			thinkingLevel: Effort.High,
		});
		return session;
	}

	it("persists a future-session default without changing session context, entries, or JSONL", async () => {
		const activeSession = createSession();
		const selected = bundledModel("claude-sonnet-4-6");
		await activeSession.sessionManager.ensureOnDisk();
		const sessionFile = activeSession.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const contextBefore = activeSession.sessionManager.buildSessionContext();
		const entriesBefore = activeSession.sessionManager.getEntries();
		const jsonlBefore = await Bun.file(sessionFile).text();
		const modelBefore = activeSession.model;
		const thinkingBefore = activeSession.thinkingLevel;

		await activeSession.setDefaultModelSelection(selected, Effort.Low);
		await activeSession.sessionManager.flush();

		expect(activeSession.model).toEqual(modelBefore);
		expect(activeSession.thinkingLevel).toBe(thinkingBefore);
		expect(activeSession.sessionManager.buildSessionContext()).toEqual(contextBefore);
		expect(activeSession.sessionManager.getEntries()).toEqual(entriesBefore);
		expect(await Bun.file(sessionFile).text()).toBe(jsonlBefore);
	});

	it("restores a legacy entry with a separate thinking-level change", () => {
		const entries: SessionEntry[] = [
			{
				type: "thinking_level_change",
				id: "thinking",
				parentId: null,
				timestamp: "2026-07-10T00:00:00.000Z",
				thinkingLevel: Effort.High,
			},
			{
				type: "model_change",
				id: "model",
				parentId: "thinking",
				timestamp: "2026-07-10T00:00:01.000Z",
				model: "anthropic/legacy-model",
				role: "default",
			} satisfies ModelChangeEntry,
		];

		expectTuple(buildSessionContext(entries), { model: "anthropic/legacy-model", thinkingLevel: Effort.High });
	});

	it("restores atomic tuple thinking when switching to another persisted session", async () => {
		const selected = bundledModel("claude-sonnet-4-6");
		const target = SessionManager.create(tempDir.path(), tempDir.path());
		target.appendModelChange(`${selected.provider}/${selected.id}`, "default", {
			thinkingLevel: Effort.Low,
		});
		await target.ensureOnDisk();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected target session file");
		await target.close();
		const activeSession = createSession(Settings.isolated({ defaultThinkingLevel: Effort.High }));

		await activeSession.switchSession(targetFile);

		expect(activeSession.model).toEqual(selected);
		expect(activeSession.thinkingLevel).toBe(Effort.Low);
	});

	it("preserves set_model durable default-role setter semantics", async () => {
		const settings = Settings.isolated();
		const activeSession = createSession(settings);
		const selected = bundledModel("claude-sonnet-4-6");

		await activeSession.setModel(selected);

		expect(settings.getModelRole("default")).toBe(`${selected.provider}/${selected.id}`);
		expect(activeSession.sessionManager.buildSessionContext().models.default).toBe(
			`${selected.provider}/${selected.id}`,
		);
	});

	it("preserves set_thinking_level session-only setter semantics", () => {
		const settings = Settings.isolated({ defaultThinkingLevel: Effort.High });
		const activeSession = createSession(settings);

		activeSession.setThinkingLevel(Effort.Low);

		expect(activeSession.sessionManager.buildSessionContext().thinkingLevel).toBe(Effort.Low);
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.High);
	});
});
