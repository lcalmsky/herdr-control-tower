#!/bin/sh
# Read-only session scan for the Pulse mod. Prints one JSON object per line:
# {t:"s", ...} for each live Claude Code CLI session, then one {t:"meta", ...}.
# Reads session records, transcripts, deadhd state, page alerts and the
# session processes' environment. Writes nothing but its ledger cache under
# ${TMPDIR:-/tmp}/herdr-pulse. Secrets (*.key) are never opened.

if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' '{"t":"meta","roots":0,"updatedAt":0,"error":"python3 not found","pages":[],"unreadablePages":[]}'
  exit 0
fi

exec python3 - <<'PY'
import json
import os
import re
import subprocess
import sys
import time
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
            ["ps", "eww", "-o", "pid=", "-o", "command=", "-p", ",".join(str(p) for p in pids)],
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
            if not process_alive(pid):
                continue
            if session_id in seen_ids:
                continue
            seen_ids.add(session_id)
            records.append((root, record, session_id, pid))

    read_error = primary_error if readable_roots == 0 else None
    environments = process_environments([pid for _, _, _, pid in records])
    pages, unreadable_pages = page_alerts()

    output_sessions = []
    for root, record, session_id, pid in records:
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
        where = where_of(env)
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
            "status": text(record.get("status")),
            "waitingFor": text(record.get("waitingFor")),
            "startedAt": started_at,
            "updatedAt": ms_num(record.get("updatedAt")),
            "statusUpdatedAt": ms_num(record.get("statusUpdatedAt")),
            "location": short_location(cwd, HOME),
            **summary,
            "background": background,
            "completed": completed,
            "deadhd": deadhd_state(session_id),
            "pages": page_list,
            "where": where,
        })

    for session in output_sessions:
        emit(session)
    emit({
        "t": "meta",
        "roots": len(roots),
        "updatedAt": NOW_MS,
        "error": read_error,
        "pages": pages,
        "unreadablePages": unreadable_pages,
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
