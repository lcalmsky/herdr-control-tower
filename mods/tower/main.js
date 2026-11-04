// Control tower: every agent is an aircraft on one of four runways.
// TOWER needs you, RUNWAY is working, APPROACH finished while you weren't looking,
// TAXI is idle. An aircraft slides to its new runway when the status changes, so the
// change is seen as motion. props().role: "head" draws the title bar, anything
// else the runways.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, spaces, focused, run, exec, hc, props, setAgentOrder } from "herdr";

// One night-console ramp; status color only marks a dot and a waiting aircraft, amber marks the selection.
const INK = {
  card: "#11141c", raised: "#1a1e28", selected: "#161a24", line: "#1d212b", dash: "#272c37",
  t1: "#eef0f5", t2: "#a3a9b8", t3: "#7a8296", amber: "#f2a93b",
};
const LANES = [
  { id: "blocked", name: "TOWER", sub: "Needs you", color: "#e5484d" },
  { id: "working", name: "RUNWAY", sub: "Working", color: "#5b9cf5" },
  { id: "done", name: "APPROACH", sub: "Done, unseen", color: "#4cc38a" },
  { id: "idle", name: "TAXI", sub: "Idle", color: "#7a8296" },
];
const LANE = Object.fromEntries(LANES.map((l, i) => [l.id, { ...l, i }]));
const LANE_H = 84, LANE_GAP = 8, LABEL_W = 148, PLANE = 26, TAG_W = 240, TAG_H = 64, PAD = 12;
const SLOT = PLANE + 8 + TAG_W + 24;
const DASHES = 80; // enough for a wide window; the runway clips the rest
const FONT = "Nunito";
const MOVE = { duration: 400, easing: "ease-out" };

// Claude Code's spinner line ("✻ Cogitating… (12s · esc to interrupt)") and its last tool call.
const VERB = /^\s*\S\s+([A-Z][\w-]*…)/gm;
const TOOL = /^\s*●\s+([A-Z]\w+)\(([^)\n]{0,48})/gm;
const ASK = /^[\s│]*([^\n]{6,80}\?)\s*[│]?\s*$/gm;

// For each pid: the newest assistant usage numbers of that Claude process's transcript,
// or "C" when a compaction came after it. Only numbers and the model name leave the shell.
const CONTEXT_SCRIPT = `root="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
tmp=$(mktemp "\${TMPDIR:-/tmp}/herdr-tower.XXXXXX") || exit 0
trap 'rm -f "$tmp"' EXIT
for pid in "$@"; do
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  id=$(head -c 65536 "$root/sessions/$pid.json" 2>/dev/null | grep -oE '"sessionId" *: *"[0-9a-fA-F-]{36}"' | grep -oE '[0-9a-fA-F-]{36}' | head -n 1)
  [ -n "$id" ] || continue
  f=$(ls "$root"/projects/*/"$id".jsonl 2>/dev/null | head -n 1)
  [ -f "$f" ] || continue
  tail -c 4194304 "$f" 2>/dev/null | grep -E '"subtype": *"compact_boundary"|"type": *"assistant"' | grep -v '"isSidechain": *true' | tail -n 1 > "$tmp"
  if grep -qE '"subtype": *"compact_boundary"' "$tmp"; then echo "$pid C"; else
    nums=$(grep -oE '"(input_tokens|cache_creation_input_tokens|cache_read_input_tokens|output_tokens)": *[0-9]+' "$tmp" | grep -oE '[0-9]+$' | tr '\\n' ' ')
    model=$(grep -oE '"model": *"[^"]*"' "$tmp" | head -n 1 | sed 's/.*: *"//; s/"$//')
    echo "$pid A $model $nums"
  fi
done`;

function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export default class Tower extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "lanes";
    this.verbs = {}; // address -> what the screen says it's doing
    this.ctx = {}; // address -> { used, limit } | null
    this.since = {}; // address -> { s, at }
    cx.timer.every(30000, (cx) => cx.notify());
    if (this.role === "head") return;
    cx.timer.every(2500, (cx) => this.readScreens(cx));
    cx.timer.every(10000, (cx) => this.readContext(cx));
    this.readContext(cx);
  }

  // What working and blocked agents show: the spinner verb and last tool, or the question asked.
  readScreens(cx) {
    if (this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      let changed = false;
      try {
        for (const a of agents().filter((a) => a.status === "working" || a.status === "blocked")) {
          const r = await hc(["read", a.address]).catch(() => null);
          const text = r?.stdout ?? "";
          let line = null;
          if (a.status === "working") {
            const verb = [...text.matchAll(VERB)].at(-1)?.[1];
            const tool = [...text.matchAll(TOOL)].at(-1);
            line = [verb, tool ? `${tool[1]}(${tool[2].trim()})` : null].filter(Boolean).join("  ") || null;
          } else {
            line = [...text.matchAll(ASK)].at(-1)?.[1]?.trim() ?? null;
          }
          if (line !== (this.verbs[a.address] ?? null)) { this.verbs[a.address] = line; changed = true; }
        }
      } finally { this.reading = false; }
      if (changed) cx.notify();
    });
  }

  // Context use of local Claude Code agents, from their own transcripts (read only).
  readContext(cx) {
    if (this.counting) return;
    const targets = terminals().filter((t) => t.state === "live" && !t.address.includes("/") && t.foreground?.pid
      && [t.program?.key, t.foreground?.name].some((n) => String(n ?? "").includes("claude")));
    if (!targets.length) return;
    this.counting = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", CONTEXT_SCRIPT, "sh", ...targets.map((t) => String(t.foreground.pid))]);
        const byPid = {};
        for (const line of (r.stdout ?? "").split("\n")) {
          const [pid, kind, model, ...nums] = line.trim().split(/\s+/);
          if (!pid) continue;
          if (kind === "C") { byPid[pid] = null; continue; }
          const used = nums.filter((n) => /^\d+$/.test(n)).reduce((s, n) => s + Number(n), 0);
          if (!used) continue;
          byPid[pid] = { used, limit: /\[1m\]/i.test(model ?? "") || used > 200000 ? 1000000 : 200000 };
        }
        // A compaction (null) clears the bar; no answer for a pid keeps the last reading.
        for (const t of targets) {
          const v = byPid[String(t.foreground.pid)];
          this.ctx[t.address] = v !== undefined ? v : this.ctx[t.address] ?? null;
        }
      } catch {}
      this.counting = false;
      cx.notify();
    });
  }

  track(list, now) {
    for (const a of list) if (this.since[a.address]?.s !== a.status) this.since[a.address] = { s: a.status, at: now };
  }

  head() {
    const cur = spaces().find((s) => s.active);
    return h_flex().size_full().pl(20).pr(20).gap(8).items_center()
      .child(div().text_size(15).font_family(FONT).font_bold().text_color(INK.t1).child(cur?.name ?? "Herdr"))
      .child(div().text_size(13).font_family(FONT).font_weight(600).text_color(INK.t3).child(`${agents().length} aircraft · 4 runways`));
  }

  // The session name: the agent's terminal title (Claude Code sets it), else its tab.
  session(a) {
    const live = String(a.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    if (live && !/^[~/]/.test(live) && !live.includes("@") && live !== a.program?.name) return live;
    return a.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : a.program?.name ?? a.address;
  }

  // One aircraft: the plane on the centre line and its controller tag beside it.
  aircraft(a, now, f) {
    const lane = LANE[a.status] ?? LANE.idle;
    const on = a.focused || (f && (f.terminal === a.address || f.agent === a.address));
    const blocked = a.status === "blocked";
    const ctx = this.ctx[a.address];
    const ratio = ctx ? Math.min(1, ctx.used / ctx.limit) : 0;
    const verb = this.verbs[a.address];
    const detail = (blocked || a.status === "working") && verb ? verb : a.status === "done" ? "Done" : a.status === "idle" ? "Idle" : lane.sub;
    const since = this.since[a.address]?.at;
    const tint = on ? INK.amber : blocked ? lane.color : INK.t3;
    const bar = Math.round(ratio * (TAG_W - 64));
    const row = () => h_flex().h(16).gap(6).items_center().min_w(0);
    const tag = v_flex().w(TAG_W).h(TAG_H).px(12).py(8).justify_between().rounded(8).bg(INK.raised)
      .border(1).border_color(on ? INK.amber : blocked ? `${lane.color}80` : INK.line)
      .child(row()
        .child(div().flex_shrink(0).max_w(140).truncate().text_size(14).font_family(FONT).font_bold().text_color(on ? INK.amber : INK.t1).child(this.session(a)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(FONT).font_weight(600).text_color(INK.t3).child(a.space_name ?? ""))
        .when(Boolean(since), (el) => el.child(div().flex_none().text_size(12).font_family("Geist Mono").text_color(INK.t3).child(ago(now - since)))))
      .child(row()
        .when(a.status === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(INK.t2).spin(900)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_family("Geist Mono").text_color(INK.t2).child(detail)))
      .child(row().gap(8)
        .child(div().relative().flex_1().h(2).rounded(1).bg(INK.line)
          .child(div().absolute().left(0).top(0).bottom(0).w(bar).rounded(1).bg(on ? INK.amber : INK.t2)))
        .child(div().flex_none().text_size(12).font_family("Geist Mono").text_color(INK.t3)
          .child(ctx ? `${Math.round(ratio * 100)}%` : "–")));
    return h_flex().id(`ac-${a.address}`).gap(8).items_center().cursor_pointer()
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(svg("mods/tower/plane.svg").size(PLANE).flex_none().text_color(tint))
      .child(tag);
  }

  // A runway: a card with a dashed centre line. The one holding the selection steps up a surface.
  runway(l, i, n, lit) {
    const top = i * (LANE_H + LANE_GAP);
    const label = v_flex().absolute().left(16).top(top).h(LANE_H).justify_center().gap(2)
      .child(h_flex().gap(8).items_center()
        .child(div().size(8).rounded(4).bg(l.color))
        .child(div().text_size(14).font_family(FONT).font_weight(800).text_color(INK.t1).child(l.name))
        .child(div().text_size(12).font_family("Geist Mono").text_color(INK.t3).child(String(n))))
      .child(div().pl(16).text_size(12).font_family(FONT).font_weight(600).text_color(INK.t3).child(l.sub));
    const card = div().id(`rwy-${l.id}`).absolute().left(0).right(0).top(top).h(LANE_H).rounded(12).overflow_hidden()
      .bg(lit ? INK.selected : INK.card).border(1).border_color(lit ? `${INK.amber}4d` : INK.line)
      .when(lit, (el) => el.child(div().absolute().left(12).right(12).top(0).h(1).bg("#ffffff14")))
      .child(h_flex().absolute().left(LABEL_W).right(16).top(LANE_H / 2).h(1).gap(12).overflow_hidden()
        .children(Array.from({ length: DASHES }, () => div().w(16).h(1).flex_none().bg(INK.dash))))
      .when(n === 0, (el) => el.child(div().absolute().right(16).top(0).bottom(0).flex().items_center().pl(8).bg(INK.card)
        .text_size(12).font_family(FONT).font_weight(600).text_color(INK.t3).child("No aircraft")));
    return [card, label];
  }

  lanes() {
    const now = Date.now();
    const list = agents();
    this.track(list, now);
    // Runway order: newest change first, so an aircraft that just arrived lands at the front.
    const order = [...list].sort((x, y) => (LANE[x.status]?.i ?? 3) - (LANE[y.status]?.i ?? 3)
      || (this.since[y.address]?.at ?? 0) - (this.since[x.address]?.at ?? 0) || y.seq - x.seq);
    setAgentOrder(order.map((a) => a.address));
    const slot = {};
    const place = {};
    for (const a of order) {
      const l = LANE[a.status] ?? LANE.idle;
      const i = slot[l.id] = (slot[l.id] ?? -1) + 1;
      place[a.address] = { left: LABEL_W + 8 + i * SLOT, top: l.i * (LANE_H + LANE_GAP) + (LANE_H - TAG_H) / 2 };
    }
    const count = (id) => list.filter((a) => (LANE[a.status] ?? LANE.idle).id === id).length;
    const f = focused();
    const cur = list.find((a) => a.focused || (f && (f.terminal === a.address || f.agent === a.address)));
    const litLane = cur ? (LANE[cur.status] ?? LANE.idle).id : null;
    // Aircraft in a fixed (address) order, so each keeps its element and slides instead of jumping.
    const craft = [...list].sort((x, y) => (x.address < y.address ? -1 : 1)).map((a) =>
      div().id(`slot-${a.address}`).absolute().left(place[a.address].left).top(place[a.address].top)
        .transition("left", MOVE).transition("top", MOVE)
        .child(this.aircraft(a, now, f)));
    return div().size_full().p(PAD).child(div().relative().size_full().overflow_hidden()
      .children(LANES.flatMap((l, i) => this.runway(l, i, count(l.id), l.id === litLane)))
      .children(craft));
  }

  render() {
    return this.role === "head" ? this.head() : this.lanes();
  }
}
