import { describe, expect, it } from "bun:test";
import { type Component, TUI, type TuiTransactionObservation } from "@gajae-code/tui";
import { VirtualTerminal } from "./virtual-terminal";

class FixedLines implements Component {
	constructor(private lines: string[]) {}

	setLines(lines: string[]): void {
		this.lines = lines;
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return this.lines;
	}
}

async function settle(term: VirtualTerminal): Promise<void> {
	const nextTick = Promise.withResolvers<void>();
	process.nextTick(nextTick.resolve);
	await nextTick.promise;
	await Bun.sleep(1);
	await term.flush();
}

describe("renderer shared-write no-repair guard", () => {
	it("strips erase CSI while preserving later shared renders", async () => {
		const sanitizedPayloads = ["\x1b[J", "\x1b[0J", "\x1b[?2J", "\x1b[1;2K", "\x9bJ", "\x9b?2K"];
		for (const payload of sanitizedPayloads) {
			const term = new VirtualTerminal(40, 10);
			const tui = new TUI(term);
			tui.addChild(new FixedLines([`safe-shared${payload}after`]));

			try {
				tui.start();
				await settle(term);
				const writes = term.getWriteLog().join("");
				expect(writes).toContain("safe-sharedafter");
				expect(writes).not.toContain(payload);
			} finally {
				tui.stop();
			}
		}
	});

	it("strips an incomplete CSI suffix and continues with later shared renders", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term);
		const component = new FixedLines(["safe-shared\x1b["]);
		tui.addChild(component);

		try {
			tui.start();
			await settle(term);
			const firstWrites = term.getWriteLog().join("");
			expect(firstWrites).toContain("safe-shared");
			expect(firstWrites).not.toContain("safe-shared\x1b[\x1b");
			expect(term.getViewport()[0]?.trim()).toBe("safe-shared");

			component.setLines(["next-safe-frame"]);
			term.clearWriteLog();
			tui.requestRender(true, "test.incomplete-csi-followup");
			await settle(term);

			expect(term.getWriteLog().join("")).toContain("next-safe-frame");
			expect(term.getViewport()[0]?.trim()).toBe("next-safe-frame");
		} finally {
			tui.stop();
		}
	});
	it("preserves text following a malformed CSI fragment", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term);
		tui.addChild(new FixedLines(["before\x1b[한글 after"]));

		try {
			tui.start();
			await settle(term);

			const writes = term.getWriteLog().join("");
			expect(writes).toContain("before한글 after");
			expect(writes).not.toContain("\x1b[한글");
			expect(term.getViewport()[0]?.trim()).toBe("before한글 after");
		} finally {
			tui.stop();
		}
	});

	it("keeps renderer-owned shared frames free of terminal erase CSI", async () => {
		const cases = [
			{ term: new VirtualTerminal(40, 10), lines: ["full-render-frame"] },
			{
				term: new VirtualTerminal(40, 10, { isProcessTerminal: true }),
				lines: ["viewport-render-frame"],
			},
		];

		for (const { term, lines } of cases) {
			const tui = new TUI(term);
			const observations: TuiTransactionObservation[] = [];
			tui.addChild(new FixedLines(lines));
			tui.setTransactionObserver(observation => observations.push(observation));

			try {
				tui.start();
				await settle(term);
				term.clearWriteLog();
				term.resize(41, 10);
				await settle(term);

				const eraseCsi = /\x1b\[(?:2K|2J|3J)/u;
				expect(term.getWriteLog().join("")).not.toMatch(eraseCsi);
				expect(
					observations
						.filter(observation => observation.classification === "shared")
						.every(observation => !eraseCsi.test(observation.bytes)),
				).toBe(true);
			} finally {
				tui.stop();
			}
		}
	});
	it("keeps Pet overlay bytes exempt from the shared guard", async () => {
		const term = new VirtualTerminal(40, 10);
		const tui = new TUI(term);
		const observations: TuiTransactionObservation[] = [];
		tui.addChild(new FixedLines(["safe-shared"]));
		tui.setTransactionObserver(observation => observations.push(observation));
		tui.setPostRenderEmitter(() => "\x1b[2JPET-OVERLAY");

		try {
			tui.start();
			await settle(term);

			expect(term.getWriteLog().some(write => write.includes("safe-shared"))).toBe(true);
			expect(term.getWriteLog().some(write => write.includes("PET-OVERLAY"))).toBe(true);
			expect(observations).toContainEqual(
				expect.objectContaining({ classification: "shared", outcome: "accepted" }),
			);
			expect(observations).toContainEqual(
				expect.objectContaining({
					classification: "exempt",
					outcome: "accepted",
					bytes: expect.stringContaining("\x1b[2J"),
				}),
			);
		} finally {
			tui.stop();
		}
	});
});
