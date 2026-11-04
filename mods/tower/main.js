// Control tower: every agent is an aircraft on one of four runways.
// TOWER needs you, RUNWAY is working, APPROACH finished while you weren't looking,
// TAXI is idle. An aircraft slides to its new runway when the status changes, so the
// change is seen as motion. props().role: "head" draws the title bar, "accounts" the
// account popup, anything else the runways.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, terminals, spaces, focused, run, exec, hc, props, setAgentOrder, openOverlay, closeOverlay } from "herdr";

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
const LANE_H = 84, LANE_GAP = 8, LABEL_W = 148, PLANE = 26, BAR_W = 72, TAG_W = 240, TAG_H = 64, PAD = 12;
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
const CONTEXT_SCRIPT = `base="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
tmp=$(mktemp "\${TMPDIR:-/tmp}/herdr-tower.XXXXXX") || exit 0
trap 'rm -f "$tmp"' EXIT
for pid in "$@"; do
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  root=
  for d in "$base" "$HOME"/.claude-accounts/*/; do
    [ -f "$d/sessions/$pid.json" ] && { root="$d"; break; }
  done
  [ -n "$root" ] || continue
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

// Which account a Claude process runs under (its environment's CLAUDE_CONFIG_DIR), the accounts
// with their signed-in email and recorded 5h/7d usage, and the focused pid's resumable session.
// Only names, emails, usage numbers, a session id and a folder leave the shell.
const ACCOUNTS_SCRIPT = `acct_name() {
  case "$1" in
    "$HOME/.claude") echo default ;;
    "$HOME"/.claude-accounts/*) b=\${1%/}; echo "\${b##*/}" ;;
    *) b=\${1%/}; echo "\${b##*/}" ;;
  esac
}
email() {
  [ -f "$1" ] || { echo "not signed in"; return; }
  e=$(grep -o '"emailAddress"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null | head -n 1 | sed 's/.*:[[:space:]]*"//; s/"$//')
  [ -n "$e" ] && echo "$e" || echo "not signed in"
}
val() {
  printf '%s' "$1" | grep -o "\\"$2\\":[0-9][0-9.]*" 2>/dev/null | head -n 1 | cut -d: -f2
}
usage() {
  f="\${XDG_STATE_HOME:-$HOME/.local/state}/herdr-tower/usage/$1.json"
  [ -f "$f" ] || return 0
  five=$(grep -o '"five_hour":{[^}]*}' "$f" 2>/dev/null | head -n 1)
  seven=$(grep -o '"seven_day":{[^}]*}' "$f" 2>/dev/null | head -n 1)
  printf 'U\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$1" "$(val "$five" used)" "$(val "$five" resets_at)" "$(val "$seven" used)" "$(val "$seven" resets_at)"
}
cur=default
if [ -n "$1" ]; then
  d=$(ps -E -ww -p "$1" -o command= 2>/dev/null | tr ' ' '\\n' | grep '^CLAUDE_CONFIG_DIR=' | tail -n 1 | cut -d= -f2-)
  d=\${d%/}
  cur=$(acct_name "\${d:-$HOME/.claude}")
fi
printf 'C\\t%s\\n' "$cur"
printf 'A\\tdefault\\t%s\\n' "$(email "$HOME/.claude.json")"
usage default
for d in "$HOME"/.claude-accounts/*/; do
  d=\${d%/}
  [ -d "$d" ] && [ "\${d##*/}" != default ] || continue
  case "\${d##*/}" in ''|*[!A-Za-z0-9_-]*) continue ;; esac
  printf 'A\\t%s\\t%s\\n' "\${d##*/}" "$(email "$d/.claude.json")"
  usage "\${d##*/}"
done
if [ -n "$1" ]; then
  sf="$HOME/.claude/sessions/$1.json"
  if [ -f "$sf" ]; then
    sid=$(head -c 65536 "$sf" 2>/dev/null | grep -oE '"sessionId" *: *"[0-9a-fA-F-]{36}"' | grep -oE '[0-9a-fA-F-]{36}' | head -n 1)
    cwd=$(head -c 65536 "$sf" 2>/dev/null | grep -oE '"cwd" *: *"[^"]*"' | head -n 1 | sed 's/.*: *"//; s/"$//')
    [ -n "$sid" ] && [ -n "$cwd" ] && printf 'S\\t%s\\t%s\\n' "$sid" "$cwd"
  fi
fi`;

// A new account is a config dir of its own: everything in ~/.claude is linked in except login and
// per-session state. Session history is linked too, so every account sees the same transcripts.
const ADD_ACCOUNT_SCRIPT = `name=$1
case "$name" in ''|*[!A-Za-z0-9_-]*) echo "Use letters, digits, - or _."; exit 2 ;; default) echo "default is the ~/.claude account."; exit 2 ;; esac
dir="$HOME/.claude-accounts/$name"
[ -e "$dir" ] && { echo "$name already exists."; exit 3; }
mkdir -p "$dir" || exit 4
# The shared entries are created under ~/.claude first: a missing link target would make Claude
# Code keep a private copy inside the account folder, and the history would split.
for x in projects file-history todos plans tasks teams paste-cache session-env sessions; do
  mkdir -p "$HOME/.claude/$x" || { rm -rf "$dir"; echo "Could not create ~/.claude/$x."; exit 4; }
done
[ -e "$HOME/.claude/history.jsonl" ] || : > "$HOME/.claude/history.jsonl" || { rm -rf "$dir"; echo "Could not create ~/.claude/history.jsonl."; exit 4; }
for src in "$HOME"/.claude/* "$HOME"/.claude/.[!.]*; do
  [ -e "$src" ] || continue
  x=\${src##*/}
  case "$x" in
    .credentials.json|.claude.json|shell-snapshots|statsig|ide|debug|backups|telemetry|cache|transcripts|jobs|logs|daemon*|.session-stats.json|.last-*|*.lock) continue ;;
  esac
  ln -s "$src" "$dir/$x" || { rm -rf "$dir"; echo "Could not link $x."; exit 5; }
done
echo "$dir"`;

// Account names go into a shell command line, so only these characters are accepted anywhere.
const ACCOUNT_NAME = /^[A-Za-z0-9_-]+$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A rate-limit window past its reset time is spent: it counts as 0 % and has no reset time to show.
const liveWindow = (w) => (w?.reset && w.reset * 1000 <= Date.now() ? { used: 0, reset: null } : w);

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
    if (this.role === "head") {
      this.accounts = [{ name: "default", email: "", usage: null }];
      this.current = "default";
      this.session = null;
      cx.timer.every(30000, (cx) => this.readAccounts(cx));
      this.readAccounts(cx);
      return;
    }
    if (this.role === "accounts") {
      if (props()?.mode === "add") {
        this.cx = cx;
        this.input = InputState.new({ value: "" });
        this.input.on("change", (_e, cx) => { this.error = null; cx.notify(); });
        this.input.on("submit", () => this.addAccount());
        this.input.focus();
        cx.timer.after(600, () => this.input.focus());
      }
      return;
    }
    cx.timer.every(30000, (cx) => cx.notify());
    cx.timer.every(2500, (cx) => this.readScreens(cx));
    cx.timer.every(10000, (cx) => this.readContext(cx));
    this.readContext(cx);
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
      let session = null;
      try {
        const r = await exec("sh", ["-c", ACCOUNTS_SCRIPT, "sh", this.focusKey]);
        const byName = {};
        for (const line of (r.stdout ?? "").split("\n")) {
          const [kind, name, mail] = line.split("\t");
          if (kind === "C" && name) current = name;
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
        this.accounts = accounts;
        this.current = current;
        this.session = session?.cwd ? session : null;
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
    // ~/.claude/.claude.json instead of ~/.claude.json and start from an empty state.
    const env = name === "default" ? "unset CLAUDE_CONFIG_DIR;" : `CLAUDE_CONFIG_DIR="$HOME/.claude-accounts/${name}"`;
    run("tab.new", { name: name === "default" ? "claude" : name, argv: ["sh", "-lc", `${env} exec claude`] });
  }

  addAccount() {
    if (this.busy) return;
    const name = (this.input?.value() ?? "").trim();
    if (!ACCOUNT_NAME.test(name)) { this.error = "Use letters, digits, - or _."; this.cx.notify(); return; }
    if (name === "default") { this.error = "default is the ~/.claude account."; this.cx.notify(); return; }
    this.busy = true;
    this.error = null;
    this.cx.notify();
    this.cx.spawn(async (cx) => {
      let r = null;
      try { r = await exec("sh", ["-c", ADD_ACCOUNT_SCRIPT, "sh", name]); } catch {}
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

  avatar(name, size, font) {
    return div().size(size).flex_none().rounded(size / 2).bg(INK.raised).flex().items_center().justify_center()
      .text_size(font).font_family(FONT).font_bold().text_color(INK.t1).child([...(name || "?")][0]?.toUpperCase() ?? "?");
  }

  accountChip() {
    const name = this.current ?? "default";
    return h_flex().id("head-accounts").h(26).flex_none().items_center().gap(6).pl(3).pr(10).rounded(13)
      .bg(INK.card).border(1).border_color(INK.line)
      .hover((h) => h.bg(INK.selected)).cursor_pointer().tooltip("Claude accounts")
      .on_click(() => {
        const list = this.accounts?.length ? this.accounts : [{ name: "default", email: "", usage: null }];
        const resume = this.session ? list.filter((a) => a.name !== name) : [];
        const section = resume.length ? 18 + resume.length * 26 : 0;
        openOverlay({ mod: "tower", kind: "popup", width: 260, height: 67 + list.length * 38 + section,
          props: { role: "accounts", current: name, accounts: list, session: this.session } });
      })
      .child(this.avatar(name, 20, 11))
      .child(div().text_size(13).font_family(FONT).font_weight(600).text_color(INK.t1).child(name))
      .child(div().text_size(10).font_family(FONT).text_color(INK.t3).child("▾"));
  }

  head(cx) {
    const cur = spaces().find((s) => s.active);
    const pid = this.focusedPid();
    if ((pid == null ? "" : String(pid)) !== this.focusKey) this.readAccounts(cx, pid);
    return h_flex().size_full().pl(20).pr(20).gap(8).items_center()
      .child(div().text_size(15).font_family(FONT).font_bold().text_color(INK.t1).child(cur?.name ?? "Herdr"))
      .child(div().text_size(13).font_family(FONT).font_weight(600).text_color(INK.t3).child(`${agents().length} aircraft · 4 runways`))
      .child(div().flex_1())
      .child(this.accountChip());
  }

  accountsMenu() {
    const p = props() ?? {};
    const cur = p.current ?? "default";
    const list = p.accounts?.length ? p.accounts : [{ name: "default", email: "", usage: null }];
    const resume = p.session ? list.filter((a) => a.name !== cur) : [];
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
      .child(h_flex().w_full().min_w(0).justify_end().child(this.usageLine(a)));
    const resumeRow = (a) => h_flex().id(`cont-${a.name}`).h(26).px(8).rounded(6).gap(8).items_center().cursor_pointer()
      .hover((h) => h.bg(INK.selected)).tooltip(`Resume this session as ${a.name}`)
      .on_click(() => { closeOverlay(props().overlay); this.continueAs(a.name, p.session); })
      .child(div().w(10).flex_none())
      .child(this.avatar(a.name, 16, 8))
      .child(div().text_size(12).font_family(FONT).font_weight(600).text_color(INK.t2).child(a.name))
      .child(h_flex().flex_1().justify_end()
        .child(div().text_size(10).font_family("Geist Mono").text_color(INK.t3).child("resume")));
    return v_flex().id("accounts-menu").w_full().min_h(0).p(5)
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
          openOverlay({ mod: "tower", kind: "popup", width: 260, height: 170,
            props: { role: "accounts", mode: "add" } });
        })
        .child(div().w(10).flex_none())
        .child(div().text_size(12).font_family(FONT).font_weight(600).text_color(INK.t2).child("+ Add account…")));
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
    const env = name === "default" ? "unset CLAUDE_CONFIG_DIR;" : `CLAUDE_CONFIG_DIR="$HOME/.claude-accounts/${name}"`;
    run("tab.new", { name, folder: session.cwd, argv: ["sh", "-lc", `${env} exec claude --resume ${session.id}`] });
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
    const bar = Math.round(ratio * BAR_W);
    const row = () => h_flex().h(16).gap(6).items_center().min_w(0);
    const tag = v_flex().w(TAG_W).h(TAG_H).px(12).py(8).justify_between().rounded(8).bg(INK.raised)
      .border(1).border_color(on ? INK.amber : blocked ? `${lane.color}80` : INK.line)
      .child(row()
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_family(FONT).font_bold().text_color(on ? INK.amber : INK.t1).child(this.session(a)))
        .when(Boolean(since), (el) => el.child(div().flex_none().text_size(12).font_family("Geist Mono").text_color(INK.t3).child(ago(now - since)))))
      .child(row()
        .when(a.status === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(INK.t2).spin(900)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_family("Geist Mono").text_color(INK.t2).child(detail)))
      .child(row().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(FONT).font_weight(600).text_color(INK.t3).child(a.space_name ?? ""))
        .child(div().relative().w(BAR_W).flex_none().h(2).rounded(1).bg(INK.line)
          .child(div().absolute().left(0).top(0).bottom(0).w(bar).rounded(1).bg(on ? INK.amber : INK.t2)))
        .child(div().flex_none().text_size(12).font_family("Geist Mono").text_color(INK.t3)
          .child(ctx ? `${Math.round(ratio * 100)}%` : "–")));
    // The tag truncates; resting on the aircraft shows the session, space and status in full.
    const full = [this.session(a), a.space_name, detail].filter(Boolean).join(" · ");
    return h_flex().id(`ac-${a.address}`).gap(8).items_center().cursor_pointer().tooltip(full)
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

  render(cx) {
    if (this.role === "head") return this.head(cx);
    if (this.role === "accounts") return props()?.mode === "add" ? this.addAccountView() : this.accountsMenu();
    return this.lanes();
  }
}
