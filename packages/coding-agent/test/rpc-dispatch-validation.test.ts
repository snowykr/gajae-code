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
	test("rejects raw malformed default-selection commands before dispatch", () => {
		expect(
			isRpcCommand({
				id: "d-inherit",
				type: "set_default_model_selection",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
				thinkingLevel: "inherit",
			}),
		).toBe(false);
		expect(
			isRpcCommand({
				id: "d-malformed-level",
				type: "set_default_model_selection",
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
				thinkingLevel: "BOGUS",
			}),
		).toBe(false);
	});

	test("rejects an unknown model without dispatching the default-selection handler", async () => {
		let handlerCalled = false;
		const res = await dispatchRpcCommand(
			{
				id: "d-invalid-model",
				type: "set_default_model_selection",
				provider: "anthropic",
				modelId: "missing-model",
				thinkingLevel: "off",
			} as unknown as RpcCommand,
			ctx({
				getAvailableModels: () => [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
				setDefaultModelSelection: async () => {
					handlerCalled = true;
					return { provider: "anthropic", modelId: "missing-model", thinkingLevel: "off" };
				},
			} as unknown as Partial<AgentSession>),
		);
		expect(res.success).toBe(false);
		expect(res.id).toBe("d-invalid-model");
		expect(res.command).toBe("set_default_model_selection");
		if (res.success) throw new Error("expected model validation failure");
		expect(res.error).toBe("Model not found: anthropic/missing-model");
		expect(handlerCalled).toBe(false);
	});

	test("returns the normalized default model selection response", async () => {
		const model = { provider: "anthropic", id: "claude-sonnet-4-5" } as Parameters<AgentSession["setModel"]>[0];
		const res = await dispatchRpcCommand(
			{
				id: "d2",
				type: "set_default_model_selection",
				provider: model.provider,
				modelId: model.id,
				thinkingLevel: "off",
			} as unknown as RpcCommand,
			ctx({
				getAvailableModels: () => [model],
				setDefaultModelSelection: async () => ({
					provider: model.provider,
					modelId: model.id,
					thinkingLevel: "off",
				}),
			} as unknown as Partial<AgentSession>),
		);
		expect(res.success).toBe(true);
		if (res.success && res.command === "set_default_model_selection") {
			expect(res.data).toEqual({ provider: model.provider, modelId: model.id, thinkingLevel: "off" });
		}
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
});
