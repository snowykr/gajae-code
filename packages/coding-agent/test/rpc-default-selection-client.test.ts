import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@gajae-code/ai";
import { RpcClient } from "@gajae-code/coding-agent/modes/rpc/rpc-client";

type FakeResponse =
	| { readonly success: true; readonly data?: unknown }
	| { readonly success: false; readonly error: string };

async function withFakeServer(
	responses: Readonly<Record<string, FakeResponse>>,
	run: (client: RpcClient) => Promise<void>,
): Promise<void> {
	const scriptPath = path.join(os.tmpdir(), `gjc-rpc-default-selection-${Date.now()}-${Math.random()}.js`);
	const source = `
let buffer = "";
const responses = ${JSON.stringify(responses)};
function write(frame) { process.stdout.write(JSON.stringify(frame) + "\\n"); }
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) {
			const frame = JSON.parse(line);
			const response = responses[frame.type];
			write({ id: frame.id, type: "response", command: frame.type, ...response });
		}
		index = buffer.indexOf("\\n");
	}
});
`;
	await Bun.write(scriptPath, source);
	const client = new RpcClient({ cliPath: scriptPath });
	try {
		await client.start();
		await run(client);
	} finally {
		client.stop();
		await fs.unlink(scriptPath).catch(() => undefined);
	}
}

describe("RpcClient default model selection response boundary", () => {
	it("returns a canonical resolved selection when the server response is valid", async () => {
		const resolved = {
			provider: "openai",
			modelId: "gpt-5.1",
			thinkingLevel: Effort.High,
			durability: "confirmed",
		} as const;

		await withFakeServer({ set_default_model_selection: { success: true, data: resolved } }, async client => {
			const result = await client.setDefaultModelSelection({
				provider: "openai",
				modelId: "gpt-5.1",
				thinkingLevel: Effort.High,
			});

			expect(result).toEqual(resolved);
		});
	});

	it.each([
		["missing provider", { modelId: "gpt-5.1", thinkingLevel: "high", durability: "confirmed" }],
		["wrong provider type", { provider: 7, modelId: "gpt-5.1", thinkingLevel: "high", durability: "confirmed" }],
		["empty provider", { provider: "", modelId: "gpt-5.1", thinkingLevel: "high", durability: "confirmed" }],
		[
			"whitespace-only provider",
			{ provider: "   ", modelId: "gpt-5.1", thinkingLevel: "high", durability: "confirmed" },
		],
		["missing modelId", { provider: "openai", thinkingLevel: "high", durability: "confirmed" }],
		["wrong modelId type", { provider: "openai", modelId: false, thinkingLevel: "high", durability: "confirmed" }],
		["empty modelId", { provider: "openai", modelId: "", thinkingLevel: "high", durability: "confirmed" }],
		[
			"whitespace-only modelId",
			{ provider: "openai", modelId: "   ", thinkingLevel: "high", durability: "confirmed" },
		],
		["missing thinkingLevel", { provider: "openai", modelId: "gpt-5.1", durability: "confirmed" }],
		[
			"wrong thinkingLevel type",
			{ provider: "openai", modelId: "gpt-5.1", thinkingLevel: 1, durability: "confirmed" },
		],
		[
			"unsupported thinkingLevel",
			{ provider: "openai", modelId: "gpt-5.1", thinkingLevel: "turbo", durability: "confirmed" },
		],
		[
			"unresolved thinkingLevel",
			{ provider: "openai", modelId: "gpt-5.1", thinkingLevel: "inherit", durability: "confirmed" },
		],
		["missing durability", { provider: "openai", modelId: "gpt-5.1", thinkingLevel: "high" }],
		[
			"unsupported durability",
			{ provider: "openai", modelId: "gpt-5.1", thinkingLevel: "high", durability: "maybe" },
		],
	] as const)("rejects a %s response", async (_caseName, data) => {
		await withFakeServer({ set_default_model_selection: { success: true, data } }, async client => {
			await expect(
				client.setDefaultModelSelection({
					provider: "openai",
					modelId: "gpt-5.1",
					thinkingLevel: Effort.High,
				}),
			).rejects.toThrow("Invalid set_default_model_selection response");
		});
	});

	it("preserves the server error text when an old server does not support the command", async () => {
		const oldServerError = "Unknown command: set_default_model_selection";

		await withFakeServer({ set_default_model_selection: { success: false, error: oldServerError } }, async client => {
			await expect(
				client.setDefaultModelSelection({
					provider: "openai",
					modelId: "gpt-5.1",
					thinkingLevel: "off",
				}),
			).rejects.toThrow(oldServerError);
		});
	});

	it("keeps legacy setModel and setThinkingLevel responses compatible", async () => {
		await withFakeServer(
			{
				set_model: { success: true, data: { provider: "openai", id: "gpt-5.1" } },
				set_thinking_level: { success: true },
			},
			async client => {
				const model = await client.setModel("openai", "gpt-5.1");
				await client.setThinkingLevel(Effort.Low);

				expect(model).toEqual({ provider: "openai", id: "gpt-5.1" });
			},
		);
	});
});
