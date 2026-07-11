import { describe, expect, test } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
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
	test("accepts a valid default model selection wire command", () => {
		// Given: a complete selector with an explicit reasoning level.
		const command = {
			id: "selection-1",
			type: "set_default_model_selection",
			provider: "openai",
			modelId: "gpt-5",
			thinkingLevel: ThinkingLevel.High,
		};

		// When: the public wire boundary validates the frame.
		const accepted = isRpcCommand(command);

		// Then: the command is accepted without dispatching it.
		expect(accepted).toBe(true);
	});

	test("accepts a default model selection without an optional reasoning level", () => {
		// Given: a complete model selector with no reasoning override.
		const command = {
			id: "selection-2",
			type: "set_default_model_selection",
			provider: "anthropic",
			modelId: "claude-sonnet-4-5",
		};

		// When: the public wire boundary validates the frame.
		const accepted = isRpcCommand(command);

		// Then: omission preserves the command's optional-level contract.
		expect(accepted).toBe(true);
	});

	test("rejects malformed default model selection wire commands", () => {
		// Given: frames covering missing, blank, non-string, inherited, and unknown selector fields.
		const malformed: readonly unknown[] = [
			{ type: "set_default_model_selection", modelId: "gpt-5" },
			{ type: "set_default_model_selection", provider: "openai" },
			{ type: "set_default_model_selection", provider: "   ", modelId: "gpt-5" },
			{ type: "set_default_model_selection", provider: "openai", modelId: "\t" },
			{ type: "set_default_model_selection", provider: 42, modelId: "gpt-5" },
			{ type: "set_default_model_selection", provider: "openai", modelId: false },
			{
				type: "set_default_model_selection",
				provider: "openai",
				modelId: "gpt-5",
				thinkingLevel: "",
			},
			{
				type: "set_default_model_selection",
				provider: "openai",
				modelId: "gpt-5",
				thinkingLevel: ThinkingLevel.Inherit,
			},
			{
				type: "set_default_model_selection",
				provider: "openai",
				modelId: "gpt-5",
				thinkingLevel: "extreme",
			},
		];

		// When: each untrusted frame crosses the public wire boundary.
		const results = malformed.map(isRpcCommand);

		// Then: none reaches the typed dispatcher contract.
		expect(results).toEqual(malformed.map(() => false));
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

	test("applies a valid thinking level", async () => {
		let applied: unknown;
		const res = await dispatchRpcCommand(
			{ id: "t2", type: "set_thinking_level", level: ThinkingLevel.High },
			ctx({
				setThinkingLevel: ((level: unknown) => {
					applied = level;
				}) as AgentSession["setThinkingLevel"],
			}),
		);
		expect(res.success).toBe(true);
		expect(applied).toBe(ThinkingLevel.High);
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
