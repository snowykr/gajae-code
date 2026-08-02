import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, TUI } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

class LinesComponent implements Component {
	constructor(private lines: string[]) {}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.lines;
	}

	setLines(lines: string[]): void {
		this.lines = lines;
	}
}

function createPinnedTui(
	rows = 5,
	transcriptLines = ["line-1", `line-2${CURSOR_MARKER}`, "line-3"],
): { term: VirtualTerminal; transcript: LinesComponent; tui: TUI } {
	const term = new VirtualTerminal(40, rows);
	const tui = new TUI(term);
	const transcript = new LinesComponent(transcriptLines);
	const suffix = new LinesComponent(["status", "composer"]);
	tui.addChild(transcript);
	tui.addChild(suffix);
	tui.setBottomPinnedComponent(suffix);
	return { term, transcript, tui };
}

describe("TUI fixed suffix scroll region", () => {
	it("keeps a current owner armed across streaming transcript appends", async () => {
		const { term, transcript, tui } = createPinnedTui();
		try {
			tui.start();
			await term.waitForRender();
			const token = tui.acquireFixedSuffixScrollRegion("test-owner");
			expect(token).toBeDefined();
			if (token === undefined) throw new Error("Expected fixed suffix token");
			transcript.setLines(["line-1", `line-2${CURSOR_MARKER}`, "line-3", "line-4"]);
			term.clearWriteLog();
			expect(tui.armFixedSuffixScrollRegion(token)).toBeGreaterThan(0);
			await term.waitForRender();

			const output = term.getWriteLog().join("");
			expect(output).toContain("\x1b[?2026h\x1b7\x1b[?6l\x1b[1;3r\x1b[3;1H");
			expect(output).toContain("\x1bD\r\x1b[2Kline-4");
			expect(output).toContain("\x1b[r\x1b[?6l\x1b[4;1H\x1b[2Kstatus");
			expect(output).toContain("\x1b[5;1H\x1b[2Kcomposer");
			expect(output).toContain("\x1b8");
			expect(output).toContain("\x1b8\x1b[r\x1b[?6l");
			expect(output).toContain("\x1b[?2026l");
			expect(output).toContain("\x1b[1A");
			expect(output).not.toContain("\r\nline-4");
			await term.flush();
			expect(term.getViewport().map(line => line.trimEnd())).toEqual([
				"line-2",
				"line-3",
				"line-4",
				"status",
				"composer",
			]);
			const scrollback = term.getScrollBuffer().map(line => line.trimEnd());
			expect(scrollback).toContain("line-1");
			expect(scrollback.filter(line => line === "line-1")).toHaveLength(1);
			transcript.setLines(["line-1", "line-2", "line-3", "line-4", "line-5"]);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();
			const secondOutput = term.getWriteLog().join("");
			expect(secondOutput).toContain("\x1b[1;3r");
			expect(secondOutput).toContain("\x1bD\r\x1b[2Kline-5");
			await term.flush();
			const secondScrollback = term.getScrollBuffer().map(line => line.trimEnd());
			expect(secondScrollback.filter(line => line === "line-2")).toHaveLength(1);
		} finally {
			tui.stop();
		}
	});

	it("uses the existing renderer unless a current owner arms the fixed suffix region", async () => {
		const { term, transcript, tui } = createPinnedTui();
		try {
			tui.start();
			await term.waitForRender();
			transcript.setLines(["line-1", "line-2", "line-3", "line-4"]);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();
			expect(term.getWriteLog().join("")).not.toContain("\x1b[1;3r");
		} finally {
			tui.stop();
		}
	});

	it("rejects resized and released owners without arming a transaction", async () => {
		const { term, tui } = createPinnedTui();
		try {
			tui.start();
			await term.waitForRender();
			const token = tui.acquireFixedSuffixScrollRegion("test-owner");
			expect(token).toBeDefined();
			if (token === undefined) throw new Error("Expected fixed suffix token");
			term.resize(40, 6);
			expect(tui.armFixedSuffixScrollRegion(token)).toBeUndefined();

			const current = tui.acquireFixedSuffixScrollRegion("test-owner");
			expect(current).toBeDefined();
			if (current === undefined) throw new Error("Expected refreshed fixed suffix token");
			tui.releaseFixedSuffixScrollRegion(current);
			expect(tui.armFixedSuffixScrollRegion(current)).toBeUndefined();
		} finally {
			tui.stop();
		}
	});

	it("does not acquire while manual history owns the viewport", async () => {
		const { term, tui } = createPinnedTui(3, ["line-1", "line-2", "line-3"]);
		try {
			tui.start();
			await term.waitForRender();
			const token = tui.acquireFixedSuffixScrollRegion("test-owner");
			expect(token).toBeDefined();
			if (token === undefined) throw new Error("Expected fixed suffix token");
			expect(tui.scrollViewportBy(-1)).toBe(true);
			expect(tui.manualViewportActive).toBe(true);
			expect(tui.armFixedSuffixScrollRegion(token)).toBeUndefined();
			expect(tui.acquireFixedSuffixScrollRegion("test-owner")).toBeUndefined();
		} finally {
			tui.stop();
		}
	});
	it("does not acquire or arm a fixed suffix owner after stop", async () => {
		const { term, tui } = createPinnedTui();
		tui.start();
		await term.waitForRender();
		const token = tui.acquireFixedSuffixScrollRegion("test-owner");
		expect(token).toBeDefined();
		if (token === undefined) throw new Error("Expected fixed suffix token");
		tui.stop();
		expect(tui.acquireFixedSuffixScrollRegion("new-owner")).toBeUndefined();
		expect(tui.armFixedSuffixScrollRegion(token)).toBeUndefined();
	});
});
