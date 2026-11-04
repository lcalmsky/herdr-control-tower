// The tower's space rail: one quiet tile per space. The shown space steps up a surface;
// a red dot means an agent there needs you, a green one that one finished unseen.

import { View, div, svg } from "gpui-kit";
import { v_flex } from "gpui-base";
import { spaces, agents, run, openOverlay } from "herdr";

const INK = { rail: "#07080d", card: "#11141c", raised: "#1a1e28", hover: "#161a24", line: "#1d212b", t1: "#eef0f5", t2: "#a3a9b8", t3: "#7a8296" };
const DOT = { blocked: "#e5484d", done: "#4cc38a" };

export default class TowerRail extends View {
  render() {
    const list = agents();
    const tile = (s, i) => {
      const mine = list.filter((a) => a.space === s.id);
      const dot = mine.some((a) => a.status === "blocked") ? DOT.blocked : mine.some((a) => a.status === "done") ? DOT.done : null;
      return div()
        .id(`rail-${s.id}`)
        .relative().size(32).flex_none().rounded(8)
        .flex().items_center().justify_center()
        .bg(s.active ? INK.raised : INK.card).border(1).border_color(INK.line)
        .when(s.active, (el) => el.child(div().absolute().left(6).right(6).top(0).h(1).bg("#ffffff1f")))
        .when(!s.active, (el) => el.hover((h) => h.bg(INK.hover)))
        .cursor_pointer()
        .tooltip(`${i + 1}. ${s.name}`)
        .on_click(() => run("space.select", { id: s.id }))
        .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: s.id } } }))
        .child(div().text_size(13).font_weight(500).text_color(s.active ? INK.t1 : INK.t2).child([...s.name][0]?.toUpperCase() ?? "?"))
        .when(Boolean(dot), (el) => el.child(div().absolute().top(-2).right(-2).size(8).rounded(4).bg(dot).border(2).border_color(INK.rail)));
    };
    const button = (id, tip, icon, size, action) => div().id(id).size(32).rounded(8).flex().items_center().justify_center()
      .text_color(INK.t3).hover((h) => h.bg(INK.hover).text_color(INK.t1))
      .tooltip(tip).on_click(action).child(svg(icon).size(size));
    return v_flex().size_full().pt(44).pb(12).items_center().gap(8)
      .children(spaces().map(tile))
      .child(div().flex_1())
      .child(button("rail-new", "New space", "mods/workspace-chrome/plus.svg", 14, () => run("space.new")))
      .child(button("rail-settings", "Settings", "mods/workspace-chrome/settings.svg", 15, () => run("app.settings")));
  }
}
