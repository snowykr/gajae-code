import { describe, expect, it } from "bun:test";
import { Text } from "../src/components/text";
import { setTerminalImageProtocol, TERMINAL } from "../src/terminal-capabilities";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui";
import { VirtualTerminal } from "./virtual-terminal";

class SecondWriteFailureTerminal extends VirtualTerminal {
	#writes = 0;

	override write(data: string): void {
		this.#writes += 1;
		if (this.#writes === 2) throw new Error("second renderer write failed");
		super.write(data);
	}
}

class CursorComponent implements Component {
	invalidate(): void {}

	render(): string[] {
		return [`cursor${CURSOR_MARKER}`];
	}
}

describe("generation-scoped render commits", () => {
	it("resolves after the requested generation writes successfully", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.start();
		tui.addChild(new Text("resume-progress", 1, 0));

		const generation = tui.requestRenderWithGeneration(false, "test.resume-progress");
		expect(await tui.waitForRenderCommit(generation)).toBe(true);
		expect(terminal.getWriteLog().join(" ")).toContain("resume-progress");

		tui.stop();
	});
	it("commits the shared frame when optional IME reanchoring fails", async () => {
		const previousIme = Bun.env.GJC_TUI_IME_CURSOR;
		const previousImageProtocol = TERMINAL.imageProtocol;
		Bun.env.GJC_TUI_IME_CURSOR = "1";
		setTerminalImageProtocol(null);
		const terminal = new SecondWriteFailureTerminal(40, 8);
		const tui = new TUI(terminal, false);
		tui.addChild(new CursorComponent());

		try {
			tui.start();
			const generation = tui.requestRenderWithGeneration(false, "test.ime-cursor-failure");

			expect(await tui.waitForRenderCommit(generation)).toBe(true);
			expect(tui.terminalAvailable).toBe(false);
		} finally {
			tui.stop();
			setTerminalImageProtocol(previousImageProtocol);
			if (previousIme === undefined) delete Bun.env.GJC_TUI_IME_CURSOR;
			else Bun.env.GJC_TUI_IME_CURSOR = previousIme;
		}
	});
	it("commits the shared frame when optional overlay delivery fails", async () => {
		const previousImageProtocol = TERMINAL.imageProtocol;
		setTerminalImageProtocol(null);
		const terminal = new SecondWriteFailureTerminal(40, 8);
		const tui = new TUI(terminal, true);
		let overlayWrites = 0;
		tui.addChild(new Text("overlay-frame", 1, 0));
		tui.setPostRenderEmitter(() => ({
			payload: "\x1b[?25l",
			onWritten: () => overlayWrites++,
		}));

		try {
			tui.start();
			const generation = tui.requestRenderWithGeneration(false, "test.overlay-failure");

			expect(await tui.waitForRenderCommit(generation)).toBe(true);
			expect(tui.terminalAvailable).toBe(false);
			expect(overlayWrites).toBe(0);
		} finally {
			tui.stop();
			setTerminalImageProtocol(previousImageProtocol);
		}
	});
	it("runs queued-output delivery callbacks at the terminal write boundary", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const events: string[] = [];
		tui.start();

		await tui
			.queueTerminalOutput("queued-overlay", {
				onWritten: () => events.push("written"),
			})
			.then(() => events.push("ack"));

		expect(events).toEqual(["written", "ack"]);
		tui.stop();
	});
	it("commits a render generation after a queued raster write finishes", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const releaseBarrier = Promise.withResolvers<boolean>();
		const prefixEntered = Promise.withResolvers<void>();
		const text = new Text("queued-raster-frame", 1, 0);
		tui.addChild(text);
		tui.start();
		await terminal.waitForRender();

		const lease = await tui.acquireRasterLease({
			ownerId: "render-commit",
			rect: { column: 38, row: 7, width: 2, height: 1 },
			erase: { type: "raster-erase", bytes: new TextEncoder().encode("ERASE") },
		});
		if (lease.status !== "acquired") throw new Error("expected lease");
		const raster = tui.submitTerminalOutput({
			token: lease.token,
			operation: {
				type: "raster-multipart-batch",
				prefix: new TextEncoder().encode("PREFIX"),
				afterPrefix: async () => {
					prefixEntered.resolve();
					return releaseBarrier.promise;
				},
				records: [new TextEncoder().encode("PAYLOAD")],
				abortSuffix: new TextEncoder().encode("ABORT"),
			},
		});
		await prefixEntered.promise;
		text.setText("queued-raster-frame-updated");

		const generation = tui.requestRenderWithGeneration(false, "test.queued-raster");
		const committed = tui.waitForRenderCommit(generation);
		releaseBarrier.resolve(true);

		expect(await raster).toMatchObject({ status: "written" });
		expect(await committed).toBe(true);
		expect(terminal.getWriteLog().join(" ")).toContain("queued-raster-frame");
		tui.stop();
	});

	it("fails open immediately after the renderer is stopped", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		tui.start();
		tui.stop();

		const generation = tui.requestRenderWithGeneration(false, "test.stopped");
		expect(await tui.waitForRenderCommit(generation)).toBe(false);
	});
});
