import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@gajae-code/agent-core";
import { RpcClient } from "@gajae-code/coding-agent/modes/rpc/rpc-client";
import type { RpcModelSelection, RpcResolvedModelSelection } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import { isRecord } from "@gajae-code/utils";

type ResponseFactory = (frame: Record<string, unknown>) => Record<string, unknown>;

async function withRpcServer(
	responseFactory: ResponseFactory,
	run: (client: RpcClient, frames: readonly Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rpc-default-model-client-"));
	const socketPath = path.join(directory, "rpc.sock");
	const frames: Record<string, unknown>[] = [];
	let serverSocket: net.Socket | undefined;
	const server = net.createServer(socket => {
		serverSocket = socket;
		socket.write(`${JSON.stringify({ type: "ready" })}\n`);
		let buffered = "";
		socket.on("data", chunk => {
			buffered += chunk.toString("utf8");
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				if (line.length > 0) {
					const frame: unknown = JSON.parse(line);
					if (isRecord(frame)) {
						frames.push(frame);
						socket.write(`${JSON.stringify(responseFactory(frame))}\n`);
					}
				}
				newline = buffered.indexOf("\n");
			}
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(socketPath, listening.resolve);
	let client: RpcClient | undefined;
	try {
		await listening.promise;
		client = new RpcClient({ transport: "uds", socketPath });
		await client.start();
		await run(client, frames);
	} finally {
		client?.stop();
		serverSocket?.destroy();
		if (server.listening) {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			await closed.promise;
		}
		await fs.rm(directory, { recursive: true, force: true });
	}
}

const selection: RpcModelSelection = {
	provider: "provider-a",
	modelId: "model-a",
	thinkingLevel: ThinkingLevel.High,
};

describe("RpcClient.setDefaultModelSelection", () => {
	test("sends the exact selection tuple and returns the correlated result", async () => {
		// Given a real UDS server that echoes a resolved selection.
		await withRpcServer(
			frame => ({
				id: frame.id,
				type: "response",
				command: "set_default_model_selection",
				success: true,
				data: selection,
			}),
			async (client, frames) => {
				// When the typed client persists the selection.
				const resolved: RpcResolvedModelSelection = await client.setDefaultModelSelection(selection);

				// Then only the command discriminator, correlation ID, and tuple cross the wire.
				expect(frames).toEqual([
					{
						id: expect.any(String),
						type: "set_default_model_selection",
						provider: "provider-a",
						modelId: "model-a",
						thinkingLevel: ThinkingLevel.High,
					},
				]);
				expect(resolved).toEqual(selection);
			},
		);
	});

	test("rejects a correlated command failure", async () => {
		// Given a real UDS server that rejects the correlated command.
		await withRpcServer(
			frame => ({
				id: frame.id,
				type: "response",
				command: "set_default_model_selection",
				success: false,
				error: "selection rejected",
			}),
			async client => {
				// When the typed client receives the failure.
				const request = client.setDefaultModelSelection(selection);

				// Then it rejects with the server error.
				await expect(request).rejects.toThrow("selection rejected");
			},
		);
	});
	test("rejects a matching ID with a response for another command", async () => {
		await withRpcServer(
			frame => ({
				id: frame.id,
				type: "response",
				command: "prompt",
				success: true,
			}),
			async client => {
				await expect(client.setDefaultModelSelection(selection)).rejects.toThrow(
					"Protocol error: expected set_default_model_selection response",
				);
			},
		);
	});
	test.each([
		["null", null],
		["array", []],
		["primitive", "selection"],
		["missing provider", { modelId: selection.modelId, thinkingLevel: selection.thinkingLevel }],
		["non-string provider", { ...selection, provider: 1 }],
		["empty provider", { ...selection, provider: "" }],
		["whitespace provider", { ...selection, provider: " \t" }],
		["missing model ID", { provider: selection.provider, thinkingLevel: selection.thinkingLevel }],
		["non-string model ID", { ...selection, modelId: 1 }],
		["empty model ID", { ...selection, modelId: "" }],
		["whitespace model ID", { ...selection, modelId: "\n " }],
		["inherit thinking level", { ...selection, thinkingLevel: "inherit" }],
		["invalid thinking level", { ...selection, thinkingLevel: "invalid" }],
	])("rejects malformed correlated selection data with %s", async (_name, data) => {
		await withRpcServer(
			frame => ({
				id: frame.id,
				type: "response",
				command: "set_default_model_selection",
				success: true,
				data,
			}),
			async client => {
				await expect(client.setDefaultModelSelection(selection)).rejects.toThrow(
					"Protocol error: invalid response",
				);
			},
		);
	});
	test("accepts a correlated selection response with max thinking level", async () => {
		const resolvedSelection = { ...selection, thinkingLevel: ThinkingLevel.Max };
		await withRpcServer(
			frame => ({
				id: frame.id,
				type: "response",
				command: "set_default_model_selection",
				success: true,
				data: resolvedSelection,
			}),
			async client => {
				await expect(client.setDefaultModelSelection(selection)).resolves.toEqual(resolvedSelection);
			},
		);
	});
});
