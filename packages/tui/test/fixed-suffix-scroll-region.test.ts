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
): { term: VirtualTerminal; transcript: LinesComponent; suffix: LinesComponent; tui: TUI } {
	const term = new VirtualTerminal(40, rows);
	const tui = new TUI(term);
	const transcript = new LinesComponent(transcriptLines);
	const suffix = new LinesComponent(["status", "composer"]);
	tui.addChild(transcript);
	tui.addChild(suffix);
	tui.setBottomPinnedComponent(suffix);
	return { term, transcript, suffix, tui };
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
	it("resets the fixed plane before iTerm post-render and queued multipart bytes", async () => {
		const { term, transcript, tui } = createPinnedTui();
		try {
			tui.start();
			await term.waitForRender();
			const lease = await tui.acquireRasterLease({
				ownerId: "iterm-owner",
				rect: { column: 36, row: 2, width: 3, height: 3 },
				erase: { type: "raster-erase", bytes: new TextEncoder().encode("ITERM_ERASE") },
				nativeScrollbackEligible: true,
			});
			expect(lease.status).toBe("acquired");
			if (lease.status !== "acquired") throw new Error("Expected iTerm lease");
			const token = tui.acquireFixedSuffixScrollRegion("iterm-owner");
			expect(token).toBeDefined();
			if (token === undefined) throw new Error("Expected fixed suffix token");

			tui.setPostRenderEmitter(() => "POST_RENDER_GIF");
			transcript.setLines(["line-1", "line-2", "line-3", "line-4"]);
			term.clearWriteLog();
			expect(tui.armFixedSuffixScrollRegion(token, lease.token)).toBeGreaterThan(0);
			await term.waitForRender();

			const rendered = term.getWriteLog().join("");
			const restore = "\x1b8\x1b[r\x1b[?6l";
			expect(rendered.indexOf(restore)).toBeGreaterThanOrEqual(0);
			expect(rendered.indexOf(restore)).toBeLessThan(rendered.indexOf("POST_RENDER_GIF"));
			expect(rendered).not.toContain("ITERM_ERASE");

			tui.releaseFixedSuffixScrollRegion(token);
			term.clearWriteLog();
			const multipart = await tui.submitTerminalOutput({
				token: lease.token,
				operation: {
					type: "raster-multipart-batch",
					prefix: new TextEncoder().encode("MULTIPART_PREFIX"),
					records: [new TextEncoder().encode("MULTIPART_GIF")],
					suffix: new TextEncoder().encode("MULTIPART_SUFFIX"),
				},
			});
			expect(multipart.status).toBe("written");
			expect(term.getWriteLog().join("")).toBe("\x1b[r\x1b[?6lMULTIPART_PREFIXMULTIPART_GIFMULTIPART_SUFFIX");
		} finally {
			tui.stop();
		}
	});

	it("keeps an armed iTerm lease across an append with an immutable historical rewrite", async () => {
		const { term, transcript, tui } = createPinnedTui();
		let invalidated = 0;
		try {
			tui.start();
			await term.waitForRender();
			const lease = await tui.acquireRasterLease({
				ownerId: "iterm-owner",
				rect: { column: 36, row: 2, width: 3, height: 3 },
				erase: { type: "raster-erase", bytes: new TextEncoder().encode("ITERM_ERASE") },
				onInvalidated: () => invalidated++,
				nativeScrollbackEligible: true,
			});
			expect(lease.status).toBe("acquired");
			if (lease.status !== "acquired") throw new Error("Expected iTerm lease");
			const token = tui.acquireFixedSuffixScrollRegion("iterm-owner");
			expect(token).toBeDefined();
			if (token === undefined) throw new Error("Expected fixed suffix token");

			transcript.setLines(["line-1", "line-2", "line-3", "line-4"]);
			expect(tui.armFixedSuffixScrollRegion(token, lease.token)).toBeGreaterThan(0);
			await term.waitForRender();
			transcript.setLines(["line-1", "line-2", "line-3", "line-4", "line-5", "line-6"]);
			await term.waitForRender();

			transcript.setLines(["line-1 revised", "line-2", "line-3", "line-4", "line-5", "line-6", "line-7"]);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();

			const output = term.getWriteLog().join("");
			expect(output).toContain("\x1b[1;2r");
			expect(output).toContain("\x1bD\r\x1b[2Kline-7");
			expect(output).not.toContain("ITERM_ERASE");
			expect(invalidated).toBe(0);
			await term.flush();
			const scrollback = term.getScrollBuffer().map(line => line.trimEnd());
			expect(scrollback.filter(line => line === "line-6")).toHaveLength(1);
		} finally {
			tui.stop();
		}
	});
	it("keeps an armed iTerm lease through a multipart barrier reflow", async () => {
		const { term, transcript, tui } = createPinnedTui();
		let invalidated = 0;
		try {
			tui.start();
			await term.waitForRender();
			const lease = await tui.acquireRasterLease({
				ownerId: "iterm-owner",
				rect: { column: 36, row: 2, width: 3, height: 3 },
				erase: { type: "raster-erase", bytes: new TextEncoder().encode("ITERM_ERASE") },
				onInvalidated: () => invalidated++,
				nativeScrollbackEligible: true,
			});
			expect(lease.status).toBe("acquired");
			if (lease.status !== "acquired") throw new Error("Expected iTerm lease");
			const token = tui.acquireFixedSuffixScrollRegion("iterm-owner");
			expect(token).toBeDefined();
			if (token === undefined) throw new Error("Expected fixed suffix token");

			transcript.setLines(["line-1", "line-2", "line-3", "line-4"]);
			expect(tui.armFixedSuffixScrollRegion(token, lease.token)).toBeGreaterThan(0);
			await term.waitForRender();

			const prefixEntered = Promise.withResolvers<void>();
			const releaseBarrier = Promise.withResolvers<boolean>();
			term.clearWriteLog();
			const multipart = tui.submitTerminalOutput({
				token: lease.token,
				operation: {
					type: "raster-multipart-batch",
					prefix: new TextEncoder().encode("MULTIPART_PREFIX"),
					afterPrefix: async () => {
						prefixEntered.resolve();
						return releaseBarrier.promise;
					},
					records: [new TextEncoder().encode("MULTIPART_GIF")],
					suffix: new TextEncoder().encode("MULTIPART_SUFFIX"),
				},
			});
			await prefixEntered.promise;

			transcript.setLines(["line-1 revised", "line-2", "line-3", "line-4", "line-5"]);
			tui.requestRender();
			await Bun.sleep(20);
			expect(term.getWriteLog().join("")).toBe("MULTIPART_PREFIX");
			releaseBarrier.resolve(true);
			expect((await multipart).status).toBe("written");
			await term.waitForRender();

			const fallbackOutput = term.getWriteLog().join("");
			expect(fallbackOutput).toContain("MULTIPART_PREFIXMULTIPART_GIFMULTIPART_SUFFIX");
			expect(fallbackOutput).not.toContain("ITERM_ERASE");
			expect(invalidated).toBe(0);

			transcript.setLines(["line-1 revised", "line-2", "line-3", "line-4", "line-5", "line-6"]);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();

			const resumedOutput = term.getWriteLog().join("");
			expect(resumedOutput).toContain("\x1b[1;2r");
			expect(resumedOutput).toContain("\x1bD\r\x1b[2Kline-6");
			expect(resumedOutput).not.toContain("ITERM_ERASE");
			await term.flush();
			const scrollback = term.getScrollBuffer().map(line => line.trimEnd());
			expect(scrollback.filter(line => line === "line-3")).toHaveLength(1);
			expect(invalidated).toBe(0);
		} finally {
			tui.stop();
		}
	});
	it("preserves a bound raster lease while advancing native scrollback", async () => {
		const { term, transcript, suffix, tui } = createPinnedTui();
		let invalidated = 0;
		try {
			tui.start();
			await term.waitForRender();
			const lease = await tui.acquireRasterLease({
				ownerId: "iterm-owner",
				rect: { column: 36, row: 2, width: 3, height: 3 },
				erase: { type: "raster-erase", bytes: new TextEncoder().encode("ITERM_ERASE") },
				onInvalidated: () => invalidated++,
				nativeScrollbackEligible: true,
			});
			expect(lease.status).toBe("acquired");
			if (lease.status !== "acquired") throw new Error("Expected iTerm lease");
			const token = tui.acquireFixedSuffixScrollRegion("iterm-owner");
			expect(token).toBeDefined();
			if (token === undefined) throw new Error("Expected fixed suffix token");

			transcript.setLines(["line-1", "line-2", "line-3", "line-4"]);
			term.clearWriteLog();
			expect(tui.armFixedSuffixScrollRegion(token, lease.token)).toBeGreaterThan(0);
			await term.waitForRender();

			const output = term.getWriteLog().join("");
			expect(output).toContain("\x1b[1;2r");
			expect(output).toContain("\x1bD\r\x1b[2Kline-4");
			expect(output).not.toContain("ITERM_ERASE");
			expect(invalidated).toBe(0);
			expect(output).not.toContain("\x1b[4;1H\x1b[2K");
			expect(output).not.toContain("\x1b[5;1H\x1b[2K");
			expect(output).toContain("\x1b[4;1H\x1b[36Xstatus");
			expect(output).toContain("\x1b[4;40H\x1b[1X");
			expect(output).toContain("\x1b[5;1H\x1b[36Xcomposer");
			expect(output).toContain("\x1b[5;40H\x1b[1X");
			expect(output).not.toContain("\x1b[4;37H");
			expect(output).not.toContain("\x1b[5;37H");
			expect(output).not.toContain("\x1b[3;1H\x1bD");
			await term.flush();
			expect(term.getScrollBuffer().map(line => line.trimEnd())).toContain("line-1");
			transcript.setLines(["line-1", "line-2", "line-3", "line-4", "line-5"]);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();
			const streamingOutput = term.getWriteLog().join("");
			expect(streamingOutput).toContain("\x1b[1;2r");
			expect(streamingOutput).toContain("\x1b[2;1H\x1bD\r\x1b[2Kline-5");
			expect(streamingOutput).not.toContain("ITERM_ERASE");
			expect(invalidated).toBe(0);
			expect(streamingOutput).not.toContain("\x1b[4;1H\x1b[2K");
			expect(streamingOutput).not.toContain("\x1b[5;1H\x1b[2K");
			expect(streamingOutput).toContain("\x1b[4;1H\x1b[36Xstatus");
			expect(streamingOutput).toContain("\x1b[4;40H\x1b[1X");
			expect(streamingOutput).toContain("\x1b[5;1H\x1b[36Xcomposer");
			expect(streamingOutput).toContain("\x1b[5;40H\x1b[1X");
			expect(streamingOutput).not.toContain("\x1b[4;37H");
			expect(streamingOutput).not.toContain("\x1b[5;37H");
			expect(streamingOutput).not.toContain("\x1b[3;1H\x1bD");
			await term.flush();
			const scrollback = term.getScrollBuffer().map(line => line.trimEnd());
			expect(scrollback.filter(line => line === "line-1")).toHaveLength(1);
			expect(scrollback.filter(line => line === "line-2")).toHaveLength(1);
			transcript.setLines(["line-1", "line-2", "line-3", "line-4", "line-5 revised", "line-6"]);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();
			const tailRewriteOutput = term.getWriteLog().join("");
			expect(tailRewriteOutput).toContain("\x1b[1;2r");
			expect(tailRewriteOutput).toContain("\x1b[1;1H\x1b[2Kline-5 revised");
			expect(tailRewriteOutput).toContain("\x1b[2;1H\x1bD\r\x1b[2Kline-6");
			expect(tailRewriteOutput).not.toContain("ITERM_ERASE");
			expect(invalidated).toBe(0);
			transcript.setLines(["line-1", "line-2", "line-3", "line-4", "line-5 revised", "line-6", "line-7"]);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();
			const postRewriteOutput = term.getWriteLog().join("");
			expect(postRewriteOutput).toContain("\x1b[1;2r");
			expect(postRewriteOutput).toContain("\x1b[2;1H\x1bD\r\x1b[2Kline-7");
			expect(postRewriteOutput).not.toContain("ITERM_ERASE");
			expect(invalidated).toBe(0);
			transcript.setLines([
				"line-1",
				"line-2",
				"line-3",
				"line-4",
				"line-5 revised",
				"line-6",
				"line-7",
				"line-8",
				"line-9",
				"line-10",
			]);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();
			const batchedOutput = term.getWriteLog().join("");
			expect(batchedOutput).toContain("\x1b[1;2r");
			expect(batchedOutput).toContain("\x1b[2;1H\x1bD\r\x1b[2Kline-8");
			expect(batchedOutput).toContain("\x1b[2;1H\x1bD\r\x1b[2Kline-9");
			expect(batchedOutput).toContain("\x1b[2;1H\x1bD\r\x1b[2Kline-10");
			expect(batchedOutput).not.toContain("ITERM_ERASE");
			await term.flush();
			const batchedScrollback = term.getScrollBuffer().map(line => line.trimEnd());
			expect(batchedScrollback.filter(line => line === "line-5 revised")).toHaveLength(1);
			expect(batchedScrollback.filter(line => line === "line-6")).toHaveLength(1);
			expect(batchedScrollback.filter(line => line === "line-7")).toHaveLength(1);
			transcript.setLines([
				"line-1",
				"line-2",
				"line-3",
				"line-4",
				"line-5 revised",
				"line-6",
				"line-7",
				"line-8",
				"line-9 revised",
				"line-10",
				"line-11",
			]);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();
			const outgoingRewriteOutput = term.getWriteLog().join("");
			expect(outgoingRewriteOutput).toContain("\x1b[1;1H\x1b[2Kline-9 revised");
			expect(outgoingRewriteOutput).toContain("\x1b[2;1H\x1bD\r\x1b[2Kline-11");
			expect(outgoingRewriteOutput).not.toContain("ITERM_ERASE");
			await term.flush();
			const outgoingRewriteScrollback = term.getScrollBuffer().map(line => line.trimEnd());
			expect(outgoingRewriteScrollback.filter(line => line === "line-9 revised")).toHaveLength(1);
			expect(outgoingRewriteScrollback).not.toContain("line-9");
			transcript.setLines([
				"line-1",
				"line-2",
				"line-3",
				"line-4",
				"line-5 revised",
				"line-6",
				"line-7",
				"line-8",
				"line-9 revised",
				"line-10",
				"line-11 revised",
			]);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();
			const reflowOutput = term.getWriteLog().join("");
			expect(reflowOutput).toContain("\x1b[r\x1b[?6l");
			expect(reflowOutput).not.toContain("\x1b[1;2r");
			expect(reflowOutput).not.toContain("ITERM_ERASE");
			suffix.setLines(["status", "progress", "composer"]);
			transcript.setLines([
				"line-1",
				"line-2",
				"line-3",
				"line-4",
				"line-5 revised",
				"line-6",
				"line-7",
				"line-8",
				"line-9 revised",
				"line-10",
				"line-11 revised",
				"line-12",
			]);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();
			const suffixGrowthOutput = term.getWriteLog().join("");
			expect(suffixGrowthOutput).toContain("\x1b[1;2r");
			expect(suffixGrowthOutput).toContain("\x1bD\r\x1b[2Kline-12");
			expect(suffixGrowthOutput).not.toContain("ITERM_ERASE");
			expect(invalidated).toBe(0);
			await term.flush();
			const suffixGrowthScrollback = term.getScrollBuffer().map(line => line.trimEnd());
			expect(suffixGrowthScrollback.filter(line => line === "line-10")).toHaveLength(1);
			transcript.setLines([
				"line-1",
				"line-2",
				"line-3",
				"line-4",
				"line-5 revised",
				"line-6",
				"line-7",
				"line-8",
				"line-9 revised",
				"line-10",
				"line-11 revised",
				"line-12",
				"line-13",
			]);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();
			const postSuffixGrowthOutput = term.getWriteLog().join("");
			expect(postSuffixGrowthOutput).toContain("\x1b[1;2r");
			expect(postSuffixGrowthOutput).toContain("\x1bD\r\x1b[2Kline-13");
			expect(postSuffixGrowthOutput).not.toContain("ITERM_ERASE");
			expect(invalidated).toBe(0);
			await term.flush();
			const postSuffixGrowthScrollback = term.getScrollBuffer().map(line => line.trimEnd());
			expect(postSuffixGrowthScrollback.filter(line => line === "line-11 revised")).toHaveLength(1);
			expect(postSuffixGrowthScrollback.filter(line => line === "line-12")).toHaveLength(1);
			suffix.setLines(["status", "progress", "hint", "composer"]);
			transcript.setLines([
				"line-1",
				"line-2",
				"line-3",
				"line-4",
				"line-5 revised",
				"line-6",
				"line-7",
				"line-8",
				"line-9 revised",
				"line-10",
				"line-11 revised",
				"line-12",
				"line-13",
				"line-14",
			]);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();
			const shrinkingPlaneOutput = term.getWriteLog().join("");
			expect(shrinkingPlaneOutput).toContain("\x1b[1;2r");
			expect(shrinkingPlaneOutput).toContain("\x1b[1;1r");
			expect(shrinkingPlaneOutput).toContain("\x1bD\r\x1b[2Kline-14");
			expect(shrinkingPlaneOutput).not.toContain("ITERM_ERASE");
			expect(invalidated).toBe(0);
			await term.flush();
			const shrinkingPlaneScrollback = term.getScrollBuffer().map(line => line.trimEnd());
			expect(shrinkingPlaneScrollback.filter(line => line === "line-12")).toHaveLength(1);
			expect(shrinkingPlaneScrollback.filter(line => line === "line-13")).toHaveLength(1);
			tui.releaseFixedSuffixScrollRegion(token);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();
			expect(term.getWriteLog().join("")).toContain("\x1b[r\x1b[?6l");
		} finally {
			tui.stop();
		}
	});
	it("keeps an ineligible raster lease on its generic renderer path", async () => {
		const { term, transcript, tui } = createPinnedTui();
		let invalidated = 0;
		try {
			tui.start();
			await term.waitForRender();
			const lease = await tui.acquireRasterLease({
				ownerId: "other-owner",
				rect: { column: 36, row: 2, width: 3, height: 3 },
				erase: { type: "raster-erase", bytes: new TextEncoder().encode("ITERM_ERASE") },
				onInvalidated: () => invalidated++,
			});
			expect(lease.status).toBe("acquired");
			const token = tui.acquireFixedSuffixScrollRegion("iterm-owner");
			expect(token).toBeDefined();
			if (token === undefined) throw new Error("Expected fixed suffix token");

			transcript.setLines(["line-1", "line-2", "line-3", "line-4"]);
			term.clearWriteLog();
			expect(tui.armFixedSuffixScrollRegion(token)).toBeGreaterThan(0);
			await term.waitForRender();

			const output = term.getWriteLog().join("");
			expect(output).not.toContain("ITERM_ERASE");
			expect(output).not.toContain("\x1b[1;3r");
			expect(output).not.toContain("\x1bD\r\x1b[2Kline-4");
			expect(invalidated).toBe(0);
		} finally {
			tui.stop();
		}
	});
	it("keeps a row-zero native lease on the clipped renderer path", async () => {
		const { term, transcript, tui } = createPinnedTui();
		let invalidated = 0;
		try {
			tui.start();
			await term.waitForRender();
			const lease = await tui.acquireRasterLease({
				ownerId: "iterm-owner",
				rect: { column: 36, row: 0, width: 3, height: 3 },
				erase: { type: "raster-erase", bytes: new TextEncoder().encode("ITERM_ERASE") },
				onInvalidated: () => invalidated++,
				nativeScrollbackEligible: true,
			});
			expect(lease.status).toBe("acquired");
			if (lease.status !== "acquired") throw new Error("Expected iTerm lease");
			const token = tui.acquireFixedSuffixScrollRegion("iterm-owner");
			expect(token).toBeDefined();
			if (token === undefined) throw new Error("Expected fixed suffix token");

			transcript.setLines(["line-1", "line-2", "line-3", "line-4"]);
			term.clearWriteLog();
			expect(tui.armFixedSuffixScrollRegion(token, lease.token)).toBeGreaterThan(0);
			await term.waitForRender();

			const output = term.getWriteLog().join("");
			expect(output).not.toContain("ITERM_ERASE");
			expect(output).not.toContain("\x1b[1;2r");
			expect(invalidated).toBe(0);
		} finally {
			tui.stop();
		}
	});
	it("keeps an armed fixed-suffix lease across a forced render", async () => {
		const { term, transcript, tui } = createPinnedTui();
		let invalidated = 0;
		try {
			tui.start();
			await term.waitForRender();
			const lease = await tui.acquireRasterLease({
				ownerId: "iterm-owner",
				rect: { column: 36, row: 2, width: 3, height: 3 },
				erase: { type: "raster-erase", bytes: new TextEncoder().encode("ITERM_ERASE") },
				onInvalidated: () => invalidated++,
				nativeScrollbackEligible: true,
			});
			expect(lease.status).toBe("acquired");
			if (lease.status !== "acquired") throw new Error("Expected iTerm lease");
			const token = tui.acquireFixedSuffixScrollRegion("iterm-owner");
			expect(token).toBeDefined();
			if (token === undefined) throw new Error("Expected fixed suffix token");
			transcript.setLines(["line-1", "line-2", "line-3", "line-4"]);
			expect(tui.armFixedSuffixScrollRegion(token, lease.token)).toBeGreaterThan(0);
			await term.waitForRender();

			term.clearWriteLog();
			tui.requestRender(true, "test armed fixed suffix render");
			await term.waitForRender();

			const output = term.getWriteLog().join("");
			expect(output).not.toContain("ITERM_ERASE");
			expect(invalidated).toBe(0);
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
	it("resets an active fixed scroll plane before stop", async () => {
		const { term, transcript, tui } = createPinnedTui();
		tui.start();
		await term.waitForRender();
		const lease = await tui.acquireRasterLease({
			ownerId: "test-owner",
			rect: { column: 36, row: 2, width: 3, height: 3 },
			erase: { type: "raster-erase", bytes: new TextEncoder().encode("ITERM_ERASE") },
			nativeScrollbackEligible: true,
		});
		expect(lease.status).toBe("acquired");
		if (lease.status !== "acquired") throw new Error("Expected iTerm lease");
		const token = tui.acquireFixedSuffixScrollRegion("test-owner");
		expect(token).toBeDefined();
		if (token === undefined) throw new Error("Expected fixed suffix token");
		transcript.setLines(["line-1", "line-2", "line-3", "line-4"]);
		term.clearWriteLog();
		expect(tui.armFixedSuffixScrollRegion(token, lease.token)).toBeGreaterThan(0);
		await term.waitForRender();
		term.clearWriteLog();
		tui.stop();
		expect(term.getWriteLog().join("")).toContain("\x1b[r\x1b[?6l");
		expect(tui.acquireFixedSuffixScrollRegion("new-owner")).toBeUndefined();
		expect(tui.armFixedSuffixScrollRegion(token)).toBeUndefined();
	});
	it("keeps a released fixed-plane lease on the clipped renderer path", async () => {
		const { term, transcript, tui } = createPinnedTui();
		let invalidated = 0;
		try {
			tui.start();
			await term.waitForRender();
			const lease = await tui.acquireRasterLease({
				ownerId: "test-owner",
				rect: { column: 36, row: 2, width: 3, height: 3 },
				erase: { type: "raster-erase", bytes: new TextEncoder().encode("ITERM_ERASE") },
				onInvalidated: () => invalidated++,
				nativeScrollbackEligible: true,
			});
			expect(lease.status).toBe("acquired");
			if (lease.status !== "acquired") throw new Error("Expected iTerm lease");
			const token = tui.acquireFixedSuffixScrollRegion("test-owner");
			expect(token).toBeDefined();
			if (token === undefined) throw new Error("Expected fixed suffix token");
			transcript.setLines(["line-1", "line-2", "line-3", "line-4"]);
			expect(tui.armFixedSuffixScrollRegion(token, lease.token)).toBeGreaterThan(0);
			await term.waitForRender();

			tui.releaseFixedSuffixScrollRegion(token);
			transcript.setLines(["line-1", "line-2", "line-3", "line-4", "line-5"]);
			term.clearWriteLog();
			tui.requestRender();
			await term.waitForRender();

			const output = term.getWriteLog().join("");
			expect(output).toContain("\x1b[r\x1b[?6l");
			expect(output).not.toContain("ITERM_ERASE");
			expect(invalidated).toBe(0);
		} finally {
			tui.stop();
		}
	});
	it("resets a released fixed plane before queued terminal output", async () => {
		const { term, transcript, tui } = createPinnedTui();
		try {
			tui.start();
			await term.waitForRender();
			const lease = await tui.acquireRasterLease({
				ownerId: "test-owner",
				rect: { column: 36, row: 2, width: 3, height: 3 },
				erase: { type: "raster-erase", bytes: new TextEncoder().encode("ITERM_ERASE") },
				nativeScrollbackEligible: true,
			});
			expect(lease.status).toBe("acquired");
			if (lease.status !== "acquired") throw new Error("Expected iTerm lease");
			const token = tui.acquireFixedSuffixScrollRegion("test-owner");
			expect(token).toBeDefined();
			if (token === undefined) throw new Error("Expected fixed suffix token");
			transcript.setLines(["line-1", "line-2", "line-3", "line-4"]);
			expect(tui.armFixedSuffixScrollRegion(token, lease.token)).toBeGreaterThan(0);
			await term.waitForRender();

			tui.releaseFixedSuffixScrollRegion(token);
			term.clearWriteLog();
			expect(await tui.queueTerminalOutput("after-release")).toMatchObject({ status: "written" });
			expect(term.getWriteLog().join("")).toContain("\x1b[r\x1b[?6lafter-release");
			expect(term.getWriteLog().join("")).not.toContain("ITERM_ERASE");
		} finally {
			tui.stop();
		}
	});
	it("resets a released fixed plane before queued terminal cleanup", async () => {
		const { term, transcript, tui } = createPinnedTui();
		try {
			tui.start();
			await term.waitForRender();
			const lease = await tui.acquireRasterLease({
				ownerId: "test-owner",
				rect: { column: 36, row: 2, width: 3, height: 3 },
				erase: { type: "raster-erase", bytes: new TextEncoder().encode("ITERM_ERASE") },
				nativeScrollbackEligible: true,
			});
			expect(lease.status).toBe("acquired");
			if (lease.status !== "acquired") throw new Error("Expected iTerm lease");
			const token = tui.acquireFixedSuffixScrollRegion("test-owner");
			expect(token).toBeDefined();
			if (token === undefined) throw new Error("Expected fixed suffix token");
			transcript.setLines(["line-1", "line-2", "line-3", "line-4"]);
			expect(tui.armFixedSuffixScrollRegion(token, lease.token)).toBeGreaterThan(0);
			await term.waitForRender();

			tui.releaseFixedSuffixScrollRegion(token);
			term.clearWriteLog();
			await tui.queueTerminalCleanup("after-release");
			expect(term.getWriteLog().join("")).toContain("\x1b[r\x1b[?6lafter-release");
			expect(term.getWriteLog().join("")).not.toContain("ITERM_ERASE");
		} finally {
			tui.stop();
		}
	});
});
