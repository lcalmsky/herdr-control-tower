// Behaviour the layout's mods must keep: guarded init under herdr-app check, a read that no longer gets
// dropped, remote-focus refusals, the tab bar's scroll and wheel, Pulse's attach/Orca branches and the
// rail's per-machine repository keys. MODS_ROOT points the same tests at the pre-fix files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODS = process.env.MODS_ROOT ?? join(ROOT, "mods");

// --- recording elements -------------------------------------------------------------

// The proxy needs a reference to itself for the builder methods to chain.
function makeElement(kind) {
  const state = { _kind: kind, _id: null, _calls: [], _handlers: {}, _children: [] };
  const proxy = new Proxy(state, {
    get(target, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      if (prop.startsWith("_")) return target[prop];
      return (...args) => {
        target._calls.push({ name: prop, args });
        if (prop === "id") target._id = args[0];
        else if (prop === "child") target._children.push(...args.flat());
        else if (prop === "children") target._children.push(...(args[0] ?? []));
        else if (prop === "when") { if (args[0]) args[1](proxy); }
        else if (["on_click", "on_scroll_wheel", "on_size_change", "on_key_down", "on_mouse_down", "on_mouse_up", "on_hover"].includes(prop)) target._handlers[prop] = args[0];
        return proxy;
      };
    },
  });
  return proxy;
}

globalThis.__el = makeElement;
globalThis.__scrollHandle = () => {
  const handle = {
    scrolls: [],
    scroll_to_item(index, strategy) { handle.scrolls.push({ index, strategy }); },
    release() { return true; },
  };
  return handle;
};
globalThis.__inputState = (spec = {}) => {
  const state = { _value: spec.value ?? "", value() { return state._value; }, on() {}, focus() {} };
  return state;
};

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear(),
};

// --- stub packages ------------------------------------------------------------------

const STUBS = {
  "gpui-kit": `
    export class View {}
    export const div = () => globalThis.__el("div");
    export const svg = () => globalThis.__el("svg");
    export const image = () => globalThis.__el("image");
    export const PathBuilder = { stroke: () => ({ move_to() { return this; }, arc_to() { return this; }, build() { return {}; } }) };
  `,
  "gpui-base": `
    export const v_flex = () => globalThis.__el("v_flex");
    export const h_flex = () => globalThis.__el("h_flex");
    export const v_virtual_list = () => globalThis.__el("v_virtual_list");
    export class ScrollHandle { static new() { return globalThis.__scrollHandle(); } }
    export class VirtualListScrollHandle { static new() { return globalThis.__scrollHandle(); } }
    export class InputState { static new(spec = {}) { return globalThis.__inputState(spec); } }
    export class Input { static new() { return globalThis.__el("input"); } }
  `,
  herdr: `
    const S = () => globalThis.__herdr;
    const blank = () => ({ code: 0, stdout: "", stderr: "" });
    export const checking = () => Boolean(S().checking);
    export const spaces = () => S().spaces ?? [];
    export const panes = () => S().panes ?? [];
    export const terminals = () => S().terminals ?? [];
    export const agents = () => S().agents ?? [];
    export const focused = () => S().focused ?? null;
    export const props = () => S().props ?? {};
    export const layout = () => S().layout ?? {};
    export const shared = (key) => (S().shared ?? {})[key];
    export const window = () => S().window ?? null;
    export const appHome = () => S().appHome ?? "/tmp/herdr-app";
    export const home = () => "/tmp/home";
    export const nextCommand = () => new Promise(() => {});
    export const theme = () => S().theme ?? new Proxy({}, { get: (_t, key) => (typeof key === "string" ? "#000" : undefined) });
    export const run = (name, args) => { S().runs.push({ name, args }); return null; };
    export const exec = (command, args, options) => {
      S().execs.push({ command, args, options });
      return S().execImpl ? S().execImpl(command, args, options) : Promise.resolve(blank());
    };
    export const openOverlay = (spec) => { S().overlays.push(spec); return "overlay"; };
    export const closeOverlay = (id) => { S().closes.push(id); return null; };
    export const setAgentOrder = (order) => { S().orders.push(order); return null; };
    export const hc = async () => blank();
    export const readTextFile = async () => null;
    export const writeTextFile = async () => null;
    export const machines = () => [];
    export const knownAgents = async () => [];
    export const pickFolder = async () => null;
    export const playSound = () => null;
    export const layouts = () => [];
    export const themes = () => [];
  `,
};

async function loadMod(name) {
  const dir = mkdtempSync(join(tmpdir(), "mods-test-"));
  for (const [pkg, body] of Object.entries(STUBS)) {
    const folder = join(dir, "node_modules", pkg);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name: pkg, type: "module", main: "index.mjs" }));
    writeFileSync(join(folder, "index.mjs"), body);
  }
  const modDir = join(dir, "mod");
  mkdirSync(modDir);
  copyFileSync(join(MODS, name, "main.js"), join(modDir, "main.js"));
  const mod = await import(pathToFileURL(join(modDir, "main.js")).href);
  return { Mod: mod.default, dir };
}

function herdrState(overrides = {}) {
  globalThis.__herdr = {
    checking: false,
    spaces: [],
    panes: [],
    terminals: [],
    agents: [],
    focused: null,
    props: {},
    layout: {},
    shared: {},
    window: null,
    appHome: "/tmp/herdr-app",
    runs: [],
    execs: [],
    overlays: [],
    closes: [],
    orders: [],
    execImpl: null,
    ...overrides,
  };
  return globalThis.__herdr;
}

function makeCx() {
  const focus = { focus() {}, is_focused() { return false; } };
  const cx = {
    timers: [],
    spawned: [],
    timer: {
      every(ms, fn) { cx.timers.push({ kind: "every", ms, fn }); return cx.timers.length; },
      after(ms, fn) { cx.timers.push({ kind: "after", ms, fn }); return cx.timers.length; },
    },
    spawn(fn) {
      const promise = Promise.resolve().then(() => fn(cx));
      cx.spawned.push(promise);
      return promise;
    },
    notify() {},
    focus_handle() { return focus; },
    stop_propagation() {},
  };
  return cx;
}

async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

function walk(el, visit) {
  if (!el || typeof el !== "object") return;
  visit(el);
  for (const child of el._children ?? []) walk(child, visit);
}

function findById(el, id) {
  let hit = null;
  walk(el, (node) => { if (node._id === id) hit = node; });
  return hit;
}

function callsNamed(el, name) {
  return el._calls.filter((call) => call.name === name);
}

// --- claude-accounts ----------------------------------------------------------------

const UUID = "0f639cb3-88c6-4c9d-90d1-c05b8c7a5d0c";

test("claude-accounts resume changes into the session's cwd and stops when it is gone", async (t) => {
  const { Mod, dir } = await loadMod("claude-accounts");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const present = join(dir, "work");
  const marker = join(dir, "marker");
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(present);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > '${marker}'\n`, { mode: 0o755 });

  const splitFor = (account, cwd) => {
    herdrState({
      props: {
        role: "menu",
        current: account === "default" ? "work" : "default",
        accounts: [{ name: "default", email: "", usage: null }, { name: "work", email: "", usage: null }],
        session: { id: UUID, cwd },
      },
    });
    const state = globalThis.__herdr;
    const cx = makeCx();
    const view = new Mod();
    view.init(undefined, cx);
    const row = findById(view.render(cx), `cont-${account}`);
    assert.ok(row, `resume row for ${account}`);
    rmSync(marker, { force: true });
    row._handlers.on_click({}, cx);
    const split = state.runs.find((call) => call.name === "pane.split");
    assert.ok(split, `pane.split for ${account}`);
    return spawnSync("sh", ["-c", split.args.argv[2]], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
    });
  };

  for (const account of ["default", "work"]) {
    const result = splitFor(account, join(dir, `missing-${account}`));
    assert.notEqual(result.status, 0, `${account} must stop without a cwd`);
    assert.equal(existsSync(marker), false, `${account} must not start Claude in the wrong folder`);
  }

  for (const account of ["default", "work"]) {
    const result = splitFor(account, present);
    assert.equal(result.status, 0, `${account} runs in an existing cwd`);
    const lines = readFileSync(marker, "utf8").split("\n");
    assert.equal(lines[0], present, `${account} starts in the session's cwd`);
    assert.ok(lines.includes("--resume"), `${account} passes --resume`);
    assert.ok(lines.includes(UUID), `${account} resumes the session`);
  }
});

test("claude-accounts starts no read under herdr-app check", async (t) => {
  const { Mod, dir } = await loadMod("claude-accounts");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const accounts = [{ name: "default", email: "", usage: null }, { name: "work", email: "", usage: null }];

  const execsFor = async (checking) => {
    const state = herdrState({ checking, props: { role: "chip", current: "default", accounts } });
    const cx = makeCx();
    const view = new Mod();
    view.init(undefined, cx);
    view.render(cx);
    await flush();
    return state.execs.length;
  };

  assert.equal(await execsFor(true), 0);
  assert.ok(await execsFor(false) >= 1);
});

test("claude-accounts runs a read asked for while another was in flight", async (t) => {
  const { Mod, dir } = await loadMod("claude-accounts");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = herdrState({ props: { role: "menu", current: "default", accounts: [{ name: "default" }] } });
  let settle = null;
  state.execImpl = () => new Promise((resolve) => { settle = resolve; });

  const cx = makeCx();
  const view = new Mod();
  view.init(undefined, cx);
  await flush();
  assert.equal(state.execs.length, 1);

  view.readAccounts(cx);
  assert.equal(state.execs.length, 1, "the in-flight read is not restarted");

  settle({ code: 0, stdout: "", stderr: "" });
  await flush();
  assert.equal(state.execs.length, 2, "the requested re-read ran after the first");
});

test("claude-accounts refuses a pane on another machine", async (t) => {
  const { Mod, dir } = await loadMod("claude-accounts");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const accounts = [{ name: "default", email: "", usage: null }, { name: "work", email: "", usage: null }];

  // Resume row on a remote focus.
  let state = herdrState({
    spaces: [{ id: "m1/s1", machine: "m1" }],
    focused: { space: "m1/s1", pane: "m1/p1" },
    props: { role: "menu", current: "work", accounts, session: { id: UUID, cwd: "/tmp" } },
  });
  let cx = makeCx();
  let view = new Mod();
  view.init(undefined, cx);
  const row = findById(view.render(cx), "cont-default");
  assert.ok(row);
  row._handlers.on_click({}, cx);
  assert.equal(state.runs.filter((call) => call.name === "pane.split").length, 0);
  assert.ok(view.actionError);

  // Add form on a remote focus.
  state = herdrState({ spaces: [{ id: "m1/s1", machine: "m1" }], focused: { space: "m1/s1", pane: "m1/p1" }, props: { role: "menu", mode: "add" } });
  cx = makeCx();
  view = new Mod();
  view.init(undefined, cx);
  view.input._value = "work";
  const create = findById(view.render(cx), "acct-create");
  assert.ok(create);
  create._handlers.on_click();
  await flush();
  assert.equal(state.execs.filter((call) => (call.args ?? []).includes("--porcelain-add")).length, 0);
  assert.ok(view.error);

  // Control: a local focus runs both.
  state = herdrState({ spaces: [{ id: "s1", machine: null }], focused: { space: "s1", pane: "p1" }, props: { role: "menu", current: "work", accounts, session: { id: UUID, cwd: "/tmp" } } });
  cx = makeCx();
  view = new Mod();
  view.init(undefined, cx);
  findById(view.render(cx), "cont-default")._handlers.on_click({}, cx);
  assert.equal(state.runs.filter((call) => call.name === "pane.split").length, 1);

  state = herdrState({ spaces: [{ id: "s1", machine: null }], focused: { space: "s1", pane: "p1" }, props: { role: "menu", mode: "add" } });
  cx = makeCx();
  view = new Mod();
  view.init(undefined, cx);
  view.input._value = "work";
  findById(view.render(cx), "acct-create")._handlers.on_click();
  await flush();
  assert.ok(state.execs.some((call) => (call.args ?? []).includes("--porcelain-add")));
});

// --- tower-tabs ---------------------------------------------------------------------

test("tower-tabs draws Files/Changes only when the layout has a panel", async (t) => {
  const { Mod, dir } = await loadMod("tower-tabs");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const render = (layoutTree) => {
    store.clear();
    herdrState({ layout: layoutTree, spaces: [{ id: "s1", active: true, name: "one", tabs: [] }] });
    const view = new Mod();
    view.init();
    return view.render();
  };

  const plain = render({ id: "root", children: [] });
  assert.equal(findById(plain, "panel-files"), null);
  assert.equal(findById(plain, "panel-changes"), null);

  const withPanel = render({ id: "root", children: [{ id: "panel", children: [{ id: "panel-body" }] }] });
  assert.ok(findById(withPanel, "panel-files"));
  assert.ok(findById(withPanel, "panel-changes"));
});

test("tower-tabs ignores a stored panel map it cannot use", async (t) => {
  const { Mod, dir } = await loadMod("tower-tabs");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const initWith = (raw) => {
    store.clear();
    store.set("panels", raw);
    herdrState({ spaces: [] });
    const view = new Mod();
    view.init();
    return view;
  };

  assert.doesNotThrow(() => initWith("[object Object]"));
  const view = initWith("[1,2]");
  assert.equal(typeof view.panels, "object");
  assert.equal(Array.isArray(view.panels), false);
});

test("tower-tabs turns one wheel gesture into one tab step", async (t) => {
  const { Mod, dir } = await loadMod("tower-tabs");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = herdrState({ spaces: [] });
  const view = new Mod();
  view.init();
  for (let i = 0; i < 10; i++) view.wheel({ delta: { y: 3 } });
  assert.equal(state.runs.filter((call) => call.name === "tab.prev").length, 1);
});

test("tower-tabs scrolls the active tab into view", async (t) => {
  const { Mod, dir } = await loadMod("tower-tabs");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const tabs = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, name: `tab ${i}`, named: true, active: i === 15 }));
  herdrState({ spaces: [{ id: "s1", active: true, name: "one", tabs }] });
  store.clear();
  const view = new Mod();
  view.init();
  const scroll = findById(view.render(), "tab-scroll");
  assert.ok(scroll);
  const track = callsNamed(scroll, "track_scroll")[0];
  assert.ok(track, "the tab strip tracks the handle");
  assert.equal(track.args[0], view.scroll);
  assert.deepEqual(track.args[0].scrolls.map((call) => call.index), [15]);
});

// --- pulse --------------------------------------------------------------------------

const pulseNow = Date.now();

function sessionLine(overrides = {}) {
  return {
    t: "s",
    pid: 4001,
    sessionId: "0f639cb3-88c6-4c9d-90d1-c05b8c7a5d0c",
    cwd: "/work/project",
    name: "project-1",
    kind: "interactive",
    jobId: null,
    parkedJobId: null,
    status: "busy",
    waitingFor: null,
    startedAt: pulseNow - 60_000,
    updatedAt: pulseNow - 5_000,
    statusUpdatedAt: pulseNow - 20_000,
    location: "project",
    identity: { firstPrompt: "build the thing", handoff: null, round: 2, thread: { topic: "PROJ-12" } },
    customTitle: null,
    agentName: null,
    lastPrompt: "build the thing",
    lastAnswer: null,
    lastSentence: null,
    currentAction: "Bash",
    lastMeaningfulAt: pulseNow - 5_000,
    pr: null,
    background: { shells: 0, agents: 0, monitors: 0, total: 0 },
    completed: [],
    deadhd: null,
    pages: [],
    where: { kind: "herdr-app", paneId: "p1", handle: "h1", terminalId: "t1" },
    agent: "claude",
    account: "default",
    repo: "project",
    ...overrides,
  };
}

const metaLine = { t: "meta", roots: 1, updatedAt: pulseNow, error: null, pages: [], unreadablePages: [] };

test("pulse tracks the session list with a plain scroll handle", async (t) => {
  const { Mod, dir } = await loadMod("pulse");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = sessionLine({ sessionId: "aaa" });
  const second = sessionLine({ sessionId: "bbb", pid: 4002 });
  const stdout = `${JSON.stringify(first)}\n${JSON.stringify(second)}\n${JSON.stringify(metaLine)}\n`;
  herdrState({ execImpl: async () => ({ code: 0, stdout, stderr: "" }) });

  const cx = makeCx();
  const view = new Mod();
  view.init(undefined, cx);
  for (let i = 0; i < 100 && view.sessions.length < 2; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.sessions.length, 2);

  const data = view.viewData();
  const list = view.listView(data, cx);
  assert.equal(list._id, "pulse-list");
  const track = callsNamed(list, "track_scroll")[0];
  assert.ok(track, "the list tracks the handle");
  assert.equal(track.args[0], view.scroll);

  view.reveal("bbb", data);
  const index = view.buildRows(data).findIndex((row) => row.kind === "row" && row.item.sessionId === "bbb");
  assert.ok(index >= 0);
  assert.ok(view.scroll.scrolls.some((call) => call.index === index));
});

test("pulse attaches a background session once and refuses another machine", async (t) => {
  const { Mod, dir } = await loadMod("pulse");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const item = { pid: null, where: { kind: "claude-bg", attachId: "0f639cb3", paneId: null, terminalId: null } };

  const state = herdrState({ focused: { pane: "p1" } });
  const cx = makeCx();
  const view = new Mod();
  view.goTo(item, cx);
  const splits = () => state.runs.filter((call) => call.name === "pane.split");
  assert.equal(splits().length, 1);
  assert.deepEqual(splits()[0].args, { pane: "p1", direction: "right", argv: ["claude", "attach", "0f639cb3"] });

  view.goTo(item, cx);
  assert.equal(splits().length, 1, "a second click inside the grace window opens nothing");

  const remote = herdrState({ focused: { pane: "m1/p1" } });
  const remoteView = new Mod();
  remoteView.goTo(item, makeCx());
  assert.equal(remote.runs.filter((call) => call.name === "pane.split").length, 0);
  assert.equal(remoteView.notice, "Focus a pane on this computer to attach");

  // A remote space is refused even when its pane id carries no prefix.
  const remoteSpace = herdrState({
    focused: { space: "s2", pane: "p2" },
    spaces: [{ id: "s2", machine: "m1", tabs: [] }],
  });
  new Mod().goTo(item, makeCx());
  assert.equal(remoteSpace.runs.filter((call) => call.name === "pane.split").length, 0);

  // While Pulse holds the keyboard focused() may name no pane: the split falls back to the implicit focused pane.
  const noPane = herdrState({ focused: { space: "s1", pane: null }, spaces: [{ id: "s1", machine: null, tabs: [] }] });
  new Mod().goTo(item, makeCx());
  assert.deepEqual(noPane.runs, [{ name: "pane.split", args: { direction: "right", argv: ["claude", "attach", "0f639cb3"] } }]);

  // A pane already running `claude attach` for the session gets the focus instead of a new split.
  const attached = herdrState({ focused: { pane: "p1" }, panes: [{ pane: "p9", terminal: "a9", tab: "t1" }] });
  new Mod().goTo({ pid: null, where: { ...item.where, paneId: "p9" } }, makeCx());
  assert.deepEqual(attached.runs, [{ name: "pane.focus", args: { pane: "p9" } }]);
});

test("pulse says when Orca switched but could not be brought forward", async (t) => {
  const { Mod, dir } = await loadMod("pulse");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  herdrState({
    focused: { pane: "p1" },
    execImpl: (command) => (command === "open"
      ? Promise.reject(new Error("no"))
      : Promise.resolve({ code: 0, stdout: "", stderr: "" })),
  });
  const view = new Mod();
  view.goTo({ where: { handle: "h1" } }, makeCx());
  for (let i = 0; i < 50 && !view.notice; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.notice, "Switched in Orca, but couldn't bring it forward");
});

test("pulse and tower-rail do nothing under herdr-app check", async (t) => {
  const pulse = await loadMod("pulse");
  const rail = await loadMod("tower-rail");
  t.after(() => {
    rmSync(pulse.dir, { recursive: true, force: true });
    rmSync(rail.dir, { recursive: true, force: true });
  });

  const pulseState = herdrState({ checking: true });
  const pulseView = new pulse.Mod();
  pulseView.init(undefined, makeCx());
  await flush();
  assert.equal(pulseState.execs.length, 0);

  const railState = herdrState({
    checking: true,
    spaces: [{ id: "s1", machine: null, tabs: [{ id: "t1" }] }],
    terminals: [{ address: "a1", cwd: "/r" }],
    panes: [{ pane: "p1", terminal: "a1", tab: "t1" }],
  });
  const railView = new rail.Mod();
  railView.init(undefined, makeCx());
  await flush();
  assert.equal(railState.execs.length, 0);
  assert.equal(railState.runs.filter((call) => call.name === "space.move").length, 0);
});

test("tower starts no repaint timer under herdr-app check", async (t) => {
  const { Mod, dir } = await loadMod("tower");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  herdrState({ checking: true });
  const checked = makeCx();
  new Mod().init(undefined, checked);
  assert.equal(checked.timers.length, 0);

  herdrState({ checking: false });
  const live = makeCx();
  new Mod().init(undefined, live);
  assert.equal(live.timers.length, 1, "the lanes role repaints every 30 s in a live window");
});

// --- tower-rail ---------------------------------------------------------------------

test("tower-rail asks git on the space's machine and keeps the two repos apart", async (t) => {
  const { Mod, dir } = await loadMod("tower-rail");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = herdrState({
    spaces: [
      { id: "s1", machine: null, tabs: [{ id: "t1" }], name: "one", active: true },
      { id: "m/s2", machine: "m", tabs: [{ id: "t2" }], name: "two", active: false },
    ],
    terminals: [{ address: "a1", cwd: "/r" }, { address: "a2", cwd: "/r" }],
    panes: [{ pane: "p1", terminal: "a1", tab: "t1" }, { pane: "p2", terminal: "a2", tab: "t2" }],
    execImpl: async () => ({ code: 0, stdout: "/r/.git\n/r\n", stderr: "" }),
  });

  const view = new Mod();
  view.init(undefined, makeCx());
  await flush();

  assert.equal(state.execs.length, 2, "one git call per machine");
  const options = state.execs.map((call) => call.options ?? {});
  assert.ok(options.some((option) => option.on === "m"));
  assert.ok(options.some((option) => option.on == null));

  const rows = view.spaceRows();
  assert.ok(rows.every((row) => row.repo));
  assert.notEqual(rows[0].repo.key, rows[1].repo.key);
});

test("tower-rail scrolls its tile list", async (t) => {
  const { Mod, dir } = await loadMod("tower-rail");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  herdrState({ spaces: [{ id: "s1", machine: null, tabs: [], name: "one", active: true }], terminals: [], panes: [], agents: [] });
  const view = new Mod();
  view.init(undefined, makeCx());
  const root = view.render();
  assert.equal(root._id, "rail-tiles");
  assert.ok(callsNamed(root, "overflow_y_scroll").length > 0);
});
