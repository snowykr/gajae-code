import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import type { RpcCommand } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	dispatchRpcCommand,
	type RpcCommandDispatchContext,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/command-dispatch";
import { isRpcCommand } from "@gajae-code/coding-agent/modes/shared/agent-wire/command-validation";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";

function ctx(session: Partial<AgentSession> = {}): RpcCommandDispatchContext {
	return {
		session: session as AgentSession,
		output: () => {},
		hostToolRegistry: { setTools: () => [] },
		hostUriRegistry: { setSchemes: () => [] },
		createUiContext: () => ({ notify: () => {} }),
	};
}

describe("dispatchRpcCommand validation + error correlation", () => {
	test("rejects inherited and malformed default selections at the raw boundary", () => {
		// Given malformed values for each field owned by the command.
		const malformedSelections: readonly unknown[] = [
			{
				type: "set_default_model_selection",
				provider: 42,
				modelId: "claude-sonnet-4-6",
				thinkingLevel: "off",
			},
			{
				type: "set_default_model_selection",
				provider: "anthropic",
				modelId: null,
				thinkingLevel: "off",
			},
		];

		// When/Then the raw boundary validates those fields before dispatch.
		for (const command of malformedSelections) expect(isRpcCommand(command)).toBe(false);
		expect(
			isRpcCommand({
				type: "set_default_model_selection",
				provider: "anthropic",
				modelId: "claude-sonnet-4-6",
				thinkingLevel: "inherit",
			}),
		).toBe(false);
		expect(
			isRpcCommand({
				type: "set_default_model_selection",
				provider: "anthropic",
				modelId: "claude-sonnet-4-6",
				thinkingLevel: "bogus",
			}),
		).toBe(false);
	});

	test("returns the normalized default selection with request correlation", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model) throw new Error("Expected bundled anthropic model");
		const res = await dispatchRpcCommand(
			{
				id: "default-1",
				type: "set_default_model_selection",
				provider: model.provider,
				modelId: model.id,
				thinkingLevel: "off",
			},
			ctx({
				getAvailableModels: () => [model],
				setDefaultModelSelection: async () => ({
					provider: model.provider,
					modelId: model.id,
					thinkingLevel: "off",
					durability: "confirmed",
				}),
			}),
		);
		expect(res).toEqual({
			id: "default-1",
			type: "response",
			command: "set_default_model_selection",
			success: true,
			data: {
				provider: model.provider,
				modelId: model.id,
				thinkingLevel: "off",
				durability: "confirmed",
			},
		});
	});

	test("keeps set_model on the durable default-role setter path", async () => {
		// Given an available model and a session seam that records optional setter arguments.
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model) throw new Error("Expected bundled anthropic model");
		let selectedModel: unknown;
		let selectedRole: string | undefined = "not-called";

		// When the legacy raw command is dispatched.
		const res = await dispatchRpcCommand(
			{ id: "model-1", type: "set_model", provider: model.provider, modelId: model.id },
			ctx({
				getAvailableModels: () => [model],
				setModel: async (nextModel, role) => {
					selectedModel = nextModel;
					selectedRole = role;
				},
			}),
		);

		// Then dispatch still delegates without overriding setModel's durable default role.
		expect(res.success).toBe(true);
		expect(selectedModel).toBe(model);
		expect(selectedRole).toBeUndefined();
	});

	test("rejects an invalid thinking level with a correlated error (issue 02)", async () => {
		const res = await dispatchRpcCommand(
			{ id: "t1", type: "set_thinking_level", level: "BOGUS" } as unknown as RpcCommand,
			ctx(),
		);
		expect(res.success).toBe(false);
		expect(res.id).toBe("t1");
		expect(res.command).toBe("set_thinking_level");
	});

	test("rejects an invalid steering mode (issue 02)", async () => {
		const res = await dispatchRpcCommand(
			{ id: "s1", type: "set_steering_mode", mode: "BOGUS" } as unknown as RpcCommand,
			ctx(),
		);
		expect(res.success).toBe(false);
		expect(res.id).toBe("s1");
		expect(res.command).toBe("set_steering_mode");
	});

	test("rejects an invalid interrupt mode (issue 02)", async () => {
		const res = await dispatchRpcCommand(
			{ id: "i1", type: "set_interrupt_mode", mode: 123 } as unknown as RpcCommand,
			ctx(),
		);
		expect(res.success).toBe(false);
		expect(res.command).toBe("set_interrupt_mode");
	});

	test("applies a valid thinking level only to the current session", async () => {
		// Given a session seam that records whether durable persistence was requested.
		let applied: unknown;
		let persistArgument: boolean | undefined = true;

		// When the raw session thinking command is dispatched.
		const res = await dispatchRpcCommand(
			{ id: "t2", type: "set_thinking_level", level: ThinkingLevel.High },
			ctx({
				setThinkingLevel: ((level: unknown, persist?: boolean) => {
					applied = level;
					persistArgument = persist;
				}) as AgentSession["setThinkingLevel"],
			}),
		);

		// Then the level is applied without opting into durable settings persistence.
		expect(res.success).toBe(true);
		expect(applied).toBe(ThinkingLevel.High);
		expect(persistArgument).toBeUndefined();
	});

	test("a handler exception is correlated to the request id and real command, not 'parse' (issue 01)", async () => {
		// `set_session_name` with no `name` throws inside the handler (command.name.trim()).
		const res = await dispatchRpcCommand({ id: "n1", type: "set_session_name" } as unknown as RpcCommand, ctx());
		expect(res.success).toBe(false);
		expect(res.id).toBe("n1");
		expect(res.command).toBe("set_session_name");
		expect(res.command).not.toBe("parse");
	});

	test("an unknown command preserves the caller's request id (issue 01 default sub-case)", async () => {
		const res = await dispatchRpcCommand(
			{ id: "u1", type: "totally_unknown_command" } as unknown as RpcCommand,
			ctx(),
		);
		expect(res.success).toBe(false);
		expect(res.id).toBe("u1");
		expect(res.command).toBe("totally_unknown_command");
	});
});
