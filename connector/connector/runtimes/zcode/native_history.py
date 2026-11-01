"""Read ZCode's local conversation database without importing or running ZCode.

The ZCode engine keeps conversations in a SQLite database under the user's
``.zcode`` directory. This module performs read-only scans of that database and
projects rows into the timeline item shape used by ACP native history (mirrors
``runtimes/acp/profiles/pi/history.py``). The schema is engine-internal: every
access validates the expected columns first and fails soft on unknown shapes.
"""

from __future__ import annotations

import json
import sqlite3
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

from connector.runtimes.acp.domain.definitions import AcpError, fingerprint

REQUIRED_COLUMNS = {
    "session": ("id", "title", "directory", "time_created", "time_updated", "time_deleted", "task_type"),
    "message": ("id", "session_id", "sequence", "data"),
    "part": ("id", "message_id", "sequence", "data"),
}

# ZCode injects agent reminders as user-role rows; only real user input is
# importable. Rows without a semantics block are imported leniently so a
# future engine change cannot silently hide user history.
HIDDEN_TEXT_VISIBILITY = {"model-only", "agent-only"}


@dataclass(frozen=True)
class NativeZcodeHistory:
    path: Path
    header: dict
    entries: tuple[dict, ...]
    revision: str
    complete: bool

    @property
    def native_id(self):
        return self.header["id"]

    @property
    def cwd(self):
        value = self.header.get("directory", "")
        return value if isinstance(value, str) else ""

    @property
    def title(self):
        value = self.header.get("title") or ""
        return str(value)[:4096] or "ZCode 历史会话"

    def source(self):
        return {
            "sessionId": self.native_id,
            "path": str(self.path),
            "cwd": self.cwd,
            "title": self.title,
            "revision": self.revision,
            "complete": self.complete,
            "updatedAt": self.header.get("time_updated"),
        }

    def require_resumable(self):
        if not self.complete:
            raise AcpError(
                "zcode_history_incomplete", "原生历史存在损坏记录，请重新校准。"
            )
        if not Path(self.cwd).is_absolute() or not Path(self.cwd).is_dir():
            raise AcpError("zcode_workspace_missing", "原会话的项目工作目录不存在或无效。")


def _connect(db_path: Path) -> sqlite3.Connection:
    # Percent-encode the path: production locations contain spaces and CJK.
    posix = db_path.resolve().as_posix()
    if not posix.startswith("/"):
        posix = "/" + posix  # Windows drive letter form for URI authorities.
    uri = "file:" + urllib.parse.quote(posix) + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=1.0)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error as error:
        raise AcpError("zcode_history_unreadable", "ZCode 会话数据库当前无法读取。") from error


def _validate_schema(conn: sqlite3.Connection):
    for table, columns in REQUIRED_COLUMNS.items():
        try:
            rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
        except sqlite3.Error as error:
            raise AcpError(
                "zcode_history_invalid", "ZCode 会话数据库结构无法识别，已停止导入。"
            ) from error
        names = {row[1] for row in rows}
        missing = [column for column in columns if column not in names]
        if missing:
            raise AcpError(
                "zcode_history_invalid",
                f"ZCode 会话数据库缺少 {table}.{'/'.join(missing)}，已停止导入。",
            )


def _loads(raw) -> dict:
    try:
        value = json.loads(raw or "{}")
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


def discover_sessions(db_path: Path) -> dict[str, dict]:
    """Bounded discovery: one row per conversation plus a message count."""
    db_path = Path(db_path)
    if not db_path.exists():
        return {}
    conn = _connect(db_path)
    try:
        _validate_schema(conn)
        rows = conn.execute(
            "SELECT s.id, s.title, s.directory, s.time_created, s.time_updated,"
            " (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count"
            " FROM session s"
            " WHERE s.time_deleted IS NULL AND s.task_type = 'interactive'"
        ).fetchall()
    except AcpError:
        raise
    except sqlite3.Error as error:
        raise AcpError("zcode_history_unreadable", "ZCode 会话数据库当前无法读取。") from error
    finally:
        conn.close()
    inventory: dict[str, dict] = {}
    for row in rows:
        native_id = row["id"]
        if not native_id:
            continue
        entry = {
            "id": native_id,
            "title": str(row["title"] or "")[:4096],
            "cwd": row["directory"] or "",
            "timeCreated": row["time_created"],
            "timeUpdated": row["time_updated"],
            "messageCount": row["message_count"],
        }
        entry["signature"] = f"{entry['timeUpdated']}:{entry['messageCount']}"
        inventory[entry["id"]] = entry
    return inventory


def read_history(db_path: Path, native_id: str) -> NativeZcodeHistory:
    db_path = Path(db_path)
    conn = _connect(db_path)
    try:
        _validate_schema(conn)
        header = conn.execute(
            "SELECT id, title, directory, time_created, time_updated, task_type"
            " FROM session WHERE id = ? AND time_deleted IS NULL",
            (native_id,),
        ).fetchone()
        if header is None:
            raise AcpError("zcode_source_missing", "原生会话已从 ZCode 数据库中消失。")
        rows = conn.execute(
            "SELECT m.id AS message_id, m.data AS message_data, m.time_created AS message_time,"
            " p.id AS part_id, p.sequence AS part_sequence, p.data AS part_data, p.time_created AS part_time"
            " FROM message m LEFT JOIN part p ON p.message_id = m.id"
            " WHERE m.session_id = ?"
            " ORDER BY COALESCE(m.sequence, 0), m.time_created, m.id, COALESCE(p.sequence, 0), p.id",
            (native_id,),
        ).fetchall()
    except AcpError:
        raise
    except sqlite3.Error as error:
        raise AcpError("zcode_history_unreadable", "ZCode 会话数据库当前无法读取。") from error
    finally:
        conn.close()
    entries: list[dict] = []
    complete = True
    for row in rows:
        message_id = row["message_id"]
        if not entries or entries[-1]["id"] != message_id:
            message = _loads(row["message_data"])
            if row["message_data"] and not message:
                complete = False
            entries.append(
                {
                    "id": message_id,
                    "time": row["message_time"],
                    "data": message,
                    "parts": [],
                }
            )
        part_id = row["part_id"]
        if not part_id:
            continue
        part_data = _loads(row["part_data"])
        if row["part_data"] and not part_data:
            complete = False
        entries[-1]["parts"].append(
            {"id": part_id, "time": row["part_time"], "data": part_data}
        )
    header = dict(header)
    revision = f"{header.get('time_updated')}:{len(entries)}"
    return NativeZcodeHistory(db_path, header, tuple(entries), revision, complete)


def _part_hidden(data: dict) -> bool:
    if data.get("synthetic"):
        return True
    metadata = data.get("metadata")
    visibility = metadata.get("visibility") if isinstance(metadata, dict) else None
    return visibility in HIDDEN_TEXT_VISIBILITY


def _tool_content(data: dict) -> dict:
    state = data.get("state") if isinstance(data.get("state"), dict) else {}
    tool = str(data.get("tool") or "tool")
    raw_input = state.get("input") if isinstance(state.get("input"), dict) else {}
    content = {
        "kind": "command" if tool == "Bash" else "tool_call",
        "title": str(state.get("title") or tool),
        "toolCallId": data.get("callID"),
        "rawInput": raw_input,
    }
    if tool == "Bash":
        content["command"] = str(raw_input.get("command") or "")
    return content


def _tool_status(data: dict) -> str:
    state = data.get("state") if isinstance(data.get("state"), dict) else {}
    return {"completed": "done", "error": "failed"}.get(str(state.get("status")), "running")


def timeline(
    history: NativeZcodeHistory, session_id: str, runtime: str = "zcode"
) -> list[dict]:
    """Project message/part rows into AA timeline items (Pi history shape)."""
    result: list[dict] = []

    def add(entry, part, kind, role, content, status="done"):
        item = {
            "id": fingerprint(
                [session_id, "zcode", entry["id"], part["id"] if part else ""]
            ),
            "sessionId": session_id,
            "type": kind,
            "role": role,
            "status": status,
            "content": content,
            "source": {
                "runtime": runtime,
                "sessionId": history.native_id,
                "itemId": part["id"] if part else entry["id"],
                "itemType": (part or {}).get("data", {}).get("type"),
                "event": "zcode.native_part",
                "nativeSessionId": history.native_id,
                "nativeMessageId": entry["id"],
                "nativePartId": part["id"] if part else None,
                "timestamp": part["time"] if part else entry["time"],
                "origin": "zcode_native_history",
            },
            "orderSeq": len(result) + 1,
            "revision": 1,
        }
        item["contentHash"] = "sha256:" + fingerprint(
            {key: item[key] for key in ("type", "role", "status", "content", "source")}
        )
        result.append(item)
        return item

    for entry in history.entries:
        message = entry["data"]
        role = message.get("role")
        parts = entry["parts"]
        if role == "user":
            semantics = message.get("semantics")
            if isinstance(semantics, dict) and semantics.get("origin") != "real_user":
                continue
            for part in parts:
                data = part["data"]
                if data.get("type") != "text" or _part_hidden(data):
                    continue
                text = str(data.get("text") or "")
                if not text.strip():
                    continue
                add(
                    entry,
                    part,
                    "message",
                    "user",
                    {"kind": "markdown", "format": "markdown", "text": text},
                )
        elif role == "assistant":
            completed = bool((message.get("time") or {}).get("completed"))
            status = "done" if completed else "running"
            for part in parts:
                data = part["data"]
                part_type = data.get("type")
                if part_type == "text":
                    if _part_hidden(data):
                        continue
                    text = str(data.get("text") or "")
                    if not text.strip():
                        continue
                    add(
                        entry,
                        part,
                        "message",
                        "assistant",
                        {"kind": "markdown", "format": "markdown", "text": text},
                        status,
                    )
                elif part_type == "reasoning":
                    text = str(data.get("text") or "")
                    if not text.strip():
                        continue
                    add(
                        entry,
                        part,
                        "message",
                        "assistant",
                        {
                            "kind": "markdown",
                            "format": "markdown",
                            "isThinking": True,
                            "text": text,
                        },
                        status,
                    )
                elif part_type == "tool":
                    add(entry, part, "tool", "tool", _tool_content(data), _tool_status(data))
                elif part_type == "file" and str(data.get("mime", "")).startswith("image/"):
                    add(
                        entry,
                        part,
                        "message",
                        "assistant",
                        {"kind": "markdown", "format": "markdown", "text": "[图片]"},
                        status,
                    )
    return result
