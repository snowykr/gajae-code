import { describe, expect, it } from "bun:test";
import { agentLoop } from "@gajae-code/agent-core/agent-loop";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "@gajae-code/agent-core/types";
import type { Message } from "@gajae-code/ai";
import { createMockModel } from "@gajae-code/ai/providers/mock";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

// A leaked tool-call envelope on the assistant text surface: the openai-codex
// model emitted the `ask` call as visible text instead of a native function
// call (with the `court` glitch line in front), exactly as seen in the wild.
const LEAKED = [
	"call",
	'<invoke name="web_search">',
	'<parameter name="query">portfolio copywriting examples</parameter>',
	'<parameter name="_i">Researching copy</parameter>',
	"</invoke>",
].join("\n");

const HARMONY_HEADER_LEAK = 'analysis to=functions.read code {\n  "path": "src/x.ts"\n}';

function assistantContains(messages: AgentMessage[], needle: string): boolean {
	return messages.some(m => m.role === "assistant" && JSON.stringify(m.content).includes(needle));
}
function isLeakedToolMessage(message: AgentMessage): boolean {
	if (!("content" in message) || !Array.isArray(message.content)) return false;
	const content: unknown[] = message.content;
	return content.some(
		block =>
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "toolCall" &&
			"id" in block &&
			block.id === "leaked-tool",
	);
}
function hasToolCall(message: AgentMessage): boolean {
	return message.role === "assistant" && message.content.some(content => content.type === "toolCall");
}

describe("agent-loop harmony-leak mitigation wiring (openai-codex)", () => {
	it("detects a leaked <invoke> envelope, drops it from history, and retries to a clean turn", async () => {
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const mock = createMockModel({
			provider: "openai-codex",
			responses: [{ content: [LEAKED] }, { content: ["ok"] }],
		});
		const audits: Array<{ action: string }> = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			onHarmonyLeak: e => {
				audits.push(e);
			},
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		await Array.fromAsync(stream);
		const messages = await stream.result();

		// Detector fired and routed to abort-retry (a text-surface leak is not a
		// recoverable tool-arg leak).
		expect(audits.some(a => a.action === "abort_retry")).toBe(true);
		// Two model calls: the leaked turn + the clean retry.
		expect(mock.calls).toHaveLength(2);
		// The retry produced a clean turn; the leak is not replayed in the output.
		expect(assistantContains(messages, "ok")).toBe(true);
		expect(assistantContains(messages, "<invoke name=")).toBe(false);
		// The contaminated assistant message was dropped from the working context,
		// so the model does not see its own leak as history on the retry.
		expect(assistantContains(context.messages, "<invoke name=")).toBe(false);
	});
	it("closes a discarded tool message before retrying", async () => {
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const mock = createMockModel({
			provider: "openai-codex",
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "leaked-tool",
							name: "read",
							arguments: { input: HARMONY_HEADER_LEAK },
						},
					],
				},
				{ content: ["ok"] },
			],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		const events = await Array.fromAsync(
			agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream),
		);
		const leakedLifecycle = events
			.filter(
				event =>
					(event.type === "message_start" || event.type === "message_end") && isLeakedToolMessage(event.message),
			)
			.map(event => event.type);
		const persisted = events.filter(event => event.type === "message_end").map(event => event.message);
		const assistantLifecycle = events
			.filter(
				event =>
					(event.type === "message_start" || event.type === "message_end") && event.message.role === "assistant",
			)
			.map(event => event.type);

		expect(leakedLifecycle).toEqual(["message_start"]);
		expect(assistantLifecycle).toEqual(["message_start", "message_end", "message_start", "message_end"]);
		expect(persisted.some(hasToolCall)).toBe(false);
		expect(
			persisted.some(
				message => message.role === "assistant" && message.stopReason === "aborted" && !hasToolCall(message),
			),
		).toBe(true);
		expect(mock.calls).toHaveLength(2);
	});
	it("closes the discarded tool lifecycle before Harmony escalation", async () => {
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const leakedToolCall = {
			type: "toolCall" as const,
			id: "leaked-tool",
			name: "read",
			arguments: { input: HARMONY_HEADER_LEAK },
		};
		const mock = createMockModel({
			provider: "openai-codex",
			responses: [{ content: [leakedToolCall] }, { content: [leakedToolCall] }, { content: [leakedToolCall] }],
		});
		const config: AgentLoopConfig = { model: mock.model, convertToLlm: identityConverter };
		let failure: unknown;
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		try {
			for await (const event of stream) events.push(event);
		} catch (error) {
			failure = error;
		}

		const lifecycle = events.filter(event => event.type === "message_start" || event.type === "message_end");
		const persisted = events.filter(event => event.type === "message_end").map(event => event.message);
		const assistantLifecycle = events
			.filter(
				event =>
					(event.type === "message_start" || event.type === "message_end") && event.message.role === "assistant",
			)
			.map(event => event.type);

		expect(failure).toBeDefined();
		expect(mock.calls).toHaveLength(3);
		expect(lifecycle.filter(event => event.type === "message_start")).toHaveLength(4);
		expect(assistantLifecycle).toEqual([
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
		]);
		expect(lifecycle.filter(event => event.type === "message_end")).toHaveLength(4);
		expect(persisted.some(hasToolCall)).toBe(false);
		expect(
			persisted.some(
				message => message.role === "assistant" && message.stopReason === "aborted" && !hasToolCall(message),
			),
		).toBe(true);
		expect(context.messages.some(isLeakedToolMessage)).toBe(false);
	});

	it("does not retry a Harmony leak when fallback is managed", async () => {
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const mock = createMockModel({
			provider: "openai-codex",
			responses: [{ content: [LEAKED] }, { content: ["unreachable"] }],
		});
		let upstreamRequests = 0;
		const streamFn: StreamFn = (...args) => {
			upstreamRequests++;
			return mock.stream(...args);
		};
		const audits: Array<{ action: string }> = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			fallbackManaged: true,
			onHarmonyLeak: event => {
				audits.push(event);
			},
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, streamFn);
		await expect(Array.fromAsync(stream)).rejects.toThrow("Detected GPT-5 Harmony protocol leakage");

		expect(upstreamRequests).toBe(1);
		expect(audits.map(audit => audit.action)).toEqual(["escalated"]);
	});

	it("detects a leaked <invoke> envelope for non-codex providers too", async () => {
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const mock = createMockModel({
			provider: "anthropic",
			responses: [{ content: [LEAKED] }, { content: ["ok"] }],
		});
		const audits: Array<{ action: string }> = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			onHarmonyLeak: e => {
				audits.push(e);
			},
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		await Array.fromAsync(stream);
		const messages = await stream.result();

		expect(audits.some(a => a.action === "abort_retry")).toBe(true);
		expect(mock.calls).toHaveLength(2);
		expect(assistantContains(messages, "ok")).toBe(true);
		expect(assistantContains(messages, "<invoke name=")).toBe(false);
	});

	it("keeps harmony-header mitigation scoped to codex providers", async () => {
		const context: AgentContext = { systemPrompt: [], messages: [], tools: [] };
		const mock = createMockModel({
			provider: "anthropic",
			responses: [{ content: [HARMONY_HEADER_LEAK] }],
		});
		const audits: Array<{ action: string }> = [];
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			onHarmonyLeak: e => {
				audits.push(e);
			},
		};

		const stream = agentLoop([createUserMessage("hi")], context, config, undefined, mock.stream);
		await Array.fromAsync(stream);
		const messages = await stream.result();

		expect(audits).toHaveLength(0);
		expect(mock.calls).toHaveLength(1);
		expect(assistantContains(messages, "to=functions.read")).toBe(true);
	});
});
