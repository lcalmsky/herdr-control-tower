// Claude accounts for Herdr: the head shows a 5h and 7d gauge for every account, then a chip
// naming the focused agent's account. The chip's popup picks the account new sessions start
// under, renames accounts in place, resumes this session under another account, or makes a new
// account. The shell work lives in `cca`.
// props().role: "chip" draws the head, "rail" one ringed avatar per account for the bottom of a
// side rail, "menu" (or none, as mod.open gives) the accounts popup, and mode "add" the add form.

import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, terminals, focused, run, exec, props, appHome, openOverlay, closeOverlay } from "herdr";

const INK = {
  ink: "#07080d", card: "#11141c", raised: "#1a1e28", selected: "#161a24", line: "#1d212b",
  t1: "#eef0f5", t2: "#a3a9b8", t3: "#7a8296", amber: "#f2a93b", red: "#e5484d", ring: "#3a404e", track: "#c4c8d2", used: "#5b9cf5",
};
const FONT = "Nunito";

// Account names go into a shell command line, so only these characters are accepted anywhere.
const ACCOUNT_NAME = /^[A-Za-z0-9_-]+$/;
const RESERVED = new Set(["ls", "add", "share", "help"]);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Herdr has no API for a mod's own folder; the app home is where Herdr keeps mods.
const cca = () => `${appHome()}/mods/claude-accounts/cca`;

// The display label cca keeps for an account, falling back to the account name.
const display = (a) => a?.label || a?.name || "";

// Herdr's JS engine ignores toLocaleDateString's weekday option and prints the whole date.
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// A rate-limit window past its reset time is spent: it counts as 0 % and has no reset time to show.
const liveWindow = (w) => (w?.reset && w.reset * 1000 <= Date.now() ? { used: 0, reset: null } : w);

// Clock time within a day, else the weekday.
const resetLabel = (at) => {
  const d = new Date(at * 1000);
  return d - Date.now() < 86400000
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : WEEKDAYS[d.getDay()];
};

// A clockwise arc from 12 o'clock on a 40 px square, drawn in pieces of at most a quarter turn:
// one large arc whose ends nearly meet (98 % used) is drawn off-centre by the painter.
function arcPath(r, frac, width) {
  let p = PathBuilder.stroke(width).move_to(20, 20 - r);
  const turn = Math.min(1, frac);
  const pieces = Math.max(1, Math.ceil(turn * 4));
  for (let i = 1; i <= pieces; i++) {
    const a = (turn * i / pieces) * 2 * Math.PI;
    p = p.arc_to(r, r, 0, false, true, 20 + r * Math.sin(a), 20 - r * Math.cos(a));
  }
  return p.build();
}

export default class ClaudeAccounts extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.role = p.role ?? "menu";
    this.accounts = p.accounts?.length ? p.accounts : [{ name: "default", email: "", usage: null }];
    this.current = p.current ?? "default";
    this.globalDefault = p.globalDefault ?? "default";
    this.session = p.session ?? null;
    this.readError = p.error ?? null;
    this.hover = null;
    this.rename = null;
    this.renameError = null;
    this.actionError = null;
    if (this.role === "menu" && p.mode === "add") {
      this.cx = cx;
      this.input = InputState.new({ value: "" });
      this.input.on("change", (_e, cx) => { this.error = null; cx.notify(); });
      this.input.on("submit", () => this.addAccount());
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
      return;
    }
    if (this.role === "menu") this.handle = cx.focus_handle();
    cx.timer.every(30000, (cx) => this.readAccounts(cx));
    this.readAccounts(cx);
  }

  // The focused agent's pid when it is a local Claude Code process.
  focusedPid() {
    const f = focused();
    const a = agents().find((x) => x.focused || (f && (f.terminal === x.address || f.agent === x.address)));
    if (!a || a.address.includes("/")) return null;
    const t = terminals().find((x) => x.address === a.address);
    const claude = [t?.program?.key, t?.foreground?.name].some((n) => String(n ?? "").toLowerCase().includes("claude"));
    return claude ? t?.foreground?.pid ?? null : null;
  }

  readAccounts(cx, pid = this.focusedPid()) {
    if (this.readingAccounts) return;
    this.focusKey = pid == null ? "" : String(pid);
    const key = this.focusKey;
    this.readingAccounts = true;
    cx.spawn(async (cx) => {
      const accounts = [];
      const labels = {};
      let current = "default";
      let globalDefault = "default";
      let session = null;
      let r = null;
      try {
        r = await exec("sh", this.focusKey ? [cca(), "--porcelain", this.focusKey] : [cca(), "--porcelain"]);
        const byName = {};
        for (const line of (r.stdout ?? "").split("\n")) {
          const [kind, name, value] = line.split("\t");
          if (kind === "C" && name) current = name;
          if (kind === "D" && ACCOUNT_NAME.test(name ?? "")) globalDefault = name;
          if (kind === "A" && ACCOUNT_NAME.test(name ?? "")) {
            const a = { name, email: (value ?? "").trim(), usage: null, label: null };
            byName[name] = a;
            accounts.push(a);
          }
          if (kind === "L" && name && (value ?? "").trim()) labels[name] = value.trim();
          if (kind === "U" && byName[name]) {
            const f = line.split("\t");
            const win = (u, at) => /^\d+(\.\d+)?$/.test(u ?? "")
              ? { used: Number(u), reset: /^\d+$/.test(at ?? "") ? Number(at) : null } : null;
            byName[name].usage = { five: win(f[2], f[3]), seven: win(f[4], f[5]) };
          }
          if (kind === "S" && SESSION_ID.test(name ?? "")) session = { id: name, cwd: (value ?? "").trim() };
        }
        for (const a of accounts) a.label = labels[a.name] ?? null;
      } catch {}
      this.readingAccounts = false;
      if (accounts.length) {
        this.readError = null;
        this.accounts = accounts;
        this.current = current;
        this.currentKey = key;
        this.globalDefault = globalDefault;
        this.session = session?.cwd ? session : null;
      } else if (!r || r.code === 127) {
        this.readError = `cca not found: ${cca()}`;
      }
      cx.notify();
      // A focus change that landed during the read is picked up here, not on the 30 s timer.
      const now = this.focusedPid();
      if ((now == null ? "" : String(now)) !== this.focusKey) this.readAccounts(cx, now);
    });
  }

  // Opens the chosen account's Claude Code in a pane beside the focused one; running agents keep their own account.
  openAgent(name) {
    if (!ACCOUNT_NAME.test(name)) return;
    // The default account runs with CLAUDE_CONFIG_DIR unset: set to ~/.claude, Claude Code would read
    // ~/.claude/.claude.json instead of ~/.claude.json and start from an empty state. CCA_ACCOUNT makes
    // this click win over the global default the shell hook would otherwise apply.
    const env = name === "default"
      ? "unset CLAUDE_CONFIG_DIR; CCA_ACCOUNT=default"
      : `CLAUDE_CONFIG_DIR="$HOME/.claude-accounts/${name}" CCA_ACCOUNT=${name}`;
    run("pane.split", { direction: "right", argv: ["sh", "-lc", `${env} exec claude`] });
  }

  addAccount() {
    if (this.busy) return;
    const name = (this.input?.value() ?? "").trim();
    if (!ACCOUNT_NAME.test(name)) { this.error = "Use letters, digits, - or _."; this.cx.notify(); return; }
    if (name === "default") { this.error = "default is the ~/.claude account."; this.cx.notify(); return; }
    if (RESERVED.has(name) || name.startsWith("-")) { this.error = `${name} is a cca command.`; this.cx.notify(); return; }
    this.busy = true;
    this.error = null;
    this.cx.notify();
    this.cx.spawn(async (cx) => {
      let r = null;
      try { r = await exec("sh", [cca(), "--porcelain-add", name]); } catch {}
      this.busy = false;
      if (!r || r.code !== 0) {
        this.error = ((r?.stderr || r?.stdout) ?? "").trim() || "Could not create the account folder.";
        cx.notify();
        return;
      }
      closeOverlay(props().overlay);
      this.openAgent(name);
    });
  }

  avatar(name, size, font) {
    return div().size(size).flex_none().rounded(size / 2).bg(INK.raised).flex().items_center().justify_center()
      .text_size(font).font_family(FONT).font_bold().text_color(INK.t1).child([...(name || "?")][0]?.toUpperCase() ?? "?");
  }

  radio(on) {
    return h_flex().size(12).flex_none().rounded(6).border(1.5).border_color(on ? INK.amber : INK.ring)
      .items_center().justify_center()
      .when(on, (el) => el.child(div().size(6).rounded(3).bg(INK.amber)));
  }

  accountChip() {
    const name = this.current ?? "default";
    const label = this.readError ? "?" : display(this.accounts.find((a) => a.name === name)) || name;
    return h_flex().id("head-accounts").h(26).flex_none().items_center().gap(6).pl(3).pr(10).rounded(13)
      .bg(INK.card).border(1).border_color(INK.line)
      .hover((h) => h.bg(INK.selected)).cursor_pointer().tooltip(this.readError ?? "Claude accounts")
      .on_click(() => this.openMenu())
      .child(this.avatar(label, 20, 11))
      .child(div().text_size(13).font_family(FONT).font_weight(600).text_color(INK.t1).child(label))
      .child(div().text_size(10).font_family(FONT).text_color(INK.t3).child("▾"));
  }

  openMenu() {
    const name = this.current ?? "default";
    const list = this.accounts?.length ? this.accounts : [{ name: "default", email: "", usage: null }];
    const resume = this.session ? list.filter((a) => a.name !== name) : [];
    openOverlay({ mod: "claude-accounts", kind: "popup", width: 300,
      height: this.readError ? 80 : this.menuHeight(list.length, resume.length),
      props: { role: "menu", current: name, globalDefault: this.globalDefault ?? "default",
        accounts: list, session: this.session, error: this.readError ?? null } });
  }

  // The popup grows by whole rows, so its height is known before it opens; the last 18 px hold
  // the rename hint or a failure line, because an overlay cannot be resized after opening.
  menuHeight(count, resumeCount) {
    return 12 + 24 + count * 44 + (resumeCount ? 13 + 24 + resumeCount * 32 : 0) + 13 + 32 + 18;
  }

  // The block is as wide as the layout says; the chip keeps its place at the right end of the head.
  chip(cx) {
    const pid = this.focusedPid();
    if ((pid == null ? "" : String(pid)) !== this.focusKey) this.readAccounts(cx, pid);
    const list = this.accounts?.length ? this.accounts : [{ name: "default", email: "", usage: null }];
    const groups = [];
    for (const a of list) {
      if (groups.length) groups.push(div().w(1).h(16).flex_none().bg(INK.line));
      groups.push(this.accountGauges(a));
    }
    return h_flex().size_full().items_center().justify_end().pr(20).gap(16)
      .children(groups)
      .child(this.accountChip());
  }

  accountGauges(a) {
    const me = a.name === this.current;
    return h_flex().flex_none().items_center().gap(8)
      .child(div().flex_none().text_size(12).font_family(FONT).font_bold().text_color(me ? INK.t1 : INK.t3).child(display(a)))
      .child(this.gauge(a, "5h", a.usage?.five))
      .child(this.gauge(a, "7d", a.usage?.seven));
  }

  // One rate-limit window as a fuel gauge: a 44 px bar with quarter ticks, the percentage and,
  // from 90 %, the reset time in red (clock time within a day, else the weekday).
  gauge(a, label, raw) {
    const w = liveWindow(raw);
    const pct = w ? Math.min(100, Math.round(w.used)) : null;
    const hot = pct != null && pct >= 90;
    const when = w?.reset ? resetLabel(w.reset) : null;
    return h_flex().flex_none().gap(4).items_center()
      .tooltip(`${display(a)} ${label} window${pct == null ? ": no usage yet" : ` ${pct}% used`}`)
      .child(div().text_size(11).font_family(FONT).font_bold().text_color(INK.t3).child(label))
      .child(div().relative().w(44).h(4).rounded(2).bg(INK.line).overflow_hidden()
        .child(div().absolute().left(0).top(0).bottom(0).w(Math.round(((pct ?? 0) / 100) * 44)).rounded(2)
          .bg(hot ? INK.red : INK.t2))
        .children([11, 22, 33].map((x) => div().absolute().left(x).top(0).bottom(0).w(1).bg("#07080d"))))
      .child(div().flex_none().text_size(12).font_family("Geist Mono")
        .text_color(hot ? INK.red : a.name === this.current ? INK.t1 : INK.t2)
        .child(pct == null ? "–" : `${pct}%`))
      .when(Boolean(hot && when), (el) => el.child(div().flex_none().text_size(12).font_family("Geist Mono")
        .text_color(INK.t3).child(`↻ ${when}`)));
  }

  // The account's current rate-limit windows: "5h 12% · 7d 9%", the 5h percentage red at the limit,
  // and the reset time once a window is nearly used up.
  usageLine(a) {
    const mono = (text, color = INK.t3) => div().flex_none().text_size(10.5).font_family("Geist Mono").text_color(color).child(text);
    const parts = [];
    for (const [label, w] of [["5h", liveWindow(a.usage?.five)], ["7d", liveWindow(a.usage?.seven)]]) {
      if (!w) continue;
      const pct = Math.round(w.used);
      if (parts.length) parts.push(mono(" · "));
      parts.push(mono(`${label} `), mono(`${pct}%`, label === "5h" && pct >= 100 ? INK.red : INK.t3));
      if (w.used >= 90 && w.reset) {
        const d = new Date(w.reset * 1000);
        parts.push(mono(` ↻${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`));
      }
    }
    return parts.length ? h_flex().items_center().children(parts) : mono("no usage yet");
  }

  // A 40 px avatar per account, stacked from the bottom: one ring per rate-limit window, the 5h
  // window outside. Every track is drawn in full so each avatar keeps the same outer edge. The
  // focused Claude Code pane's account goes on top with an amber disc and a dark letter; otherwise
  // the letter is bright only on the account new sessions open as.
  rail(cx) {
    const pid = this.focusedPid();
    if ((pid == null ? "" : String(pid)) !== this.focusKey) this.readAccounts(cx, pid);
    const list = this.accounts?.length ? this.accounts : [{ name: "default", email: "", usage: null }];
    // Without a focused Claude Code pane there is no "this pane" account to mark, and `current`
    // counts only once a read for the pane focused now has come back.
    const here = this.focusKey && this.currentKey === this.focusKey ? this.current : null;
    const ordered = [...list.filter((a) => a.name === here), ...list.filter((a) => a.name !== here)];
    return v_flex().size_full().items_center().justify_end().gap(8).pb(8)
      .children(ordered.map((a) => this.ringAvatar(a, a.name === here)));
  }

  ringAvatar(a, here) {
    const windows = [["5h", a.usage?.five], ["7d", a.usage?.seven]].map(([label, raw]) => [label, liveWindow(raw)]);
    // Ring slots are fixed (sized for three) and filled from the outside, so a ring keeps its size
    // and place whatever the ring count; fewer windows only leave the inner slots empty.
    const width = 3;
    const step = 4.5;
    const outer = 20 - width / 2;
    const core = 7.5;
    const rings = [];
    windows.forEach(([, w], i) => {
      const r = outer - i * step;
      const pct = w ? Math.min(100, Math.max(0, w.used)) : 0;
      rings.push(window.paint_path(arcPath(r, 1, width), INK.track).absolute().top(0).left(0).size(40));
      if (pct > 0) {
        rings.push(window.paint_path(arcPath(r, pct / 100, width), pct >= 90 ? INK.red : INK.used)
          .absolute().top(0).left(0).size(40));
      }
    });
    const tip = [display(a), ...windows.map(([label, w]) => {
      if (!w) return `${label} –`;
      const pct = Math.round(w.used);
      return pct >= 90 && w.reset ? `${label} ${pct}% ↻ ${resetLabel(w.reset)}` : `${label} ${pct}%`;
    })].join(" · ");
    const bright = a.name === (this.globalDefault ?? "default");
    return div().id(`rail-acct-${a.name}`).relative().size(40).flex_none().rounded(20).cursor_pointer()
      .tooltip(this.readError ?? `${tip}${here ? " · this pane" : ""}${bright ? " · new sessions" : ""}`)
      .on_click(() => this.openMenu())
      .children(rings)
      // The focused pane's account fills its disc amber with a dark letter, so it reads as selected.
      .child(div().absolute().top(20 - core).left(20 - core).size(core * 2).rounded(core).bg(here ? INK.amber : INK.raised)
        .when(!here, (el) => el.hover((h) => h.bg(INK.selected)))
        .flex().items_center().justify_center()
        .text_size(10).font_semibold().text_color(here ? INK.ink : bright ? INK.t1 : INK.t3)
        .child([...(display(a) || "?")][0]?.toUpperCase() ?? "?"));
  }

  // Resumes the focused agent's session under another account in a new pane; the old one keeps running.
  continueAs(name, session) {
    if (!ACCOUNT_NAME.test(name) || !SESSION_ID.test(session?.id ?? "") || !session?.cwd) return;
    const env = name === "default"
      ? "unset CLAUDE_CONFIG_DIR; CCA_ACCOUNT=default"
      : `CLAUDE_CONFIG_DIR="$HOME/.claude-accounts/${name}" CCA_ACCOUNT=${name}`;
    // pane.split takes no folder, so the shell changes into the session's cwd first.
    const cwd = `'${session.cwd.replace(/'/g, "'\\''")}'`;
    run("pane.split", { direction: "right", argv: ["sh", "-lc", `cd ${cwd} && ${env} exec claude --resume ${session.id}`] });
  }

  // Makes the account new sessions start under; the popup stays open so the radio follows.
  useAccount(name, cx) {
    if (!ACCOUNT_NAME.test(name) || this.usingAccount) return;
    this.usingAccount = true;
    this.actionError = null;
    cx.spawn(async (cx) => {
      let r = null;
      try { r = await exec("sh", [cca(), "use", name]); } catch {}
      this.usingAccount = false;
      if (!r || r.code !== 0) {
        this.actionError = ((r?.stderr || r?.stdout) ?? "").trim() || "Could not change the default account.";
        cx.notify();
        return;
      }
      this.readAccounts(cx);
      cx.notify();
    });
  }

  startRename(a, cx) {
    this.actionError = null;
    this.renameError = null;
    this.hover = null;
    const input = InputState.new({ value: display(a) });
    input.on("submit", (_e, cx) => this.saveRename(cx));
    this.rename = { name: a.name, input };
    input.focus();
    cx.timer.after(300, () => { if (this.rename?.input === input) input.focus(); });
    cx.notify();
  }

  saveRename(cx) {
    const r = this.rename;
    if (!r || this.savingRename) return;
    const value = (r.input.value() ?? "").trim();
    this.savingRename = true;
    this.renameError = null;
    cx.spawn(async (cx) => {
      let res = null;
      try { res = await exec("sh", [cca(), "--porcelain-rename", r.name, value]); } catch {}
      this.savingRename = false;
      if (!res || res.code !== 0) {
        this.renameError = ((res?.stderr || res?.stdout) ?? "").trim() || "Could not rename the account.";
        cx.notify();
        return;
      }
      this.rename = null;
      this.readAccounts(cx);
      cx.notify();
    });
  }

  accountsMenu() {
    if (this.readError) {
      return v_flex().id("accounts-menu").w_full().h_full().min_h(0).p(6).overflow_y_scroll()
        .child(div().px(8).py(6).text_size(11).font_family(FONT).text_color(INK.red).child(this.readError));
    }
    const cur = this.current ?? "default";
    const list = this.accounts?.length ? this.accounts : [{ name: "default", email: "", usage: null }];
    const resume = this.session ? list.filter((a) => a.name !== cur) : [];
    const accountRow = (a) => {
      const isDefault = a.name === (this.globalDefault ?? "default");
      if (this.rename?.name === a.name) {
        return v_flex().id(`acct-${a.name}`).w_full().flex_none()
          .child(h_flex().h(44).px(8).rounded(8).gap(8).items_center().bg(INK.selected)
            .child(div().w(14).flex_none().flex().justify_center().child(this.radio(isDefault)))
            .child(this.avatar(display(a), 20, 10))
            .child(Input.new(this.rename.input).h(28).flex_1().min_w(0).rounded(6).border(1)
              .border_color("#f2a93b80").bg(INK.raised).text_size(13).font_family(FONT).font_bold()
              .text_color(INK.t1)))
          .child(div().h(18).pl(50).pr(8).flex().items_center().text_size(10).font_family("Geist Mono")
            .text_color(this.renameError ? INK.red : INK.t3).child(this.renameError ?? "↩ save · esc cancel"));
      }
      const hovered = this.hover === a.name;
      return h_flex().id(`acct-${a.name}`).h(44).flex_none().px(8).rounded(8).gap(8).items_center().cursor_pointer()
        .hover((h) => h.bg(INK.selected))
        .on_hover((on, cx) => {
          if (on) this.hover = a.name;
          else if (this.hover === a.name) this.hover = null;
          cx.notify();
        })
        .tooltip(`New sessions open as ${display(a)}`)
        .on_click((_e, cx) => { if (!this.rename) this.useAccount(a.name, cx); })
        .child(div().w(14).flex_none().flex().justify_center().child(this.radio(isDefault)))
        .child(this.avatar(display(a), 20, 10))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(8).items_center().min_w(0)
            .child(div().flex_none().text_size(13).font_family(FONT).font_bold().text_color(INK.t1).child(display(a)))
            .when(a.name === cur, (el) => el.child(div().flex_none().text_size(10).font_family("Geist Mono")
              .text_color(INK.t3).child("this pane"))))
          .child(div().truncate().text_size(11).font_family("Geist Mono").text_color(INK.t3).child(a.email || "not signed in")))
        .child(h_flex().flex_none().items_center()
          .when(!hovered, (el) => el.child(this.usageLine(a)))
          .when(hovered, (el) => el.child(h_flex().id(`pen-${a.name}`).size(16).flex_none().items_center()
            .justify_center().cursor_pointer()
            .on_click((_e, cx) => { cx.stop_propagation(); this.startRename(a, cx); })
            .child(svg("mods/claude-accounts/pencil.svg").size(16).flex_none().text_color(INK.t3)))));
    };
    const resumeRow = (a) => h_flex().id(`cont-${a.name}`).h(32).flex_none().px(8).rounded(8).gap(8).items_center().cursor_pointer()
      .hover((h) => h.bg(INK.selected)).tooltip(`Resume this session as ${display(a)}`)
      .on_click(() => { closeOverlay(props().overlay); this.continueAs(a.name, this.session); })
      .child(div().w(14).flex_none())
      .child(this.avatar(display(a), 20, 10))
      .child(div().flex_1().min_w(0).truncate().text_size(13).font_family(FONT).font_bold().text_color(INK.t2).child(display(a)))
      .child(div().flex_none().text_size(11).font_family("Geist Mono").text_color(INK.t3).child("resume in pane"));
    return v_flex().id("accounts-menu").w_full().h_full().min_h(0).p(6).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.rename) {
          this.rename = null;
          this.renameError = null;
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(div().h(24).px(8).flex().items_center().text_size(11).font_family(FONT).font_weight(600).text_color(INK.t3)
        .child("New sessions open as"))
      .children(list.map(accountRow))
      .when(Boolean(this.actionError), (el) => el.child(div().h(18).px(8).flex().items_center().text_size(11)
        .font_family(FONT).text_color(INK.red).child(this.actionError)))
      .when(resume.length > 0, (el) => el
        .child(div().h(1).mx(2).my(6).bg(INK.line))
        .child(div().h(24).px(8).flex().items_center().text_size(11).font_family(FONT).font_weight(600).text_color(INK.t3)
          .child("Continue this session as"))
        .children(resume.map(resumeRow)))
      .child(div().h(1).mx(2).my(6).bg(INK.line))
      .child(h_flex().id("acct-add").h(32).flex_none().pl(30).pr(8).rounded(8).items_center().cursor_pointer()
        .hover((h) => h.bg(INK.selected))
        .on_click(() => {
          closeOverlay(props().overlay);
          openOverlay({ mod: "claude-accounts", kind: "popup", width: 260, height: 170,
            props: { mode: "add" } });
        })
        .child(div().text_size(12).font_family(FONT).font_weight(600).text_color(INK.t2).child("+ Add account…")));
  }

  addAccountView() {
    const button = (id, label, primary, action) => h_flex().id(id).h(30).px(12).items_center().rounded(8).border(1)
      .border_color(primary ? INK.amber : INK.line).bg(primary ? INK.amber : INK.raised)
      .text_color(primary ? "#0b0d14" : INK.t1).text_size(12).font_family(FONT).font_weight(600).cursor_pointer()
      .hover((h) => h.opacity(0.9)).on_click(action).child(label);
    return v_flex().id("account-add").w_full().min_h(0).p(14).gap(8)
      .child(div().text_size(14).font_family(FONT).font_bold().text_color(INK.t1).child("Add account"))
      .child(div().text_size(11).font_family(FONT).text_color(INK.t3).child("Creates ~/.claude-accounts/<name>"))
      .child(Input.new(this.input).h(32).px(10).rounded(8).border(1).border_color(INK.line).bg(INK.raised)
        .text_size(13).text_color(INK.t1))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11).font_family(FONT).text_color(INK.red).child(this.error)))
      .child(h_flex().justify_end().gap(8)
        .child(button("acct-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("acct-create", this.busy ? "Creating…" : "Create", true, () => this.addAccount())));
  }

  render(cx) {
    if (this.role === "chip") return this.chip(cx);
    if (this.role === "rail") return this.rail(cx);
    return props()?.mode === "add" ? this.addAccountView() : this.accountsMenu();
  }
}
