# Modes TUI design system

## Workflow branch and sources

This surface uses the **extract existing system first** branch from
[`docs/ui-design-visual-qa.md`](../../../../docs/ui-design-visual-qa.md). The
rules below are extracted from the current settings selector and shared TUI
components; they are first-party implementation guidance, not a third-party
reference or a screenshot substitute.

Source material:

- `components/settings-selector.ts` and `components/settings-defs.ts`
- `components/provider-onboarding-selector.ts` and `components/dynamic-border.ts`
- the status-line custom editor embedded in `components/settings-selector.ts`
- `../theme/theme.ts` and `../shared.ts`
- `packages/tui/src/components/tab-bar.ts`, `settings-list.ts`, `select-list.ts`,
  and `input.ts`
- `components/gajae-pet-widget.ts`, `components/iterm-pet-transport.ts`, and
  `components/pet-capability.ts`
- `packages/tui/src/components/gajae-pet.ts` and the terminal capability
  transport APIs
- `test/gajae-pet-widget.test.ts` for focused placement and cleanup invariants

## Corrective iTerm Pet guidance

This section is **corrective first-party design documentation** for the selected
workflow branch. It records the contract that the iTerm Pet surface must satisfy;
it is not evidence that this guidance preceded implementation, and it is not a
live-terminal, independent-review, or capture-provenance claim.

The Pet is a 16×16 real-pixel sprite presented in a two-terminal-row footprint
beside the composer. Its component anatomy is:

1. `PetFramedEditor` wraps the existing composer and reserves only the Pet's
   measured cell width plus a one-cell right inset. It narrows the editor; it
   does not add a floor row or replace the editor's input behavior.
2. `GajaePetWidget` owns the mode, skin/frame timeline, cell-metric rebuild,
   composer-bottom calculation, and overlay lifecycle.
3. The post-render overlay emitter re-applies the absolute-positioned raster
   after ordinary TUI writes, while animation frame swaps go through the TUI
   output queue. The overlay must not move the hardware/IME cursor.
4. A raster lease owns the iTerm placement rectangle. Disable, disposal,
   capability loss, topology loss, and resize invalidate that lease before a
   replacement can be submitted. Cleanup authority is retained until erase or
   image deletion is actually delivered.

### iTerm transport states and failure copy

Direct transport is allowed only for a TTY identified as iTerm.app 3.5 or
newer. It drains input, sends the iTerm `Capabilities` query, and accepts the
Pet only after a complete `f` capability reply. Managed transport is a separate
state: all managed-session, pane, and owner-run identifiers must be present;
the single-client topology and expected pane/client must match; tmux
`allow-passthrough` is enabled from a saved value and restored during cleanup.
Managed records are wrapped for tmux and refresh the managed cursor before
submission. A tmux/screen/zellij context that is not an eligible managed
session must not silently use direct transport.

Availability is explicit and recoverable rather than inferred from an ANSI
string. Pending probe, available direct, available managed, revoked, and
disposed/cleaned-up are distinct lifecycle states. User-facing status names a
safe next action and never exposes credentials. Capability errors include
`not-iterm2`, `tty-unavailable`, `missing-f`, `invalid-f`, and `probe-timeout`.
Topology errors include `topology-ineligible`, `topology-lost`, and
`zero-client-recovery`; managed-option restoration failure is
`cleanup-failed`. A failed probe or topology check suppresses raster submission,
invalidates the owned lease, and leaves the saved Pet choice understandable as
unavailable. Cleanup failure remains visible to the lifecycle owner and must
not strand a stale image or leave managed passthrough enabled.

### Placement, composer, and responsive behavior

The Pet occupies exactly two terminal rows, uses terminal-cell measurements,
and remains one cell inset from the right edge. The editor renders at
`terminalColumns - (petColumns + 1)` only when it has more than the reserved
area plus its minimum usable width; otherwise the normal full-width editor is
used and no raster is submitted. The composer remains pinned to the bottom.
Placement uses the composer bottom offset (including content below it), then
clamps the two-row image to retain one safety row above the terminal scrolling
edge. This one-row lift is an intentional iTerm safety trade-off: it prevents an
inline-image cursor advance from scrolling the viewport. Unlike Kitty/Sixel,
iTerm has no sub-cell placement or cursor-advance suppression; do not “fix” the
trade-off by adding a permanent floor row or allowing placement to reach the
unsafe last row.

On a narrow transition, stop submitting new raster frames, erase the previous
Sixel footprint or delete the Kitty placement, and retain cleanup authority
until delivery is acknowledged. On resize or font/zoom cell-metric change,
invalidate the old lease, rebuild the two-row presentation and reserve, and
resume only after the new rectangle fits. Widening the terminal may place the
Pet again; it must not reuse stale coordinates or image ownership.

### Pet state and motion

`off` removes the frame, reserve, emitter authority, and image/lease state.
Active idle uses a discrete base/gaze-left/base/gaze-right/flicker loop.
Working uses the shared para-para loop. A skin burst is a finite flex/show-off
sequence; selector preview may schedule its deterministic introductory
eye-roll and signature burst, while live automatic bursts remain time-spaced.
Every state remains legible when animation is paused: mode, availability, and
composer controls are textual/structural, not conveyed by motion alone.

### Pet visual-QA matrix

The Pet showcase must exercise the full terminal surface, not just a raster
payload: direct and managed/tmux transport; RedGajae and BlueGajae in idle,
working, burst, and selector-preview states; capability/probe failure,
topology rejection/loss, cleanup failure, and unavailable/disabled states; and
normal, narrow, resize, composer-bottom, scroll, and mixed-script layouts.
The matrix must include the canonical wide terminal sizes and a deliberately
narrow case (including `80x24` and `40x12` where the surrounding harness uses
those sizes), plus normal-to-narrow and narrow-to-wide transitions.

Each required capture is full-surface evidence with `terminal.txt`,
`terminal-ansi.txt`, `terminal.html`, and `metadata.json`. The text must remain
readable, ANSI/control semantics must be preserved for replay, and metadata must
describe the source, terminal size, font/render assumptions, timestamp, tool
version, and wrapping policy.
The matrix is a requirement for future capture/review, not a claim that any
capture, live origin, or independent review exists in this corrective change.

### Evidence, provenance, and localized text

ANSI output, terminal-cell rectangles, protocol records, and local validator
results are implementation artifacts. They can establish deterministic
payload/placement invariants, but they cannot establish that a live iTerm
terminal rendered the Pet, that the source was iTerm rather than a replay or
stub, or that an independent reviewer inspected a capture. Live capture,
terminal-origin metadata, and independent review must remain separately
identified evidence; never relabel ANSI evidence as any of those.

The Pet reserve is measured with ANSI-aware terminal-cell width helpers and
must not change composer wrapping semantics. Mixed CJK/Latin text wraps at
semantic phrase or action boundaries, never through an action label, status
name, masked-secret marker, or short code/config identifier. Narrow CJK
fixtures must prove both cell alignment and semantic wrapping; a visually
aligned but semantically split line fails this contract.

## Existing visual grammar

### Tokens and theme roles

- **Foreground roles:** use `accent` for the active cursor, active setting
  label/value, titles, and the Settings label; `text` for ordinary active-tab
  content; `muted` for inactive tabs and secondary values; `dim` for
  descriptions, navigation hints, and unavailable preview text; `border` for
  structural rules. The selector must use semantic theme roles rather than
  hard-coded SGR values.
- **Selection:** the active tab is bold `text` on `selectedBg`; a selected list
  row has an `accent` cursor and accent label/value. Selection remains
  distinguishable by cursor, reverse/background treatment, and its position,
  not color alone.
- **Symbols:** Unicode defaults include `❯` for the navigation cursor and
  `─` for the sharp horizontal rule. The ASCII preset supplies `>` for the
  cursor and ASCII box/separator alternatives. A no-color render removes SGR
  styling but retains textual state, cursor, selection, and action labels.
- **Typography and density:** terminal cells are the grid. Current selector
  titles are bold, one line; ordinary list rows are one line; descriptions are
  indented two spaces and are secondary. Do not invent rounded cards, shadow,
  or pixel-like padding. Preserve the compact one-cell vertical rhythm used by
  `Spacer(1)`.

### Frame and navigation anatomy

The existing settings selector is a vertically stacked frame:

1. a `DynamicBorder` renders a full-width sharp horizontal rule in `border`;
2. a `TabBar` renders `Settings:` followed by tab chunks and the dim
   `(tab to cycle)` hint;
3. one blank spacer row separates navigation from content;
4. the selected tab content renders; and
5. the same border closes the frame.

`TabBar` gives each tab a leading/trailing space, leaves two spaces between
chunks, and wraps *between chunks* when the next chunk exceeds the available
visible width. It cycles with Tab/Right and Shift+Tab/Left. The tab label and
hint can occupy their own lines at narrow widths; this is intentional rather
than a reason to truncate tab identities.

`SettingsList` uses a two-column row: cursor/indent, a label padded to a
visible-width-aligned column capped at 30 cells, two spaces, then a truncated
value. The selected row uses the themed cursor; unselected rows reserve two
spaces. It centers the selected item inside its `maxVisible` window, reports
scroll position as `(current/total)`, places a blank row before the selected
item description, and ends with the dim
`Enter/Space to change · Esc to cancel` hint. Hosts that need stable height
reserve fixed description rows; the status-line custom editor reserves two.

Submenus are a content replacement, not a modal overlay: a bold accent title,
optional muted description, optional preview, a spacer, a select/list control,
and a dim return hint. The status-line custom editor demonstrates the expected
pattern for a transactional draft: live preview while editing; explicit
**Save** and **Cancel and restore** actions; save only commits the draft;
cancel restores the prior preview.

Provider onboarding is the smaller framed-list variant: border, spacer, bold
title, muted explanatory line, spacer, cursor list with each description
indented four spaces, guidance, spacer, border. It establishes the expected
empty space and list density for an operational setup flow.

### Focus, cursor, keyboard, and input behavior

- Up/Down wrap within selector lists. Enter and Space activate the current
  action. Escape follows the current component's cancel path before the parent
  is allowed to close.
- The parent routes Tab/Left/Right to the tab bar except while a text input is
  active. Text entry owns arrow keys and Tab in that state.
- `Input` has a visible `> ` prompt, a zero-width hardware cursor marker only
  while focused, and inverse video on the current grapheme. It horizontally
  scrolls to keep the cursor grapheme visible, including wide graphemes.
- Input normalizes to NFC, moves/deletes by grapheme cluster, supports word
  navigation, undo, kill/yank, bracketed paste, and replaces pasted tabs while
  removing line breaks. Notification secrets will use the dedicated masked
  input from Work item 6; they must never appear in list values, descriptions,
  previews, artifacts, or logs.
### Shortcut labels and binding authority

Keybinding configuration is a portable canonical grammar: textual key IDs use `ctrl`, `alt`, `shift`, and `super` plus a key name (for example, `ctrl+p` or `alt+enter`). Do not serialize or require display-only labels. Runtime UI renders those IDs through the shared formatter for its explicit platform context; macOS uses MacBook-style glyphs (`⌃`, `⌥`, `⇧`, `⌘`, `↩`, `⎋`, `⇥`, `⌫`, `⌦`, and arrow glyphs) while other platforms use textual labels. A glyph is never configuration syntax.

Static onboarding and generated documentation have authority only over shipped defaults. Keep generated tables host-independent by showing canonical textual IDs, not the capture host's labels. The runtime `KeybindingsManager` owns the effective binding set after user remaps and extensions load; `/hotkeys` and runtime hints must render that effective set with the platform context injected by their host. Do not let a static onboarding hint imply that it reflects remaps.

### Status, errors, confirmation, and disabled work

Operational status is concise, textual, and adjacent to the action/list that
caused it. Success, warning, error, pending/running, disabled, blocked, and
aborted states use the themed status symbols when available, but also name the
condition in prose. Error guidance states the safe recovery action without
showing credentials. Confirmations are explicit focused choices; destructive
remove/disable actions are never the default side effect of navigation.

A non-cancellable action visibly locks navigation and names the reason. A
cancellable action names cancellation while it is pending, aborts on exit, and
must not render a late completion after disposal. This follows the selector's
existing preview/cancel ownership rather than adding a parallel focus model.

### Motion, no-motion, and depth

The selector has no required animation, easing, shadows, or overlay depth.
State changes are discrete renders. Pending work may use a static pending or
running symbol and textual progress; it must be equally understandable with
reduced motion or no motion. Do not add a spinner whose frame is the only
signal of progress.

### Accessibility and international text

- Never rely on hue, Unicode-only iconography, or an animated spinner as the
  sole indication of selection, severity, progress, or confirmation.
- Keep keyboard affordances visible in the persistent hint and retain a clear
  selected cursor in ASCII/no-color output.
- Measure clipping and alignment with ANSI-aware terminal-cell width helpers;
  do not use JavaScript string length for CJK layout.
- Preserve NFC in editable values. Use grapheme-aware cursor and deletion
  behavior. When CJK or mixed CJK/Latin prose wraps, break between semantic
  phrases/actions, never through an action label, a status name, a masked
  secret marker, or a short code/config identifier. CJK semantic wrapping
  defects block visual QA.

## Responsive contract

The canonical visual-QA viewports are **80×24**, **120×36**, and **160×48**
terminal cells. Captures include the whole terminal surface for each state.

- **80×24:** prioritize the selected action, one-line status, and navigation
  hint. The final Settings tab bar including Notifications must occupy no more
  than four rendered lines, leaving at least 14 rows between the tab spacer and
  closing border. The selected action, its one-line status, and one-line hint
  must be simultaneously visible in that content budget. Long guidance wraps
  only in its allocated body region; the list scrolls rather than pushing the
  focused action below the frame.
- **120×36:** retain the same anatomy and show the summary, active action list,
  status, and localized sample without clipping. Use the additional height for
  description/guidance, not decorative whitespace.
- **160×48:** retain the same hierarchy and terminal density while exposing the
  full status/help detail and all relevant scroll positions. It is not a
  different desktop layout.

## Notifications editor contract (Work item 7 consumer)

The Notifications editor will be a directly hosted `Notifications` tab, not a
`SettingItem.submenu`. It preserves the frame above and owns its lifecycle.
Its body is ordered as:

1. a concise global/session/runtime summary;
2. an actionable list (configure/reconfigure, global enable/disable,
   session on/off, health, test, recovery, reconnect, and adapter-local remove
   where applicable);
3. one focused status/progress or confirmation region;
4. contextual localized guidance; and
5. a persistent keyboard/navigation hint.

Masked credential entry is a dedicated focus state, never a generic text
setting. Pairing is cancellable; save, health probe, test, recovery, and
reconnect are guarded as specified by the product plan. Tab navigation must
abort and await a cancellable pairing before switching; it must remain locked
for guarded work. Completion after disposal is ignored.

The showcase fixture and capture script render the live
`SettingsSelectorComponent` Notifications tab with in-memory operations and a
fixed clock. Captures are deterministic visual evidence for the product screen;
they must never fall back to placeholder text or bypass the real editor render.

## Canonical showcase states

These identifiers are stable external visual-QA contract values. Do not rename,
combine, or substitute them.

| State ID | Required condition represented |
| --- | --- |
| `home-unconfigured` | No configured notification destination. |
| `home-configured-inactive` | Credentials/configuration exist; current session is inactive. |
| `home-runtime-active` | Current session endpoint is active. |
| `home-local-off` | Current session is explicitly locally disabled. |
| `home-env-off` | Environment hard-off suppresses the surface/runtime. |
| `home-env-on` | Explicit environment opt-in enables the current session. |
| `home-discord-only` | Global Discord configuration without Telegram setup. |
| `home-slack-only` | Global Slack configuration without Telegram setup. |
| `setup-provider` | Provider choice is focused. |
| `setup-chat-entry` | Telegram chat ID field is focused. |
| `setup-token-entry` | Masked Telegram token field is focused. |
| `setup-validating` | Token/destination validation is pending. |
| `setup-threaded-warning` | Threaded mode compatibility warning is visible. |
| `setup-pairing` | Cancellable private-chat pairing/discovery is pending. |
| `setup-review` | Sanitized setup choices await explicit save. |
| `saving` | Durable atomic save is in progress and guarded. |
| `health-probing` | Non-cancellable health probe is in progress and guarded. |
| `health-ok` | Health report is successful. |
| `health-warning` | Health report contains a recoverable warning. |
| `no-health-load` | Health data is unavailable and reload guidance is visible. |
| `testing` | Notification delivery test is in progress and guarded. |
| `recovering` | Recovery action is in progress and guarded. |
| `reconnecting` | Reconnect action is in progress and guarded. |
| `navigation-locked` | A guarded operation explains why Tab/Escape cannot leave. |
| `confirmation-remove` | Adapter-local Telegram removal awaits confirmation. |
| `confirmation-disable` | Global disable awaits confirmation. |
| `success` | A completed operation has concise success copy. |
| `preferences` | Notification preferences are visible and editable. |
| `error` | A sanitized operation failure has recovery guidance. |
| `foreign-blocked` | A foreign/unknown daemon identity blocks activation safely. |
| `blocked-restore-retain` | A blocked post-save identity race requires Restore or Retain before navigation. |
| `cancellation` | A cancellable setup/pairing action was cancelled and restored. |
| `narrow-cjk` | Narrow localized CJK content exercises semantic line wrapping. |
| `narrow-scroll` | Narrow viewport content exercises vertical scrolling and focus visibility. |

## Deterministic showcase and capture matrix

`test/fixtures/tui/notifications-settings-showcase.ts` is the source of truth
for the canonical states, localized English/Korean/Japanese/Chinese content,
viewports, and matrix. The required capture command is:

```sh
bun packages/coding-agent/scripts/capture-notifications-settings-showcase.ts --output .gjc/qa/issue-2050-notifications
```

The baseline consists of every canonical state at `80x24`, `120x36`, and
`160x48` using `unicode-color`: **34 × 3 = 102** entries. Add exactly these
ASCII/no-color variants:

- `home-configured-inactive/80x24/ascii-no-color`
- `health-warning/80x24/ascii-no-color`
- `foreign-blocked/120x36/ascii-no-color`
- `confirmation-remove/80x24/ascii-no-color`

Add exactly these targeted narrow Unicode variants at `48x36`:

- `narrow-cjk/48x36/unicode-color`
- `narrow-scroll/48x36/unicode-color`

The expected manifest count is therefore **108 = (34 × 3) + 4 + 2**. Every key
is `{state_id}/{viewport}/{render_mode}`. Each entry directory contains
`terminal.txt`, `terminal-ansi.txt`, `terminal.html`, and `metadata.json`; the
root `manifest.json` lists all 108 entries and the SHA-256/byte length of every
entry file. Metadata records replay source, terminal size, fixed fixture
capture timestamp, rendering assumptions, wrapping policy, and capture mode.

Regenerate captures, inspect all relevant scroll positions, and obtain an
independent-review receipt at
`.gjc/qa/issue-2050-notifications/independent-review.json`. The reviewer must
not be the implementing executor. That receipt must use the plan's schema and
record both manifest counts as 108 plus CJK review results.

No raw third-party design corpus, screenshot, or reference asset is stored by
this workflow.
