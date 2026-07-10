import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
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

	async function recordOldTuple(activeSession: AgentSession): Promise<ModelThinkingTuple> {
		const oldModel = bundledModel("claude-sonnet-4-5");
		await activeSession.setDefaultModelSelection(oldModel, Effort.High);
		await activeSession.sessionManager.ensureOnDisk();
		return { model: `${oldModel.provider}/${oldModel.id}`, thinkingLevel: Effort.High };
	}

	it("persists default model and thinking as a single tuple", async () => {
		// Given
		const activeSession = createSession();
		const selected = bundledModel("claude-sonnet-4-6");
		const entryCount = activeSession.sessionManager.getEntries().length;

		// When
		await activeSession.setDefaultModelSelection(selected, Effort.Low);

		// Then
		const appended = activeSession.sessionManager.getEntries().slice(entryCount);
		expect(appended).toHaveLength(1);
		const tupleEntry = appended[0];
		if (tupleEntry?.type !== "model_change") throw new Error("Expected one model_change tuple entry");
		expect(tupleEntry).toMatchObject({
			model: `${selected.provider}/${selected.id}`,
			role: "default",
			thinkingLevel: Effort.Low,
		});
		expectTuple(activeSession.sessionManager.buildSessionContext(), {
			model: `${selected.provider}/${selected.id}`,
			thinkingLevel: Effort.Low,
		});
	});

	it("keeps the old complete tuple in the same session when tuple append failure occurs", async () => {
		// Given
		const activeSession = createSession();
		const oldTuple = await recordOldTuple(activeSession);
		const selected = bundledModel("claude-sonnet-4-6");
		const appendSpy = spyOn(activeSession.sessionManager, "appendModelChange").mockImplementation(() => {
			throw new Error("forced tuple append failure");
		});

		// When
		try {
			await activeSession.setDefaultModelSelection(selected, "off");
		} finally {
			appendSpy.mockRestore();
		}

		// Then
		expectTuple(activeSession.sessionManager.buildSessionContext(), oldTuple);
	});

	it("restores the old complete tuple in a fresh session when tuple append failure occurs", async () => {
		// Given
		const activeSession = createSession();
		const oldTuple = await recordOldTuple(activeSession);
		const sessionFile = activeSession.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted session file");
		const selected = bundledModel("claude-sonnet-4-6");
		const appendSpy = spyOn(activeSession.sessionManager, "appendModelChange").mockImplementation(() => {
			throw new Error("forced tuple append failure");
		});

		// When
		try {
			await activeSession.setDefaultModelSelection(selected, "off");
		} finally {
			appendSpy.mockRestore();
		}
		await activeSession.sessionManager.flush();
		const reopened = await SessionManager.open(sessionFile);

		// Then
		expectTuple(reopened.buildSessionContext(), oldTuple);
		await reopened.close();
	});

	it("restores a legacy entry with a separate thinking-level change", () => {
		// Given
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

		// When
		const context = buildSessionContext(entries);

		// Then
		expectTuple(context, { model: "anthropic/legacy-model", thinkingLevel: Effort.High });
	});

	it("restores atomic tuple thinking when switching to another persisted session", async () => {
		// Given
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

		// When
		await activeSession.switchSession(targetFile);

		// Then
		expect(activeSession.model).toEqual(selected);
		expect(activeSession.thinkingLevel).toBe(Effort.Low);
	});

	it("preserves set_model durable default-role setter semantics", async () => {
		// Given
		const settings = Settings.isolated();
		const activeSession = createSession(settings);
		const selected = bundledModel("claude-sonnet-4-6");

		// When
		await activeSession.setModel(selected);

		// Then
		expect(settings.getModelRole("default")).toBe(`${selected.provider}/${selected.id}`);
		expect(activeSession.sessionManager.buildSessionContext().models.default).toBe(
			`${selected.provider}/${selected.id}`,
		);
	});

	it("preserves set_thinking_level session-only setter semantics", () => {
		// Given
		const settings = Settings.isolated({ defaultThinkingLevel: Effort.High });
		const activeSession = createSession(settings);

		// When
		activeSession.setThinkingLevel(Effort.Low);

		// Then
		expect(activeSession.sessionManager.buildSessionContext().thinkingLevel).toBe(Effort.Low);
		expect(settings.get("defaultThinkingLevel")).toBe(Effort.High);
	});
});
