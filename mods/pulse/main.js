// Pulse: Claude Code sessions as one board. Sessions that need you come first,
// then the ones still working, then the ones that finished. Every 3 seconds the
// read-only scan.sh reads session records, transcripts, deadhd state and page
// alerts; this view groups them and draws the rows. Keys work while the panel
// holds the keyboard (pane.go), and the legend appears only then.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { exec, run, appHome, terminals, panes, nextCommand } from "herdr";

const INK = {
  bg: "#07080d", card: "#11141c", sel: "#1a1e28", raised: "#161a24",
  line: "#1d212b", dash: "#272c37", sep: "#3a4050",
  t1: "#eef0f5", t2: "#a3a9b8", t3: "#7a8296",
  amber: "#f2a93b", red: "#e5484d", blue: "#5b9cf5", green: "#4cc38a",
};
const FONT = "Geist";
const SANS = "Geist";
const MONO = "Geist Mono";
const POLL_MS = 3000;
const STALL_MS = 10 * 60 * 1000;
const SNOOZE_MS = 10 * 60 * 1000;
const DONE_WINDOW_MS = 12 * 60 * 60 * 1000;
const STALE_MS = 30 * 60 * 1000;
const MAX_DONE = 5;
const SEEN_KEY = "pulse.seen";
const UNDO_MS = 6000;
const NONE = "\u0000none";
const BADGES = { "herdr-app": "herdr", herdr: "herdr", tmux: "tmux", orca: "orca" };
const GROUP_COLOR = { attention: INK.red, working: INK.blue, done: INK.green };
const GROUP_TITLE = { attention: "Needs you", working: "Working", done: "Done" };

function clean(value) {
  if (typeof value !== "string") return null;
  const collapsed = value.trim().split(/\s+/).join(" ");
  return collapsed || null;
}

function clip(value, limit) {
  const text = clean(value);
  if (!text) return null;
  return text.length > limit ? text.slice(0, limit) : text;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return null;
}

function fold(value) {
  const decomposed = String(value ?? "").normalize("NFD");
  return Array.from(decomposed).filter((ch) => {
    const code = ch.codePointAt(0);
    return code < 0x300 || code > 0x36f;
  }).join("").toLowerCase();
}

function minutesOf(ms) {
  return Math.max(0, Math.floor(ms / 60000));
}

function shortDuration(ms) {
  const minutes = Math.max(1, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function agoText(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function etaText(eta, now) {
  if (!Number.isFinite(eta)) return null;
  const minutes = Math.ceil((eta - now) / 60000);
  return minutes > 0 ? `~${minutes}m left` : null;
}

function trailingComponent(path) {
  const text = String(path ?? "").replace(/\/+$/, "");
  if (!text) return "";
  const parts = text.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function normalizeLabel(value) {
  return String(value ?? "").toLowerCase().replace(/[-_]/g, "");
}

function ackSession(key) {
  const index = key.lastIndexOf("+");
  return index > 0 ? key.slice(0, index) : key;
}

export default class Pulse extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.sessions = [];
    this.meta = { roots: 0, pages: [], unreadablePages: [] };
    this.err = null;
    this.notice = null;
    this.sel = null;
    this.query = "";
    this.expanded = new Set();
    this.fullSteps = new Set();
    this.replyCursor = null;
    this.noticeAction = null;
    this.showAllDone = false;
    this.snoozed = {};
    this.seen = this.loadSeen();
    this.lastScanAt = null;
    this.scanning = false;
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") {
          this.handle.focus();
          cx.notify();
        } else if (command === "toggle") {
          // ctrl-alt-p: give the panel the keyboard, or hand it back when it already has it.
          if (this.handle.is_focused()) run("pane.go", { direction: "left" });
          else this.handle.focus();
          cx.notify();
        }
      }
    });
    cx.timer.every(POLL_MS, (cx) => this.poll(cx));
    this.poll(cx);
  }

  loadSeen() {
    try {
      const raw = localStorage.getItem(SEEN_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((key) => typeof key === "string") : [];
    } catch {
      return [];
    }
  }

  saveSeen() {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(this.seen));
    } catch {}
  }

  poll(cx) {
    if (this.scanning) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      let error = null;
      let sessions = this.sessions;
      let meta = this.meta;
      try {
        const result = await exec("sh", [`${appHome()}/mods/pulse/scan.sh`]);
        if (result.code !== 0) {
          throw new Error((result.stderr || result.stdout || "").trim() || `scan.sh exited ${result.code}`);
        }
        const parsed = this.parseScan(result.stdout ?? "");
        if (!parsed.meta) throw new Error("scan.sh returned no meta line");
        sessions = parsed.sessions;
        meta = parsed.meta;
      } catch (error_) {
        error = String(error_?.message ?? error_);
      }
      this.scanning = false;
      this.lastScanAt = Date.now();
      if (error) {
        this.err = error;
      } else {
        this.err = meta.error ?? null;
        this.sessions = sessions;
        this.meta = meta;
        this.pruneSeen();
      }
      cx.notify();
    });
  }

  parseScan(output) {
    const sessions = [];
    let meta = null;
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (value?.t === "s") sessions.push(value);
      else if (value?.t === "meta") meta = value;
    }
    return { sessions, meta };
  }

  pruneSeen() {
    const live = new Set(this.sessions.map((session) => session.sessionId));
    const kept = this.seen.filter((key) => live.has(ackSession(key)));
    if (kept.length !== this.seen.length) {
      this.seen = kept;
      this.saveSeen();
    }
  }

  flash(cx, message, action = null, ms = 4000) {
    const token = {};
    this.notice = message;
    this.noticeAction = action;
    this.noticeToken = token;
    cx.notify();
    cx.timer.after(ms, (later) => {
      if (this.noticeToken === token) {
        this.notice = null;
        this.noticeAction = null;
        later.notify();
      }
    });
  }

  buildModel(now) {
    const seen = new Set(this.seen);
    const items = [];
    for (const raw of this.sessions) {
      const deadhd = raw.deadhd ?? null;
      const hasChecklist = Boolean(deadhd && !deadhd.off && deadhd.counts && (deadhd.total ?? 0) > 0);
      const counts = hasChecklist ? deadhd.counts : null;
      const background = raw.background ?? { shells: 0, agents: 0, monitors: 0, total: 0 };

      let bucket;
      if (raw.status === "waiting") bucket = "wait";
      else if (raw.status === "busy") {
        const hasBackground = (background.total ?? 0) > 0;
        const last = raw.lastMeaningfulAt;
        bucket = !hasBackground && last && now - last > STALL_MS ? "stall" : "working";
      } else if (raw.status === "shell") {
        bucket = (counts?.blocked ?? 0) > 0 ? "wait" : "working";
      } else if (raw.status === "idle") {
        bucket = "done";
      } else {
        bucket = "working";
      }

      let group = bucket === "wait" || bucket === "stall" ? "attention" : bucket === "done" ? "done" : "working";
      if (group === "attention" && bucket === "stall" && (this.snoozed[raw.sessionId] ?? 0) > now) {
        group = "working";
      }

      const since = raw.statusUpdatedAt ?? raw.startedAt ?? null;
      const updatedAt = Math.max(raw.statusUpdatedAt ?? 0, raw.lastMeaningfulAt ?? 0) || null;
      const title = clip(firstNonEmpty(
        hasChecklist ? deadhd.title : null,
        raw.customTitle,
        raw.agentName,
        raw.name,
        raw.lastPrompt ? clip(raw.lastPrompt, 60) : null,
      ), 60) ?? "Untitled session";

      const location = clip(raw.location, 40);
      const place = location && normalizeLabel(location) !== normalizeLabel(title) ? location : null;
      const keyTag = deadhd?.key && deadhd.key.toLowerCase() !== title.trim().toLowerCase() ? deadhd.key : null;

      const prs = [];
      if (hasChecklist && deadhd.pr?.href) {
        prs.push({ url: deadhd.pr.href, label: deadhd.pr.text ?? null, number: deadhd.pr.number ?? 0 });
      }
      if (raw.pr?.url && !prs.some((pr) => pr.url === raw.pr.url)) {
        prs.push({ url: raw.pr.url, label: raw.pr.label ?? null, number: raw.pr.number ?? 0 });
      }
      const prTag = prs[0] ? (prs[0].label ?? (prs[0].number ? `#${prs[0].number}` : null)) : null;
      const extraPRs = prs.slice(1).map((pr) => pr.label ?? (pr.number ? `#${pr.number}` : pr.url)).filter(Boolean);

      const progress = hasChecklist && (deadhd.total ?? 0) > 0
        ? { done: Math.max(0, counts.done), total: deadhd.total }
        : null;
      const steps = hasChecklist && Array.isArray(deadhd.items) ? deadhd.items : [];
      const eta = hasChecklist && Number.isFinite(deadhd.eta) ? etaText(deadhd.eta, now) : null;
      const nowLabel = clean(hasChecklist ? deadhd.nowLabel : null);
      const currentAction = clean(raw.currentAction);
      const lastSentence = clean(raw.lastSentence);
      let nowLine = null;
      if (nowLabel) nowLine = `▶ ${nowLabel}`;
      else if (currentAction) nowLine = currentAction;
      else if (lastSentence) nowLine = lastSentence;

      let answer;
      if (bucket === "stall") {
        const quiet = Math.max(1, minutesOf(now - (raw.lastMeaningfulAt ?? since ?? now)));
        answer = `No new activity for ${quiet} minute${quiet === 1 ? "" : "s"}. Check whether it is stuck`;
      } else if (hasChecklist && (counts?.blocked ?? 0) > 0 && deadhd.blockedAsk) {
        answer = deadhd.blockedAsk;
      } else {
        answer = clean(raw.lastAnswer)
          ?? (raw.waitingFor === "permission prompt" ? "Waiting for permission approval" : "Waiting for your reply");
      }

      const pages = Array.isArray(raw.pages) ? raw.pages : [];
      const ackKey = `${raw.sessionId}+${since != null ? Math.floor(since / 1000) : "none"}`;
      const sortDate = since ?? updatedAt;

      if (group === "done") {
        if (seen.has(ackKey)) continue;
        if (sortDate == null || now - sortDate > DONE_WINDOW_MS) continue;
      }

      items.push({
        sessionId: raw.sessionId,
        pid: raw.pid,
        raw,
        bucket,
        group,
        title,
        since,
        updatedAt,
        sortDate,
        place,
        keyTag,
        jiraKey: deadhd?.key ?? null,
        prTag,
        extraPRs,
        hasChecklist,
        counts,
        total: deadhd?.total ?? null,
        progress,
        stepStates: deadhd?.states ?? null,
        steps,
        progressStale: Boolean(deadhd?.dataAt && now - deadhd.dataAt > STALE_MS),
        blocked: (counts?.blocked ?? 0) > 0,
        eta,
        nowLabel,
        nowLine,
        answer,
        replyTail: clean(raw.lastAnswer),
        lastSentence,
        background,
        pages,
        where: raw.where ?? {},
        ackKey,
      });
    }

    const sortAsc = (a, b) => {
      if (a.sortDate == null && b.sortDate == null) return a.sessionId < b.sessionId ? -1 : 1;
      if (a.sortDate == null) return 1;
      if (b.sortDate == null) return -1;
      if (a.sortDate !== b.sortDate) return a.sortDate - b.sortDate;
      return a.sessionId < b.sessionId ? -1 : 1;
    };
    const sortDesc = (a, b) => {
      if (a.sortDate == null && b.sortDate == null) return a.sessionId < b.sessionId ? -1 : 1;
      if (a.sortDate == null) return 1;
      if (b.sortDate == null) return -1;
      if (a.sortDate !== b.sortDate) return b.sortDate - a.sortDate;
      return a.sessionId < b.sessionId ? -1 : 1;
    };

    const attention = items.filter((item) => item.group === "attention").sort(sortAsc);
    const working = items.filter((item) => item.group === "working").sort(sortAsc);
    const done = items.filter((item) => item.group === "done").sort(sortDesc);
    return {
      attention,
      working,
      done,
      counts: { attention: attention.length, working: working.length, done: done.length },
    };
  }

  matches(item, tokens) {
    if (!tokens.length) return true;
    const fields = [
      item.title,
      item.place,
      trailingComponent(item.raw.cwd),
      item.raw.name,
      item.keyTag,
      item.jiraKey,
      item.prTag,
      ...item.extraPRs,
    ].filter(Boolean).map(fold);
    return tokens.every((token) => fields.some((field) => field.includes(token)));
  }

  viewData(now = Date.now()) {
    const model = this.buildModel(now);
    const tokens = fold(this.query).split(/\s+/).filter(Boolean);
    const filter = (list) => (tokens.length ? list.filter((item) => this.matches(item, tokens)) : list);
    const attention = filter(model.attention);
    const working = filter(model.working);
    const doneAll = filter(model.done);
    const doneVisible = this.showAllDone || tokens.length ? doneAll : doneAll.slice(0, MAX_DONE);
    const hiddenDone = doneAll.length - doneVisible.length;
    const groups = [
      { id: "attention", title: GROUP_TITLE.attention, color: GROUP_COLOR.attention, items: attention, count: attention.length },
      { id: "working", title: GROUP_TITLE.working, color: GROUP_COLOR.working, items: working, count: working.length },
      { id: "done", title: GROUP_TITLE.done, color: GROUP_COLOR.done, items: doneVisible, count: doneAll.length },
    ];
    return { model, groups, hiddenDone, now, counts: model.counts };
  }

  stepWindow(steps) {
    const states = steps.map((step) => step.state);
    const total = states.length;
    if (!total) return { rows: [], total: 0, hasHidden: false };
    const first = (state) => { const at = states.indexOf(state); return at >= 0 ? at : null; };
    const focus = first("now") ?? first("side") ?? first("blocked") ?? first("left") ?? total - 1;
    const start = Math.min(Math.max(focus - 1, 0), Math.max(total - 3, 0));
    const rows = [];
    for (let i = start; i < Math.min(total, start + 3); i++) rows.push(i);
    const blocked = first("blocked");
    if (blocked != null && !rows.includes(blocked)) {
      if (blocked > rows[rows.length - 1]) rows[rows.length - 1] = blocked;
      else if (blocked < rows[0]) rows[0] = blocked;
    }
    return { rows, total, hasHidden: total > rows.length };
  }

  visibleSteps(item) {
    if (this.fullSteps.has(item.sessionId)) return { steps: item.steps, hidden: 0 };
    const window = this.stepWindow(item.steps);
    return { steps: window.rows.map((i) => item.steps[i]), hidden: window.total - window.rows.length };
  }

  // Pulse StepDisclosure: collapsed -> window (3 steps) -> full. Returns true when it moved.
  stepDisclosure(item, by, toEnd) {
    if (!item?.steps.length) return false;
    const id = item.sessionId;
    const canFull = this.stepWindow(item.steps).hasHidden;
    const levels = canFull ? 2 : 1;
    const from = !this.expanded.has(id) ? 0 : this.fullSteps.has(id) ? 2 : 1;
    const at = Math.min(from, levels);
    const to = toEnd ? (by > 0 ? levels : 0) : Math.max(0, Math.min(levels, at + by));
    if (to === 0) { this.expanded.delete(id); this.fullSteps.delete(id); }
    else if (to === 1) { this.expanded.add(id); this.fullSteps.delete(id); }
    else { this.expanded.add(id); this.fullSteps.add(id); }
    return to !== from;
  }

  stepHeight(item) {
    const { steps, hidden } = this.visibleSteps(item);
    const lines = steps.length + (hidden > 0 ? 1 : 0);
    if (!lines) return 0;
    return 1 + 6 + 2 + lines * 20 + Math.max(0, lines - 1) * 2;
  }

  itemHeight(item, selected) {
    const children = [20, 18];
    if (item.group === "attention") children.push(36);
    if (item.group === "working") children.push(18);
    if (item.progress && (item.group !== "done" || item.progress.done < item.progress.total)) children.push(16);
    if (this.expanded.has(item.sessionId) && item.steps.length) children.push(this.stepHeight(item));
    if (item.pages.length) children.push(20);
    if (selected && item.group !== "done" && this.progressTarget(item)) children.push(28);
    return 24 + children.reduce((sum, height) => sum + height, 0) + 6 * (children.length - 1);
  }

  buildRows(data) {
    const rows = [];
    for (const group of data.groups) {
      if (!group.items.length) continue;
      rows.push({ kind: "sec", group, h: 40, key: `sec-${group.id}` });
      for (const item of group.items) {
        rows.push({
          kind: "row", item, group: group.id,
          h: this.itemHeight(item, item.sessionId === this.sel),
          key: `${group.id}-${item.sessionId}`,
        });
      }
      if (group.id === "done" && data.hiddenDone > 0) {
        rows.push({ kind: "more", h: 28, key: "more-done", count: data.hiddenDone });
      }
    }
    return rows;
  }

  selectedItem(data) {
    const rows = data.groups.flatMap((group) => group.items);
    if (this.sel === NONE) return null;
    return rows.find((item) => item.sessionId === this.sel) ?? rows[0] ?? null;
  }

  reveal(sessionId, data) {
    const rows = this.buildRows(data);
    const index = rows.findIndex((row) => row.kind === "row" && row.item.sessionId === sessionId);
    if (index >= 0) this.scroll.scroll_to_item(index, "center");
  }

  select(sessionId, cx) {
    this.sel = sessionId;
    if (cx) cx.notify();
  }

  markSeen(item, cx) {
    if (!item || item.group !== "done") return false;
    if (this.seen.includes(item.ackKey)) return false;
    this.seen = [...this.seen, item.ackKey];
    this.saveSeen();
    const key = item.ackKey;
    if (cx) this.flash(cx, "Marked as seen", { label: "Undo", run: () => {
      this.seen = this.seen.filter((candidate) => candidate !== key);
      this.saveSeen();
    } }, UNDO_MS);
    return true;
  }

  acknowledge(item, cx) {
    if (!item) return;
    if (item.group === "done") this.markSeen(item, cx);
    else if (item.group === "attention" && item.bucket === "stall") this.snooze(item);
  }

  // Space: the session that has waited longest for a reply, cycling on repeat; stalls are skipped.
  // Shift+Space: the oldest finished session, opened and marked seen.
  jump(kind, data, cx) {
    let target = null;
    if (kind === "reply") {
      const candidates = data.model.attention.filter((item) => item.bucket !== "stall");
      if (candidates.length) {
        const at = candidates.findIndex((item) => item.sessionId === this.replyCursor);
        target = at < 0 ? candidates[0] : candidates[(at + 1) % candidates.length];
        this.replyCursor = target.sessionId;
      }
    } else {
      target = data.model.done[data.model.done.length - 1] ?? null;
    }
    if (!target) {
      this.flash(cx, kind === "reply" ? "No session is waiting for a reply" : "No finished session");
      return;
    }
    this.goTo(target, cx);
    if (kind === "done") {
      this.showAllDone = true;
      this.markSeen(target, cx);
    } else {
      this.sel = target.sessionId;
      this.reveal(target.sessionId, data);
    }
  }

  snooze(item) {
    if (!item || item.bucket !== "stall") return false;
    this.snoozed[item.sessionId] = Date.now() + SNOOZE_MS;
    return true;
  }

  goTo(item, cx) {
    if (!item) return;
    const live = terminals().filter((terminal) => terminal.state === "live"
      && !String(terminal.address ?? "").includes("/"));
    const byPid = live.find((terminal) => Number(terminal.foreground?.pid) === Number(item.pid));
    const byId = item.where?.terminalId ? live.find((terminal) => terminal.address === item.where.terminalId) : null;
    const terminal = byPid ?? byId;
    if (terminal) {
      const pane = panes().find((candidate) => candidate.terminal === terminal.address);
      run("pane.focus", pane ? { pane: pane.pane } : { terminal: terminal.address });
      return;
    }
    const where = item.where ?? {};
    if (where.kind === "tmux" && where.paneId) {
      const base = where.socket ? ["-S", where.socket] : [];
      const calls = [
        ["switch-client", "-t", where.paneId],
        ["select-window", "-t", where.paneId],
        ["select-pane", "-t", where.paneId],
      ];
      cx.spawn(async () => {
        for (const call of calls) {
          try {
            await exec("tmux", [...base, ...call]);
          } catch {}
        }
      });
      return;
    }
    if (where.handle) {
      cx.spawn(async (later) => {
        try {
          const result = await exec("/Applications/Orca.app/Contents/Resources/bin/orca",
            ["terminal", "switch", "--terminal", where.handle, "--json"]);
          if (result.code !== 0) this.flash(later, "Not in Herdr, tmux or Orca");
          else await exec("open", ["-a", "Orca"]);
        } catch {
          this.flash(later, "Not in Herdr, tmux or Orca");
        }
      });
      return;
    }
    this.flash(cx, "Not in Herdr, tmux or Orca");
  }

  pageGroup(item) {
    return item?.pages?.[0] ?? null;
  }

  dropPage(page) {
    const same = (candidate) => candidate
      && candidate.pageId === page.pageId
      && candidate.worktree === page.worktree
      && candidate.url === page.url;
    if (this.meta?.pages) this.meta.pages = this.meta.pages.filter((candidate) => !same(candidate));
    for (const session of this.sessions) {
      if (Array.isArray(session.pages)) session.pages = session.pages.filter((candidate) => !same(candidate));
    }
  }

  openPage(page, cx) {
    if (!page) {
      this.flash(cx, "No page to open");
      return;
    }
    if (!page.openable) {
      this.flash(cx, "Couldn't open this page");
      return;
    }
    cx.spawn(async (later) => {
      let opened = false;
      try {
        const result = await exec("open", [page.url]);
        opened = result.code === 0;
      } catch {}
      if (!opened) {
        this.flash(later, "Couldn't open this page");
        return;
      }
      try {
        await exec("rm", ["-f", ...(page.files ?? [])]);
      } catch {}
      this.dropPage(page);
      later.notify();
      this.poll(later);
    });
  }

  openOldestPage(cx) {
    const pages = this.meta?.pages ?? [];
    if (!pages.length) {
      this.flash(cx, "No page to open");
      return;
    }
    this.openPage(pages[0], cx);
  }

  key(event, cx) {
    const modifiers = event.modifiers ?? {};
    const alt = Boolean(modifiers.alt);
    const shift = Boolean(modifiers.shift);
    const command = Boolean(modifiers.platform);
    const control = Boolean(modifiers.control);
    const key = event.key;
    const data = this.viewData();
    const items = data.groups.flatMap((group) => group.items);
    const selected = this.selectedItem(data);
    if (selected && this.sel !== selected.sessionId) this.sel = selected.sessionId;
    const index = items.findIndex((item) => item.sessionId === selected?.sessionId);

    const choose = (next) => {
      if (!items.length) return;
      const target = items[Math.max(0, Math.min(items.length - 1, next))];
      this.sel = target.sessionId;
      this.reveal(target.sessionId, data);
    };

    const plain = !command && !control && !alt;
    const searching = Boolean(this.query);
    let handled = true;
    if (key === "escape") {
      if (searching) this.query = "";
      else if (this.sel !== NONE && selected) this.sel = NONE;
      else {
        run("pane.go", { direction: "left" });
        handled = false;
      }
    } else if (key === "backspace" && plain) {
      if (searching) this.query = this.query.slice(0, -1);
      else if (!event.is_held) this.acknowledge(selected, cx);
    } else if (key === "backspace" && searching && command && !control && !alt) {
      this.query = "";
    } else if (key === "backspace" && searching && alt && !command && !control) {
      this.query = this.query.replace(/\S*\s*$/, "");
    } else if (key === "up" && alt) choose(0);
    else if (key === "down" && alt) choose(items.length - 1);
    else if (key === "up") choose(index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length);
    else if (key === "down") choose(index < 0 ? 0 : (index + 1) % items.length);
    else if (key === "right") {
      if (selected?.steps.length) this.stepDisclosure(selected, 1, alt);
      else if (data.hiddenDone > 0) this.showAllDone = true;
      else handled = false;
    } else if (key === "left") {
      if (selected?.steps.length) this.stepDisclosure(selected, -1, alt);
      else handled = false;
    } else if (key === "enter") {
      if (shift) {
        const page = this.pageGroup(selected);
        if (page) this.openPage(page, cx);
        else this.flash(cx, "This row has no page");
      } else this.goTo(selected, cx);
    } else if (key === "space" && plain && !searching) {
      this.jump(shift ? "done" : "reply", data, cx);
    } else if (key === "tab" && plain && !shift) {
      if (searching) handled = false;
      else this.openOldestPage(cx);
    } else if (event.key_char && event.key_char.length === 1 && plain) {
      if (searching || event.key_char.trim()) this.query += event.key_char;
      else handled = false;
    } else {
      handled = false;
    }

    if (handled) {
      cx.stop_propagation();
      cx.notify();
    }
  }

  dot(color, size = 6) {
    return div().size(size).flex_none().rounded(size / 2).bg(color);
  }

  keycap(label) {
    return h_flex().h(18).min_w(18).px(4).rounded(4).border(1).border_color(INK.dash)
      .bg(INK.card).items_center().justify_center()
      .child(div().text_size(11).font_family(MONO).text_color(INK.t2).child(label));
  }

  header(counts) {
    const pageCount = (this.meta?.pages?.length ?? 0) + (this.meta?.unreadablePages?.length ?? 0);
    const count = (color, value) => h_flex().gap(4).items_center()
      .child(this.dot(color))
      .child(div().text_size(12).font_family(MONO).text_color(INK.t3).child(String(value)));
    return h_flex().h(44).flex_none().px(16).gap(8).items_center()
      .child(image("mods/pulse/logo.svg").size(20).flex_none())
      .child(div().text_size(15).font_family(FONT).font_semibold().text_color(INK.t1).child("Pulse"))
      .child(h_flex().id("pulse-pages").h(24).px(8).rounded(6).gap(6).items_center()
        .bg(INK.card).border(1).border_color(INK.line).cursor_pointer()
        .hover((style) => style.bg(INK.sel))
        .tooltip(`Open the oldest page (${pageCount})`)
        .on_click((_event, cx) => this.openOldestPage(cx))
        .child(svg("mods/workspace-chrome/file-text.svg").size(12).flex_none().text_color(INK.t2))
        .child(div().text_size(12).font_family(FONT).font_semibold().text_color(INK.t1).child(`${pageCount} to read`)))
      .child(div().flex_1())
      .child(h_flex().gap(12)
        .child(count(INK.red, counts.attention))
        .child(count(INK.blue, counts.working))
        .child(count(INK.green, counts.done)));
  }

  searchField() {
    return h_flex().id("pulse-search").mx(8).mb(4).h(32).flex_none().px(8).gap(8).items_center()
      .rounded(8).bg(INK.card).border(1).border_color(INK.line).cursor_text()
      .on_click((_event, cx) => {
        this.handle.focus();
        cx.notify();
      })
      .child(svg("mods/workspace-chrome/search.svg").size(13).flex_none().text_color(INK.t3))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_family(SANS)
        .text_color(this.query ? INK.t1 : INK.t3).child(this.query || "Type to search"));
  }

  sectionHeader(group) {
    return h_flex().w_full().h(40).flex_none().px(8).gap(8).items_center()
      .child(this.dot(group.color))
      .child(div().text_size(13).font_family(FONT).font_semibold().text_color(INK.t1).child(group.title))
      .child(div().text_size(12).font_family(MONO).text_color(INK.t3).child(String(group.count ?? group.items.length)));
  }

  moreRow(count) {
    return h_flex().id("pulse-more").w_full().h(28).flex_none().pl(32).pr(8).items_center().cursor_pointer()
      .hover((style) => style.bg(INK.card))
      .on_click((_event, cx) => {
        this.showAllDone = true;
        this.handle.focus();
        cx.notify();
      })
      .child(div().text_size(12).font_family(FONT).font_semibold().text_color(INK.t3).child(`${count} more`));
  }

  glyph(item) {
    if (item.group === "done") {
      return h_flex().w(16).h(20).flex_none().items_center().justify_center()
        .child(div().text_size(12).font_family(MONO).text_color(INK.green).child("✓"));
    }
    if (item.group === "working") {
      return h_flex().w(16).h(20).flex_none().items_center().justify_center()
        .child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(INK.blue).spin(900));
    }
    if (item.bucket === "stall") {
      return h_flex().w(16).h(20).flex_none().items_center().justify_center()
        .child(div().size(8).flex_none().rounded(4).border(1.5).border_color(INK.red));
    }
    return h_flex().w(16).h(20).flex_none().items_center().justify_center()
      .child(this.dot(INK.red, 8));
  }

  titleRow(item, selected) {
    let right;
    if (item.group === "done") right = item.sortDate != null ? agoText(Date.now() - item.sortDate) : "";
    else if (item.group === "working") right = item.eta ?? (item.since != null ? shortDuration(Date.now() - item.since) : "");
    else if (item.bucket === "stall") {
      right = `quiet ${shortDuration(Date.now() - (item.raw.lastMeaningfulAt ?? item.since ?? Date.now()))}`;
    } else right = item.since != null ? shortDuration(Date.now() - item.since) : "";
    return h_flex().h(20).gap(8).items_center().min_w(0)
      .child(div().flex_1().min_w(0).truncate().text_size(14).font_family(FONT).font_semibold()
        .text_color(selected ? INK.amber : INK.t1).child(item.title))
      .when(Boolean(right), (element) => element.child(
        div().flex_none().text_size(12).font_family(MONO).text_color(INK.t3).child(right)));
  }

  backgroundLabel(counts) {
    if (!counts) return null;
    const parts = [];
    if (counts.shells > 0) parts.push(`${counts.shells} shell${counts.shells === 1 ? "" : "s"}`);
    if (counts.agents > 0) parts.push(`${counts.agents} agent${counts.agents === 1 ? "" : "s"}`);
    if (counts.monitors > 0) parts.push(`${counts.monitors} monitor${counts.monitors === 1 ? "" : "s"}`);
    return parts.length ? parts.join(" · ") : null;
  }

  metaRow(item) {
    const badge = BADGES[item.where?.kind] ?? null;
    const tag = (text, color = INK.t2) => div().flex_none().text_size(12).font_family(MONO).text_color(color).child(text);
    const showCounts = item.group === "working" || item.group === "done";
    const background = showCounts ? this.backgroundLabel(item.background) : null;
    return h_flex().h(18).gap(6).items_center().min_w(0)
      .when(Boolean(badge), (element) => element.child(
        h_flex().h(18).px(4).rounded(4).bg(INK.card).border(1).border_color(INK.dash).items_center()
          .child(div().text_size(11).font_family(MONO).text_color(INK.t2).child(badge))))
      .when(Boolean(item.place), (element) => element.child(
        div().min_w(0).truncate().text_size(12).font_family(FONT).font_weight(500).text_color(INK.t3).child(item.place)))
      .when(Boolean(item.keyTag), (element) => element
        .child(div().flex_none().text_size(12).font_family(MONO).text_color(INK.sep).child("·"))
        .child(h_flex().flex_none().items_center().tooltip(item.raw.deadhd?.keyHref ?? item.keyTag).child(tag(item.keyTag, INK.t2))))
      .when(Boolean(item.prTag), (element) => element
        .child(div().flex_none().text_size(12).font_family(MONO).text_color(INK.sep).child("·"))
        .child(tag(item.prTag, INK.t2)))
      .child(div().flex_1())
      .when(Boolean(background), (element) => element.child(
        div().flex_none().text_size(11).font_family(MONO).text_color(INK.t3).child(background)));
  }

  answerRow(item) {
    return div().max_h(36).text_size(12).line_height(18).font_family(SANS).text_color(INK.t2)
      .overflow_hidden().child(item.answer ?? "");
  }

  nowRow(item) {
    const waiting = item.raw.status === "shell";
    const text = waiting ? "Waiting on background tasks" : item.nowLine;
    return h_flex().h(18).items_center()
      .child(div().truncate().text_size(12).font_family(SANS)
        .text_color(waiting ? INK.t3 : INK.t2).child(text ?? ""));
  }

  segmentColor(state) {
    if (state === "done") return INK.green;
    if (state === "now" || state === "side") return INK.blue;
    if (state === "blocked") return INK.red;
    return INK.dash;
  }

  progressRow(item) {
    const total = item.progress?.total ?? 0;
    const counts = item.counts ?? { done: 0, now: 0, blocked: 0 };
    const states = [];
    if (Array.isArray(item.stepStates) && item.stepStates.length === total) {
      states.push(...item.stepStates);
    } else {
      for (let i = 0; i < Math.max(0, counts.done); i++) states.push("done");
      for (let i = 0; i < Math.max(0, counts.now); i++) states.push("now");
      for (let i = 0; i < Math.max(0, counts.blocked); i++) states.push("blocked");
      while (states.length < total) states.push("left");
      if (states.length > total) states.splice(total);
    }
    return h_flex().h(16).gap(8).items_center()
      .when(item.progressStale, (element) => element.opacity(0.45))
      .child(h_flex().flex_1().min_w(0).gap(2).h(4)
        .children(states.map((state) => div().flex_1().h(4).rounded(1).bg(this.segmentColor(state)))))
      .child(div().flex_none().text_size(11).font_family(MONO).text_color(INK.t3)
        .child(`${item.progress.done}/${total}`));
  }

  stepRow(step) {
    const color = step.state === "done" ? INK.t3
      : step.state === "blocked" ? INK.t1
        : step.state === "now" || step.state === "side" ? INK.t1 : INK.t2;
    const glyph = step.state === "done"
      ? div().text_size(11).font_family(MONO).text_color(INK.green).child("✓")
      : step.state === "blocked"
        ? div().text_size(11).font_family(MONO).text_color(INK.red).child("!")
        : step.state === "now" || step.state === "side"
          ? svg("mods/workspace-chrome/spinner.svg").size(9).flex_none().text_color(INK.blue).spin(900)
          : div().text_size(11).font_family(MONO).text_color(INK.sep).child("○");
    const trailing = step.state === "blocked" ? step.ask ?? step.sub ?? null : step.sub ?? null;
    return h_flex().h(20).gap(8).items_center().min_w(0)
      .child(h_flex().w(16).flex_none().items_center().justify_center().child(glyph))
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(SANS).text_color(color).child(step.label))
      .when(Boolean(trailing), (element) => element.child(
        div().flex_none().max_w(120).truncate().text_size(11).font_family(MONO).text_color(INK.t3)
          .tooltip(trailing).child(trailing)));
  }

  stepsBlock(item) {
    const { steps, hidden } = this.visibleSteps(item);
    const rows = steps.map((step) => this.stepRow(step));
    if (hidden > 0) {
      rows.push(h_flex().h(20).gap(8).items_center().min_w(0)
        .child(h_flex().w(16).flex_none())
        .child(div().text_size(11).font_family(MONO).text_color(INK.t3).child(`${hidden} more · → all ${item.steps.length}`)));
    }
    return v_flex().flex_none().pt(6).pb(2).gap(2).border_t(1).border_color(INK.line).children(rows);
  }

  pageTag(item) {
    const page = item.pages[0];
    const extra = item.pages.length - 1;
    const label = extra > 0 ? `${page.label} +${extra}` : page.label;
    return h_flex().h(20).px(8).rounded(4).gap(6).items_center().self_start()
      .bg(INK.card).border(1).border_color(INK.dash).cursor_pointer()
      .hover((style) => style.bg(INK.sel))
      .tooltip(page.url)
      .on_click((_event, cx) => {
        cx.stop_propagation();
        this.handle.focus();
        this.openPage(page, cx);
      })
      .child(svg("mods/workspace-chrome/file-text.svg").size(12).flex_none().text_color(INK.t2))
      .child(div().text_size(12).font_family(FONT).font_semibold().text_color(INK.t2).child(label));
  }

  actionButton(id, label, primary, hint, action) {
    const cap = this.keycap(hint);
    return h_flex().id(id).h(28).px(8).rounded(6).gap(6).items_center().cursor_pointer()
      .bg(primary ? INK.t1 : INK.card).border(1).border_color(primary ? INK.t1 : INK.dash)
      .hover((style) => style.opacity(0.9))
      .on_click((event, cx) => {
        cx.stop_propagation();
        this.handle.focus();
        action(cx);
      })
      .child(div().text_size(12).font_family(FONT).font_semibold()
        .text_color(primary ? "#0b0d14" : INK.t1).child(label))
      .child(primary
        ? h_flex().h(16).min_w(16).px(4).rounded(4).bg("#d4d7df").border(1).border_color("#c4c8d2")
          .items_center().justify_center()
          .child(div().text_size(10).font_family(MONO).text_color("#3a4050").child(hint))
        : cap);
  }

  progressTarget(item) {
    const path = item.raw.deadhd?.pagePath;
    if (path) return { url: path, openable: true, files: [] };
    return this.pageGroup(item);
  }

  actionsRow(item) {
    const target = this.progressTarget(item);
    return h_flex().h(28).gap(8).items_center()
      .child(this.actionButton(`page-${item.sessionId}`, "Progress page", false, "⇧↩",
        (cx) => this.openPage(target, cx)));
  }

  rowView(item, selected) {
    const content = [
      this.titleRow(item, selected),
      this.metaRow(item),
    ];
    if (item.group === "attention") content.push(this.answerRow(item));
    else if (item.group === "working") content.push(this.nowRow(item));
    if (item.progress && (item.group !== "done" || item.progress.done < item.progress.total)) {
      content.push(this.progressRow(item));
    }
    if (this.expanded.has(item.sessionId) && item.steps.length) content.push(this.stepsBlock(item));
    if (item.pages.length) content.push(this.pageTag(item));
    if (selected && item.group !== "done" && this.progressTarget(item)) content.push(this.actionsRow(item));

    return h_flex().id(`row-${item.sessionId}`).w_full().h(this.itemHeight(item, selected)).flex_none()
      .px(8).py(12).gap(8).items_start().rounded(8)
      .bg(selected ? INK.sel : INK.card)
      .border(1).border_color(selected ? `${INK.amber}80` : "#00000000")
      .when(!selected, (element) => element.bg(INK.bg).hover((style) => style.bg(INK.card)))
      .cursor_pointer().overflow_hidden()
      .on_click((event, cx) => {
        this.sel = item.sessionId;
        this.handle.focus();
        this.goTo(item, cx);
        cx.notify();
      })
      .child(this.glyph(item))
      .child(v_flex().flex_1().min_w(0).gap(6).children(content));
  }

  listView(data, cx) {
    const rows = this.buildRows(data);
    if (!rows.length) {
      return h_flex().flex_1().min_h(0).items_center().justify_center()
        .child(div().text_size(13).font_family(FONT).font_weight(600).text_color(INK.t3)
          .child(this.query ? "No matching sessions" : "All quiet for now"));
    }
    const draw = (row) => row.kind === "sec" ? this.sectionHeader(row.group)
      : row.kind === "more" ? this.moreRow(row.count)
      : this.rowView(row.item, row.item.sessionId === this.sel);
    return v_flex().id("pulse-list").flex_1().min_h(0).px(8).pb(8).overflow_y_scroll()
      .children(rows.map((row) => div().id(`row-${row.key}`).flex_none().when(row.kind === "row", (element) => element.pt(4)).child(draw(row))));
  }

  keysBlock() {
    const item = (keys, label) => h_flex().flex_1().min_w(0).gap(6).items_center()
      .child(h_flex().gap(3).flex_none().children(keys.map((key) => this.keycap(key))))
      .child(div().truncate().text_size(12).font_family(SANS).text_color(INK.t3).child(label));
    return v_flex().flex_none().border_t(1).border_color(INK.line).px(16).py(8).gap(6)
      .child(h_flex().gap(12)
        .child(item(["↑", "↓"], "Move"))
        .child(item(["↩"], "Open session")))
      .child(h_flex().gap(12)
        .child(item(["→", "←"], "Steps"))
        .child(item(["⌫"], "Acknowledge")))
      .child(h_flex().gap(12)
        .child(item(["Space"], "Oldest reply"))
        .child(item(["Tab"], "Oldest page")))
      .child(h_flex().gap(12)
        .child(item(["⇧", "Space"], "Oldest done"))
        .child(item(["Esc"], "Back")));
  }

  footer() {
    const updated = this.lastScanAt == null ? "Not updated yet"
      : `updated ${Math.max(0, Math.floor((Date.now() - this.lastScanAt) / 1000))}s ago`;
    return h_flex().h(28).flex_none().px(16).gap(12).items_center().border_t(1).border_color(INK.line)
      .child(div().text_size(11).font_family(MONO).text_color(INK.t3).child(updated))
      .child(div().flex_1())
      .child(div().text_size(11).font_family(MONO).text_color(INK.t3)
        .child(`${this.sessions.length} sessions · ${this.meta?.roots ?? 0} roots`));
  }

  errorNotice() {
    return h_flex().flex_none().px(16).py(4).gap(8).items_center().border_t(1).border_color(INK.line)
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(SANS).text_color(INK.red).child(this.err))
      .child(h_flex().id("pulse-retry").h(22).px(8).rounded(6).items_center().cursor_pointer()
        .bg(INK.card).border(1).border_color(INK.dash).hover((style) => style.bg(INK.sel))
        .on_click((_event, cx) => {
          this.err = null;
          this.poll(cx);
          cx.notify();
        })
        .child(div().text_size(12).font_family(FONT).font_semibold().text_color(INK.t1).child("Retry")));
  }

  noticeRow() {
    const action = this.noticeAction;
    return h_flex().flex_none().px(16).py(4).gap(8).items_center().border_t(1).border_color(INK.line)
      .child(div().flex_1().min_w(0).truncate().text_size(12).font_family(SANS).text_color(INK.t3).child(this.notice))
      .when(Boolean(action), (element) => element.child(
        h_flex().id("pulse-undo").h(22).px(8).rounded(6).items_center().cursor_pointer()
          .bg(INK.card).border(1).border_color(INK.dash).hover((style) => style.bg(INK.sel))
          .on_click((_event, cx) => {
            cx.stop_propagation();
            action.run();
            this.notice = null;
            this.noticeAction = null;
            cx.notify();
          })
          .child(div().text_size(12).font_family(FONT).font_semibold().text_color(INK.t1).child(action.label))));
  }

  render(cx) {
    const data = this.viewData();
    const selected = this.selectedItem(data);
    if (selected) this.sel = selected.sessionId;
    const focused = this.handle.is_focused();
    return v_flex().id("pulse").size_full().min_h(0).bg(INK.bg).text_color(INK.t1)
      .font_family(FONT).text_size(13)
      .track_focus(this.handle)
      .on_key_down((event, cx) => this.key(event, cx))
      .child(this.header(data.counts))
      .child(this.searchField())
      .child(this.listView(data, cx))
      .when(Boolean(this.err), (element) => element.child(this.errorNotice()))
      .when(Boolean(this.notice), (element) => element.child(this.noticeRow()))
      .when(focused, (element) => element.child(this.keysBlock()))
      .child(this.footer());
  }
}
