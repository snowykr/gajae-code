import { beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import type { ToolExecutionHandle } from "@gajae-code/coding-agent/modes/components/tool-execution";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import type { AgentSessionEvent } from "@gajae-code/coding-agent/session/agent-session";
import { Container } from "@gajae-code/tui";

type AutoCompactionEndEvent = Extract<AgentSessionEvent, { type: "auto_compaction_end" }>;
beforeAll(() => initTheme());

type AutoCompactionFixture = {
	controller: EventController;
	ctx: InteractiveModeContext;
	order: string[];
	showStatus: Mock<(message: string) => void>;
	showWarning: Mock<(message: string) => void>;
	flushCompactionQueue: Mock<(options: { willRetry: boolean }) => Promise<void>>;
	loaderStop: Mock<() => void>;
	loadingStop: Mock<() => void>;
	statusContainerClear: Mock<() => void>;
	rebuildChatFromMessages: Mock<(policy: "replace-identity" | "reconcile-same-transcript") => void>;
};

function createFixture(): AutoCompactionFixture {
	const order: string[] = [];
	const loaderStop = vi.fn(() => {
		order.push("loader.stop");
	});
	const loadingStop = vi.fn(() => {
		order.push("loading.stop");
	});
	const statusContainerClear = vi.fn(() => {
		order.push("statusContainer.clear");
	});
	const showStatus = vi.fn(() => {
		order.push("showStatus");
	});
	const showWarning = vi.fn(() => {
		order.push("showWarning");
	});
	const flushCompactionQueue = vi.fn(async () => {
		order.push("flushCompactionQueue");
	});
	const prepareViewportAnchorForTranscriptRebuild = vi.fn();
	const rebuildChatFromMessages = vi.fn((policy: "replace-identity" | "reconcile-same-transcript") => {
		order.push(`rebuildChatFromMessages:${policy}`);
	});

	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		autoCompactionEscapeHandler: () => order.push("originalEscape"),
		autoCompactionLoader: { stop: loaderStop },
		loadingAnimation: { stop: loadingStop },
		editor: { onEscape: () => order.push("temporaryEscape") },
		session: { abortCompaction: vi.fn(), retryNow: vi.fn(), abortRetry: vi.fn() },
		statusContainer: { clear: statusContainerClear, addChild: vi.fn() },
		statusLine: {
			invalidate: vi.fn(() => {
				order.push("statusLine.invalidate");
			}),
		},
		updateEditorTopBorder: vi.fn(() => {
			order.push("updateEditorTopBorder");
		}),
		updateEditorBorderColor: vi.fn(() => {
			order.push("updateEditorBorderColor");
		}),
		ui: {
			requestRender: vi.fn(() => {
				order.push("ui.requestRender");
			}),
			prepareViewportAnchorForTranscriptRebuild,
			resetViewportAnchorIntent: vi.fn(),
		},
		showStatus,
		showWarning,
		rebuildChatFromMessages,
		flushCompactionQueue,
		reloadTodos: vi.fn(async () => {
			order.push("reloadTodos");
		}),
	} as unknown as InteractiveModeContext;

	return {
		controller: new EventController(ctx),
		ctx,
		order,
		showStatus,
		showWarning,
		flushCompactionQueue,
		loaderStop,
		loadingStop,
		statusContainerClear,
		rebuildChatFromMessages,
	};
}

function compactionResult(): NonNullable<AutoCompactionEndEvent["result"]> {
	return {
		summary: "summary",
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
	};
}

async function runEndEvent(event: AutoCompactionEndEvent): Promise<AutoCompactionFixture> {
	const fixture = createFixture();
	await fixture.controller.handleEvent(event);
	return fixture;
}

describe("EventController auto-compaction overflow status", () => {
	it("stops an active compaction loader during final disposal", () => {
		const fixture = createFixture();
		fixture.controller.dispose();
		expect(fixture.loaderStop).toHaveBeenCalledTimes(1);
		expect(fixture.ctx.autoCompactionLoader).toBeUndefined();
		fixture.ctx.editor.onEscape?.();
		expect(fixture.order).toContain("originalEscape");
	});
	it("releases the working loader before replacing it with the compaction loader", async () => {
		const fixture = createFixture();
		fixture.ctx.autoCompactionLoader = undefined;

		await fixture.controller.handleEvent({
			type: "auto_compaction_start",
			reason: "threshold",
			action: "context-full",
		});

		expect(fixture.loadingStop).toHaveBeenCalledTimes(1);
		expect(fixture.ctx.loadingAnimation).toBeUndefined();
		expect(fixture.order.indexOf("loading.stop")).toBeLessThan(fixture.order.indexOf("statusContainer.clear"));
		await fixture.controller.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: true,
			willRetry: false,
		});
	});
	it("releases the working loader before replacing it with the retry loader", async () => {
		const fixture = createFixture();
		fixture.ctx.autoCompactionLoader = undefined;

		await fixture.controller.handleEvent({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "rate limited",
		});

		expect(fixture.loadingStop).toHaveBeenCalledTimes(1);
		expect(fixture.ctx.loadingAnimation).toBeUndefined();
		expect(fixture.order.indexOf("loading.stop")).toBeLessThan(fixture.order.indexOf("statusContainer.clear"));

		await fixture.controller.handleEvent({ type: "auto_retry_end", success: true, attempt: 1 });
	});
	it("clears the loader before showing overflow completion status", async () => {
		const fixture = await runEndEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: compactionResult(),
			aborted: false,
			willRetry: true,
		});

		expect(fixture.loaderStop).toHaveBeenCalledTimes(1);
		expect(fixture.statusContainerClear).toHaveBeenCalledTimes(1);
		expect(fixture.ctx.autoCompactionLoader).toBeUndefined();
		expect(fixture.showStatus).toHaveBeenCalledWith("Context overflow maintenance completed");
		expect(fixture.showWarning).not.toHaveBeenCalled();
		expect(fixture.order.indexOf("loader.stop")).toBeLessThan(fixture.order.indexOf("showStatus"));
		expect(fixture.rebuildChatFromMessages).toHaveBeenCalledWith("reconcile-same-transcript");
		expect(fixture.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: true });
	});

	it("clears the loader before showing overflow skipped status", async () => {
		const fixture = await runEndEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: true,
			skipped: true,
		});

		expect(fixture.loaderStop).toHaveBeenCalledTimes(1);
		expect(fixture.ctx.autoCompactionLoader).toBeUndefined();
		expect(fixture.showStatus).toHaveBeenCalledWith("Context overflow maintenance skipped");
		expect(fixture.showWarning).not.toHaveBeenCalled();
		expect(fixture.order.indexOf("statusContainer.clear")).toBeLessThan(fixture.order.indexOf("showStatus"));
		expect(fixture.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: true });
	});

	it("shows a skipped overflow reason as status instead of warning", async () => {
		const fixture = await runEndEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
			errorMessage:
				"Context overflow recovery skipped: nothing eligible to compact. Run /clear to preserve this session ID, or switch to a larger-context model before retrying.",
		});

		expect(fixture.loaderStop).toHaveBeenCalledTimes(1);
		expect(fixture.ctx.autoCompactionLoader).toBeUndefined();
		expect(fixture.showStatus).toHaveBeenCalledWith(
			"Context overflow recovery skipped: nothing eligible to compact. Run /clear to preserve this session ID, or switch to a larger-context model before retrying.",
		);
		expect(fixture.showWarning).not.toHaveBeenCalled();
		expect(fixture.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	it("keeps an oversized unchanged maintenance skip as a warning", async () => {
		const errorMessage =
			"Auto-compaction skipped: previous unchanged maintenance request exceeded the model context window; change or reduce the conversation before retrying maintenance.";
		const fixture = await runEndEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
			errorMessage,
		});

		expect(fixture.loaderStop).toHaveBeenCalledTimes(1);
		expect(fixture.ctx.autoCompactionLoader).toBeUndefined();
		expect(fixture.showStatus).not.toHaveBeenCalled();
		expect(fixture.showWarning).toHaveBeenCalledWith(errorMessage);
		expect(fixture.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	it("clears the loader before showing disabled non-resumable overflow recovery status", async () => {
		const fixture = await runEndEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: compactionResult(),
			aborted: false,
			willRetry: false,
			continuationSkipReason: "auto_continue_disabled_non_resumable_tail",
		});

		expect(fixture.loaderStop).toHaveBeenCalledTimes(1);
		expect(fixture.ctx.autoCompactionLoader).toBeUndefined();
		expect(fixture.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fixture.rebuildChatFromMessages).toHaveBeenCalledWith("reconcile-same-transcript");
		expect(fixture.showStatus).toHaveBeenCalledWith(
			"Context overflow recovery skipped: auto_continue_disabled_non_resumable_tail",
		);
		expect(fixture.showWarning).not.toHaveBeenCalled();
		expect(fixture.order.indexOf("loader.stop")).toBeLessThan(fixture.order.indexOf("showStatus"));
		expect(fixture.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});
	it("acknowledges a later durable source when preceding reads share grouped coverage", async () => {
		const pendingTools = new Map<string, ToolExecutionHandle>();
		const context = {
			isInitialized: true,
			statusLine: { invalidate: vi.fn() },
			updateEditorTopBorder: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			setWorkingMessage: vi.fn(),
			ui: { requestRender: vi.fn(), terminal: { columns: 80 } },
			chatContainer: new Container(),
			pendingTools,
			settings: { get: () => false },
			toolOutputExpanded: false,
			addMessageToChat: vi.fn(),
			session: {},
		} as unknown as InteractiveModeContext;
		const controller = new EventController(context);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "read-0",
			toolName: "read",
			args: { path: "/tmp/read-0" },
		});
		const firstSource = pendingTools.get("read-0")!;
		for (let index = 1; index < 257; index++) {
			(firstSource as unknown as { updateArgs(args: unknown, toolCallId: string): void }).updateArgs(
				{ path: `/tmp/read-${index}` },
				`read-${index}`,
			);
		}

		await controller.handleEvent({
			type: "message_start",
			message: {
				role: "custom",
				customType: "test-boundary",
				content: "boundary",
				timestamp: 1,
			},
		} as AgentSessionEvent);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "read-257",
			toolName: "read",
			args: { path: "/tmp/read-257" },
		});
		const laterSource = pendingTools.get("read-257")!;
		const acknowledgeLater = vi.spyOn(laterSource, "acknowledgeDurableHistoryEvent");

		controller.acknowledgeAcceptedRenderEvent(80);
		expect(acknowledgeLater).toHaveBeenCalledWith("read-257", expect.any(Number));
	});
});
