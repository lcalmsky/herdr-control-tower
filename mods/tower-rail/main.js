// The tower's space rail: one quiet tile per space. The shown space steps up a surface;
// a red dot means an agent there needs you, a green one that one finished unseen.
// Spaces cut from the same git repository hang off one trunk in the left gutter, and a
// hollow ring at a tile's lower right means a shell there has sat at its prompt for 10 min.
// props().role "buttons" draws only the new-space and settings buttons for the rail's bottom.

import { View, div, svg } from "gpui-kit";
import { v_flex } from "gpui-base";
import { spaces, agents, terminals, panes, exec, run, openOverlay, props } from "herdr";

const INK = { rail: "#07080d", card: "#11141c", raised: "#1a1e28", hover: "#161a24", line: "#1d212b", sep: "#3a4050", t1: "#eef0f5", t2: "#a3a9b8", t3: "#7a8296", amber: "#f2a93b" };
const DOT = { blocked: "#e5484d", done: "#4cc38a" };
const TILE = 32;
const GAP = 8;
const IDLE_MS = 10 * 60 * 1000;
const REPO_MS = 30 * 1000;
// Trunk positions in the 16 px gutter left of the tiles; a third overlapping repo gets no lines.
const LANES = [8, 3];

function quiet(ms) {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

export default class TowerRail extends View {
  init(_props, cx) {
    this.role = props()?.role ?? "spaces";
    if (this.role === "buttons") return;
    this.turns = {};
    this.repos = {};
    this.reading = false;
    cx.timer.every(REPO_MS, (cx) => this.readRepos(cx));
    cx.timer.every(30000, (cx) => cx.notify());
    this.readRepos(cx);
  }

  // SpaceInfo.folder is where new terminals start, not where they are, so the repo comes from a terminal's cwd.
  readRepos(cx) {
    if (this.reading) return;
    this.reading = true;
    const folders = [...new Set(terminals().map((t) => t.cwd).filter(Boolean))];
    cx.spawn(async (later) => {
      const next = {};
      for (const cwd of folders) {
        try {
          const r = await exec("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"]);
          const [common, top] = String(r.stdout ?? "").trim().split("\n");
          next[cwd] = r.code === 0 && common ? { common, base: Boolean(top) && `${top}/.git` === common } : null;
        } catch {
          next[cwd] = null;
        }
      }
      this.repos = next;
      this.reading = false;
      this.groupSpaces();
      later.notify();
    });
  }

  // Each space's first terminal cwd and the repository git found there; repo is undefined
  // while git hasn't been asked about that cwd yet.
  spaceRows() {
    const byAddress = new Map(terminals().map((t) => [t.address, t]));
    const paneList = panes();
    return spaces().map((s) => {
      const mine = this.spaceTerminals(s, byAddress, paneList);
      const cwd = mine.find((t) => t.cwd)?.cwd ?? null;
      return { space: s, mine, repo: cwd ? this.repos[cwd] : null };
    });
  }

  // Keeps the spaces of one repository next to each other in Herdr's own order (base checkout
  // first), so ⌃1–9 and the trunk follow the rail. Each order is tried once.
  groupSpaces() {
    const rows = this.spaceRows();
    if (rows.some((row) => row.repo === undefined)) return;
    const groups = new Map();
    for (const row of rows) {
      const key = row.repo?.common ?? row.space.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const want = [...groups.values()].flatMap((members) =>
      [...members.filter((r) => r.repo?.base), ...members.filter((r) => !r.repo?.base)]).map((r) => r.space.id);
    const have = rows.map((r) => r.space.id);
    const key = `${have.join(",")}>${want.join(",")}`;
    if (want.join(",") === have.join(",") || this.lastMove === key) return;
    this.lastMove = key;
    const order = [...have];
    want.forEach((id, index) => {
      if (order[index] === id) return;
      run("space.move", { id, index: index + 1 });
      order.splice(order.indexOf(id), 1);
      order.splice(index, 0, id);
    });
  }

  spaceTerminals(s, byAddress, paneList) {
    const tabs = new Set(s.tabs.map((t) => t.id));
    return paneList.filter((p) => p.terminal && tabs.has(p.tab)).map((p) => byAddress.get(p.terminal)).filter(Boolean);
  }

  // hc gives no last-activity time, so a shell counts as idle from when this view last saw its turn change.
  idleShells(list, now) {
    const idle = [];
    for (const t of list) {
      if (!t.program?.shell) continue;
      const seen = this.turns[t.address];
      if (!seen || seen.turn !== t.turn) this.turns[t.address] = { turn: t.turn, at: now };
      const since = now - this.turns[t.address].at;
      if (since >= IDLE_MS) idle.push(since);
    }
    return idle;
  }

  branches(rows) {
    const groups = new Map();
    rows.forEach((row, i) => {
      if (!row.repo) return;
      if (!groups.has(row.repo.common)) groups.set(row.repo.common, []);
      groups.get(row.repo.common).push(i);
    });
    const cy = (i) => i * (TILE + GAP) + TILE / 2;
    const lines = [];
    const busy = LANES.map(() => -1);
    for (const members of [...groups.values()].filter((m) => m.length > 1).sort((a, b) => a[0] - b[0])) {
      const first = members[0];
      const last = members[members.length - 1];
      const lane = busy.findIndex((until) => until < first);
      if (lane < 0) continue;
      busy[lane] = last;
      const x = LANES[lane];
      const trunkTop = cy(first);
      const trunkEnd = rows[last].repo.base ? cy(last) : cy(last) - 8;
      lines.push(div().absolute().left(x).top(trunkTop).w(2).h(Math.max(0, trunkEnd - trunkTop)).bg(INK.sep));
      for (const i of members) {
        if (rows[i].repo.base || i === first) {
          lines.push(div().absolute().left(x).top(cy(i) - 1).w(16 - x).h(2).bg(INK.sep));
        } else {
          lines.push(div().absolute().left(x).top(cy(i) - 8).w(16 - x).h(9)
            .border_l(2).border_b(2).border_color(INK.sep).rounded_bl(8));
        }
      }
    }
    return lines;
  }

  render() {
    if (this.role === "buttons") return this.buttons();
    const now = Date.now();
    const list = agents();
    const rows = this.spaceRows().map((row) => ({ ...row, repo: row.repo ?? null, idle: this.idleShells(row.mine, now) }));

    const tile = (row, i) => {
      const s = row.space;
      const mine = list.filter((a) => a.space === s.id);
      const dot = mine.some((a) => a.status === "blocked") ? DOT.blocked : mine.some((a) => a.status === "done") ? DOT.done : null;
      const idle = row.idle.length;
      const tip = idle
        ? `${i + 1}. ${s.name} · ${idle} idle shell${idle === 1 ? "" : "s"} · ${quiet(Math.max(...row.idle))}`
        : `${i + 1}. ${s.name}`;
      return div()
        .id(`rail-${s.id}`)
        .relative().size(TILE).flex_none().rounded(8)
        .flex().items_center().justify_center()
        .bg(s.active ? INK.raised : INK.card).border(1).border_color(INK.line)
        .when(s.active, (el) => el.child(div().absolute().left(6).right(6).top(0).h(1).bg("#ffffff1f")))
        .when(!s.active, (el) => el.hover((h) => h.bg(INK.hover)))
        .cursor_pointer()
        .tooltip(tip)
        .on_click(() => run("space.select", { id: s.id }))
        .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: s.id } } }))
        .child(div().text_size(13).font_weight(500).text_color(s.active ? INK.amber : INK.t2).child([...s.name][0]?.toUpperCase() ?? "?"))
        .when(Boolean(dot), (el) => el.child(div().absolute().top(-2).right(-2).size(8).rounded(4).bg(dot).border(2).border_color(INK.rail)))
        .when(idle > 0, (el) => el.child(div().absolute().bottom(-3).right(-3).size(10).rounded(5)
          .bg(INK.rail).border(1.5).border_color(INK.t3)));
    };
    return v_flex().size_full().pt(44).items_center()
      .child(v_flex().relative().w_full().items_center().gap(GAP).flex_none()
        .children(this.branches(rows))
        .children(rows.map(tile)));
  }

  // props().role "buttons": the rail's bottom copy, below the Claude accounts block.
  buttons() {
    const button = (id, tip, icon, size, action) => div().id(id).size(32).rounded(8).flex().items_center().justify_center()
      .text_color(INK.t3).hover((h) => h.bg(INK.hover).text_color(INK.t1))
      .tooltip(tip).on_click(action).child(svg(icon).size(size));
    return v_flex().size_full().justify_end().pb(12).items_center().gap(8)
      .child(button("rail-new", "New space", "mods/workspace-chrome/plus.svg", 14, () => run("space.new")))
      .child(button("rail-settings", "Settings", "mods/workspace-chrome/settings.svg", 15, () => run("app.settings")));
  }
}
