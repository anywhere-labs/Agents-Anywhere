"""Read Antigravity's local conversation store without importing Antigravity code.

The Antigravity desktop keeps one SQLite database per conversation under
``~/.gemini/antigravity/conversations/<uuid>.db`` plus an indexed
``conversation_summaries.db`` with titles, workspaces and timestamps. Message
content lives in protobuf ``step_payload`` blobs without a published schema;
this module walks the protobuf wire format and extracts the human-readable
text fields (user prompts, assistant markdown, tool calls) that survive the
walk. Mirrors ``runtimes.zcode.native_history`` in shape.
"""

from __future__ import annotations

import json
import re
import sqlite3
import urllib.parse
from dataclasses import dataclass
from pathlib import Path

from connector.runtimes.acp.domain.definitions import AcpError, fingerprint

REQUIRED_COLUMNS = {
    "conversation_summaries": (
        "conversation_id",
        "title",
        "preview",
        "step_count",
        "last_modified_time",
        "workspace_uris",
        "parent_conversation_id",
        "nesting_depth",
        "killed",
    ),
}

# steps.step_type 的实测语义（2026-11 桌面版脑库样本）。
STEP_TYPE_USER = 14
STEP_TYPE_ASSISTANT = 15
STEP_TYPE_ERROR = 17
STEP_TYPE_TOOL = 132

_UUID_RE = re.compile(r"^[0-9a-fA-F-]{16,}$")
_CALL_ID_RE = re.compile(r"^call_\d+$")
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,}$")


@dataclass(frozen=True)
class NativeAntigravityHistory:
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
        value = self.header.get("cwd", "")
        return value if isinstance(value, str) else ""

    @property
    def title(self):
        value = self.header.get("title") or ""
        return str(value)[:4096] or "Antigravity 历史会话"

    def source(self):
        return {
            "sessionId": self.native_id,
            "path": str(self.path),
            "cwd": self.cwd,
            "title": self.title,
            "revision": self.revision,
            "complete": self.complete,
            "updatedAt": self.header.get("last_modified_time"),
        }

    def require_resumable(self):
        # 转录解析是 best-effort 启发式（protobuf 无公开 schema）：不完整时
        # 时间线可能缺条目，但继续任务以引擎会话为准，不应因此阻断。
        if not Path(self.cwd).is_absolute() or not Path(self.cwd).is_dir():
            raise AcpError(
                "antigravity_workspace_missing", "原会话的项目工作目录不存在或无效。"
            )


def _connect(db_path: Path) -> sqlite3.Connection:
    posix = db_path.resolve().as_posix()
    if not posix.startswith("/"):
        posix = "/" + posix
    uri = "file:" + urllib.parse.quote(posix) + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=1.0)
        conn.row_factory = sqlite3.Row
        return conn
    except sqlite3.Error as error:
        raise AcpError(
            "antigravity_history_unreadable", "Antigravity 会话数据库当前无法读取。"
        ) from error


def _validate_summaries_schema(conn: sqlite3.Connection):
    for table, columns in REQUIRED_COLUMNS.items():
        try:
            rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
        except sqlite3.Error as error:
            raise AcpError(
                "antigravity_history_invalid",
                "Antigravity 会话数据库结构无法识别，已停止导入。",
            ) from error
        names = {row[1] for row in rows}
        missing = [column for column in columns if column not in names]
        if missing:
            raise AcpError(
                "antigravity_history_invalid",
                f"Antigravity 会话数据库缺少 {table}.{'/'.join(missing)}，已停止导入。",
            )


def _first_workspace_path(raw: str) -> str:
    try:
        values = json.loads(raw or "[]")
    except (ValueError, TypeError):
        return ""
    for value in values if isinstance(values, list) else []:
        if not isinstance(value, str) or not value.startswith("file://"):
            continue
        parsed = urllib.parse.urlparse(value)
        path = urllib.parse.unquote(parsed.path)
        return path
    return ""


def discover_sessions(db_path: Path) -> dict[str, dict]:
    """One row per conversation, from the summaries index."""
    db_path = Path(db_path)
    if not db_path.exists():
        return {}
    conn = _connect(db_path)
    try:
        _validate_summaries_schema(conn)
        rows = conn.execute(
            "SELECT conversation_id, title, preview, step_count, last_modified_time,"
            " workspace_uris, parent_conversation_id, nesting_depth, killed"
            " FROM conversation_summaries"
        ).fetchall()
    except AcpError:
        raise
    except sqlite3.Error as error:
        raise AcpError(
            "antigravity_history_unreadable", "Antigravity 会话数据库当前无法读取。"
        ) from error
    finally:
        conn.close()
    inventory: dict[str, dict] = {}
    for row in rows:
        native_id = row["conversation_id"]
        if not native_id:
            continue
        # 子代理与被终止的运行不进主列表。
        if row["parent_conversation_id"] or (row["nesting_depth"] or 0) > 0 or row["killed"]:
            continue
        entry = {
            "id": native_id,
            "title": str(row["title"] or "")[:4096],
            "cwd": _first_workspace_path(row["workspace_uris"] or ""),
            "timeUpdated": row["last_modified_time"],
            "stepCount": row["step_count"],
            "preview": str(row["preview"] or "")[:2000],
        }
        entry["signature"] = f"{entry['timeUpdated']}:{entry['stepCount']}"
        inventory[native_id] = entry
    return inventory


def _walk_proto_strings(buf: bytes, depth: int = 0, out: list | None = None) -> list:
    """Extract printable length-delimited fields from a protobuf blob."""
    if out is None:
        out = []
    if depth > 5:
        return out
    i, n = 0, len(buf)
    while i < n:
        key = 0
        shift = 0
        while i < n:
            byte = buf[i]
            i += 1
            key |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                break
        else:
            break
        wire_type = key & 7
        if wire_type == 0:
            while i < n and buf[i] & 0x80:
                i += 1
            i += 1
        elif wire_type == 1:
            i += 8
        elif wire_type == 5:
            i += 4
        elif wire_type == 2:
            length = 0
            shift = 0
            while i < n:
                byte = buf[i]
                i += 1
                length |= (byte & 0x7F) << shift
                shift += 7
                if not byte & 0x80:
                    break
            data = buf[i : i + length]
            i += length
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                text = None
            if text is not None and text and all(
                ch.isprintable() or ch in "\n\t\r" for ch in text
            ):
                out.append((depth, key >> 3, text))
                continue
            _walk_proto_strings(data, depth + 1, out)
        else:
            break
    return out


def _entry_from_step(idx: int, step_type: int, payload: bytes | None) -> dict | None:
    if not payload:
        return None
    fields = _walk_proto_strings(bytes(payload))
    if step_type == STEP_TYPE_USER:
        # f2 承载用户输入（偶见 @[conversation:...] 引用前缀，原样保留）。
        text = next((s for d, f, s in fields if f == 2 and len(s.strip()) > 0), "")
        if not text.strip():
            return None
        return {"id": f"step-{idx}", "type": "message", "role": "user", "text": text}
    if step_type == STEP_TYPE_ASSISTANT:
        # 正文在嵌套消息的长文本字段；工具调用同藏于嵌套（call_*/name/json）。
        prose = [
            s
            for d, f, s in fields
            if d >= 1
            and len(s) > 20
            and not _UUID_RE.match(s)
            and not _TOKEN_RE.match(s)
            and not s.startswith(("{" , "bot-", "call_", "sessionID", "file://"))
            and ("一" <= s[0] <= "鿿" or s[0].isalpha() or s[0] == "#")
        ]
        entries = []
        if prose:
            entries.append(
                {
                    "id": f"step-{idx}",
                    "type": "message",
                    "role": "assistant",
                    "text": "\n".join(dict.fromkeys(prose)),
                }
            )
        tool_names = [s for d, f, s in fields if f == 2 and not s.startswith("{") and "_" in s]
        for name in tool_names:
            if not name or len(name) > 64:
                continue
            args = next((s for d, f, s in fields if s.startswith("{") and s.endswith("}")), "")
            entries.append(
                {
                    "id": f"step-{idx}-{name}",
                    "type": "tool",
                    "role": "tool",
                    "tool": name,
                    "args": args,
                    "status": "done",
                }
            )
        return entries or None
    if step_type == STEP_TYPE_TOOL:
        call_id = next((s for s in (f[2] for f in fields) if _CALL_ID_RE.match(s)), "")
        tool = next(
            (
                s
                for d, f, s in fields
                if f == 2 and not _CALL_ID_RE.match(s) and not s.startswith("{")
            ),
            "tool",
        )
        args = next((s for d, f, s in fields if s.startswith("{") and s.endswith("}")), "")
        return {
            "id": f"step-{idx}-{call_id or 'tool'}",
            "type": "tool",
            "role": "tool",
            "tool": tool,
            "args": args,
            "status": "done",
        }
    if step_type == STEP_TYPE_ERROR:
        text = next((s for d, f, s in fields if len(s) > 12 and " " in s), "")
        if not text.strip():
            return None
        return {
            "id": f"step-{idx}",
            "type": "message",
            "role": "assistant",
            "text": text,
            "status": "failed",
        }
    return None


def read_history(db_path: Path, conversations_dir: Path, native_id: str) -> NativeAntigravityHistory:
    """Load one conversation's transcript from its per-conversation database."""
    summaries = Path(db_path)
    conn = _connect(summaries)
    try:
        _validate_summaries_schema(conn)
        header = conn.execute(
            "SELECT conversation_id, title, preview, step_count, last_modified_time,"
            " workspace_uris FROM conversation_summaries WHERE conversation_id = ?",
            (native_id,),
        ).fetchone()
    except AcpError:
        raise
    except sqlite3.Error as error:
        raise AcpError(
            "antigravity_history_unreadable", "Antigravity 会话数据库当前无法读取。"
        ) from error
    finally:
        conn.close()
    if header is None:
        raise AcpError(
            "antigravity_source_missing", "原生会话已从 Antigravity 数据库中消失。"
        )

    conversation_db = Path(conversations_dir) / f"{native_id}.db"
    entries: list[dict] = []
    complete = True
    if conversation_db.exists():
        convo = _connect(conversation_db)
        try:
            rows = convo.execute(
                "SELECT idx, step_type, step_payload FROM steps ORDER BY idx"
            ).fetchall()
            for row in rows:
                try:
                    mapped = _entry_from_step(row["idx"], row["step_type"], row["step_payload"])
                except Exception:  # noqa: BLE001 -- one bad step must not sink the import
                    complete = False
                    continue
                if mapped is None:
                    continue
                if isinstance(mapped, list):
                    entries.extend(mapped)
                else:
                    entries.append(mapped)
        except sqlite3.Error as error:
            raise AcpError(
                "antigravity_history_unreadable", "Antigravity 会话数据库当前无法读取。"
            ) from error
        finally:
            convo.close()
    else:
        complete = False

    header_dict = dict(header)
    header_dict["id"] = header_dict.pop("conversation_id")
    header_dict["cwd"] = _first_workspace_path(header_dict.get("workspace_uris") or "")
    revision = f"{header_dict.get('last_modified_time')}:{header_dict.get('step_count')}"
    return NativeAntigravityHistory(
        summaries, header_dict, tuple(entries), revision, complete
    )


def timeline(
    history: NativeAntigravityHistory, session_id: str, runtime: str = "antigravity"
) -> list[dict]:
    """Project transcript entries into AA timeline items (zcode history shape)."""
    result: list[dict] = []

    def add(entry_id: str, kind: str, role: str, content: dict, status: str = "done"):
        item = {
            "id": fingerprint([session_id, "antigravity", entry_id]),
            "sessionId": session_id,
            "type": kind,
            "role": role,
            "status": status,
            "content": content,
            "source": {
                "runtime": runtime,
                "sessionId": history.native_id,
                "itemId": entry_id,
                "itemType": kind,
                "event": "antigravity.native_step",
                "nativeSessionId": history.native_id,
                "nativeEntryId": entry_id,
                "timestamp": None,
                "origin": "antigravity_native_history",
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
        if entry["type"] == "message":
            text = str(entry.get("text") or "")
            if not text.strip():
                continue
            add(
                entry["id"],
                "message",
                entry["role"],
                {"kind": "markdown", "format": "markdown", "text": text},
                entry.get("status", "done"),
            )
        elif entry["type"] == "tool":
            tool = str(entry.get("tool") or "tool")
            args = entry.get("args") or ""
            try:
                raw_input = json.loads(args) if args else {}
                if not isinstance(raw_input, dict):
                    raw_input = {}
            except (ValueError, TypeError):
                raw_input = {}
            content = {
                "kind": "command" if tool == "run_command" else "tool_call",
                "title": tool,
                "toolCallId": entry["id"],
                "rawInput": raw_input,
            }
            if tool == "run_command":
                content["command"] = str(raw_input.get("CommandLine") or "")
            add(entry["id"], "tool", "tool", content, entry.get("status", "done"))
    return result
