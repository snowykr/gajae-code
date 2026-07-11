import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import type { Model } from "@gajae-code/ai";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import type { RpcCommand, RpcResponse } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	dispatchRpcCommand,
	type RpcCommandDispatchContext,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/command-dispatch";
import { isRpcCommand } from "@gajae-code/coding-agent/modes/shared/agent-wire/command-validation";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";
import { YAML } from "bun";

const registeredModel = {
	id: "model-a",
	name: "Model A",
	api: "openai-responses",
	provider: "provider-a",
	baseUrl: "https://models.example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 32_000,
	thinking: {
		mode: "effort",
		minLevel: ThinkingLevel.Low,
		maxLevel: ThinkingLevel.High,
	},
} satisfies Model<"openai-responses">;

function context(settings: Settings): RpcCommandDispatchContext {
	const session = {
		settings,
		getAvailableModels: () => [registeredModel],
		setModel: () => {
			throw new Error("setModel must not be called");
		},
		setThinkingLevel: () => {
			throw new Error("setThinkingLevel must not be called");
		},
		sessionManager: {
			appendModelChange: () => {
				throw new Error("appendModelChange must not be called");
			},
			appendThinkingLevelChange: () => {
				throw new Error("appendThinkingLevelChange must not be called");
			},
		},
	} as unknown as AgentSession;
	return {
		session,
		output: () => {},
		hostToolRegistry: { setTools: () => [] },
		hostUriRegistry: { setSchemes: () => [] },
		createUiContext: () => ({ notify: () => {} }),
	};
}

function expectError(response: RpcResponse, id: string): void {
	expect(response.success).toBe(false);
	expect(response.id).toBe(id);
	expect(response.command).toBe("set_default_model_selection");
}

describe("set_default_model_selection RPC", () => {
	let testDir: string;
	let agentDir: string;
	let projectDir: string;
	let configPath: string;

	beforeEach(() => {
		resetSettingsForTest();
		testDir = path.join(os.tmpdir(), "rpc-default-model-selection", crypto.randomUUID());
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

	test("accepts a concrete global default selection", () => {
		// Given a complete model and thinking selector.
		const command: unknown = {
			id: "default-1",
			type: "set_default_model_selection",
			provider: "provider-a",
			modelId: "model-a",
			thinkingLevel: "high",
		};

		// When the RPC boundary parses the command.
		const accepted = isRpcCommand(command);

		// Then the concrete selection is accepted as one command.
		expect(accepted).toBe(true);
	});

	test.each([
		["blank provider", { provider: "   ", modelId: "model-a", thinkingLevel: "high" }],
		["blank model ID", { provider: "provider-a", modelId: "\t", thinkingLevel: "high" }],
		["inherited thinking", { provider: "provider-a", modelId: "model-a", thinkingLevel: "inherit" }],
		["unknown thinking", { provider: "provider-a", modelId: "model-a", thinkingLevel: "extreme" }],
	])("rejects %s", (_name, selection) => {
		// Given an invalid global default boundary value.
		const command: unknown = { id: "invalid-1", type: "set_default_model_selection", ...selection };

		// When the RPC boundary parses the command.
		const accepted = isRpcCommand(command);

		// Then it rejects the entire selection.
		expect(accepted).toBe(false);
	});

	test("persists only the global default role before returning success", async () => {
		// Given persisted role siblings, a runtime profile override, and unrelated thinking state.
		await Bun.write(
			configPath,
			YAML.stringify({
				modelRoles: { default: "old/default:low", smol: "provider-s/smol:off" },
				defaultThinkingLevel: ThinkingLevel.Low,
			}),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		settings.overrideModelRoles({ default: "profile/runtime:xhigh" });

		// When the real dispatcher selects a registered model with an out-of-range resolved level.
		const response = await dispatchRpcCommand(
			{
				id: "persist-1",
				type: "set_default_model_selection",
				provider: registeredModel.provider,
				modelId: registeredModel.id,
				thinkingLevel: ThinkingLevel.XHigh,
			},
			context(settings),
		);

		// Then success observes the durable, model-effective global selection only.
		expect(response).toEqual({
			id: "persist-1",
			type: "response",
			command: "set_default_model_selection",
			success: true,
			data: { provider: "provider-a", modelId: "model-a", thinkingLevel: ThinkingLevel.High },
		});
		const persisted = YAML.parse(await Bun.file(configPath).text()) as {
			modelRoles: Record<string, string>;
			defaultThinkingLevel: string;
		};
		expect(persisted.modelRoles).toEqual({
			default: "provider-a/model-a:high",
			smol: "provider-s/smol:off",
		});
		expect(persisted.defaultThinkingLevel).toBe(ThinkingLevel.Low);
		expect(settings.getModelRole("default")).toBe("profile/runtime:xhigh");
		settings.clearOverride("modelRoles");
		expect(settings.getModelRole("default")).toBe("provider-a/model-a:high");
	});

	test("rejects malformed and unknown selections without poisoning the next command", async () => {
		// Given stable persisted settings and a live dispatcher.
		await Bun.write(
			configPath,
			YAML.stringify({
				modelRoles: { default: "old/default:low", smol: "provider-s/smol:off" },
				defaultThinkingLevel: ThinkingLevel.Low,
			}),
		);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const dispatchContext = context(settings);
		const initialBytes = await Bun.file(configPath).bytes();

		// When invalid commands are followed by a valid command.
		const blank = await dispatchRpcCommand(
			{
				id: "blank-1",
				type: "set_default_model_selection",
				provider: " ",
				modelId: "model-a",
				thinkingLevel: ThinkingLevel.High,
			} as unknown as RpcCommand,
			dispatchContext,
		);
		const unknownLevel = await dispatchRpcCommand(
			{
				id: "level-1",
				type: "set_default_model_selection",
				provider: "provider-a",
				modelId: "model-a",
				thinkingLevel: "inherit",
			} as unknown as RpcCommand,
			dispatchContext,
		);
		const unknownModel = await dispatchRpcCommand(
			{
				id: "model-1",
				type: "set_default_model_selection",
				provider: "provider-a",
				modelId: "missing",
				thinkingLevel: ThinkingLevel.High,
			} as RpcCommand,
			dispatchContext,
		);

		// Then every failure is correlated, preserves bytes/state, and a later valid command succeeds.
		expectError(blank, "blank-1");
		expectError(unknownLevel, "level-1");
		expectError(unknownModel, "model-1");
		expect(await Bun.file(configPath).bytes()).toEqual(initialBytes);
		expect(settings.getModelRole("default")).toBe("old/default:low");
		const valid = await dispatchRpcCommand(
			{
				id: "valid-1",
				type: "set_default_model_selection",
				provider: "provider-a",
				modelId: "model-a",
				thinkingLevel: ThinkingLevel.High,
			},
			dispatchContext,
		);
		expect(valid.success).toBe(true);
	});
});
