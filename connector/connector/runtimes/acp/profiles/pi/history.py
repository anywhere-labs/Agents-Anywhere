"""Read Pi JSONL without importing or running Pi, extensions, or configuration code."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path

from ...domain.definitions import AcpError, fingerprint

MAX_HISTORY_BYTES = 128 * 1024 * 1024


@dataclass(frozen=True)
class NativeHistory:
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
        for entry in reversed(self.entries):
            if entry.get("type") == "session_info" and entry.get("name"):
                return str(entry["name"])[:4096]
        for entry in self.entries:
            message = entry.get("message", {})
            if (
                isinstance(message, dict)
                and message.get("role") == "user"
                and (text := text_content(message.get("aaDisplayText", message.get("content"))))
            ):
                return text[:160]
        return "Pi 历史会话"

    def source(self):
        return {
            "sessionId": self.native_id,
            "path": str(self.path),
            "cwd": self.cwd,
            "title": self.title,
            "revision": self.revision,
            "version": self.header.get("version"),
            "complete": self.complete,
            "updatedAt": next(
                (
                    entry.get("timestamp")
                    for entry in reversed(self.entries)
                    if entry.get("timestamp")
                ),
                self.header.get("timestamp"),
            ),
        }

    def require_resumable(self):
        if not self.complete:
            raise AcpError(
                "pi_history_incomplete", "原生历史正在写入或存在损坏记录，请重新校准。"
            )
        if self.header.get("version") != 3:
            raise AcpError(
                "pi_history_migration_required",
                "此历史需要格式迁移，当前仅开放浏览，未修改源文件。",
            )
        if not Path(self.cwd).is_absolute() or not Path(self.cwd).is_dir():
            raise AcpError("pi_workspace_missing", "原会话的项目工作目录不存在或无效。")


def text_content(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(
            str(block.get("text", ""))
            for block in value
            if isinstance(block, dict) and block.get("type") == "text"
        )
    return ""


def read_history(path: Path, roots: tuple[Path, ...]) -> NativeHistory:
    resolved = path.resolve(strict=True)
    if not any(resolved.is_relative_to(root.resolve()) for root in roots):
        raise AcpError("pi_history_outside_source", "历史位置已超出配置的来源目录。")
    with resolved.open("rb") as source:
        before = os.fstat(source.fileno())
        if before.st_size > MAX_HISTORY_BYTES:
            raise AcpError("pi_history_too_large", "历史文件超过单文件读取上限。")
        data = source.read(MAX_HISTORY_BYTES + 1)
        after = os.fstat(source.fileno())
    complete = (
        before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns
    )
    entries = []
    lines = data.splitlines(keepends=True)
    for index, raw in enumerate(lines):
        if not raw.strip():
            continue
        try:
            entry = json.loads(raw)
            if not isinstance(entry, dict):
                raise ValueError("not an entry")  # noqa: TRY004 -- invalid serialized history
            entries.append(entry)
        except (ValueError, UnicodeError):
            complete = False
            if index == len(lines) - 1:
                break
    if (
        not entries
        or entries[0].get("type") != "session"
        or not isinstance(entries[0].get("id"), str)
    ):
        raise AcpError("pi_history_invalid", "文件没有有效的 Pi 原生会话头。")
    ids = [entry["id"] for entry in entries[1:] if isinstance(entry.get("id"), str)]
    if len(ids) != len(set(ids)):
        complete = False
    return NativeHistory(
        resolved,
        entries[0],
        tuple(entries[1:]),
        "sha256:" + hashlib.sha256(data).hexdigest(),
        complete,
    )


def scan_histories(
    roots: tuple[Path, ...],
) -> tuple[dict[Path, NativeHistory], list[dict]]:
    histories, errors = {}, []
    for root in roots:
        if not root.exists():
            continue

        def on_error(error, source_root=root):
            errors.append({"root": str(source_root), "code": "pi_source_unreadable"})

        for current, directories, files in os.walk(
            root, followlinks=False, onerror=on_error
        ):
            directories[:] = sorted(
                directory for directory in directories if not directory.startswith(".")
            )
            for name in sorted(files):
                if not name.endswith(".jsonl"):
                    continue
                path = Path(current) / name
                try:
                    history = read_history(path, roots)
                    histories[history.path] = history
                except (OSError, RuntimeError) as error:
                    errors.append(
                        {
                            "path": str(path),
                            "code": getattr(error, "code", "pi_history_unreadable"),
                        }
                    )
    return histories, errors


def discover_history_files(
    roots: tuple[Path, ...],
) -> tuple[dict[Path, dict], list[dict]]:
    """Bounded header discovery; the runtime parses only changed files one at a time."""
    found, errors = {}, []
    for root in roots:
        if not root.exists():
            continue

        def on_error(error, source_root=root):
            errors.append({"root": str(source_root), "code": "pi_source_unreadable"})

        for directory, children, files in os.walk(
            root, followlinks=False, onerror=on_error
        ):
            children[:] = sorted(name for name in children if not name.startswith("."))
            for name in sorted(files):
                if not name.endswith(".jsonl"):
                    continue
                path = Path(directory) / name
                try:
                    path = path.resolve(strict=True)
                    if not any(
                        path.is_relative_to(source.resolve()) for source in roots
                    ):
                        raise ValueError("outside source")
                    with path.open("rb") as source:
                        header = json.loads(source.readline(128 * 1024))
                        stat = os.fstat(source.fileno())
                    if (
                        not isinstance(header, dict)
                        or header.get("type") != "session"
                        or not isinstance(header.get("id"), str)
                        or not header["id"]
                    ):
                        raise ValueError("invalid header")
                    found[path] = {
                        "id": header["id"],
                        "signature": [
                            stat.st_dev,
                            stat.st_ino,
                            stat.st_size,
                            stat.st_mtime_ns,
                        ],
                    }
                except (OSError, ValueError, RuntimeError):
                    errors.append({"path": str(path), "code": "pi_history_unreadable"})
    return found, errors


def timeline(
    history: NativeHistory, session_id: str, runtime: str = "pi"
) -> list[dict]:
    """Preserve the whole entry tree; expose branch and compaction facts explicitly."""
    result, tools = [], {}

    def add(entry, suffix, kind, role, content, status="done"):
        source = {
            "runtime": runtime,
            "sessionId": history.native_id,
            "itemId": entry.get("id"),
            "itemType": entry.get("type"),
            "event": "pi.native_entry",
            "derivedKey": str(suffix),
            "nativeSessionId": history.native_id,
            "nativeEntryId": entry.get("id"),
            "parentId": entry.get("parentId"),
            "timestamp": entry.get("timestamp"),
            "origin": "pi_native_history",
        }
        if content.get("clientMessageId"):
            source["clientMessageId"] = content["clientMessageId"]
        item = {
            "id": fingerprint(
                [
                    session_id,
                    "pi",
                    entry.get("id") or f"legacy:{entry_index}:{fingerprint(entry)}",
                    suffix,
                ]
            ),
            "sessionId": session_id,
            "type": kind,
            "role": role,
            "status": status,
            "content": content,
            "source": source,
            "orderSeq": len(result) + 1,
            "revision": 1,
        }
        item["contentHash"] = "sha256:" + fingerprint(
            {key: item[key] for key in ("type", "role", "status", "content", "source")}
        )
        result.append(item)
        return item

    for entry_index, entry in enumerate(history.entries):
        kind = entry.get("type")
        message = entry.get("message")
        if kind == "message" and isinstance(message, dict):
            role = message.get("role")
            blocks = message.get("content", [])
            if role in {"user", "assistant", "custom"}:
                if role == "user" and isinstance(message.get("aaDisplayText"), str):
                    # The SDK text contains execution resource paths. AA-origin
                    # messages retain their original presentation independently.
                    blocks = [{"type": "text", "text": message["aaDisplayText"]}]
                blocks = (
                    [{"type": "text", "text": blocks}]
                    if isinstance(blocks, str)
                    else blocks
                )
                if not isinstance(blocks, list):
                    continue
                for index, block in enumerate(blocks):
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") in {"text", "thinking", "image"}:
                        thinking = block["type"] == "thinking"
                        content = {
                            "kind": "markdown",
                            "format": "markdown",
                            "isThinking": thinking,
                            "text": block.get(
                                "thinking" if thinking else "text",
                                "[图片]" if block["type"] == "image" else "",
                            ),
                        }
                        if message.get("aaClientMessageId"):
                            content["clientMessageId"] = message["aaClientMessageId"]
                        if role == "user" and index == 0 and message.get("aaAttachments"):
                            content["attachments"] = message["aaAttachments"]
                        add(
                            entry,
                            index,
                            "message",
                            "user" if role == "user" else "assistant",
                            content,
                            "failed"
                            if message.get("stopReason") == "error"
                            else "cancelled"
                            if message.get("stopReason") == "aborted"
                            else "done",
                        )
                    elif block.get("type") == "toolCall":
                        args = block.get("arguments", {})
                        content = {
                            "kind": "command"
                            if block.get("name") == "bash"
                            else "tool_call",
                            "title": block.get("name", "tool"),
                            "toolCallId": block.get("id"),
                            "rawInput": args,
                            **(
                                {"command": args.get("command")}
                                if isinstance(args, dict)
                                and block.get("name") == "bash"
                                else {}
                            ),
                        }
                        tools[block.get("id")] = add(
                            entry, index, "tool", "tool", content, "pending"
                        )
            elif role == "toolResult":
                item = tools.get(message.get("toolCallId"))
                if item is None:
                    item = add(
                        entry,
                        "result",
                        "tool",
                        "tool",
                        {"kind": "tool_call", "title": message.get("toolName", "tool")},
                    )
                item["content"].update(
                    output=text_content(blocks),
                    rawOutput={"content": blocks, "details": message.get("details")},
                )
                item["status"] = "failed" if message.get("isError") else "done"
                item["contentHash"] = "sha256:" + fingerprint(
                    {
                        key: item[key]
                        for key in ("type", "role", "status", "content", "source")
                    }
                )
            elif role == "bashExecution":
                add(
                    entry,
                    "bash",
                    "tool",
                    "tool",
                    {
                        "kind": "command",
                        "title": "bash",
                        "command": message.get("command"),
                        "output": message.get("output", ""),
                        "exitCode": message.get("exitCode"),
                    },
                    "failed" if message.get("exitCode", 0) else "done",
                )
        elif kind in {"compaction", "branch_summary", "custom_message"}:
            text = entry.get("summary") or text_content(entry.get("content"))
            if text:
                add(
                    entry,
                    kind,
                    "message",
                    "assistant",
                    {
                        "kind": "markdown",
                        "format": "markdown",
                        "text": text,
                        "nativeEntryType": kind,
                    },
                )
    return result
