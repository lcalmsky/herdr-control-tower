// Control tower: every agent is an aircraft on one of four runways.
// TOWER needs you, RUNWAY is working, APPROACH finished while you weren't looking,
// TAXI is idle. An aircraft is a small side-view plane with its session name under it,
// and it slides to its new runway when the status changes, so the change is seen as
// motion. The detail of each session lives in the pulse mod. props().role: "head" draws
// the title bar; anything else the runways. The account chip beside the head is the
// claude-accounts mod.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, spaces, focused, run, setAgentOrder, props } from "herdr";

// One night-console ramp; status color marks the runway lights and the planes, amber the selection.
const INK = {
  card: "#11141c", raised: "#1a1e28", selected: "#161a24", line: "#1d212b", dash: "#272c37",
  t1: "#eef0f5", t2: "#a3a9b8", t3: "#7a8296", amber: "#f2a93b", glass: "#0b0d14", shade: "#00000055",
};
const LANES = [
  { id: "blocked", name: "TOWER", sub: "Needs you", color: "#e5484d" },
  { id: "working", name: "RUNWAY", sub: "Working", color: "#5b9cf5" },
  { id: "done", name: "APPROACH", sub: "Done, unseen", color: "#4cc38a" },
  { id: "idle", name: "TAXI", sub: "Idle", color: "#7a8296" },
];
const LANE = Object.fromEntries(LANES.map((l, i) => [l.id, { ...l, i }]));
const LANE_H = 76, LANE_GAP = 8, LABEL_W = 148, PAD = 12;
const CRAFT_W = 200, CRAFT_H = 52, PLANE_W = 48, PLANE_H = 28, SLOT = CRAFT_W + 20;
const DASHES = 80; // enough for a wide window; the runway clips the rest
const LAMPS = 64, LAMP_GAP = 26;
const FONT = "Nunito";
const MOVE = { duration: 400, easing: "ease-out" };

export default class Tower extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "lanes";
    this.since = {}; // address -> { s, at }
    if (this.role === "head") return;
    cx.timer.every(30000, (cx) => cx.notify());
  }

  track(list, now) {
    for (const a of list) if (this.since[a.address]?.s !== a.status) this.since[a.address] = { s: a.status, at: now };
  }

  head() {
    const cur = spaces().find((s) => s.active);
    const list = agents();
    const count = (s) => list.filter((a) => a.status === s).length;
    const stat = (n, color, label) => h_flex().gap(6).items_center()
      .child(div().size(6).rounded(3).bg(color))
      .child(div().text_size(13).font_family(FONT).font_weight(600).text_color(INK.t3).child(`${n} ${label}`));
    return h_flex().size_full().pl(20).pr(20).gap(12).items_center()
      .child(div().text_size(15).font_family(FONT).font_bold().text_color(INK.t1).child(cur?.name ?? "Herdr"))
      .when(count("blocked") > 0, (el) => el.child(stat(count("blocked"), LANE.blocked.color, "need you")))
      .when(count("working") > 0, (el) => el.child(stat(count("working"), LANE.working.color, "working")))
      .child(div().text_size(13).font_family(FONT).font_weight(600).text_color(INK.t3).child(`${list.length} aircraft`));
  }

  // The session name: the agent's terminal title (Claude Code sets it), else its tab.
  session(a) {
    const live = String(a.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
    if (live && !/^[~/]/.test(live) && !live.includes("@") && live !== a.program?.name) return live;
    return a.tab_name && !/^\d+$/.test(a.tab_name) ? a.tab_name : a.program?.name ?? a.address;
  }

  // One aircraft: a side-view plane in three tinted layers, the session name centred under it.
  aircraft(a, f) {
    const lane = LANE[a.status] ?? LANE.idle;
    const on = a.focused || (f && (f.terminal === a.address || f.agent === a.address));
    const tint = on ? INK.amber : lane.color;
    const layer = (file, color) => svg(`mods/tower/${file}`).absolute().left(0).top(0).w(PLANE_W).h(PLANE_H).text_color(color);
    return div().id(`ac-${a.address}`).w(CRAFT_W).h(CRAFT_H).flex().flex_col().items_center().gap(6).cursor_pointer()
      .tooltip([this.session(a), a.space_name, lane.sub].filter(Boolean).join(" · "))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(div().relative().w(PLANE_W).h(PLANE_H).flex_none()
        .child(layer("plane-body.svg", tint))
        .child(layer("plane-glass.svg", INK.glass))
        .child(layer("plane-shade.svg", INK.shade)))
      .child(h_flex().max_w(CRAFT_W).h(18).gap(6).items_center()
        .when(a.status === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none()
          .text_color(on ? INK.amber : lane.color).spin(900)))
        .child(div().min_w(0).truncate().text_size(12.5).font_family(FONT).font_bold().text_color(on ? INK.amber : INK.t1)
          .child(this.session(a))));
  }

  // A runway: a card with edge lights, threshold keys and a dashed centre line. TOWER's dot
  // blinks while something waits.
  runway(l, i, n, lit) {
    const top = i * (LANE_H + LANE_GAP);
    const lamps = (y) => h_flex().absolute().left(LABEL_W).right(16).top(y).h(2).gap(LAMP_GAP - 2).overflow_hidden()
      .children(Array.from({ length: LAMPS }, () => div().size(2).flex_none().rounded(1).bg(`${l.color}${lit ? "aa" : "55"}`)));
    const label = h_flex().absolute().left(16).top(top).h(LANE_H).gap(8).items_center()
      .child(div().id(`dot-${l.id}`).size(8).rounded(4).bg(l.color)
        .when(l.id === "blocked" && n > 0, (el) => el.loop("opacity", { from: 1, to: 0.25, period: 1200 })))
      .child(div().text_size(14).font_family(FONT).font_weight(800).text_color(INK.t1).child(l.name))
      .child(div().text_size(12).font_family("Geist Mono").text_color(INK.t3).child(String(n)));
    const card = div().id(`rwy-${l.id}`).absolute().left(0).right(0).top(top).h(LANE_H).rounded(12).overflow_hidden()
      .bg(lit ? INK.selected : INK.card).border(1).border_color(lit ? `${INK.amber}4d` : INK.line)
      .when(lit, (el) => el.child(div().absolute().left(12).right(12).top(0).h(1).bg("#ffffff14")))
      .child(div().absolute().left(LABEL_W - 16).top(14).w(6).h(LANE_H - 28).flex().flex_col().justify_between()
        .children(Array.from({ length: 4 }, () => div().h(2).rounded(1).bg(INK.dash))))
      .child(lamps(5))
      .child(lamps(LANE_H - 7))
      .child(h_flex().absolute().left(LABEL_W).right(16).top(LANE_H / 2).h(1).gap(12).overflow_hidden()
        .children(Array.from({ length: DASHES }, () => div().w(16).h(1).flex_none().bg(INK.dash))))
      .when(n === 0, (el) => el.child(div().absolute().right(16).top(0).bottom(0).flex().items_center().pl(8).bg(lit ? INK.selected : INK.card)
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
      place[a.address] = { left: LABEL_W + 4 + i * SLOT, top: l.i * (LANE_H + LANE_GAP) + (LANE_H - CRAFT_H) / 2 };
    }
    const count = (id) => list.filter((a) => (LANE[a.status] ?? LANE.idle).id === id).length;
    const f = focused();
    const cur = list.find((a) => a.focused || (f && (f.terminal === a.address || f.agent === a.address)));
    const litLane = cur ? (LANE[cur.status] ?? LANE.idle).id : null;
    // Aircraft in a fixed (address) order, so each keeps its element and slides instead of jumping.
    const craft = [...list].sort((x, y) => (x.address < y.address ? -1 : 1)).map((a) =>
      div().id(`slot-${a.address}`).absolute().left(place[a.address].left).top(place[a.address].top)
        .transition("left", MOVE).transition("top", MOVE)
        .child(this.aircraft(a, f)));
    return div().size_full().p(PAD).child(div().relative().size_full().overflow_hidden()
      .children(LANES.flatMap((l, i) => this.runway(l, i, count(l.id), l.id === litLane)))
      .children(craft));
  }

  render() {
    if (this.role === "head") return this.head();
    return this.lanes();
  }
}
