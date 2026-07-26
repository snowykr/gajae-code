import { Container, Text, TUI, type TuiTransactionObservation } from "@gajae-code/tui";
import chalk from "chalk";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { Settings } from "../../../src/config/settings";
import { CustomEditor } from "../../../src/modes/components/custom-editor";
import { GajaePetWidget, type PetMode } from "../../../src/modes/components/gajae-pet-widget";
import { ToolExecutionComponent } from "../../../src/modes/components/tool-execution";
import { getEditorTheme, initTheme } from "../../../src/modes/theme/theme";

/** Stable, ordered state keys for the Pet renderer visual-QA follow-up. */
export const PET_RENDERER_VISUAL_SHOWCASE_STATE_KEYS = [
	"pet-off",
	"pet-idle-red",
	"pet-working-blue",
	"tool-running",
	"durable-history-replay",
	"reservation-narrow",
	"transaction-shared-failure",
	"transaction-overlay-failure",
	"accessibility-ascii",
	"no-motion",
	"cjk-semantic-wrap",
	"unsupported-capability",
] as const;
export type PetRendererVisualShowcaseStateKey = (typeof PET_RENDERER_VISUAL_SHOWCASE_STATE_KEYS)[number];
export const PET_RENDERER_VISUAL_SHOWCASE_STATE_KEYS_ORDER = PET_RENDERER_VISUAL_SHOWCASE_STATE_KEYS;

export const PET_RENDERER_VISUAL_SHOWCASE_VIEWPORTS = [
	{ key: "80x24", columns: 80, rows: 24 },
	{ key: "120x36", columns: 120, rows: 36 },
	{ key: "160x48", columns: 160, rows: 48 },
] as const;
export type PetRendererVisualShowcaseViewportKey = (typeof PET_RENDERER_VISUAL_SHOWCASE_VIEWPORTS)[number]["key"];
export type PetRendererVisualShowcaseRenderMode = "unicode-color" | "ascii-no-color";
export const PET_RENDERER_VISUAL_SHOWCASE_VIEWPORT_KEYS = PET_RENDERER_VISUAL_SHOWCASE_VIEWPORTS.map(
	viewport => viewport.key,
);

export const PET_RENDERER_VISUAL_SHOWCASE_PROFILES = [
	{ key: "off", mode: "off", working: false, description: "Text-only composer with an explicit Pet-off state." },
	{ key: "idle-red", mode: "red", working: false, description: "Red Pet beside an idle composer." },
	{ key: "working-blue", mode: "blue", working: true, description: "Blue Pet while a tool and composer are working." },
	{ key: "tool", mode: "red", working: false, description: "Real ToolExecutionComponent output and call identity." },
	{ key: "history", mode: "red", working: false, description: "Durable tool snapshot and replay acknowledgement." },
	{
		key: "narrow-reservation",
		mode: "red",
		working: false,
		description: "Reservation hides safely when width cannot fit.",
	},
	{
		key: "shared-transaction",
		mode: "red",
		working: false,
		description: "Shared renderer transaction is the commit authority.",
	},
	{
		key: "overlay-transaction",
		mode: "red",
		working: false,
		description: "Pet payload is exempt and independently retryable.",
	},
	{
		key: "ascii-accessibility",
		mode: "off",
		working: false,
		description: "ASCII/no-color state keeps textual affordances.",
	},
	{ key: "no-motion", mode: "off", working: false, description: "Discrete state with no animation-only signal." },
	{ key: "cjk", mode: "off", working: false, description: "CJK and mixed CJK/Latin semantic wrapping corpus." },
	{ key: "unsupported", mode: "red", working: false, description: "Saved Pet mode with no graphics capability." },
] as const;
export type PetRendererVisualShowcaseProfileKey = (typeof PET_RENDERER_VISUAL_SHOWCASE_PROFILES)[number]["key"];
export const PET_RENDERER_VISUAL_SHOWCASE_PROFILE_KEYS = PET_RENDERER_VISUAL_SHOWCASE_PROFILES.map(
	profile => profile.key,
);

export const PET_RENDERER_VISUAL_SHOWCASE_CAPABILITIES = [
	{
		key: "sixel",
		protocol: "sixel",
		terminal: "xterm-256color",
		graphics: true,
		description: "Sixel overlay accepted after the shared frame.",
	},
	{
		key: "kitty",
		protocol: "kitty",
		terminal: "xterm-kitty",
		graphics: true,
		description: "Kitty placement and image cleanup are exempt physical writes.",
	},
	{
		key: "none",
		protocol: null,
		terminal: "xterm-256color",
		graphics: false,
		description: "No image protocol; text and tool/history semantics remain available.",
	},
] as const;
export type PetRendererVisualShowcaseCapabilityKey = (typeof PET_RENDERER_VISUAL_SHOWCASE_CAPABILITIES)[number]["key"];
export const PET_RENDERER_VISUAL_SHOWCASE_CAPABILITY_KEYS = PET_RENDERER_VISUAL_SHOWCASE_CAPABILITIES.map(
	capability => capability.key,
);

export type PetRendererVisualShowcaseCheckpointKind =
	| "semantic"
	| "reservation"
	| "transaction"
	| "accessibility"
	| "motion"
	| "cjk"
	| "durable-history"
	| "xterm";

export interface PetRendererVisualShowcaseCheckpoint {
	readonly id: string;
	readonly kind: PetRendererVisualShowcaseCheckpointKind;
	readonly assertion: string;
}

export const PET_RENDERER_VISUAL_SHOWCASE_CHECKPOINTS = [
	{
		id: "semantic-state-is-textual",
		kind: "semantic",
		assertion: "The composer, working/tool status, and Pet mode remain named in terminal text.",
	},
	{
		id: "reservation-is-measured",
		kind: "reservation",
		assertion: "The editor uses the measured reserve and remains usable when the Pet cannot fit.",
	},
	{
		id: "shared-before-overlay",
		kind: "transaction",
		assertion: "A shared TUI transaction is observed before any Sixel or Kitty payload.",
	},
	{
		id: "overlay-is-exempt",
		kind: "transaction",
		assertion: "Graphics placement and cleanup are exempt physical output, not history bytes.",
	},
	{
		id: "ascii-retains-affordances",
		kind: "accessibility",
		assertion: "ASCII/no-color retains labels, borders, cursor meaning, and recovery text.",
	},
	{
		id: "discrete-no-motion",
		kind: "motion",
		assertion: "No animation-only signal is required to understand this state.",
	},
	{
		id: "cjk-semantic-breaks",
		kind: "cjk",
		assertion: "CJK wraps only at declared semantic boundaries and never through protected spans.",
	},
	{
		id: "durable-revision-visible",
		kind: "durable-history",
		assertion: "A stable tool identity and revision produce an xterm-replayable durable snapshot.",
	},
	{
		id: "xterm-cell-surface",
		kind: "xterm",
		assertion: "The capture is read from the real xterm-compatible VirtualTerminal viewport.",
	},
] as const satisfies readonly PetRendererVisualShowcaseCheckpoint[];

export interface PetRendererVisualShowcaseProtectedSpan {
	readonly text: string;
	readonly kind: "action-label" | "status-name" | "tool-identifier" | "code-config" | "masked-value";
}

export interface PetRendererVisualShowcaseCjkCorpusEntry {
	readonly key: string;
	readonly language: "korean" | "japanese" | "chinese" | "mixed";
	readonly text: string;
	readonly allowedSemanticBreaks: readonly string[];
	readonly protectedSpans: readonly PetRendererVisualShowcaseProtectedSpan[];
}

export const PET_RENDERER_VISUAL_SHOWCASE_CJK_CORPUS = [
	{
		key: "korean-tool-status",
		language: "korean",
		text: "도구 실행 중 · 결과를 durable-history에 저장합니다",
		allowedSemanticBreaks: ["도구 실행 중 ·", "결과를 durable-history에 저장합니다"],
		protectedSpans: [
			{ text: "도구 실행 중", kind: "status-name" },
			{ text: "durable-history", kind: "code-config" },
		],
	},
	{
		key: "japanese-action",
		language: "japanese",
		text: "Petを無効化 · Composerをそのまま表示",
		allowedSemanticBreaks: ["Petを無効化 ·", "Composerをそのまま表示"],
		protectedSpans: [
			{ text: "Petを無効化", kind: "action-label" },
			{ text: "Composer", kind: "code-config" },
		],
	},
	{
		key: "chinese-recovery",
		language: "chinese",
		text: "图像能力不可用 · 保留文本并重试清理",
		allowedSemanticBreaks: ["图像能力不可用 ·", "保留文本并重试清理"],
		protectedSpans: [
			{ text: "图像能力不可用", kind: "status-name" },
			{ text: "重试清理", kind: "action-label" },
		],
	},
	{
		key: "mixed-protected",
		language: "mixed",
		text: "保存到 ~/.gjc/sessions · token=•••••••• · Esc 取消",
		allowedSemanticBreaks: ["保存到 ~/.gjc/sessions ·", "token=•••••••• · Esc 取消"],
		protectedSpans: [
			{ text: "~/.gjc/sessions", kind: "code-config" },
			{ text: "token=••••••••", kind: "masked-value" },
			{ text: "Esc 取消", kind: "action-label" },
		],
	},
] as const satisfies readonly PetRendererVisualShowcaseCjkCorpusEntry[];

interface PetRendererVisualShowcaseStateDefinition {
	readonly stateKey: PetRendererVisualShowcaseStateKey;
	readonly profileKey: PetRendererVisualShowcaseProfileKey;
	readonly capabilityKey: PetRendererVisualShowcaseCapabilityKey;
	readonly renderMode: PetRendererVisualShowcaseRenderMode;
	readonly checkpoints: readonly PetRendererVisualShowcaseCheckpoint[];
	readonly corpusKey?: string;
}

const checkpoint = (
	id: (typeof PET_RENDERER_VISUAL_SHOWCASE_CHECKPOINTS)[number]["id"],
): PetRendererVisualShowcaseCheckpoint => {
	const found = PET_RENDERER_VISUAL_SHOWCASE_CHECKPOINTS.find(candidate => candidate.id === id);
	if (!found) throw new Error(`Unknown Pet showcase checkpoint: ${id}`);
	return found;
};

const stateDefinitions: readonly PetRendererVisualShowcaseStateDefinition[] = [
	{
		stateKey: "pet-off",
		profileKey: "off",
		capabilityKey: "none",
		renderMode: "unicode-color",
		checkpoints: [checkpoint("semantic-state-is-textual"), checkpoint("xterm-cell-surface")],
	},
	{
		stateKey: "pet-idle-red",
		profileKey: "idle-red",
		capabilityKey: "sixel",
		renderMode: "unicode-color",
		checkpoints: [
			checkpoint("semantic-state-is-textual"),
			checkpoint("reservation-is-measured"),
			checkpoint("shared-before-overlay"),
			checkpoint("overlay-is-exempt"),
		],
	},
	{
		stateKey: "pet-working-blue",
		profileKey: "working-blue",
		capabilityKey: "kitty",
		renderMode: "unicode-color",
		checkpoints: [
			checkpoint("semantic-state-is-textual"),
			checkpoint("shared-before-overlay"),
			checkpoint("overlay-is-exempt"),
		],
	},
	{
		stateKey: "tool-running",
		profileKey: "tool",
		capabilityKey: "sixel",
		renderMode: "unicode-color",
		checkpoints: [
			checkpoint("semantic-state-is-textual"),
			checkpoint("durable-revision-visible"),
			checkpoint("shared-before-overlay"),
		],
	},
	{
		stateKey: "durable-history-replay",
		profileKey: "history",
		capabilityKey: "kitty",
		renderMode: "unicode-color",
		checkpoints: [
			checkpoint("durable-revision-visible"),
			checkpoint("shared-before-overlay"),
			checkpoint("xterm-cell-surface"),
		],
	},
	{
		stateKey: "reservation-narrow",
		profileKey: "narrow-reservation",
		capabilityKey: "sixel",
		renderMode: "unicode-color",
		checkpoints: [checkpoint("reservation-is-measured"), checkpoint("semantic-state-is-textual")],
	},
	{
		stateKey: "transaction-shared-failure",
		profileKey: "shared-transaction",
		capabilityKey: "sixel",
		renderMode: "unicode-color",
		checkpoints: [
			checkpoint("shared-before-overlay"),
			checkpoint("overlay-is-exempt"),
			checkpoint("durable-revision-visible"),
		],
	},
	{
		stateKey: "transaction-overlay-failure",
		profileKey: "overlay-transaction",
		capabilityKey: "kitty",
		renderMode: "unicode-color",
		checkpoints: [
			checkpoint("shared-before-overlay"),
			checkpoint("overlay-is-exempt"),
			checkpoint("xterm-cell-surface"),
		],
	},
	{
		stateKey: "accessibility-ascii",
		profileKey: "ascii-accessibility",
		capabilityKey: "none",
		renderMode: "ascii-no-color",
		checkpoints: [
			checkpoint("ascii-retains-affordances"),
			checkpoint("semantic-state-is-textual"),
			checkpoint("xterm-cell-surface"),
		],
	},
	{
		stateKey: "no-motion",
		profileKey: "no-motion",
		capabilityKey: "none",
		renderMode: "unicode-color",
		checkpoints: [checkpoint("discrete-no-motion"), checkpoint("semantic-state-is-textual")],
	},
	{
		stateKey: "cjk-semantic-wrap",
		profileKey: "cjk",
		capabilityKey: "none",
		renderMode: "unicode-color",
		corpusKey: "mixed-protected",
		checkpoints: [
			checkpoint("cjk-semantic-breaks"),
			checkpoint("semantic-state-is-textual"),
			checkpoint("xterm-cell-surface"),
		],
	},
	{
		stateKey: "unsupported-capability",
		profileKey: "unsupported",
		capabilityKey: "none",
		renderMode: "unicode-color",
		checkpoints: [
			checkpoint("semantic-state-is-textual"),
			checkpoint("reservation-is-measured"),
			checkpoint("ascii-retains-affordances"),
		],
	},
];

export interface PetRendererVisualShowcaseEntry {
	readonly key: string;
	readonly stateKey: PetRendererVisualShowcaseStateKey;
	readonly profileKey: PetRendererVisualShowcaseProfileKey;
	readonly capabilityKey: PetRendererVisualShowcaseCapabilityKey;
	readonly viewportKey: PetRendererVisualShowcaseViewportKey;
	readonly viewport: (typeof PET_RENDERER_VISUAL_SHOWCASE_VIEWPORTS)[number];
	readonly renderMode: PetRendererVisualShowcaseRenderMode;
	readonly checkpoints: readonly PetRendererVisualShowcaseCheckpoint[];
	readonly corpusKey?: string;
}

export const PET_RENDERER_VISUAL_SHOWCASE_EXPECTED_ENTRY_COUNT = 36;

export const PET_RENDERER_VISUAL_SHOWCASE_ENTRIES: readonly PetRendererVisualShowcaseEntry[] = stateDefinitions.flatMap(
	definition =>
		PET_RENDERER_VISUAL_SHOWCASE_VIEWPORTS.map(viewport => ({
			key: `${definition.stateKey}/${definition.profileKey}/${definition.capabilityKey}/${viewport.key}/${definition.renderMode}`,
			stateKey: definition.stateKey,
			profileKey: definition.profileKey,
			capabilityKey: definition.capabilityKey,
			viewportKey: viewport.key,
			viewport,
			renderMode: definition.renderMode,
			checkpoints: definition.checkpoints,
			corpusKey: definition.corpusKey,
		})),
);

export function assertPetRendererVisualShowcaseMatrix(
	entries: readonly PetRendererVisualShowcaseEntry[] = PET_RENDERER_VISUAL_SHOWCASE_ENTRIES,
): void {
	if (entries.length !== PET_RENDERER_VISUAL_SHOWCASE_EXPECTED_ENTRY_COUNT) {
		throw new Error(
			`Pet showcase entry count mismatch: expected ${PET_RENDERER_VISUAL_SHOWCASE_EXPECTED_ENTRY_COUNT}, got ${entries.length}`,
		);
	}
	if (
		PET_RENDERER_VISUAL_SHOWCASE_EXPECTED_ENTRY_COUNT !==
		PET_RENDERER_VISUAL_SHOWCASE_STATE_KEYS.length * PET_RENDERER_VISUAL_SHOWCASE_VIEWPORTS.length
	) {
		throw new Error("Pet showcase expected count does not match ordered state and viewport axes");
	}
	for (const sample of PET_RENDERER_VISUAL_SHOWCASE_CJK_CORPUS) {
		for (const boundary of sample.allowedSemanticBreaks) {
			if (!sample.text.includes(boundary))
				throw new Error(`CJK boundary is not in corpus ${sample.key}: ${boundary}`);
		}
		for (const span of sample.protectedSpans) {
			if (!sample.text.includes(span.text))
				throw new Error(`Protected CJK span is not in corpus ${sample.key}: ${span.text}`);
		}
	}
	const keys = new Set<string>();
	for (const entry of entries) {
		if (keys.has(entry.key)) throw new Error(`Duplicate Pet showcase entry key: ${entry.key}`);
		keys.add(entry.key);
		if (!PET_RENDERER_VISUAL_SHOWCASE_STATE_KEYS.includes(entry.stateKey))
			throw new Error(`Unknown Pet state: ${entry.stateKey}`);
		if (!PET_RENDERER_VISUAL_SHOWCASE_VIEWPORTS.some(viewport => viewport.key === entry.viewportKey))
			throw new Error(`Unknown Pet viewport: ${entry.viewportKey}`);
		if (entry.corpusKey && !PET_RENDERER_VISUAL_SHOWCASE_CJK_CORPUS.some(corpus => corpus.key === entry.corpusKey))
			throw new Error(`Unknown Pet corpus: ${entry.corpusKey}`);
	}
}

assertPetRendererVisualShowcaseMatrix();

export interface PetRendererVisualShowcaseDurableHistory {
	readonly identity: string;
	readonly revision: number;
	readonly final: boolean;
	readonly snapshot: readonly string[];
	readonly acknowledged: boolean;
}

export interface PetRendererVisualShowcaseRender {
	readonly terminalText: string;
	readonly terminalAnsiText: string;
	readonly captureMode: "live-tui-xterm";
	readonly rawPtyPublished: false;
	readonly entry: PetRendererVisualShowcaseEntry;
	readonly petProtocol: "sixel" | "kitty" | null;
	readonly durableHistory?: PetRendererVisualShowcaseDurableHistory;
	readonly transactions: readonly TuiTransactionObservation[];
	readonly viewport: readonly string[];
}

function stateDefinition(stateKey: PetRendererVisualShowcaseStateKey): PetRendererVisualShowcaseStateDefinition {
	const definition = stateDefinitions.find(candidate => candidate.stateKey === stateKey);
	if (!definition) throw new Error(`Unknown Pet showcase state: ${stateKey}`);
	return definition;
}

function profile(profileKey: PetRendererVisualShowcaseProfileKey) {
	const found = PET_RENDERER_VISUAL_SHOWCASE_PROFILES.find(candidate => candidate.key === profileKey);
	if (!found) throw new Error(`Unknown Pet showcase profile: ${profileKey}`);
	return found;
}

function capability(capabilityKey: PetRendererVisualShowcaseCapabilityKey) {
	const found = PET_RENDERER_VISUAL_SHOWCASE_CAPABILITIES.find(candidate => candidate.key === capabilityKey);
	if (!found) throw new Error(`Unknown Pet showcase capability: ${capabilityKey}`);
	return found;
}

function corpus(corpusKey: string | undefined): PetRendererVisualShowcaseCjkCorpusEntry | undefined {
	if (!corpusKey) return undefined;
	const found = PET_RENDERER_VISUAL_SHOWCASE_CJK_CORPUS.find(candidate => candidate.key === corpusKey);
	if (!found) throw new Error(`Unknown Pet showcase corpus: ${corpusKey}`);
	return found;
}

/** Render one matrix entry through the real TUI, Pet, composer, Tool, history, and xterm test harness. */
export async function renderPetRendererVisualShowcase(
	entry: PetRendererVisualShowcaseEntry,
): Promise<PetRendererVisualShowcaseRender> {
	const definition = stateDefinition(entry.stateKey);
	const selectedProfile = profile(definition.profileKey);
	const selectedCapability = capability(definition.capabilityKey);
	const selectedCorpus = corpus(definition.corpusKey);
	const originalChalkLevel = chalk.level;
	chalk.level = 3;
	try {
		await Settings.init({ inMemory: true });
		await initTheme(
			false,
			entry.renderMode === "ascii-no-color" ? "ascii" : "unicode",
			false,
			"red-claw",
			"red-claw",
		);
	} catch (error) {
		chalk.level = originalChalkLevel;
		throw error;
	}

	const terminal = new VirtualTerminal(entry.viewport.columns, entry.viewport.rows, { isProcessTerminal: true });
	const ui = new TUI(terminal, false);
	const transactions: TuiTransactionObservation[] = [];
	ui.setTransactionObserver(observation => transactions.push(observation));
	const transcript = new Container();
	transcript.addChild(new Text(`Pet ${entry.stateKey} · ${selectedCapability.description}`, 1, 0));
	const tool = new ToolExecutionComponent(
		"bash",
		{ command: selectedCorpus?.text ?? "printf 'deterministic Pet tool checkpoint'" },
		{ showImages: false },
		undefined,
		ui,
		"/showcase",
		`pet-showcase/${entry.stateKey}`,
	);
	tool.updateArgs({ command: selectedCorpus?.text ?? "printf 'deterministic Pet tool checkpoint'" });
	tool.setArgsComplete();
	tool.updateResult(
		{
			content: [
				{
					type: "text",
					text: selectedCorpus?.text ?? `tool status: ${selectedProfile.description}`,
				},
			],
		},
		selectedProfile.working,
	);
	tool.setExpanded(true);

	const editor = new CustomEditor(getEditorTheme());
	editor.setBorderVisible(true);
	editor.setBorderStyle("round");
	editor.setClosedBorderBox(true);
	editor.setInputPrefix("> ");
	editor.setPlaceholder(selectedCorpus?.text ?? "Type a message; Pet state remains supplementary");
	editor.setPaddingX(1);
	editor.setRightGutterWidth(1);
	editor.setText(selectedCorpus?.text ?? "composer checkpoint");
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const floorContainer = new Container();
	ui.addChild(transcript);
	ui.addChild(tool);
	ui.addChild(editorContainer);
	ui.addChild(floorContainer);

	const pet = new GajaePetWidget({
		ui,
		editor,
		editorContainer,
		floorContainer,
		isWorking: () => selectedProfile.working,
		getComposerBottomOffset: () => floorContainer.render(entry.viewport.columns).length,
		forcePixelProtocol: selectedCapability.protocol ?? undefined,
		autoFlexGapMs: null,
	});
	try {
		ui.start();
		await terminal.waitForRender();
		if (selectedProfile.mode !== "off") pet.setMode(selectedProfile.mode as PetMode);
		await terminal.waitForRender();
		const durableEvent = tool.getDurableHistoryEvent(entry.viewport.columns);
		const durableHistory = durableEvent
			? {
					identity: durableEvent.identity,
					revision: durableEvent.revision,
					final: durableEvent.final,
					snapshot: durableEvent.snapshot,
					acknowledged: true,
				}
			: undefined;
		if (durableEvent) tool.acknowledgeDurableHistoryEvent(durableEvent.identity, durableEvent.revision);
		await terminal.flush();
		const viewport = terminal.getViewport();
		const terminalAnsiText = terminal.getWriteLog().join("");
		return {
			terminalText: `${viewport.join("\n")}\n`,
			terminalAnsiText: entry.renderMode === "ascii-no-color" ? Bun.stripANSI(terminalAnsiText) : terminalAnsiText,
			captureMode: "live-tui-xterm",
			rawPtyPublished: false,
			entry,
			petProtocol: selectedCapability.protocol,
			durableHistory,
			transactions: [...transactions],
			viewport,
		};
	} finally {
		pet.dispose();
		ui.dispose();
		chalk.level = originalChalkLevel;
	}
}

// Compatibility aliases keep the fixture discoverable by generic TUI showcase tooling.
export const PET_RENDERER_SHOWCASE_ENTRIES = PET_RENDERER_VISUAL_SHOWCASE_ENTRIES;
export const PET_RENDERER_SHOWCASE_EXPECTED_ENTRY_COUNT = PET_RENDERER_VISUAL_SHOWCASE_EXPECTED_ENTRY_COUNT;
