// Claude accounts for Herdr: a chip naming the account of the focused Claude Code
// agent, and a popup that opens any account in a new tab, resumes this session
// under another account, or makes a new account. The shell work lives in `cca`.
// props().role: "chip" draws the chip, "menu" (or none, as mod.open gives) the
// accounts popup, and mode "add" the add form.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, terminals, focused, run, exec, props, appHome, openOverlay, closeOverlay } from "herdr";

const INK = {
  card: "#11141c", raised: "#1a1e28", selected: "#161a24", line: "#1d212b",
  t1: "#eef0f5", t2: "#a3a9b8", t3: "#7a8296", amber: "#f2a93b",
};
const FONT = "Nunito";

// Account names go into a shell command line, so only these characters are accepted anywhere.
const ACCOUNT_NAME = /^[A-Za-z0-9_-]+$/;
const RESERVED = new Set(["ls", "add", "share", "help"]);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Herdr has no API for a mod's own folder; the app home is where Herdr keeps mods.
const cca = () => `${appHome()}/mods/claude-accounts/cca`;

// A rate-limit window past its reset time is spent: it counts as 0 % and has no reset time to show.
const liveWindow = (w) => (w?.reset && w.reset * 1000 <= Date.now() ? { used: 0, reset: null } : w);

export default class ClaudeAccounts extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.role = p.role ?? "menu";
    this.accounts = p.accounts?.length ? p.accounts : [{ name: "default", email: "", usage: null }];
    this.current = p.current ?? "default";
    this.globalDefault = p.globalDefault ?? "default";
    this.session = p.session ?? null;
    this.readError = p.error ?? null;
    if (this.role !== "chip" && p.mode === "add") {
      this.cx = cx;
      this.input = InputState.new({ value: "" });
      this.input.on("change", (_e, cx) => { this.error = null; cx.notify(); });
      this.input.on("submit", () => this.addAccount());
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
      return;
    }
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
    this.readingAccounts = true;
    cx.spawn(async (cx) => {
      const accounts = [];
      let current = "default";
      let globalDefault = "default";
      let session = null;
      let r = null;
      try {
        r = await exec("sh", this.focusKey ? [cca(), "--porcelain", this.focusKey] : [cca(), "--porcelain"]);
        const byName = {};
        for (const line of (r.stdout ?? "").split("\n")) {
          const [kind, name, mail] = line.split("\t");
          if (kind === "C" && name) current = name;
          if (kind === "D" && ACCOUNT_NAME.test(name ?? "")) globalDefault = name;
          if (kind === "A" && ACCOUNT_NAME.test(name ?? "")) {
            const a = { name, email: (mail ?? "").trim(), usage: null };
            byName[name] = a;
            accounts.push(a);
          }
          if (kind === "U" && byName[name]) {
            const f = line.split("\t");
            const win = (u, at) => /^\d+(\.\d+)?$/.test(u ?? "")
              ? { used: Number(u), reset: /^\d+$/.test(at ?? "") ? Number(at) : null } : null;
            byName[name].usage = { five: win(f[2], f[3]), seven: win(f[4], f[5]) };
          }
          if (kind === "S" && SESSION_ID.test(name ?? "")) session = { id: name, cwd: (mail ?? "").trim() };
        }
      } catch {}
      this.readingAccounts = false;
      if (accounts.length) {
        this.readError = null;
        this.accounts = accounts;
        this.current = current;
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

  // Opens the chosen account's Claude Code in a new tab; running agents keep their own account.
  openAgent(name) {
    if (!ACCOUNT_NAME.test(name)) return;
    // The default account runs with CLAUDE_CONFIG_DIR unset: set to ~/.claude, Claude Code would read
    // ~/.claude/.claude.json instead of ~/.claude.json and start from an empty state. CCA_ACCOUNT makes
    // this click win over the global default the shell hook would otherwise apply.
    const env = name === "default"
      ? "unset CLAUDE_CONFIG_DIR; CCA_ACCOUNT=default"
      : `CLAUDE_CONFIG_DIR="$HOME/.claude-accounts/${name}" CCA_ACCOUNT=${name}`;
    run("tab.new", { name: name === "default" ? "claude" : name, argv: ["sh", "-lc", `${env} exec claude`] });
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

  accountChip() {
    const name = this.current ?? "default";
    const label = this.readError ? "?" : name;
    return h_flex().id("head-accounts").h(26).flex_none().items_center().gap(6).pl(3).pr(10).rounded(13)
      .bg(INK.card).border(1).border_color(INK.line)
      .hover((h) => h.bg(INK.selected)).cursor_pointer().tooltip(this.readError ?? "Claude accounts")
      .on_click(() => {
        const list = this.accounts?.length ? this.accounts : [{ name: "default", email: "", usage: null }];
        const resume = this.session ? list.filter((a) => a.name !== name) : [];
        const section = resume.length ? 18 + resume.length * 26 : 0;
        openOverlay({ mod: "claude-accounts", kind: "popup", width: 260,
          height: this.readError ? 80 : 67 + list.length * 38 + section,
          props: { role: "menu", current: name, globalDefault: this.globalDefault ?? "default",
            accounts: list, session: this.session, error: this.readError ?? null } });
      })
      .child(this.avatar(label, 20, 11))
      .child(div().text_size(13).font_family(FONT).font_weight(600).text_color(INK.t1).child(label))
      .child(div().text_size(10).font_family(FONT).text_color(INK.t3).child("▾"));
  }

  // The block is as wide as the layout says; the chip keeps its place at the right end of the head.
  chip(cx) {
    const pid = this.focusedPid();
    if ((pid == null ? "" : String(pid)) !== this.focusKey) this.readAccounts(cx, pid);
    return h_flex().size_full().items_center().justify_end().pr(20).child(this.accountChip());
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
      parts.push(mono(`${label} `), mono(`${pct}%`, label === "5h" && pct >= 100 ? "#e5484d" : INK.t3));
      if (w.used >= 90 && w.reset) {
        const d = new Date(w.reset * 1000);
        parts.push(mono(` ↻${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`));
      }
    }
    return parts.length ? h_flex().items_center().children(parts) : mono("no usage yet");
  }

  // Resumes the focused agent's session under another account; the old tab keeps running.
  continueAs(name, session) {
    if (!ACCOUNT_NAME.test(name) || !SESSION_ID.test(session?.id ?? "") || !session?.cwd) return;
    const env = name === "default"
      ? "unset CLAUDE_CONFIG_DIR; CCA_ACCOUNT=default"
      : `CLAUDE_CONFIG_DIR="$HOME/.claude-accounts/${name}" CCA_ACCOUNT=${name}`;
    run("tab.new", { name, folder: session.cwd, argv: ["sh", "-lc", `${env} exec claude --resume ${session.id}`] });
  }

  accountsMenu() {
    if (this.readError) {
      return v_flex().id("accounts-menu").w_full().h_full().min_h(0).p(5).overflow_y_scroll()
        .child(div().px(8).py(6).text_size(11).font_family(FONT).text_color("#e5484d").child(this.readError));
    }
    const cur = this.current ?? "default";
    const list = this.accounts?.length ? this.accounts : [{ name: "default", email: "", usage: null }];
    const resume = this.session ? list.filter((a) => a.name !== cur) : [];
    const fiveUsed = (a) => liveWindow(a.usage?.five)?.used;
    const best = list.reduce((m, a) => {
      const used = fiveUsed(a);
      return used != null && (m == null || used < m) ? used : m;
    }, null);
    const row = (a) => v_flex().id(`acct-${a.name}`).h(38).px(8).rounded(6).justify_center().gap(1).cursor_pointer()
      .hover((h) => h.bg(INK.selected)).tooltip(`Open ${a.name} in a new tab`)
      .on_click(() => { closeOverlay(props().overlay); this.openAgent(a.name); })
      .child(h_flex().h(18).gap(8).items_center().min_w(0)
        .child(div().w(10).flex_none().text_size(11).font_family(FONT).text_color(INK.amber).child(a.name === cur ? "✓" : ""))
        .child(this.avatar(a.name, 18, 9))
        .child(div().flex_none().text_size(12).font_family(FONT).font_weight(600).text_color(INK.t1).child(a.name))
        .when(fiveUsed(a) != null && fiveUsed(a) === best,
          (el) => el.child(div().size(5).flex_none().rounded(3).bg(INK.amber).tooltip("Most 5h headroom")))
        .child(h_flex().flex_1().min_w(0).justify_end()
          .child(div().truncate().text_size(10.5).font_family("Geist Mono").text_color(INK.t3).child(a.email || "not signed in"))))
      .child(h_flex().w_full().min_w(0).items_center()
        .child(div().w(36).flex_none())
        .when(a.name === (this.globalDefault ?? "default"),
          (el) => el.child(div().flex_none().text_size(10).font_family("Geist Mono").text_color(INK.t3).child("default for new")))
        .child(h_flex().flex_1().min_w(0).justify_end().child(this.usageLine(a))));
    const resumeRow = (a) => h_flex().id(`cont-${a.name}`).h(26).px(8).rounded(6).gap(8).items_center().cursor_pointer()
      .hover((h) => h.bg(INK.selected)).tooltip(`Resume this session as ${a.name}`)
      .on_click(() => { closeOverlay(props().overlay); this.continueAs(a.name, this.session); })
      .child(div().w(10).flex_none())
      .child(this.avatar(a.name, 16, 8))
      .child(div().text_size(12).font_family(FONT).font_weight(600).text_color(INK.t2).child(a.name))
      .child(h_flex().flex_1().justify_end()
        .child(div().text_size(10).font_family("Geist Mono").text_color(INK.t3).child("resume")));
    return v_flex().id("accounts-menu").w_full().h_full().min_h(0).p(5).overflow_y_scroll()
      .child(div().h(18).px(8).flex().items_center().text_size(10).font_family(FONT).font_bold().text_color(INK.t3)
        .child("OPEN IN A NEW TAB"))
      .children(list.map(row))
      .child(div().h(1).mx(2).my(4).bg(INK.line))
      .when(resume.length > 0, (el) => el
        .child(div().h(18).px(8).flex().items_center().text_size(10).font_family(FONT).font_weight(600).text_color(INK.t3)
          .child("Continue this session as"))
        .children(resume.map(resumeRow)))
      .child(h_flex().id("acct-add").h(30).px(8).rounded(6).gap(8).items_center().cursor_pointer()
        .hover((h) => h.bg(INK.selected))
        .on_click(() => {
          closeOverlay(props().overlay);
          openOverlay({ mod: "claude-accounts", kind: "popup", width: 260, height: 170,
            props: { mode: "add" } });
        })
        .child(div().w(10).flex_none())
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
      .when(Boolean(this.error), (el) => el.child(div().text_size(11).font_family(FONT).text_color("#e5484d").child(this.error)))
      .child(h_flex().justify_end().gap(8)
        .child(button("acct-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("acct-create", this.busy ? "Creating…" : "Create", true, () => this.addAccount())));
  }

  render(cx) {
    if (this.role === "chip") return this.chip(cx);
    return props()?.mode === "add" ? this.addAccountView() : this.accountsMenu();
  }
}
