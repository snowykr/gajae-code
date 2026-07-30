import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@gajae-code/coding-agent/config/settings";
import { type IrcSidebarTheme, IrcSplitViewComponent } from "@gajae-code/coding-agent/modes/components/irc-sidebar";
import { ToolExecutionComponent } from "@gajae-code/coding-agent/modes/components/tool-execution";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import * as themeModule from "@gajae-code/coding-agent/modes/theme/theme";
import { ImageProtocol, TERMINAL, type TUI } from "@gajae-code/tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await themeModule.initTheme(false, undefined, undefined, "red-claw", "blue-crab");
});

const uiStub = { requestRender() {} } as unknown as TUI;

const sidebarTheme = {
	fg: (_color: "dim" | "accent", text: string) => text,
	bold: (text: string) => text,
	boxSharp: { vertical: "|" },
} satisfies IrcSidebarTheme;

const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
const originalImageProtocol = TERMINAL.imageProtocol;
const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };

afterEach(() => {
	if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
	if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
	terminal.imageProtocol = originalImageProtocol;
});

function renderTool(command: string): string[] {
	const component = new ToolExecutionComponent("bash", { command }, {}, undefined, uiStub);
	component.updateResult({ content: [{ type: "text", text: `output of ${command}` }], isError: false }, false);
	return component.render(80).map(line => Bun.stripANSI(line));
}

function countEdgeBlanks(lines: string[]): { leading: number; trailing: number } {
	let leading = 0;
	for (let i = 0; i < lines.length && lines[i].trim() === ""; i++) leading++;
	let trailing = 0;
	for (let i = lines.length - 1; i >= 0 && lines[i].trim() === ""; i--) trailing++;
	return { leading, trailing };
}

// 083.2: block separation is exactly the leading Spacer (1 blank line above each
// block); the content box itself has no vertical padding. Two consecutive tools
// must be separated by exactly 1 blank line.
describe("ToolExecutionComponent spacing", () => {
	it("renders exactly one blank line above and none below a tool block", () => {
		const lines = renderTool("ls -la");
		const { leading, trailing } = countEdgeBlanks(lines);
		expect(leading).toBe(1);
		expect(trailing).toBe(0);
	});

	it("separates consecutive tool blocks by exactly one blank line", () => {
		const a = renderTool("ls -la");
		const b = renderTool("git status");
		const { trailing } = countEdgeBlanks(a);
		const { leading } = countEdgeBlanks(b);
		expect(trailing + leading).toBe(1);
	});
});
it("uses a supplied bare relative cwd for apply_patch previews", async () => {
	const relativeCwd = `worktree-${process.pid}-${Date.now()}`;
	const absoluteCwd = path.join(process.cwd(), relativeCwd);
	const fileName = "tool-execution-cwd.ts";
	await fs.mkdir(absoluteCwd);
	try {
		await Bun.write(path.join(absoluteCwd, fileName), "const value = 1;\n");
		const input = [
			"*** Begin Patch",
			`*** Update File: ${fileName}`,
			"@@",
			"-const value = 1;",
			"+const value = 2;",
			"*** End Patch",
		].join("\n");
		const component = new ToolExecutionComponent("apply_patch", { input }, {}, undefined, uiStub, relativeCwd);

		component.setArgsComplete();
		await Bun.sleep(50);

		const rendered = Bun.stripANSI(component.render(160).join("\n"));
		expect(rendered).toContain("(preview)");
		expect(rendered).toContain("const value = 2;");
	} finally {
		await fs.rm(absoluteCwd, { recursive: true, force: true });
	}
});
it("preserves manual expansion through automatic updates and drops it on remount", () => {
	const component = new ToolExecutionComponent("custom", { path: "/tmp/example.ts" }, {}, undefined, uiStub);
	component.setManuallyExpanded(true);
	component.setExpanded(false);

	expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Args");

	const remounted = new ToolExecutionComponent("custom", { path: "/tmp/example.ts" }, {}, undefined, uiStub);
	remounted.setExpanded(false);
	expect(Bun.stripANSI(remounted.render(80).join("\n"))).not.toContain("Args");
});

it("lets untouched components follow automatic expansion", () => {
	const component = new ToolExecutionComponent("custom", { path: "/tmp/example.ts" }, {}, undefined, uiStub);
	component.setExpanded(true);

	expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("Args");
});

it("replaces generic SIXEL output while the IRC sidebar is visible and restores passthrough when hidden", () => {
	terminal.imageProtocol = ImageProtocol.Sixel;
	Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
	Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
	const sixel = "\x1bPqcustom-image\x1b\\";
	const component = new ToolExecutionComponent("custom", {}, {}, undefined, uiStub);
	component.updateResult({ content: [{ type: "text", text: `before\n${sixel}\nafter` }], isError: false }, false);
	const split = new IrcSplitViewComponent(component, new IrcObservationLedger(), sidebarTheme);

	expect(split.render(120).join("\n")).toContain(sixel);
	split.setVisible(true);
	const visible = split.render(120).join("\n");
	expect(visible).not.toContain("\x1bP");
	expect(Bun.stripANSI(visible).split("[SIXEL image hidden while IRC sidebar is visible]").length - 1).toBe(1);
	split.setVisible(false);
	expect(split.render(120).join("\n")).toContain(sixel);
});
it("does not reuse a stale Kitty conversion after replacing an image at the same slot", async () => {
	terminal.imageProtocol = ImageProtocol.Kitty;
	const firstImage = Buffer.from(
		await Bun.file(path.join(import.meta.dir, "../../../../../assets/tool-image-fixture.webp")).arrayBuffer(),
	).toBase64();
	const replacementImage =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
	const releases: Array<() => void> = [];
	const originalToBase64 = Bun.Image.prototype.toBase64;
	const toBase64Spy = vi.spyOn(Bun.Image.prototype, "toBase64").mockImplementation(function (this: Bun.Image) {
		const deferred = Promise.withResolvers<string>();
		releases.push(() => {
			void originalToBase64.call(this).then(deferred.resolve, deferred.reject);
		});
		return deferred.promise;
	});
	let requests = 0;
	const ui = { requestRender: () => requests++ } as unknown as TUI;
	try {
		const component = new ToolExecutionComponent("custom", {}, {}, undefined, ui);
		component.updateResult({ content: [{ type: "image", data: firstImage, mimeType: "image/webp" }] }, false);
		component.updateResult({ content: [{ type: "image", data: replacementImage, mimeType: "image/webp" }] }, false);

		expect(releases).toHaveLength(2);
		releases[0]();
		await Bun.sleep(10);
		expect(requests).toBe(1);
		expect(component.render(80).join("\n")).not.toContain("\x1b_G");

		releases[1]();
		await Bun.sleep(10);
		expect(requests).toBe(2);
		expect(component.render(80).join("\n")).toContain("\x1b_G");
	} finally {
		toBase64Spy.mockRestore();
	}
});
it("reuses a Kitty conversion for a recreated equivalent image object", async () => {
	terminal.imageProtocol = ImageProtocol.Kitty;
	const image = Buffer.from(
		await Bun.file(path.join(import.meta.dir, "../../../../../assets/tool-image-fixture.webp")).arrayBuffer(),
	).toBase64();
	const releases: Array<() => void> = [];
	const originalToBase64 = Bun.Image.prototype.toBase64;
	const toBase64Spy = vi.spyOn(Bun.Image.prototype, "toBase64").mockImplementation(function (this: Bun.Image) {
		const deferred = Promise.withResolvers<string>();
		releases.push(() => {
			void originalToBase64.call(this).then(deferred.resolve, deferred.reject);
		});
		return deferred.promise;
	});
	let requests = 0;
	const ui = { requestRender: () => requests++ } as unknown as TUI;
	try {
		const component = new ToolExecutionComponent("custom", {}, {}, undefined, ui);
		component.updateResult(
			{
				content: [
					{ type: "image", data: image, mimeType: "image/webp" },
					{ type: "text", text: "first update" },
				],
			},
			true,
		);
		component.updateResult(
			{
				content: [
					{ type: "image", data: image, mimeType: "image/webp" },
					{ type: "text", text: "second update" },
				],
			},
			true,
		);

		expect(releases).toHaveLength(1);
		releases[0]();
		await Bun.sleep(10);
		expect(requests).toBe(1);
		component.updateResult(
			{
				content: [
					{ type: "image", data: image, mimeType: "image/webp" },
					{ type: "text", text: "third update" },
				],
			},
			true,
		);
		expect(releases).toHaveLength(1);
		expect(component.render(80).join("\n")).toContain("\x1b_G");
	} finally {
		toBase64Spy.mockRestore();
	}
});
it("requests a render after a Kitty conversion rejects", async () => {
	terminal.imageProtocol = ImageProtocol.Kitty;
	const image = Buffer.from(
		await Bun.file(path.join(import.meta.dir, "../../../../../assets/tool-image-fixture.webp")).arrayBuffer(),
	).toBase64();
	const toBase64Spy = vi
		.spyOn(Bun.Image.prototype, "toBase64")
		.mockImplementation(() => Promise.reject(new Error("conversion failed")));
	let requests = 0;
	const ui = { requestRender: () => requests++ } as unknown as TUI;
	try {
		const component = new ToolExecutionComponent("custom", {}, {}, undefined, ui);
		component.updateResult({ content: [{ type: "image", data: image, mimeType: "image/webp" }] }, false);

		await Bun.sleep(10);

		expect(requests).toBe(1);
	} finally {
		toBase64Spy.mockRestore();
	}
});

describe("ToolExecutionComponent durable lifecycle", () => {
	it("keeps the tool identity stable while revisions advance to a final event", () => {
		const component = new ToolExecutionComponent(
			"custom",
			{ path: "/tmp/example.ts" },
			{},
			undefined,
			uiStub,
			".",
			"tool-call-1",
		);

		const initial = component.getDurableHistoryEvent(80)!;
		expect(initial.identity).toBe("tool-call-1");
		expect(initial.revision).toBeGreaterThan(0);
		expect(initial.final).toBe(false);

		component.updateArgs({ path: "/tmp/example.ts", content: "updated" }, "different-call-id");
		const streaming = component.getDurableHistoryEvent(80)!;
		expect(streaming.identity).toBe(initial.identity);
		expect(streaming.revision).toBeGreaterThan(initial.revision);
		expect(streaming.final).toBe(false);

		component.setArgsComplete("different-call-id");
		const argsComplete = component.getDurableHistoryEvent(80)!;
		expect(argsComplete.identity).toBe(initial.identity);
		expect(argsComplete.revision).toBeGreaterThan(streaming.revision);
		expect(argsComplete.final).toBe(false);

		component.updateResult({ content: [{ type: "text", text: "done" }] }, false, "different-call-id");
		const completed = component.getDurableHistoryEvent(80)!;
		expect(completed.identity).toBe(initial.identity);
		expect(completed.revision).toBeGreaterThan(argsComplete.revision);
		expect(completed.final).toBe(true);
		expect(completed.snapshot.join("\n")).toContain("done");
	});

	it("does not emit a durable event without a tool call identity", () => {
		const component = new ToolExecutionComponent("custom", {}, {}, undefined, uiStub);

		expect(component.getDurableHistoryEvent(80)).toBeUndefined();
	});

	it("ignores invalid or foreign acknowledgements without changing the durable revision", () => {
		const component = new ToolExecutionComponent("custom", {}, {}, undefined, uiStub, ".", "tool-call-2");
		const event = component.getDurableHistoryEvent(80)!;

		component.acknowledgeDurableHistoryEvent("other-call", event.revision);
		component.acknowledgeDurableHistoryEvent("tool-call-2", 0);
		component.acknowledgeDurableHistoryEvent("tool-call-2", event.revision + 1);

		const afterInvalidAcks = component.getDurableHistoryEvent(80)!;
		expect(afterInvalidAcks.identity).toBe(event.identity);
		expect(afterInvalidAcks.revision).toBe(event.revision);
		expect(afterInvalidAcks.final).toBe(false);

		component.acknowledgeDurableHistoryEvent("tool-call-2", event.revision);
		expect(component.getDurableHistoryEvent(80)).toBeUndefined();

		component.updateArgs({ changed: true });
		const reactivated = component.getDurableHistoryEvent(80);
		expect(reactivated).toBeDefined();
		expect(reactivated!.revision).toBeGreaterThan(event.revision);
	});
	it("does not reopen an acknowledged final revision on layout invalidation", () => {
		const component = new ToolExecutionComponent("custom", {}, {}, undefined, uiStub, ".", "tool-call-3");
		component.updateResult({ content: [{ type: "text", text: "done" }] }, false);

		const finalEvent = component.getDurableHistoryEvent(80)!;
		expect(finalEvent.final).toBe(true);
		component.acknowledgeDurableHistoryEvent("tool-call-3", finalEvent.revision);
		expect(component.getDurableHistoryEvent(80)).toBeUndefined();

		component.invalidate();
		expect(component.getDurableHistoryEvent(80)).toBeUndefined();

		component.updateResult({ content: [{ type: "text", text: "changed" }] }, false);
		const changedEvent = component.getDurableHistoryEvent(80);
		expect(changedEvent).toBeDefined();
		expect(changedEvent!.revision).toBeGreaterThan(finalEvent.revision);
		expect(changedEvent!.final).toBe(true);
		expect(changedEvent!.snapshot.join("\n")).toContain("changed");
	});
});
