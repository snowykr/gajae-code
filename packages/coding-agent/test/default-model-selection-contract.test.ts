import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@gajae-code/ai";
import { RpcClient } from "@gajae-code/coding-agent/modes/rpc/rpc-client";
import type { RpcModelSelection, RpcResolvedModelSelection } from "@gajae-code/coding-agent/modes/rpc/rpc-types";
import {
	dispatchRpcCommand,
	type RpcCommandDispatchContext,
} from "@gajae-code/coding-agent/modes/shared/agent-wire/command-dispatch";
import type { AgentSession } from "@gajae-code/coding-agent/session/agent-session";

type SelectionFixture = {
	readonly requested: RpcModelSelection;
	readonly resolved: RpcResolvedModelSelection;
};

const fixture = {
	requested: { provider: "anthropic", modelId: "claude-sonnet-4-6", thinkingLevel: "off" },
	resolved: { provider: "anthropic", modelId: "claude-sonnet-4-6", thinkingLevel: "off" },
} satisfies SelectionFixture;

function dispatchContext(): RpcCommandDispatchContext {
	const model = getBundledModel("anthropic", "claude-sonnet-4-6");
	if (!model) throw new Error(`Expected bundled model ${fixture.requested.provider}/${fixture.requested.modelId}`);
	return {
		session: {
			getAvailableModels: () => [model],
			setDefaultModelSelection: async () => fixture.resolved,
		} as unknown as AgentSession,
		output: () => {},
		hostToolRegistry: { setTools: () => [] },
		hostUriRegistry: { setSchemes: () => [] },
		createUiContext: () => ({ notify: () => {} }),
	};
}

async function withResponse(data: unknown, run: (client: RpcClient) => Promise<void>): Promise<void> {
	const scriptPath = path.join(os.tmpdir(), `gjc-default-selection-contract-${crypto.randomUUID()}.js`);
	const source = `
let buffer = "";
const data = ${JSON.stringify(data)};
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
			write({ id: frame.id, type: "response", command: frame.type, success: true, data });
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

describe("default model selection cross-surface contract", () => {
	it("returns the same canonical selection through raw dispatch and RpcClient", async () => {
		// Given one selection fixture shared by the raw dispatcher and typed client.
		const rawResponse = await dispatchRpcCommand(
			{ id: "selection-contract", type: "set_default_model_selection", ...fixture.requested },
			dispatchContext(),
		);
		expect(rawResponse.success).toBe(true);
		if (!rawResponse.success || rawResponse.command !== "set_default_model_selection" || !("data" in rawResponse)) {
			throw new Error("Expected successful raw selection response");
		}

		// When the TypeScript boundary consumes the raw surface's response data.
		await withResponse(rawResponse.data, async client => {
			const typedSelection = await client.setDefaultModelSelection(fixture.requested);

			// Then both surfaces expose the identical canonical resolved tuple.
			expect(rawResponse.data).toEqual(fixture.resolved);
			expect(typedSelection).toEqual(fixture.resolved);
			expect(typedSelection).toEqual(rawResponse.data);
		});
	});

	it("rejects a malformed successful response at the TypeScript boundary", async () => {
		// Given a nominally successful wire response without a resolved thinking level.
		const malformedSuccess = { provider: "anthropic", modelId: "claude-sonnet-4-6" };

		// When/Then the typed client parses the untrusted success payload.
		await withResponse(malformedSuccess, async client => {
			await expect(client.setDefaultModelSelection(fixture.requested)).rejects.toThrow(
				"Invalid set_default_model_selection response",
			);
		});
	});
});
