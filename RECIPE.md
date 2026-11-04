# Control Tower

A quiet night-console window for watching agents. A thin rail of space tiles runs down the left. Across the top, four fixed runways hold your agents as aircraft: TOWER (needs you), RUNWAY (working), APPROACH (done while you weren't looking) and TAXI (idle). Each aircraft carries a controller tag with the session name, what the agent is doing and how full its context is. When a status changes the aircraft slides to its new runway. Everything is ink-grey; status color is only a small dot beside each runway name and a red waiting aircraft, and amber marks the agent you're focused on. Terminals sit below as rounded cards.

![Control Tower](preview.png)

## What you see

Left to right, then top to bottom:

- **Rail** (64 px, not resizable, drags the window, `chrome` background `#07080d`). Space tiles start 44 px from the top (room for the traffic lights at [12, 16]), 32 px squares with radius 8, 8 px apart: `#11141c` with a 1 px `#1d212b` hairline and the space name's first letter (13 px, weight 500, `#a3a9b8`). The shown space is `#1a1e28` with a white letter `#eef0f5` and a 1 px `#ffffff1f` highlight along its top edge. An 8 px dot with a 2 px `#07080d` ring sits on a tile's top-right corner: red `#e5484d` when an agent there is blocked, green `#4cc38a` when one finished unseen. At the bottom: 32 px + (new space) and settings buttons in `#7a8296`.
- **Head** (44 px, drags the window, 20 px side padding): the shown space's name (Nunito 15 px bold, `#eef0f5`) and "N aircraft · 4 runways" (Nunito 13 px semibold, `#7a8296`).
- **Runways** (384 px block, 12 px padding): four cards 84 px tall, 8 px apart, radius 12, `#11141c` with a 1 px `#1d212b` hairline. Their height never changes, empty or not.
  - Label, 16 px in: an 8 px status dot, the runway name (Nunito 14 px, weight 800, `#eef0f5`), the count (Geist Mono 12 px, `#7a8296`); below it, indented 16 px, "Needs you / Working / Done, unseen / Idle" (Nunito 12 px semibold, `#7a8296`).
  - Status dots: TOWER `#e5484d`, RUNWAY `#5b9cf5`, APPROACH `#4cc38a`, TAXI `#7a8296`.
  - A dashed centre line from 148 px to 16 px before the right edge: 16 px dashes, 12 px gaps, 1 px, `#272c37`.
  - An empty runway shows "No aircraft" (Nunito 12 px semibold, `#7a8296`) at its right end.
- **Aircraft**: a 26 px plane (side view, nose right) then, 8 px later, a 240 × 64 controller tag (radius 8, `#1a1e28`, 1 px `#1d212b` hairline, 12 px side and 8 px vertical padding) with three 16 px rows:
  1. the session name (Nunito 14 px bold, `#eef0f5`, taking the rest of the row) and the time since the status changed (Geist Mono 12 px, `#7a8296`: `<1m`, `5m`, `2h`, `1d`);
  2. an 11 px spinner (working only) and what it's doing (Geist Mono 12 px, `#a3a9b8`);
  3. the space name (Nunito 12 px semibold, `#7a8296`, taking the rest of the row), a 72 px wide 2 px context bar (`#1d212b` track, `#a3a9b8` fill) and the percentage (Geist Mono 12 px, `#7a8296`; `–` when unknown).
  Planes are `#7a8296`; a waiting (TOWER) plane is red and its tag border is red at 50 %. Aircraft on one runway line up from the left, 298 px apart, starting 156 px into the card.
- **Tab bar** (38 px): Herdr's tabs, except an unnamed tab shows its agent's session name (else its space's name) instead of its number.
- **Work area**: padding 8, gap 8. Each pane is a card with radius 10, a 1 px `border` (1 px `accent`, amber, when focused) and Herdr's 30 px pane header.
- **Status bar** (28 px): Herdr's workspace status.
- **Theme** `control-tower`: background/canvas `#0b0d14`, chrome `#07080d`, foreground `#eef0f5`, border `#1d212b`, selected `#1a1e28`, hover `#161a24`, muted `#7a8296`, accent and cursor `#f2a93b`, selection `#26304a`, bright ANSI colors for terminal output.

## How it behaves

- **Status → runway**: blocked → TOWER, working → RUNWAY, done → APPROACH, idle → TAXI. On a change the aircraft slides (left and top, 400 ms ease-out) to its new place. On each runway the most recent change comes first, and the same order is handed to Herdr (`setAgentOrder`).
- **Focus**: the focused agent's runway steps up to `#161a24` with an amber hairline at 30 % and a 1 px `#ffffff14` highlight along its top. That aircraft's plane, tag border, session name and context bar turn amber `#f2a93b`. Nothing glows, pulses or loops; the only continuous motion is the working spinner.
- **What it's doing**: every 2.5 s the screen of each working or blocked agent is read. Working shows Claude Code's spinner verb ("Cogitating…") and the last tool call (`Edit(main.kt)`); blocked shows the last line ending in "?". Done shows "Done", idle "Idle".
- **Context**: every 10 s, for local Claude Code agents, the newest assistant usage in the agent's own transcript (input + cache creation + cache read + output) against 200k, or 1M when the model name has `[1m]` or usage passes 200k. A compaction (a `"subtype": "compact_boundary"` line) after the last usage clears it to `–`; a pid the script can't read keeps its last value.
- **Session name**: the agent's terminal title (Claude Code sets it) without leading symbols; when the title is a path, has `@` or is just the program name, the tab name; else the program name.
- **Clicks**: an aircraft focuses its pane (`pane.focus`); resting the pointer on it shows a tooltip with the full session name, space name and status, joined by " · ". A rail tile selects its space; right-click opens Herdr's space menu; hovering shows "N. name". + runs `space.new`, the gear `app.settings`. The tab bar works like Herdr's.
- The head and timers refresh every 30 s.

## Built from

- `layouts/control-tower.json`: root `row` (theme `control-tower`, background `canvas`, titlebar none, traffic_lights [12, 16], terminal_padding [14, 12], 1 px `border` dividers):
  - `rail` block (px 64, not resizable, `window_drag`, background `chrome`) with `tower-rail`;
  - `work` column: `tower-head` (px 44, `window_drag`, `tower` with props `{role: "head"}`), `tower-lanes` (px 384, `tower`), `tabs` (px 38, `tower-tabs`), `work-body` row (padding 8, gap 8) with `main` (`{tab: "active", pane: {header: {content: {mod: "pane"}, reveal: "always", height: 30, position: "top"}, background: "background", border 1 `border`, focus 1 `accent`, radius 10, gap 8, lone: true}}`), and `status` (px 28, the shipped `workspace-status`).
- `themes/control-tower.json`: the theme above.
- `mods/tower/`: `props().role === "head"` draws the head, anything else the runways. `plane.svg` is the aircraft (one path set, tinted with `text_color`). `fonts/` holds Nunito SemiBold and Bold (OFL), picked up automatically and used through `font_family("Nunito")`.
- `mods/tower-rail/`: the rail.
- `mods/tower-tabs/`: Herdr's shipped `tabs` (0.1.12), modified: an unnamed tab shows the lead agent's terminal title, else its space's name; the bar's left padding is a fixed 10 px. Apache-2.0, with its LICENSE.
- `herdr` functions: `agents`, `terminals`, `spaces`, `panes`, `focused`, `run`, `exec`, `hc`, `props`, `shared`, `setAgentOrder`, `openOverlay`, `theme`, `window`, `layout`.
- Commands: `pane.focus`, `space.select`, `space.new`, `app.settings`, and the tab bar's `tab.*`, `layout.show/hide/select`, `window.*`.
- Shipped mods and icons: `pane`, `workspace-status`, `menu`, `new-menu`, and icons from `mods/workspace-chrome/` (spinner, plus, settings), `mods/pane/`, `mods/files/`, `mods/changes/`.
- Programs: `hc read <address>` (screens) and `sh -c` with a read-only script over `~/.claude/sessions/<pid>.json` and `~/.claude/projects/*/<session>.jsonl` (honours `CLAUDE_CONFIG_DIR`; one `mktemp` file, removed by a `trap` on exit). No network.

## Watch out

- `agent.focused` isn't enough to find the selection; also compare `focused().terminal` / `focused().agent` with the agent's address.
- Only opacity, width, height, left and top animate. Aircraft keep a stable element id per agent (`slot-<address>`) and are drawn in address order so they slide instead of jumping.
- Runways keep their height when empty on purpose: collapsing them would shift every runway below on each status change and bury the one move that matters.
- A block doesn't report its width, so tags are fixed px and the runway clips. The dashes are a fixed count (80) that covers a wide window. A runway shows about four aircraft on a 1600 px window; more run off the right edge.
- The runway block is sized for four 84 px runways with 8 px gaps (4 × 84 + 3 × 8 + 24 padding = 384). Changing the runway height means changing the layout's px too.
- GPUI colors accept `#rrggbbaa`; the waiting tag's red border at 50 % and the selected runway's amber hairline at 30 % use it.
- Screen reading matches Claude Code's spinner and tool lines; other agents show only their status word. Context use is Claude Code only (local terminals).

## Done when

- `herdr-app check mods/tower`, `mods/tower-rail` and `mods/tower-tabs` all pass, and `layout.switch {name: "control-tower"}` shows the rail, head, four runways, tabs and panes with no errors in `herdr-app status`.
- Starting an agent puts an aircraft on RUNWAY with a spinner; when it waits for permission the aircraft slides to TOWER with a red plane; when it finishes unfocused it slides to APPROACH. No runway changes height.
- Clicking an aircraft focuses its pane; that aircraft turns amber and its runway steps up while the previous one returns to `#11141c`.
- A Claude Code agent's tag shows a context percentage within 10 s, and its session name matches its terminal title.
- An unnamed tab shows the session name (or, with no usable title, the space name) instead of a number.
