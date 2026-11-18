// Pulse must keep reading the shared scanner's session line after scan.sh grew: the new keys
// (identity thread, account, repo, agent) are ignored, the fields it already knew still land.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// main.js imports the modules Herdr supplies at runtime; the test gives them empty stand-ins so
// the file can be loaded outside the app.
async function loadPulse() {
  const dir = mkdtempSync(join(tmpdir(), "pulse-scan-"));
  const stubs = {
    "gpui-kit": `
      export class View {}
      export const div = () => ({});
      export const image = () => ({});
      export const svg = () => ({});
    `,
    "gpui-base": `
      export const v_flex = () => ({});
      export const h_flex = () => ({});
      export const v_virtual_list = () => ({});
      export class VirtualListScrollHandle {}
      export class ScrollHandle { static new() { return {}; } }
    `,
    herdr: `
      export const exec = async () => ({ code: 0, stdout: "", stderr: "" });
      export const run = () => {};
      export const appHome = () => "";
      export const terminals = () => [];
      export const panes = () => [];
      export const spaces = () => [];
      export const nextCommand = () => new Promise(() => {});
      export const checking = () => false;
      export const focused = () => null;
    `,
  };
  for (const [name, body] of Object.entries(stubs)) {
    const folder = join(dir, "node_modules", name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "package.json"), JSON.stringify({ name, type: "module", main: "index.mjs" }));
    writeFileSync(join(folder, "index.mjs"), body);
  }
  const modDir = join(dir, "mod");
  mkdirSync(modDir);
  copyFileSync(join(ROOT, "mods", "pulse", "main.js"), join(modDir, "main.js"));
  const Pulse = (await import(pathToFileURL(join(modDir, "main.js")).href)).default;
  return { Pulse, dir };
}

const now = Date.now();

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
    startedAt: now - 60_000,
    updatedAt: now - 5_000,
    statusUpdatedAt: now - 20_000,
    location: "project",
    identity: { firstPrompt: "build the thing", handoff: null, round: 2, thread: { topic: "PROJ-12" } },
    customTitle: null,
    agentName: null,
    lastPrompt: "build the thing",
    lastAnswer: null,
    lastSentence: null,
    currentAction: "Bash",
    lastMeaningfulAt: now - 5_000,
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

const metaLine = { t: "meta", roots: 1, updatedAt: now, error: null, pages: [], unreadablePages: [], objectives: { "PROJ-12": "ship it" } };

test("a shared-scanner session line parses and groups as a working card", async (t) => {
  const { Pulse, dir } = await loadPulse();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = `${JSON.stringify(sessionLine())}\n${JSON.stringify(metaLine)}\n`;
  const parsed = Pulse.prototype.parseScan.call({}, output);

  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.meta.objectives["PROJ-12"], "ship it");

  const model = Pulse.prototype.buildModel.call(
    { seen: new Set(), snoozed: {}, sessions: parsed.sessions },
    now,
  );
  assert.equal(model.counts.working, 1);
  assert.equal(model.working[0].title, "project-1");
  assert.deepEqual(model.working[0].where, sessionLine().where);
});

test("a session the new scanner adds without identity still becomes a card", async (t) => {
  const { Pulse, dir } = await loadPulse();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const line = sessionLine({ sessionId: "native-1", identity: {}, agent: "codex", name: null, status: "idle" });
  const parsed = Pulse.prototype.parseScan.call({}, `${JSON.stringify(line)}\n${JSON.stringify(metaLine)}\n`);
  const model = Pulse.prototype.buildModel.call(
    { seen: new Set(), snoozed: {}, sessions: parsed.sessions },
    now,
  );
  assert.equal(model.counts.done, 1);
  assert.equal(model.done[0].title, "build the thing");
});
