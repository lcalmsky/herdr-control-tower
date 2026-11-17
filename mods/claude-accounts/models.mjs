// The user's other models (Codex through a proxy, Gemini, Grok) live in one JSON file beside cca's
// other state, so the accounts popup can list and start them without a code change.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ID = /^[A-Za-z0-9_-]+$/;
const NAME_VALUE = /^[A-Za-z_][A-Za-z0-9_]*=/;
// cca's own commands are not model ids; "default" means ~/.claude and gets its own check.
const RESERVED = new Set(["ls", "add", "share", "use", "current", "shell-init", "help"]);
const USAGE_WORD = /^codex-rollout(?:\s+(\S+))?$/;
const CAPITALISED = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

const homeOf = () => process.env.HOME || homedir();
const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

const expandHome = (path, home) => (
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path
);

export function slug(label) {
  return String(label ?? "")
    .toLowerCase()
    .replace(/ /g, "-")
    .replace(/[^A-Za-z0-9_-]/g, "");
}

// One file entry as a model, or null when it cannot be used. opts.home places ~/.claude-accounts,
// and opts.ids holds the ids already taken so the caller can drop a duplicate.
export function validModel(raw, opts = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const home = opts.home ?? homeOf();
  const ids = opts.ids ?? new Set();
  const id = raw.id;
  if (typeof id !== "string" || !ID.test(id) || id.startsWith("-")) return null;
  if (id === "default" || RESERVED.has(id) || ids.has(id)) return null;
  if (existsSync(join(home, ".claude-accounts", id))) return null;
  // A tab or newline would cut the tab-separated porcelain M line, so such a command is rejected.
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!command || /[\t\r\n]/.test(command)) return null;
  const model = { id, command };
  const oneLine = (value) => (typeof value === "string" && value.trim() && !/[\t\r\n]/.test(value) ? value.trim() : "");
  // A tab or newline would cut the tab-separated porcelain L line, so such a label is dropped.
  const label = oneLine(raw.label);
  if (label) model.label = label;
  const usage = oneLine(raw.usage);
  if (usage) model.usage = usage;
  const resume = oneLine(raw.resume);
  if (resume) model.resume = resume;
  const detect = oneLine(raw.detect);
  if (detect && NAME_VALUE.test(detect)) model.detect = detect;
  return model;
}

export function parseModels(text, opts = {}) {
  let raw;
  try {
    raw = JSON.parse(String(text ?? ""));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const ids = new Set();
  const models = [];
  for (const entry of raw) {
    const model = validModel(entry, { ...opts, ids });
    if (!model) continue;
    ids.add(model.id);
    models.push(model);
  }
  return models;
}

// The first model whose detect line, or CCA_ACCOUNT=<id>, appears in the pane's environment.
export function matchEnv(models, lines) {
  const tokens = new Set();
  for (const raw of lines ?? []) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    tokens.add(text);
    for (const token of text.split(/\s+/)) if (token) tokens.add(token);
  }
  for (const model of models ?? []) {
    if (model.detect && tokens.has(model.detect)) return model.id;
    if (tokens.has(`CCA_ACCOUNT=${model.id}`)) return model.id;
  }
  return null;
}

// One line of five tab fields; epoch seconds are kept only when they are digits, and a line with
// nothing in it means the usage command had no data to report.
export function parseUsage(text) {
  const line = String(text ?? "")
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .find((l) => l.trim());
  if (!line) return null;
  const fields = line.split("\t").map((value) => value.trim());
  const epoch = (value) => (/^\d+$/.test(value ?? "") ? value : "");
  const usage = {
    fiveUsed: epoch(fields[0]),
    fiveReset: epoch(fields[1]),
    sevenUsed: epoch(fields[2]),
    sevenReset: epoch(fields[3]),
    plan: fields[4] ?? "",
  };
  if (!usage.fiveUsed && !usage.fiveReset && !usage.sevenUsed && !usage.sevenReset && !usage.plan) return null;
  return usage;
}

// Native Codex writes its 5h and 7d windows under ~/.codex, so its entry gets the bundled reader.
export function defaultUsage(command) {
  const first = String(command ?? "").trim().split(/\s+/)[0] ?? "";
  return first === "codex" || first.endsWith("/codex") ? "codex-rollout ~/.codex" : null;
}

// `codex-rollout <home>` is shorthand for the bundled reader, with ~ in <home> expanded.
export function usageCommand(usage, modDir, home = homeOf()) {
  const text = String(usage ?? "").trim();
  const word = text.match(USAGE_WORD);
  if (!word) return text;
  const dir = expandHome(word[1] ?? "~", home);
  return `${shQuote(process.execPath)} ${shQuote(join(modDir, "codex-usage.mjs"))} ${shQuote(dir)}`;
}

function usageOf(model, modDir, home) {
  const run = spawnSync("/bin/sh", ["-c", usageCommand(model.usage, modDir, home)], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
  });
  if (!run || run.status !== 0) return null;
  return parseUsage(run.stdout);
}

function porcelain(models, modDir, home) {
  const out = [];
  for (const model of models) {
    out.push(`M\t${model.id}\t${model.command}\t${model.resume ? 1 : 0}`);
    if (model.label) out.push(`L\t${model.id}\t${model.label}`);
    const usage = model.usage ? usageOf(model, modDir, home) : null;
    if (!usage) continue;
    out.push(`U\t${model.id}\t${usage.fiveUsed}\t${usage.fiveReset}\t${usage.sevenUsed}\t${usage.sevenReset}\t\t`);
    if (usage.plan) out.push(`P\t${model.id}\tChatGPT ${CAPITALISED(usage.plan)}`);
  }
  return out;
}

function readFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const refuse = (message) => {
  process.stderr.write(`${message}\n`);
  return 2;
};

// Keeping entries parseModels rejected means a hand edit outside the format is not lost by a form add.
function addModel(stateDir, label, command, home) {
  const file = join(stateDir, "models.json");
  const text = readFile(file);
  let raw = [];
  try {
    if (text.trim()) raw = JSON.parse(text);
  } catch {
    return refuse("models.json is not valid JSON");
  }
  if (!Array.isArray(raw)) return refuse("models.json is not a list");
  const id = slug(label);
  if (!id) return refuse("The name needs at least one letter or digit");
  const line = String(command ?? "").trim();
  if (!line) return refuse("A start command is required");
  if (/[\r\n]/.test(String(command))) return refuse("The start command must be one line");
  if (id === "default") return refuse("default is the ~/.claude account");
  if (RESERVED.has(id)) return refuse(`${id} is a cca command`);
  if (parseModels(text, { home }).some((model) => model.id === id)) return refuse(`There is already a model called ${id}`);
  if (existsSync(join(home, ".claude-accounts", id))) return refuse(`There is already an account called ${id}`);
  const entry = { id, label: String(label).trim(), command: line };
  const usage = defaultUsage(line);
  if (usage) entry.usage = usage;
  raw.push(entry);
  try {
    mkdirSync(stateDir, { recursive: true });
    const tmp = join(stateDir, `.models.json.${process.pid}`);
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    return refuse("Could not write models.json");
  }
  process.stdout.write(`${id}\n`);
  return 0;
}

function main(argv) {
  const [command, stateDir, ...rest] = argv;
  const home = homeOf();
  const file = join(stateDir ?? "", "models.json");
  if (command === "porcelain") {
    const modDir = rest[0] ?? "";
    const models = parseModels(readFile(file), { home });
    let stdin = "";
    try {
      stdin = readFileSync(0, "utf8");
    } catch {}
    for (const line of porcelain(models, modDir, home)) process.stdout.write(`${line}\n`);
    const current = matchEnv(models, stdin.split("\n"));
    if (current) process.stdout.write(`C\t${current}\n`);
    return 0;
  }
  if (command === "add") return addModel(stateDir ?? "", rest[0], rest[1], home);
  if (command === "exists") {
    const id = rest[0] ?? "";
    return parseModels(readFile(file), { home }).some((model) => model.id === id) ? 0 : 1;
  }
  return 1;
}

const entry = process.argv[1] && realpathSync(process.argv[1]);
if (entry === realpathSync(fileURLToPath(import.meta.url))) {
  let code = 1;
  try {
    code = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`models: ${error?.message ?? error}\n`);
  }
  process.exit(code);
}
