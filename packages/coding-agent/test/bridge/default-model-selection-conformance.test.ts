import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { getBundledModel } from "@gajae-code/ai";
import { BridgeClient, type BridgeResolvedModelSelection } from "../../../bridge-client/src";
import { createBridgeFetchHandler } from "../../src/modes/bridge/bridge-mode";
import type { RpcCommand, RpcResponse } from "../../src/modes/rpc/rpc-types";
import { dispatchRpcCommand, type RpcCommandDispatchContext } from "../../src/modes/shared/agent-wire/command-dispatch";
import type { AgentSession } from "../../src/session/agent-session";

const SESSION_ID = "selection-session";
const COMMAND_URL = `https://bridge.test/v1/sessions/${SESSION_ID}/commands`;

function deferredRequestBody(): {
	readonly stream: ReadableStream<Uint8Array>;
	readonly resolve: (body: string) => void;
} {
	const body = Promise.withResolvers<string>();
	return {
		stream: new ReadableStream<Uint8Array>({
			async pull(controller) {
				controller.enqueue(new TextEncoder().encode(await body.promise));
				controller.close();
			},
		}),
		resolve: body.resolve,
	};
}

function dispatcherFor(session: Partial<AgentSession>): (command: RpcCommand) => Promise<RpcResponse> {
	const context: RpcCommandDispatchContext = {
		session: session as AgentSession,
		output: () => {},
		hostToolRegistry: { setTools: () => [] },
		hostUriRegistry: { setSchemes: () => [] },
		createUiContext: () => ({ notify: () => {} }),
	};
	return command => dispatchRpcCommand(command, context);
}

function requestUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	return input instanceof URL ? input.href : input.url;
}

describe("bridge default-model-selection conformance", () => {
	it("matches the real dispatcher envelope to the public client's typed result", async () => {
		// Given: the public client is wired through the real bridge handler and command dispatcher.
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model) throw new Error("Expected bundled anthropic model");
		const canonicalSelection = {
			provider: model.provider,
			modelId: model.id,
			thinkingLevel: ThinkingLevel.High,
			durability: "confirmed",
		} as const;
		const handle = createBridgeFetchHandler({
			sessionId: SESSION_ID,
			token: "secret",
			commandScopes: ["model"],
			endpointMatrix: { commands: true },
			idempotencyCache: new Map(),
			commandDispatcher: dispatcherFor({
				getAvailableModels: () => [model],
				setDefaultModelSelection: async () => canonicalSelection,
			}),
		});
		let rawResponse: unknown;
		let rawData: unknown;
		const client = new BridgeClient({
			baseUrl: "https://bridge.test",
			token: "secret",
			fetch: async (input, init) => {
				const response = await handle(new Request(requestUrl(input), init));
				rawResponse = await response.clone().json();
				if (typeof rawResponse === "object" && rawResponse !== null && "data" in rawResponse) {
					rawData = rawResponse.data;
				}
				return response;
			},
		});

		// When: the canonical durable future-session default crosses both public boundaries.
		const result: BridgeResolvedModelSelection = await client.setDefaultModelSelection(
			SESSION_ID,
			model.provider,
			model.id,
			"high",
			{ id: "selection-1", idempotencyKey: "selection-1" },
		);

		// Then: the typed value is exactly the data in the real dispatch response.
		expect(rawResponse).toEqual({
			id: "selection-1",
			type: "response",
			command: "set_default_model_selection",
			success: true,
			data: canonicalSelection,
		});
		expect(result).toEqual(canonicalSelection);
		expect(rawData).toEqual(result);
	});

	it("preserves future-default mutation arrival order when the earlier request body is slow", async () => {
		// Given: an earlier streamed global-default mutation and a later public-client mutation with a buffered body.
		const firstModel = getBundledModel("anthropic", "claude-sonnet-4-6");
		const secondModel = getBundledModel("openai", "gpt-4o");
		if (!firstModel || !secondModel) throw new Error("Expected bundled bridge conformance models");
		const committedDefaults: string[] = [];
		const handle = createBridgeFetchHandler({
			sessionId: SESSION_ID,
			token: "secret",
			commandScopes: ["model"],
			endpointMatrix: { commands: true },
			idempotencyCache: new Map(),
			commandDispatcher: dispatcherFor({
				getAvailableModels: () => [firstModel, secondModel],
				setDefaultModelSelection: async (model, thinkingLevel) => {
					committedDefaults.push(model.id);
					return { provider: model.provider, modelId: model.id, thinkingLevel, durability: "confirmed" };
				},
			}),
		});
		const slowBody = deferredRequestBody();
		const earlierResponse = handle(
			new Request(COMMAND_URL, {
				method: "POST",
				headers: { Authorization: "Bearer secret", "Idempotency-Key": "earlier" },
				body: slowBody.stream,
				duplex: "half",
			}),
		);
		const laterFetchStarted = Promise.withResolvers<void>();
		const client = new BridgeClient({
			baseUrl: "https://bridge.test",
			token: "secret",
			fetch: async (input, init) => {
				laterFetchStarted.resolve();
				return handle(new Request(requestUrl(input), init));
			},
		});
		const laterSelection = client.setDefaultModelSelection(SESSION_ID, secondModel.provider, secondModel.id, "max", {
			id: "later",
			idempotencyKey: "later",
		});
		await laterFetchStarted.promise;

		// When: the earlier request body finally becomes readable.
		slowBody.resolve(
			JSON.stringify({
				id: "earlier",
				type: "set_default_model_selection",
				provider: firstModel.provider,
				modelId: firstModel.id,
				thinkingLevel: "low",
			}),
		);
		const [earlierRaw, laterTyped] = await Promise.all([
			earlierResponse.then(response => response.json()),
			laterSelection,
		]);

		// Then: global-default commit order, raw dispatch output, and typed client output all agree.
		expect(committedDefaults).toEqual([firstModel.id, secondModel.id]);
		expect(earlierRaw).toMatchObject({
			id: "earlier",
			command: "set_default_model_selection",
			success: true,
			data: {
				provider: firstModel.provider,
				modelId: firstModel.id,
				thinkingLevel: "low",
				durability: "confirmed",
			},
		});
		expect(laterTyped).toEqual({
			provider: secondModel.provider,
			modelId: secondModel.id,
			thinkingLevel: "max",
			durability: "confirmed",
		});
	});

	it("rejects a malformed success envelope at the public client boundary", async () => {
		// Given: an HTTP-success response with invalid typed selection data.
		const client = new BridgeClient({
			baseUrl: "https://bridge.test",
			token: "secret",
			fetch: async () =>
				new Response(
					JSON.stringify({
						type: "response",
						command: "set_default_model_selection",
						success: true,
						data: { provider: "anthropic", modelId: "claude-sonnet-4-6", thinkingLevel: "inherit" },
					}),
					{ status: 200 },
				),
		});

		// When: the typed helper parses the response.
		const result = client.setDefaultModelSelection(SESSION_ID, "anthropic", "claude-sonnet-4-6", "high");

		// Then: malformed data cannot escape as a typed result.
		await expect(result).rejects.toThrow("Bridge returned a malformed set_default_model_selection response");
	});

	it("preserves an old server's explicit command error at the public client boundary", async () => {
		// Given: an old server explicitly reports that it does not know the command.
		const client = new BridgeClient({
			baseUrl: "https://bridge.test",
			token: "secret",
			fetch: async () =>
				new Response(JSON.stringify({ error: "Unknown command: set_default_model_selection" }), { status: 400 }),
		});

		// When: the typed helper sends the new command.
		const result = client.setDefaultModelSelection(SESSION_ID, "anthropic", "claude-sonnet-4-6", "high");

		// Then: the explicit version-skew diagnostic remains visible.
		await expect(result).rejects.toThrow("Bridge request failed: 400 (Unknown command: set_default_model_selection)");
	});
});
