#!/bin/sh
# Read-only session scan shared by the Herdr mods. Prints one JSON object per line:
# {t:"s", ...} for each live Claude Code, Codex or Gemini CLI session, then one
# {t:"meta", ...}. Reads session records, transcripts, agent rollout/chat files,
# deadhd state, page alerts and the session processes' environment, plus the handoff
# file and thread memory a session starts from. Writes nothing but its ledger
# and identity caches under ${TMPDIR:-/tmp}/herdr-pulse. Secrets (*.key) are never opened.

if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' '{"t":"meta","roots":0,"updatedAt":0,"error":"python3 not found","pages":[],"unreadablePages":[]}'
  exit 0
fi

exec python3 - <<'PY'
import json
import hashlib
import os
import re
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

HOME = os.path.expanduser("~")
NOW_MS = int(time.time() * 1000)
TAIL_BYTES = 256 * 1024
STATE_LIMIT = 1024 * 1024
SESSION_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
DIGITS_RE = re.compile(r"^[0-9]+$")
HTTP_RE = re.compile(r"^https?://", re.I)
ISO_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$"
)
ETIME_RE = re.compile(r"^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$")
DAY_DIR_RE = re.compile(r"^\d{1,4}$")
ROLLOUT_RE = re.compile(r"^rollout-.*\.jsonl$")
CODEX_REQUEST_RE = re.compile(r"##\s*My request(?: for Codex)?\s*:?\s*", re.I)
CODEX_TOOL_TYPES = ("function_call", "custom_tool_call")
# `codex <subcommand>` forms that are not an interactive session; `codex resume` is one.
CODEX_NON_SESSION = {
    "app-server", "mcp", "mcp-server", "exec", "proto", "login", "logout",
    "completion", "apply", "sandbox", "debug", "cloud",
}
# Codex's global options and the value each takes, so `codex -c k=v app-server` finds its subcommand.
CODEX_VALUE_FLAGS = {
    "-c", "--config", "-m", "--model", "-p", "--profile", "-a", "--ask-for-approval",
    "-s", "--sandbox", "-C", "--cd", "--add-dir", "--enable", "--disable",
}

CACHE_DIR = os.path.join(os.environ.get("TMPDIR") or "/tmp", "herdr-pulse")


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")


def iso_ms(value):
    if not isinstance(value, str):
        return None
    m = ISO_RE.match(value.strip())
    if not m:
        return None
    try:
        parts = [int(m.group(i)) for i in range(1, 7)]
        frac = m.group(7) or ""
        micro = int((frac + "000000")[:6])
        tz = m.group(8)
        if tz in (None, "Z"):
            zone = timezone.utc
        else:
            sign = 1 if tz[0] == "+" else -1
            digits = tz[1:].replace(":", "")
            zone = timezone(sign * timedelta(hours=int(digits[:2]), minutes=int(digits[2:4])))
        return int(datetime(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], micro, zone).timestamp() * 1000)
    except Exception:
        return None


def ms_num(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value) if value > 0 else None


def text(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def int_num(value):
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def jload(path, limit=STATE_LIMIT):
    try:
        if os.path.getsize(path) > limit:
            return None
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return json.load(f)
    except Exception:
        return None


def is_file(path):
    try:
        return os.path.isfile(path)
    except Exception:
        return False


def process_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except Exception:
        return False


def project_slug(cwd):
    out = []
    for ch in cwd:
        out.append(ch if (ord(ch) < 128 and ch.isalnum()) else "-")
    return "".join(out)


def tail_lines(path):
    try:
        st = os.stat(path)
        offset = max(0, st.st_size - TAIL_BYTES)
        with open(path, "rb") as f:
            if offset:
                f.seek(offset)
            data = f.read()
        raw = data.decode("utf-8", "replace")
        lines = raw.split("\n")
        if offset > 0 and lines:
            lines = lines[1:]
        return lines
    except Exception:
        return []


def strip_fences(value):
    kept = []
    fenced = False
    for line in value.splitlines():
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            fenced = not fenced
            continue
        if not fenced:
            kept.append(line)
    return "\n".join(kept)


def collapse(value):
    return " ".join(value.split())


def last_answer(raw):
    block = strip_fences(raw)
    paragraphs = [p for p in re.split(r"\n\s*\n", block) if p.strip()]
    if not paragraphs:
        return None
    value = collapse(paragraphs[-1])
    return value[:160] if value else None


def is_fragment(sentence):
    value = sentence.strip()
    if not value:
        return True
    if "|" in value or "```" in value or "~~~" in value:
        return True
    if value[0] in "-*+•·–—":
        return True
    m = re.match(r"^\d+", value)
    if m:
        rest = value[m.end():]
        if rest[:1] in (".", ")"):
            return True
    return False


def last_sentence(raw):
    value = collapse(strip_fences(raw))
    if not value:
        return None
    parts = re.split(r"(?<=[.!?。！？…])\s+", value)
    for part in reversed(parts):
        part = part.strip()
        if not part or is_fragment(part):
            continue
        return part[:119] + "…" if len(part) > 120 else part
    return None


def basename(value):
    if not isinstance(value, str):
        return None
    name = value.rstrip("/").split("/")[-1].strip()
    return name or None


REPO_CACHE = {}


def repo_of(cwd):
    if not isinstance(cwd, str) or not cwd:
        return None
    if cwd in REPO_CACHE:
        return REPO_CACHE[cwd]
    repo = None
    try:
        folder = os.path.abspath(cwd)
        while True:
            dotgit = os.path.join(folder, ".git")
            if os.path.isdir(dotgit):
                repo = basename(folder)
                break
            if os.path.isfile(dotgit):
                gitdir = None
                with open(dotgit, "r", encoding="utf-8", errors="replace") as f:
                    for line in f:
                        if line.startswith("gitdir:"):
                            gitdir = line[len("gitdir:"):].strip()
                            break
                if gitdir:
                    if not os.path.isabs(gitdir):
                        gitdir = os.path.join(folder, gitdir)
                    gitdir = os.path.normpath(gitdir)
                    common = gitdir
                    has_common = False
                    common_file = os.path.join(gitdir, "commondir")
                    if os.path.isfile(common_file):
                        with open(common_file, "r", encoding="utf-8", errors="replace") as f:
                            value = f.read().strip()
                        if value:
                            common = os.path.normpath(os.path.join(gitdir, value))
                            has_common = True
                    if not has_common:
                        # A gitdir without commondir (a submodule) is named after its own folder.
                        repo = basename(folder)
                    else:
                        name = basename(common)
                        if name and name != ".git" and name.endswith(".git"):
                            repo = name[:-4] or None
                        elif basename(os.path.dirname(common)) == "modules" and basename(os.path.dirname(os.path.dirname(common))) == ".git":
                            repo = name
                        else:
                            repo = basename(os.path.dirname(common))
                break
            parent = os.path.dirname(folder)
            if parent == folder:
                break
            folder = parent
    except Exception:
        repo = None
    REPO_CACHE[cwd] = repo
    return repo


def tool_label(name, data):
    if not isinstance(name, str) or not name:
        return None
    data = data if isinstance(data, dict) else {}
    if name.startswith("mcp__"):
        parts = name.split("__")
        label = parts[-1] or name
    elif name == "Bash":
        description = text(data.get("description"))
        if description:
            label = description
        else:
            command = text(data.get("command"))
            label = command.split("\n")[0].strip() if command else name
    elif name in ("Agent", "Task"):
        label = text(data.get("description")) or name
    elif name in ("Edit", "Write", "MultiEdit"):
        file_name = basename(data.get("file_path"))
        label = "Edit file · " + file_name if file_name else "Edit file"
    elif name == "Read":
        file_name = basename(data.get("file_path"))
        label = "Read file · " + file_name if file_name else "Read file"
    elif name in ("Grep", "Glob"):
        label = "Search"
    elif name in ("WebFetch", "WebSearch"):
        label = "Web fetch"
    else:
        label = name
    return label[:40]


def short_location(cwd, home):
    if not isinstance(cwd, str) or not cwd:
        return None
    comps = [c for c in cwd.split("/") if c]
    if not comps:
        return None
    home_comps = [c for c in home.split("/") if c]
    if home_comps:
        if comps == home_comps:
            return "~"
        orca = home_comps + ["orca", "workspaces"]
        if comps[:len(orca)] == orca and len(comps) > len(orca) + 1:
            return comps[len(orca)] + "/" + comps[len(orca) + 1]
    if ".claude" in comps:
        index = comps.index(".claude")
        if index > 0 and len(comps) > index + 2 and comps[index + 1] == "worktrees":
            return comps[index - 1] + "/" + comps[index + 2]
    if home_comps:
        git_prefix = home_comps + ["git-repo"]
        if comps[:len(git_prefix)] == git_prefix and len(comps) > len(git_prefix):
            repo = comps[len(git_prefix)]
            if len(comps) > len(git_prefix) + 1:
                return repo + "/" + comps[len(git_prefix) + 1]
            return repo
    return comps[-1]


def task_notification_values(content, tag, terminal_only=False):
    texts = []
    if isinstance(content, str):
        texts = [content]
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                texts.append(block["text"])
    found = set()
    pattern = re.compile(r"<%s>(.*?)</%s>" % (re.escape(tag), re.escape(tag)), re.S)
    for source in texts:
        rest = source
        while True:
            opening = rest.find("<task-notification>")
            if opening < 0:
                break
            start = opening + len("<task-notification>")
            closing = rest.find("</task-notification>", start)
            block = rest[start:closing] if closing >= 0 else rest[start:]
            rest = rest[closing + len("</task-notification>"):] if closing >= 0 else ""
            if terminal_only and "<status>" not in block:
                continue
            for match in pattern.finditer(block):
                value = match.group(1).strip()
                if value:
                    found.add(value)
    return found


def cache_path(session_id):
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", session_id)
    return os.path.join(CACHE_DIR, "ledger-" + safe + ".json")


def build_ledger(path, session_id):
    tool_names = {}
    launches = {}
    completed_tool = set()
    completed_task = set()
    try:
        with open(path, "rb") as f:
            for raw in f:
                try:
                    record = json.loads(raw.decode("utf-8", "replace"))
                except Exception:
                    continue
                kind = record.get("type")
                if kind == "queue-operation":
                    completed_task |= task_notification_values(record.get("content"), "task-id", True)
                elif kind == "attachment":
                    attachment = record.get("attachment")
                    if isinstance(attachment, dict) and attachment.get("type") == "queued_command":
                        completed_task |= task_notification_values(attachment.get("prompt"), "task-id", True)
                elif kind == "assistant":
                    stamp = iso_ms(record.get("timestamp"))
                    message = record.get("message")
                    blocks = message.get("content") if isinstance(message, dict) else None
                    if not isinstance(blocks, list):
                        continue
                    for block in blocks:
                        if not isinstance(block, dict) or block.get("type") != "tool_use":
                            continue
                        tool_id = text(block.get("id"))
                        if not tool_id:
                            continue
                        name = text(block.get("name"))
                        if name:
                            tool_names[tool_id] = name
                        data = block.get("input")
                        if isinstance(data, dict) and data.get("run_in_background") is True:
                            launch = launches.get(tool_id, {})
                            if not launch.get("taskId"):
                                launch["taskId"] = None
                            if launch.get("launchedAt") is None:
                                launch["launchedAt"] = stamp
                            launches[tool_id] = launch
                elif kind == "user":
                    stamp = iso_ms(record.get("timestamp"))
                    message = record.get("message")
                    blocks = message.get("content") if isinstance(message, dict) else None
                    result = record.get("toolUseResult") if isinstance(record.get("toolUseResult"), dict) else None
                    if isinstance(blocks, list):
                        for block in blocks:
                            if not isinstance(block, dict) or block.get("type") != "tool_result":
                                continue
                            tool_id = text(block.get("tool_use_id"))
                            if not tool_id:
                                continue
                            task_id = None
                            if result:
                                if text(result.get("backgroundTaskId")):
                                    task_id = text(result.get("backgroundTaskId"))
                                elif result.get("isAsync") is True and text(result.get("agentId")):
                                    task_id = text(result.get("agentId"))
                                elif tool_names.get(tool_id) == "Monitor" and text(result.get("taskId")):
                                    task_id = text(result.get("taskId"))
                            if task_id:
                                launch = launches.get(tool_id, {})
                                if not launch.get("taskId"):
                                    launch["taskId"] = task_id
                                if launch.get("launchedAt") is None:
                                    launch["launchedAt"] = stamp
                                launches[tool_id] = launch
                    if result and text(result.get("task_id")):
                        completed_task.add(text(result.get("task_id")))
                    completed_tool |= task_notification_values(blocks, "tool-use-id", False)
                    completed_task |= task_notification_values(blocks, "task-id", True)
    except Exception:
        pass
    state = {
        "toolNames": tool_names,
        "launches": launches,
        "completedToolUse": sorted(completed_tool),
        "completedTaskIds": sorted(completed_task),
    }
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        temp = cache_path(session_id) + ".tmp"
        with open(temp, "w", encoding="utf-8") as f:
            json.dump(state, f)
        os.replace(temp, cache_path(session_id))
    except Exception:
        pass
    return state


def ledger_for(path, session_id, started_at):
    try:
        st = os.stat(path)
    except Exception:
        return {"shells": 0, "agents": 0, "monitors": 0, "total": 0}, []
    state = None
    try:
        with open(cache_path(session_id), "r", encoding="utf-8") as f:
            cached = json.load(f)
        if (cached.get("ino") == st.st_ino and cached.get("size") == st.st_size
                and cached.get("mtime") == st.st_mtime_ns):
            state = cached
    except Exception:
        state = None
    if state is None:
        state = build_ledger(path, session_id)
        try:
            stat_record = {"ino": st.st_ino, "size": st.st_size, "mtime": st.st_mtime_ns}
            stat_record.update(state)
            with open(cache_path(session_id), "w", encoding="utf-8") as f:
                json.dump(stat_record, f)
            state = stat_record
        except Exception:
            pass
    tool_names = state.get("toolNames") or {}
    launches = state.get("launches") or {}
    completed_tool = set(state.get("completedToolUse") or [])
    completed_task = set(state.get("completedTaskIds") or [])
    counts = {"shells": 0, "agents": 0, "monitors": 0, "total": 0}
    for tool_id, launch in launches.items():
        done = tool_id in completed_tool or (launch.get("taskId") and launch["taskId"] in completed_task)
        if done:
            continue
        launched_at = launch.get("launchedAt")
        if started_at is not None and launched_at is not None and launched_at < started_at:
            continue
        name = tool_names.get(tool_id)
        if name == "Bash":
            counts["shells"] += 1
        elif name == "Monitor":
            counts["monitors"] += 1
        else:
            counts["agents"] += 1
        counts["total"] += 1
    completed = set(completed_task)
    for tool_id, launch in launches.items():
        task_id = launch.get("taskId")
        if task_id and (tool_id in completed_tool or task_id in completed_task):
            completed.add(task_id)
    return counts, sorted(completed)


def summarize_transcript(path):
    summary = {
        "customTitle": None, "agentName": None, "lastPrompt": None,
        "lastAnswer": None, "lastSentence": None, "currentAction": None,
        "lastToolName": None, "lastToolAt": None, "lastMeaningfulAt": None,
        "pr": None,
    }
    pending = []
    resolved = set()
    texts = []
    last_tool_name = None
    last_tool_at = None
    last_meaningful = None
    pull_request = None
    for line in tail_lines(path):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if not isinstance(record, dict):
            continue
        kind = record.get("type")
        if kind == "custom-title":
            summary["customTitle"] = text(record.get("customTitle")) or summary["customTitle"]
        elif kind == "agent-name":
            summary["agentName"] = text(record.get("agentName")) or summary["agentName"]
        elif kind == "last-prompt":
            summary["lastPrompt"] = text(record.get("lastPrompt")) or summary["lastPrompt"]
        elif kind == "assistant":
            stamp = iso_ms(record.get("timestamp"))
            if stamp is not None:
                last_meaningful = stamp
            message = record.get("message")
            blocks = message.get("content") if isinstance(message, dict) else None
            if not isinstance(blocks, list):
                continue
            for block in blocks:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    texts.append(block["text"])
                elif block.get("type") == "tool_use":
                    name = text(block.get("name"))
                    if name:
                        last_tool_name = name
                        last_tool_at = stamp
                    pending.append({"id": text(block.get("id")), "name": name,
                                    "input": block.get("input") if isinstance(block.get("input"), dict) else {}})
        elif kind == "user":
            stamp = iso_ms(record.get("timestamp"))
            if stamp is not None:
                last_meaningful = stamp
            message = record.get("message")
            blocks = message.get("content") if isinstance(message, dict) else None
            if isinstance(blocks, list):
                for block in blocks:
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        tool_id = text(block.get("tool_use_id"))
                        if tool_id:
                            resolved.add(tool_id)
        elif kind == "pr-link":
            url = text(record.get("prUrl"))
            number = record.get("prNumber")
            if not isinstance(number, int) or isinstance(number, bool):
                try:
                    number = int(str(number).strip())
                except Exception:
                    number = 0
            if url and HTTP_RE.match(url) and number and number > 0:
                pull_request = {"number": number, "url": url, "label": None}
    for raw in reversed(texts):
        answer = last_answer(raw)
        if answer:
            summary["lastAnswer"] = answer
            summary["lastSentence"] = last_sentence(raw)
            break
    current = None
    for entry in reversed(pending):
        if entry["id"] is None or entry["id"] not in resolved:
            current = entry
            break
    if current:
        summary["currentAction"] = tool_label(current["name"], current["input"])
    summary["lastToolName"] = last_tool_name
    summary["lastToolAt"] = last_tool_at
    summary["lastMeaningfulAt"] = last_meaningful
    summary["pr"] = pull_request
    return summary


HEAD_BYTES = 512 * 1024
HANDOFF_RE = re.compile(r"(/[^\s`'\"]+/\.claude/handoff/[\w.-]+\.md)")
# A round is counted either in Korean ("3회차") or in English ("round 3").
ROUND_RE = re.compile(r"(\d+)\s*회차|\bround\s+(\d+)\b", re.IGNORECASE)
PASTE_H1_RE = re.compile(r"<pasted_content[^>]*>\s*#\s+([^\n#<]+)")
ARGS_RE = re.compile(r"<command-args>(.*?)</command-args>", re.S)
# The thread-memory folder and the goals file are optional inputs: the environment names the
# path first, then ${XDG_CONFIG_HOME:-$HOME/.config}/herdr-shared/scan.json, and with neither
# that reader is off.
CONFIG_PATH = os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"), "herdr-shared", "scan.json")


def scan_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


CONFIG = scan_config()


def configured_path(key):
    value = CONFIG.get(key)
    if not isinstance(value, str) or not value:
        return None
    return HOME + value[1:] if value == "~" or value.startswith("~/") else value


THREAD_SESSIONS = os.environ.get("HERDR_THREAD_SESSIONS") or configured_path("threadSessions")
THREAD_KEY_RE = re.compile(r"^([A-Z0-9]+)-(\d+)_(\d+)$")
MEMORY_TOPIC_RE = re.compile(r"^-\s*(질문|원글):\s*(.+)$")


def first_prompt(path):
    try:
        with open(path, "rb") as f:
            data = f.read(HEAD_BYTES)
    except Exception:
        return None
    for line in data.decode("utf-8", "replace").split("\n"):
        try:
            entry = json.loads(line)
        except Exception:
            continue
        if not isinstance(entry, dict) or entry.get("type") != "user" or entry.get("isMeta"):
            continue
        content = (entry.get("message") or {}).get("content")
        if isinstance(content, list):
            content = " ".join(block.get("text", "") for block in content
                               if isinstance(block, dict) and block.get("type") == "text")
        if not isinstance(content, str) or not content.strip():
            continue
        stripped = content.lstrip()
        if stripped.startswith(("<local-command", "<system-reminder", "Caveat:")):
            continue
        if stripped.startswith(("<command-name>", "<command-message>")):
            args = ARGS_RE.search(content)
            content = args.group(1) if args else ""
            if not content.strip():
                continue
        return content
    return None


def first_heading(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for index, line in enumerate(f):
                if line.startswith("# "):
                    return collapse(line[2:])
                if index > 200:
                    break
    except Exception:
        pass
    return None


def thread_topic(cwd):
    if not THREAD_SESSIONS:
        return None
    match = THREAD_KEY_RE.match(os.path.basename(cwd))
    if not match:
        return None
    channel, seconds, fraction = match.groups()
    thread = {"channel": channel, "threadAt": int(seconds) * 1000}
    state = os.path.dirname(THREAD_SESSIONS)
    record = jload(os.path.join(state, "threads", os.path.basename(cwd) + ".json"))
    if isinstance(record, dict):
        thread["lane"] = text(record.get("lane"))
        session = record.get("session")
        thread["label"] = text(session.get("label")) if isinstance(session, dict) else None
    try:
        memories = os.listdir(os.path.join(state, "memory", "threads"))
    except Exception:
        memories = []
    for name in memories:
        if seconds + "_" + fraction not in name and seconds + "." + fraction not in name:
            continue
        try:
            with open(os.path.join(state, "memory", "threads", name), "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    found = MEMORY_TOPIC_RE.match(line.strip())
                    if found:
                        thread["topic"] = collapse(found.group(2))
                        break
        except Exception:
            pass
        if thread.get("topic"):
            break
    if not thread.get("topic"):
        thread_ts = seconds + "." + fraction
        try:
            with open(os.path.join(state, "events.ndjson"), "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if thread_ts not in line or '"received"' not in line:
                        continue
                    try:
                        event = json.loads(line)
                    except Exception:
                        continue
                    if isinstance(event, dict) and event.get("type") == "received" and text(event.get("thread_ts")) == thread_ts:
                        thread["topic"] = collapse(text(event.get("text")) or "")
                        break
        except Exception:
            pass
    return thread


RD_PROGRAMS = os.environ.get("HERDR_GOALS_FILE") or configured_path("goalsFile")
OBJECTIVE_RE = re.compile(r"^\s*([A-Z][A-Z0-9]+-\d+)\s+(.+)$", re.S)


def rd_objectives():
    """Each ticket's goal from the goals file, newest program first: {"ABC-123": "goal text"}."""
    if not RD_PROGRAMS:
        return {}
    try:
        with open(RD_PROGRAMS, encoding="utf-8") as handle:
            programs = json.load(handle).get("programs") or []
    except (OSError, ValueError, AttributeError):
        return {}
    if not isinstance(programs, list):
        return {}
    found = {}
    for program in sorted((p for p in programs if isinstance(p, dict)), key=lambda p: str(p.get("updated_at") or ""), reverse=True):
        match = OBJECTIVE_RE.match(str(program.get("objective") or ""))
        if not match:
            continue
        text = re.split(r"\s*\((?:PRD|ADR|설계|https?:)", match.group(2).strip())[0]
        text = re.sub(r"\s*\([^()]*\)\s*$", "", re.split(r"(?<=[.!?])\s", text)[0]).strip()
        found.setdefault(match.group(1).upper(), text[:200])
    return found


def identity_path(session_id):
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", session_id)
    return os.path.join(CACHE_DIR, "identity-v2-" + safe + ".json")


# What a session is about, read once from the start of its transcript and the files it names; handoff
# files and prompts change later, so the first answer is cached for the life of the session.
def session_identity(path, session_id, cwd):
    cached = jload(identity_path(session_id))
    if isinstance(cached, dict) and cached.get("final"):
        return cached.get("identity")
    identity = {}
    prompt = first_prompt(path) if path else None
    if prompt:
        identity["firstPrompt"] = prompt[:400]
        handoff = HANDOFF_RE.search(prompt)
        if handoff:
            heading = first_heading(handoff.group(1))
            if heading:
                identity["handoff"] = heading
        round_match = ROUND_RE.search(prompt)
        if round_match:
            identity["round"] = int(round_match.group(1) or round_match.group(2))
        paste = PASTE_H1_RE.search(prompt)
        if paste:
            identity["paste"] = collapse(paste.group(1))
    if cwd and THREAD_SESSIONS and os.path.dirname(os.path.normpath(cwd)) == THREAD_SESSIONS:
        thread = thread_topic(cwd)
        if thread:
            identity["thread"] = thread
    final = bool(prompt) and (not identity.get("thread") or bool(identity["thread"].get("topic")))
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(identity_path(session_id), "w", encoding="utf-8") as f:
            json.dump({"final": final, "identity": identity}, f, ensure_ascii=False)
    except Exception:
        pass
    return identity


def transcript_path(root, cwd, session_id):
    projects = os.path.join(root, "projects")
    name = session_id + ".jsonl"
    if cwd:
        direct = os.path.join(projects, project_slug(cwd), name)
        if is_file(direct):
            return direct
    try:
        for directory in os.listdir(projects):
            candidate = os.path.join(projects, directory, name)
            if is_file(candidate):
                return candidate
    except Exception:
        pass
    return None


def valid_tmp_path(value, suffix):
    if not isinstance(value, str) or not value.startswith("/"):
        return None
    standard = os.path.normpath(value)
    if not (standard.startswith("/tmp/") or standard.startswith("/private/tmp/")):
        return None
    if not standard.endswith(suffix):
        return None
    return standard


def read_checklist(path):
    data = jload(path)
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        return []
    items = []
    for raw in data["items"]:
        if not isinstance(raw, dict):
            continue
        state = text(raw.get("state"))
        if state not in ("done", "now", "side", "left", "blocked"):
            state = "left"
        label = text(raw.get("label")) or text(raw.get("title")) or text(raw.get("id"))
        if not label:
            label = "Step %d" % (len(items) + 1)
        items.append({
            "label": label,
            "state": state,
            "sub": text(raw.get("sub")),
            "doneAt": iso_ms(text(raw.get("doneAt"))),
            "ask": text(raw.get("ask")),
        })
    return items


def deadhd_state(session_id):
    directory = os.environ.get("DEADHD_STATE_DIR") or "/tmp/deadhd-state"
    path = os.path.join(os.path.expanduser(directory), session_id + ".json")
    data = jload(path)
    if not isinstance(data, dict):
        return None
    if text(data.get("sessionId")) != session_id:
        return None
    summary = data.get("summary") if isinstance(data.get("summary"), dict) else None
    counts_raw = summary.get("counts") if summary and isinstance(summary.get("counts"), dict) else None
    counts = None
    if counts_raw is not None:
        counts = {
            "done": int_num(counts_raw.get("done")) or 0,
            "left": int_num(counts_raw.get("left")) or 0,
            "now": int_num(counts_raw.get("now")) or 0,
            "blocked": int_num(counts_raw.get("blocked")) or 0,
        }
    total = int_num(summary.get("total")) if summary else None
    states = None
    if summary and isinstance(summary.get("states"), list):
        states = [s for s in summary["states"] if isinstance(s, str)]
        if len(states) != len(summary["states"]):
            states = None
    key = text(summary.get("key")) if summary else None
    key_href = text(summary.get("keyHref")) if summary else None
    if key_href and not HTTP_RE.match(key_href):
        key_href = None
    pr = None
    if summary and isinstance(summary.get("pr"), dict):
        href = text(summary["pr"].get("href"))
        if href and HTTP_RE.match(href):
            label = text(summary["pr"].get("text"))
            number = 0
            for source in (label, href):
                if not source:
                    continue
                digits = re.search(r"(\d+)$", source)
                if digits:
                    number = int(digits.group(1))
                    break
            pr = {"href": href, "text": label, "number": number}
    data_at = iso_ms(text(summary.get("dataAt"))) if summary else None
    eta = None
    if summary:
        eta = iso_ms(text(summary.get("etaCalibrated"))) or iso_ms(text(summary.get("eta")))
    page_path = valid_tmp_path(text(data.get("out")), ".html")
    data_path = valid_tmp_path(text(data.get("data")), ".json")
    if page_path and not is_file(page_path) and not (data_path and is_file(data_path)):
        page_path = None
    items = read_checklist(data_path) if data_path and is_file(data_path) else []
    blocked_ask = None
    for item in items:
        if item["state"] == "blocked":
            blocked_ask = item["ask"]
            break
    title = text(summary.get("title")) if summary else None
    now_label = text(summary.get("nowLabel")) if summary else None
    return {
        "title": title,
        "counts": counts,
        "total": total,
        "states": states,
        "nowLabel": now_label,
        "key": key,
        "keyHref": key_href,
        "pr": pr,
        "eta": eta,
        "dataAt": data_at,
        "pagePath": page_path,
        "dataPath": data_path,
        "items": items,
        "blockedAsk": blocked_ask,
        "off": text(data.get("offAt")) is not None,
        "summaryAvailable": summary is not None,
    }


def page_alerts():
    directory = os.environ.get("PULSE_PAGES_DIR") or os.path.join(HOME, ".pulse", "pages")
    directory = os.path.expanduser(directory)
    alerts = []
    unreadable = []
    if not os.path.isdir(directory):
        return [], []
    try:
        names = os.listdir(directory)
    except Exception:
        return [], []
    for name in names:
        if name.startswith(".") or not name.endswith(".json"):
            continue
        payload = jload(os.path.join(directory, name))
        if not isinstance(payload, dict):
            unreadable.append(name)
            continue
        page_id = text(payload.get("page_id"))
        worktree = text(payload.get("worktree"))
        url = text(payload.get("url"))
        label = text(payload.get("label"))
        created = iso_ms(text(payload.get("created_at")))
        if not (page_id and worktree and url and label and created is not None):
            unreadable.append(name)
            continue
        alerts.append({
            "pageId": page_id,
            "worktree": worktree,
            "url": url,
            "label": label,
            "createdAt": created,
            "terminalHandle": text(payload.get("terminal_handle")),
            "sessionId": text(payload.get("session_id")),
            "fileName": name,
        })
    groups = {}
    for alert in alerts:
        groups.setdefault((alert["worktree"], alert["url"]), []).append(alert)
    merged = []
    for group in groups.values():
        ordered = sorted(group, key=lambda a: (a["createdAt"], a["pageId"], a["fileName"]))
        representative = ordered[-1]
        file_names = [a["fileName"] for a in ordered]
        url = representative["url"]
        openable = bool(HTTP_RE.match(url))
        if not openable:
            local = os.path.expanduser(url)
            openable = is_file(local) and local.lower().endswith((".html", ".htm"))
            if openable:
                url = local
        merged.append({
            "pageId": representative["pageId"],
            "worktree": representative["worktree"],
            "url": url,
            "label": representative["label"],
            "createdAt": representative["createdAt"],
            "oldestCreatedAt": ordered[0]["createdAt"],
            "terminalHandle": representative["terminalHandle"],
            "sessionId": representative["sessionId"],
            "fileNames": file_names,
            "files": [os.path.join(directory, n) for n in file_names],
            "openable": openable,
        })
    merged.sort(key=lambda a: (a["oldestCreatedAt"], a["pageId"]))
    return merged, sorted(unreadable)


def process_environments(pids):
    if not pids:
        return {}
    try:
        result = subprocess.run(
            [os.environ.get("PULSE_PS") or "ps", "eww", "-o", "pid=", "-o", "command=", "-p", ",".join(str(p) for p in pids)],
            capture_output=True, text=True, timeout=5,
        )
        output = result.stdout
    except Exception:
        return {}
    wanted = ["TMUX_PANE", "TMUX", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID",
              "HERDR_SOCKET_PATH", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "ORCA_TERMINAL_HANDLE"]
    found = {}
    for line in output.splitlines():
        match = re.match(r"^\s*(\d+)\s+(.*)$", line)
        if not match:
            continue
        pid = int(match.group(1))
        command = match.group(2)
        values = {}
        for name in wanted:
            matches = re.findall(r"(?:^|\s)" + re.escape(name) + r"=(\S*)", command)
            if matches:
                last = matches[-1].strip()
                if last:
                    values[name] = last
        found[pid] = values
    return found


def where_of(env):
    tmux_pane = env.get("TMUX_PANE")
    if tmux_pane:
        tmux = env.get("TMUX") or ""
        socket = tmux.split(",", 1)[0] if tmux else None
        return {"kind": "tmux", "paneId": tmux_pane, "socket": socket or None, "handle": None, "terminalId": None}
    herdr_pane = env.get("HERDR_PANE_ID")
    if herdr_pane:
        return {"kind": "herdr", "paneId": herdr_pane, "socket": env.get("HERDR_SOCKET_PATH"),
                "handle": env.get("ORCA_TERMINAL_HANDLE"), "terminalId": None,
                "tabId": env.get("HERDR_TAB_ID"), "workspaceId": env.get("HERDR_WORKSPACE_ID")}
    terminal_id = env.get("HC_TERMINAL_ID")
    if terminal_id:
        return {"kind": "herdr-app", "paneId": terminal_id, "socket": env.get("HC_TERMINAL_SOCKET"),
                "handle": env.get("ORCA_TERMINAL_HANDLE"), "terminalId": terminal_id}
    handle = env.get("ORCA_TERMINAL_HANDLE")
    if handle:
        return {"kind": "orca", "paneId": None, "socket": None, "handle": handle, "terminalId": None}
    return {"kind": None, "paneId": None, "socket": None, "handle": None, "terminalId": None}


def claude_attach_panes():
    command = [os.environ.get("PULSE_PS") or "ps", "-axww", "-o", "pid=,tty=,etime=,command="]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        output = result.stdout
    except Exception:
        return []
    attached = []
    for line in output.splitlines():
        match = re.match(r"^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.*\S)\s*$", line)
        if not match or match.group(2) in ("??", "-"):
            continue
        argv = match.group(4).split()
        if len(argv) < 3 or os.path.basename(argv[0]) != "claude" or argv[1] != "attach":
            continue
        attached.append((int(match.group(1)), argv[2]))
    environments = process_environments([pid for pid, _ in attached])
    return [(arg, environments.get(pid) or {}) for pid, arg in attached]


# A background session inherits the terminal variables of whoever started the daemon, so its own
# environment says nothing about where it is. `claude attach` takes the 8-character id, a prefix or the name.
def claude_bg_where(where, record, session_id, attached):
    if record.get("kind") != "bg" or not isinstance(session_id, str):
        return where
    attach_id = session_id[:8]
    name = text(record.get("name"))
    pane = terminal = None
    for arg, env in attached:
        if arg == attach_id or session_id.startswith(arg) or (name and arg == name):
            pane, terminal = env.get("HERDR_PANE_ID"), env.get("HC_TERMINAL_ID")
            if pane or terminal:
                break
    return {"kind": "claude-bg", "paneId": pane, "socket": None, "handle": None, "terminalId": terminal,
            "attachId": attach_id}


# Native Codex and Gemini CLI sessions: their processes (ps), folders (lsof) and own
# rollout/chat files. Nothing here writes, and a failure here must not hide the Claude sessions.

def elapsed_ms(value):
    match = ETIME_RE.match(value or "")
    if not match:
        return None
    days, hours, minutes, seconds = match.groups()
    total = int(seconds) + int(minutes) * 60
    if hours:
        total += int(hours) * 3600
    if days:
        total += int(days) * 86400
    return total * 1000


def codex_subcommand(argv):
    index = 1
    while index < len(argv):
        arg = argv[index]
        if arg in CODEX_VALUE_FLAGS:
            index += 2
            continue
        if arg.startswith("-"):
            index += 1
            continue
        return arg
    return None


def native_agent_kind(argv):
    if not argv:
        return None
    base = os.path.basename(argv[0].rstrip("/"))
    if base == "codex":
        if codex_subcommand(argv) in CODEX_NON_SESSION:
            return None
        return "codex"
    if base == "gemini":
        return "gemini"
    if base in ("node", "nodejs"):
        for arg in argv[1:3]:
            leaf = os.path.basename(arg)
            if leaf in ("gemini", "gemini.js") or "@google/gemini-cli" in arg:
                return "gemini"
    return None


def agent_processes():
    command = [os.environ.get("PULSE_PS") or "ps", "-axww", "-o", "pid=,tty=,etime=,command="]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        output = result.stdout
    except Exception:
        return []
    found = []
    for line in output.splitlines():
        match = re.match(r"^\s*(\d+)\s+(\S+)\s+(\S+)\s+(.*\S)\s*$", line)
        # An interactive session runs on a terminal; servers the ChatGPT app starts have none.
        if not match or match.group(2) in ("??", "-"):
            continue
        kind = native_agent_kind(match.group(4).split())
        if not kind:
            continue
        elapsed = elapsed_ms(match.group(3))
        if elapsed is None:
            continue
        found.append({"pid": int(match.group(1)), "kind": kind, "startedAt": NOW_MS - elapsed})
    return found


def process_cwds(pids):
    if not pids:
        return {}
    command = [os.environ.get("PULSE_LSOF") or "lsof", "-a", "-p", ",".join(str(p) for p in sorted(pids)),
               "-d", "cwd", "-Fn"]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        output = result.stdout
    except Exception:
        return {}
    cwds = {}
    pid = None
    next_cwd = False
    for line in output.splitlines():
        if line.startswith("p"):
            try:
                pid = int(line[1:])
            except Exception:
                pid = None
            next_cwd = False
        elif line == "fcwd":
            next_cwd = True
        elif line.startswith("n") and next_cwd and pid:
            value = line[1:].strip()
            if value.startswith("/"):
                cwds[pid] = value
            next_cwd = False
    return cwds


def file_mtime_ms(path):
    try:
        return int(os.stat(path).st_mtime * 1000)
    except Exception:
        return None


def head_lines(path, limit=HEAD_BYTES):
    try:
        with open(path, "rb") as f:
            data = f.read(limit)
        return data.decode("utf-8", "replace").split("\n")
    except Exception:
        return []


def codex_day_dirs():
    base = os.path.join(HOME, ".codex", "sessions")
    found = []
    try:
        years = [name for name in os.listdir(base) if DAY_DIR_RE.match(name)]
    except Exception:
        return []
    for year in years:
        year_path = os.path.join(base, year)
        try:
            months = [name for name in os.listdir(year_path) if DAY_DIR_RE.match(name)]
        except Exception:
            continue
        for month in months:
            month_path = os.path.join(year_path, month)
            try:
                days = [name for name in os.listdir(month_path) if DAY_DIR_RE.match(name)]
            except Exception:
                continue
            for day in days:
                found.append(((int(year), int(month), int(day)), os.path.join(month_path, day)))
    found.sort(key=lambda item: item[0], reverse=True)
    return [path for _, path in found[:4]]


# Newest first, and only files written since the process started (a rollout from an earlier
# run of the same folder is not this process's).
def codex_rollout_paths(started_at):
    candidates = []
    for directory in codex_day_dirs():
        try:
            names = os.listdir(directory)
        except Exception:
            continue
        for name in names:
            if not ROLLOUT_RE.match(name):
                continue
            path = os.path.join(directory, name)
            mtime = file_mtime_ms(path)
            if mtime is not None and started_at - 5000 <= mtime:
                candidates.append((mtime, path))
    candidates.sort(key=lambda item: item[0], reverse=True)
    return [path for _, path in candidates]


def codex_meta(path):
    for line in head_lines(path):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if isinstance(record, dict) and record.get("type") == "session_meta":
            payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
            return {
                "sessionId": text(payload.get("session_id")) or text(payload.get("id")),
                "cwd": text(payload.get("cwd")),
                "timestamp": iso_ms(record.get("timestamp")),
            }
    return None


def agent_prompt(value, codex=False):
    if not isinstance(value, str):
        return None
    if codex:
        match = CODEX_REQUEST_RE.search(value)
        if match:
            value = value[match.end():]
    value = collapse(value)
    return value[:400] if value else None


# Codex CLI builds without event_msg/user_message record the prompt only as a user
# response_item, beside injected context (AGENTS.md, <environment_context>) of the same shape.
def codex_item_prompt(payload):
    if payload.get("type") != "message" or payload.get("role") != "user":
        return None
    parts = payload.get("content") if isinstance(payload.get("content"), list) else []
    value = "\n".join(text(part.get("text")) or "" for part in parts if isinstance(part, dict)).strip()
    if not value or value.startswith(("<", "# AGENTS.md instructions")):
        return None
    return agent_prompt(value, True)


def native_summary():
    return {
        "customTitle": None, "agentName": None, "lastPrompt": None,
        "lastAnswer": None, "lastSentence": None, "currentAction": None,
        "lastToolName": None, "lastToolAt": None, "lastMeaningfulAt": None,
        "pr": None,
    }


def native_record(proc, agent, session_id, cwd, env, status,
                  started_at, status_at, last_meaningful, identity, summary):
    when = last_meaningful if last_meaningful is not None else started_at
    return {
        "t": "s",
        "pid": proc["pid"],
        "sessionId": session_id,
        "cwd": cwd,
        "name": None,
        "kind": None,
        "jobId": None,
        "parkedJobId": None,
        "status": status,
        "waitingFor": None,
        "startedAt": started_at,
        "updatedAt": when,
        "statusUpdatedAt": status_at if status_at is not None else when,
        "location": short_location(cwd, HOME),
        "identity": identity,
        **summary,
        "background": {"shells": 0, "agents": 0, "monitors": 0, "total": 0},
        "completed": [],
        "deadhd": None,
        "pages": [],
        "where": where_of(env),
        "agent": agent,
    }


def synthetic_session_id(agent, proc, started_at):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "%s:%d:%s" % (agent, proc["pid"], int(started_at / 1000))))


# A long turn can push its task_started out of the tail, so the last turn event is looked for
# further back, a block at a time, up to TURN_SCAN_BYTES.
TURN_SCAN_BYTES = 32 * 1024 * 1024


def last_turn_event(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            carry = b""
            scanned = 0
            while end > 0 and scanned < TURN_SCAN_BYTES:
                start = max(0, end - 1024 * 1024)
                f.seek(start)
                block = f.read(end - start) + carry
                lines = block.split(b"\n")
                carry = lines[0] if start > 0 else b""
                body = lines[1:] if start > 0 else lines
                for raw in reversed(body):
                    if b'"task_started"' not in raw and b'"task_complete"' not in raw:
                        continue
                    try:
                        record = json.loads(raw.decode("utf-8", "replace"))
                    except Exception:
                        continue
                    payload = record.get("payload") if isinstance(record, dict) else None
                    if record.get("type") == "event_msg" and isinstance(payload, dict) \
                            and payload.get("type") in ("task_started", "task_complete"):
                        return payload.get("type"), iso_ms(record.get("timestamp"))
                scanned += end - start
                end = start
    except Exception:
        return None, None
    return None, None


def codex_record(proc, cwd, env, meta_cache, taken=None):
    started_at = proc["startedAt"]
    path = None
    meta = None
    taken = taken if taken is not None else set()
    for candidate in codex_rollout_paths(started_at):
        if candidate in taken:
            continue
        if candidate in meta_cache:
            info = meta_cache[candidate]
        else:
            info = codex_meta(candidate)
            meta_cache[candidate] = info
        if info and info.get("cwd") and os.path.normpath(info["cwd"]) == os.path.normpath(cwd):
            path, meta = candidate, info
            taken.add(candidate)
            break
    summary = native_summary()
    if path is None:
        return native_record(proc, "codex", synthetic_session_id("codex", proc, started_at), cwd, env,
                             "idle", started_at, started_at, None, {}, summary)

    session_id = meta.get("sessionId") or synthetic_session_id("codex", proc, started_at)
    session_start = meta.get("timestamp") if isinstance(meta.get("timestamp"), int) else started_at
    open_turn = None
    saw_turn_event = False
    saw_user_event = False
    last_turn_at = None
    last_tool = None
    last_tool_at = None
    last_meaningful = None
    for line in tail_lines(path):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if not isinstance(record, dict):
            continue
        stamp = iso_ms(record.get("timestamp"))
        if stamp is not None:
            last_meaningful = stamp
        if record.get("type") == "event_msg":
            payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
            kind = payload.get("type")
            if kind in ("task_started", "task_complete"):
                saw_turn_event = True
            if kind == "task_started":
                open_turn = payload.get("turn_id") or "turn"
                last_turn_at = stamp if stamp is not None else ms_num(payload.get("started_at"))
                if last_turn_at is not None and last_turn_at < 100000000000:
                    last_turn_at = last_turn_at * 1000
            elif kind == "task_complete":
                turn = payload.get("turn_id") or "turn"
                if open_turn == turn:
                    open_turn = None
                last_turn_at = stamp if stamp is not None else last_turn_at
                answer = text(payload.get("last_agent_message"))
                error = payload.get("error")
                if answer:
                    summary["lastAnswer"] = collapse(answer)[:400]
                elif isinstance(error, dict) and text(error.get("message")):
                    summary["lastAnswer"] = ("Error: " + collapse(text(error.get("message"))))[:400]
                if summary["lastAnswer"]:
                    summary["lastSentence"] = last_sentence(summary["lastAnswer"])
            elif kind == "user_message":
                saw_user_event = True
                value = agent_prompt(payload.get("message"), True)
                if value:
                    summary["lastPrompt"] = value
        elif record.get("type") == "response_item":
            payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
            item_prompt = codex_item_prompt(payload)
            if item_prompt and not saw_user_event:
                summary["lastPrompt"] = item_prompt
            if payload.get("type") in CODEX_TOOL_TYPES:
                name = text(payload.get("name"))
                if name:
                    last_tool = name
                    last_tool_at = stamp
    if not saw_turn_event:
        kind, stamp = last_turn_event(path)
        if kind == "task_started":
            open_turn = "turn"
        if kind:
            last_turn_at = stamp
    status = "busy" if open_turn is not None else "idle"
    summary["currentAction"] = last_tool if status == "busy" else None
    summary["lastToolName"] = last_tool
    summary["lastToolAt"] = last_tool_at
    summary["lastMeaningfulAt"] = last_meaningful

    first = None
    first_item = None
    for line in head_lines(path):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if not isinstance(record, dict):
            continue
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        if record.get("type") == "response_item" and first_item is None:
            first_item = codex_item_prompt(payload)
        if record.get("type") == "event_msg" and payload.get("type") == "user_message":
            first = agent_prompt(payload.get("message"), True)
            if first:
                break
    first = first or first_item
    identity = {"firstPrompt": first} if first else {}
    return native_record(proc, "codex", session_id, cwd, env, status, session_start,
                         last_turn_at, last_meaningful, identity, summary)


def gemini_slots(cwd):
    names = []
    try:
        names.append(hashlib.sha256(os.path.abspath(cwd).encode("utf-8")).hexdigest())
    except Exception:
        pass
    projects = jload(os.path.join(HOME, ".gemini", "projects.json"))
    if isinstance(projects, dict):
        for key, value in projects.items():
            if not isinstance(key, str) or not isinstance(value, str):
                continue
            if os.path.normpath(key) == os.path.normpath(cwd) and value.strip():
                names.append(value.strip())
    slots = []
    for name in names:
        if "/" in name or name in (".", ".."):
            continue
        path = os.path.join(HOME, ".gemini", "tmp", name)
        if path not in slots:
            slots.append(path)
    return slots


def gemini_chat_path(cwd, started_at):
    candidates = []
    for slot in gemini_slots(cwd):
        chats = os.path.join(slot, "chats")
        try:
            names = os.listdir(chats)
        except Exception:
            continue
        for name in names:
            if not (name.endswith(".jsonl") or (name.startswith("session-") and name.endswith(".json"))):
                continue
            path = os.path.join(chats, name)
            mtime = file_mtime_ms(path)
            if mtime is not None and started_at - 5000 <= mtime:
                candidates.append((mtime, path))
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1] if candidates else None


def gemini_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, dict) and isinstance(content.get("text"), str):
        return content["text"]
    if isinstance(content, list):
        parts = [block["text"] for block in content
                 if isinstance(block, dict) and isinstance(block.get("text"), str)]
        return "\n".join(parts) if parts else None
    return None


def stamp_ms(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value) if value > 0 else None
    return iso_ms(value)


def gemini_messages(lines, state):
    for line in lines:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except Exception:
            continue
        if not isinstance(record, dict):
            continue
        kind = record.get("type")
        if kind == "session_metadata":
            state["sessionId"] = text(record.get("sessionId")) or state["sessionId"]
            state["startedAt"] = stamp_ms(record.get("startTime")) or state["startedAt"]
        elif kind in ("user", "gemini"):
            content = gemini_text(record.get("content"))
            stamp = stamp_ms(record.get("timestamp"))
            if stamp is not None:
                state["lastAt"] = stamp
            if content and content.strip():
                state["messages"].append((kind, content, stamp))


def gemini_record(proc, cwd, env):
    started_at = proc["startedAt"]
    path = gemini_chat_path(cwd, started_at)
    summary = native_summary()
    if path is None:
        return native_record(proc, "gemini", synthetic_session_id("gemini", proc, started_at), cwd, env,
                             "idle", started_at, started_at, None, {}, summary)

    state = {"sessionId": None, "startedAt": None, "lastAt": None, "messages": []}
    if path.endswith(".jsonl"):
        gemini_messages(tail_lines(path), state)
        head = {"messages": [], "sessionId": state["sessionId"], "startedAt": state["startedAt"], "lastAt": None}
        gemini_messages(head_lines(path), head)
        first = next((content for kind, content, _ in head["messages"] if kind == "user"), None)
        state["sessionId"] = state["sessionId"] or head["sessionId"]
        state["startedAt"] = state["startedAt"] or head["startedAt"]
    else:
        data = jload(path)
        records = []
        if isinstance(data, dict):
            state["sessionId"] = text(data.get("sessionId"))
            state["startedAt"] = stamp_ms(data.get("startTime"))
            messages = data.get("messages")
            if isinstance(messages, list):
                records = [record for record in messages if isinstance(record, dict)]
        gemini_messages([json.dumps(record) for record in records], state)
        first = next((content for kind, content, _ in state["messages"] if kind == "user"), None)

    messages = state["messages"]
    last_kind = next((kind for kind, _, _ in reversed(messages) if kind in ("user", "gemini")), None)
    status = "busy" if last_kind == "user" else "idle"
    session_id = state["sessionId"] or synthetic_session_id("gemini", proc, started_at)
    session_start = state["startedAt"] if state["startedAt"] is not None else started_at
    last_meaningful = state["lastAt"] if state["lastAt"] is not None else file_mtime_ms(path)
    for kind, content, _ in messages:
        if kind == "user":
            summary["lastPrompt"] = agent_prompt(content)
        else:
            summary["lastAnswer"] = agent_prompt(content)
            summary["lastSentence"] = last_sentence(content)
    summary["lastMeaningfulAt"] = last_meaningful
    identity = {"firstPrompt": agent_prompt(first)} if first else {}
    return native_record(proc, "gemini", session_id, cwd, env, status, session_start,
                         last_meaningful, last_meaningful, identity, summary)


def native_agent_sessions():
    processes = agent_processes()
    if not processes:
        return []
    pids = [proc["pid"] for proc in processes]
    environments = process_environments(pids)
    cwds = process_cwds(pids)
    meta_cache = {}
    taken = set()
    sessions = []
    # Newest process first, so two codex in one folder take the newest rollouts in turn.
    for proc in sorted(processes, key=lambda item: -(item.get("startedAt") or 0)):
        cwd = cwds.get(proc["pid"])
        if not cwd:
            continue
        env = environments.get(proc["pid"]) or {}
        try:
            if proc["kind"] == "codex":
                sessions.append(codex_record(proc, cwd, env, meta_cache, taken))
            else:
                sessions.append(gemini_record(proc, cwd, env))
        except Exception:
            continue
    return sessions


def main():
    primary = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(HOME, ".claude")
    primary = os.path.expanduser(primary)
    roots = [primary]
    accounts = os.path.join(HOME, ".claude-accounts")
    if os.path.isdir(accounts):
        try:
            for name in sorted(os.listdir(accounts)):
                directory = os.path.join(accounts, name)
                if os.path.isdir(os.path.join(directory, "sessions")):
                    roots.append(directory)
        except Exception:
            pass
    deduped = []
    seen_roots = set()
    for root in roots:
        normalized = os.path.normpath(root)
        if normalized and normalized not in seen_roots:
            seen_roots.add(normalized)
            deduped.append(normalized)
    roots = deduped

    primary_error = None
    readable_roots = 0
    records = []
    seen_ids = set()
    for index, root in enumerate(roots):
        sessions_dir = os.path.join(root, "sessions")
        try:
            names = sorted(os.listdir(sessions_dir))
        except Exception as exc:
            if index == 0:
                primary_error = "Couldn't read %s" % sessions_dir
            continue
        readable_roots += 1
        for name in names:
            if not name.endswith(".json"):
                continue
            stem = name[:-5]
            if not stem or not DIGITS_RE.match(stem):
                continue
            record = jload(os.path.join(sessions_dir, name))
            if not isinstance(record, dict):
                continue
            session_id = text(record.get("sessionId"))
            pid = int_num(record.get("pid"))
            if not session_id or not SESSION_ID_RE.match(session_id) or not pid or pid <= 0:
                continue
            if record.get("entrypoint") != "cli":
                continue
            # Claude Code pre-starts an idle "spare" bg worker beside each fork; it is no session yet.
            if record.get("spare") is True and record.get("status") == "idle":
                continue
            if not process_alive(pid):
                continue
            if session_id in seen_ids:
                continue
            seen_ids.add(session_id)
            records.append((root, record, session_id, pid))

    read_error = primary_error if readable_roots == 0 else None
    environments = process_environments([pid for _, _, _, pid in records])
    attached = claude_attach_panes() if any(record.get("kind") == "bg" for _, record, _, _ in records) else []
    pages, unreadable_pages = page_alerts()

    accounts_prefix = os.path.normpath(accounts) + os.sep
    output_sessions = []
    for root, record, session_id, pid in records:
        normalized_root = os.path.normpath(root)
        account = os.path.basename(normalized_root) if normalized_root.startswith(accounts_prefix) else "default"
        cwd = record.get("cwd") if isinstance(record.get("cwd"), str) else None
        started_at = ms_num(record.get("startedAt"))
        transcript = transcript_path(root, cwd, session_id)
        summary = summarize_transcript(transcript) if transcript else {
            "customTitle": None, "agentName": None, "lastPrompt": None,
            "lastAnswer": None, "lastSentence": None, "currentAction": None,
            "lastToolName": None, "lastToolAt": None, "lastMeaningfulAt": None, "pr": None,
        }
        background, completed = ledger_for(transcript, session_id, started_at) if transcript else (
            {"shells": 0, "agents": 0, "monitors": 0, "total": 0}, [])
        env = environments.get(pid) or {}
        where = claude_bg_where(where_of(env), record, session_id, attached)
        page_list = []
        for page in pages:
            if page["sessionId"]:
                if page["sessionId"] == session_id:
                    page_list.append(page)
            elif where.get("handle") and page["terminalHandle"] == where["handle"]:
                page_list.append(page)
        output_sessions.append({
            "t": "s",
            "pid": pid,
            "sessionId": session_id,
            "cwd": cwd,
            "name": text(record.get("name")),
            "kind": text(record.get("kind")),
            "jobId": text(record.get("jobId")),
            "parkedJobId": text(record.get("parkedJobId")),
            "status": text(record.get("status")),
            "waitingFor": text(record.get("waitingFor")),
            "startedAt": started_at,
            "updatedAt": ms_num(record.get("updatedAt")),
            "statusUpdatedAt": ms_num(record.get("statusUpdatedAt")),
            "location": short_location(cwd, HOME),
            "identity": session_identity(transcript, session_id, cwd),
            **summary,
            "background": background,
            "completed": completed,
            "deadhd": deadhd_state(session_id),
            "pages": page_list,
            "where": where,
            "agent": "claude",
            "account": account,
        })

    try:
        native = native_agent_sessions()
    except Exception:
        native = []
    emitted = set(session["sessionId"] for session in output_sessions)
    for session in native:
        if session["sessionId"] in emitted:
            continue
        emitted.add(session["sessionId"])
        output_sessions.append(session)

    for session in output_sessions:
        session.setdefault("repo", repo_of(session.get("cwd")))
        emit(session)
    emit({
        "t": "meta",
        "roots": len(roots),
        "updatedAt": NOW_MS,
        "error": read_error,
        "pages": pages,
        "unreadablePages": unreadable_pages,
        "objectives": rd_objectives(),
    })


try:
    main()
except Exception as exc:
    emit({
        "t": "meta",
        "roots": 0,
        "updatedAt": NOW_MS,
        "error": "Scan failed: %s" % exc,
        "pages": [],
        "unreadablePages": [],
    })
PY
