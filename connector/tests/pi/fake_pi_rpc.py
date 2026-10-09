#!/usr/bin/env python3
"""Deterministic fake ``pi --mode rpc`` used by the test suite.

Behaviour is controlled by environment variables:

- ``PI_FAKE_SESSION_FILE``: session JSONL path (defaults to ``fake-session.jsonl``
  inside ``PI_FAKE_SESSIONS_DIR`` or the current directory).
- ``PI_FAKE_UI``: when set to ``confirm`` or ``select``, the first prompt emits an
  extension UI dialog and waits for ``extension_ui_response`` before settling.
- ``PI_FAKE_SESSIONS``: number of synthetic sessions to report for inventory
  (not used yet; sessions are discovered from files).
- A ``/hold-dialog`` prompt behaves like an extension command whose handler
  opens a select dialog: Pi answers the prompt (``handled``) only after the
  dialog is answered, and records the answer as a custom message.
"""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from pathlib import Path

VERSION = os.environ.get("PI_FAKE_VERSION", "9.9.9-fake")

STATE: dict[str, object] = {
    "model": {
        "id": "test-model",
        "name": "Test Model",
        "provider": "test",
        "reasoning": True,
        "contextWindow": 128_000,
    },
    "thinkingLevel": "medium",
    "isStreaming": False,
    "isCompacting": False,
    "sessionFile": None,
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "sessionName": None,
    "messageCount": 0,
    "waitingUi": False,
    "uiIssued": False,
    "pendingTool": None,
    "heldPrompt": None,
    # Entry ids this process knows: loaded at startup or written by it.
    "knownIds": set(),
}


def emit(record: dict) -> None:
    sys.stdout.write(json.dumps(record, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def session_path() -> Path:
    configured = STATE["sessionFile"]
    if not isinstance(configured, str):
        configured = os.environ.get("PI_FAKE_SESSION_FILE")
        if not configured:
            base = os.environ.get("PI_FAKE_SESSIONS_DIR", ".")
            configured = str(Path(base) / "fake-session.jsonl")
        STATE["sessionFile"] = configured
    return Path(configured)


def last_entry_id() -> str | None:
    path = session_path()
    if not path.is_file():
        return None
    last: str | None = None
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        entry_id = record.get("id")
        if isinstance(entry_id, str):
            last = entry_id
    return last


def append(record: dict) -> None:
    if isinstance(record.get("id"), str) and record.get("type") != "session":
        STATE["knownIds"].add(record["id"])  # type: ignore[union-attr]
    path = session_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def ensure_header() -> None:
    path = session_path()
    if not path.is_file():
        append(
            {
                "type": "session",
                "version": 3,
                "id": STATE["sessionId"],
                "timestamp": "2026-01-01T00:00:00.000Z",
                "cwd": os.getcwd(),
            }
        )


def state_data() -> dict:
    return {
        "model": STATE["model"],
        "thinkingLevel": STATE["thinkingLevel"],
        "isStreaming": STATE["isStreaming"],
        "isCompacting": STATE["isCompacting"],
        "sessionFile": str(session_path()),
        "sessionId": STATE["sessionId"],
        "sessionName": STATE["sessionName"],
        "messageCount": STATE["messageCount"],
        "pendingMessageCount": 0,
    }


def settle_after_ui() -> None:
    STATE["isStreaming"] = False
    emit({"type": "agent_end", "messages": [], "willRetry": False})
    emit({"type": "agent_settled"})


def issue_ui_if_needed() -> bool:
    method = os.environ.get("PI_FAKE_UI")
    if not method or STATE["uiIssued"] or method not in ("confirm", "select", "input", "editor"):
        return False
    STATE["uiIssued"] = True
    STATE["waitingUi"] = True
    request: dict = {
        "type": "extension_ui_request",
        "id": "ui-request-1",
        "method": method,
        "title": "Fake dialog",
    }
    if method == "confirm":
        request["message"] = "Proceed?"
    if method == "select":
        request["options"] = ["alpha", "beta"]
    emit(request)
    return True


def log_command(command: dict) -> None:
    log_path = os.environ.get("PI_FAKE_COMMAND_LOG")
    if log_path:
        with Path(log_path).open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(command, ensure_ascii=False) + "\n")


def save_message(message: dict) -> None:
    append(
        {
            "type": "message",
            "id": uuid.uuid4().hex[:8],
            "parentId": last_entry_id(),
            "timestamp": "2026-01-01T00:00:02.000Z",
            "message": message,
        }
    )
    STATE["messageCount"] = int(STATE["messageCount"]) + 1


def finish_tool(tool: dict, allowed: bool) -> None:
    call_id = tool["id"]
    emit(
        {
            "type": "tool_execution_start",
            "toolCallId": call_id,
            "toolName": tool["name"],
            "args": tool["arguments"],
        }
    )
    if allowed:
        emit(
            {
                "type": "tool_execution_update",
                "toolCallId": call_id,
                "toolName": tool["name"],
                "args": tool["arguments"],
                "partialResult": {"content": [{"type": "text", "text": "partial output"}]},
            }
        )
        time.sleep(float(os.environ.get("PI_FAKE_STREAM_DELAY", "0")))
    result = {
        "content": [{"type": "text", "text": "tool complete" if allowed else "Denied"}],
        "details": {"exitCode": 0 if allowed else 1},
    }
    emit(
        {
            "type": "tool_execution_end",
            "toolCallId": call_id,
            "toolName": tool["name"],
            "result": result,
            "isError": not allowed,
        }
    )
    message = {
        "role": "toolResult",
        "toolCallId": call_id,
        "toolName": tool["name"],
        **result,
        "isError": not allowed,
        "timestamp": time.time_ns() // 1_000_000,
    }
    save_message(message)
    emit({"type": "message_start", "message": message})
    emit({"type": "message_end", "message": message})
    settle_after_ui()


def handle_prompt(command: dict) -> None:
    text = command.get("message", "")
    images = command.get("images") or []
    content = text if not images else [{"type": "text", "text": text}, *images]
    ensure_header()
    STATE["isStreaming"] = True
    stamp = time.time_ns() // 1_000_000
    user = {"role": "user", "content": content, "timestamp": stamp}
    save_message(user)
    emit({"type": "agent_start"})
    emit({"type": "turn_start"})
    emit({"type": "message_start", "message": user})
    emit({"type": "message_end", "message": user})
    assistant = {
        "role": "assistant",
        "content": [],
        "stopReason": "pending",
        "timestamp": stamp + 1,
        "provider": "test",
        "model": "test-model",
    }
    emit({"type": "message_start", "message": assistant})
    blocks = []
    if os.environ.get("PI_FAKE_THINKING"):
        blocks.append({"type": "thinking", "thinking": "Think carefully"})
        for delta in ("Think ", "carefully"):
            emit(
                {
                    "type": "message_update",
                    "assistantMessageEvent": {
                        "type": "thinking_delta",
                        "contentIndex": 0,
                        "delta": delta,
                    },
                }
            )
    reply = "reply to " + str(text)
    text_index = len(blocks)
    for delta in ("reply ", "to ", str(text)):
        emit(
            {
                "type": "message_update",
                "assistantMessageEvent": {
                    "type": "text_delta",
                    "contentIndex": text_index,
                    "delta": delta,
                },
            }
        )
        time.sleep(float(os.environ.get("PI_FAKE_STREAM_DELAY", "0")))
    blocks.append({"type": "text", "text": reply})
    tool = None
    if os.environ.get("PI_FAKE_TOOLS"):
        tool = {
            "type": "toolCall",
            "id": "call-" + uuid.uuid4().hex[:8],
            "name": "bash",
            "arguments": {"command": "echo hello"},
        }
        blocks.append(tool)
    assistant = {
        **assistant,
        "content": blocks,
        "stopReason": "toolUse" if tool else "stop",
        "usage": {"input": 1, "output": 1, "totalTokens": 2},
    }
    save_message(assistant)
    emit({"type": "message_end", "message": assistant})
    emit({"type": "turn_end", "message": assistant, "toolResults": []})
    if tool:
        mode = os.environ.get("PI_AA_PERMISSION_MODE", "ask-writes")
        if mode in ("full-auto", "read-only"):
            finish_tool(tool, mode == "full-auto")
        else:
            STATE["pendingTool"] = tool
            STATE["waitingUi"] = True
            emit(
                {
                    "type": "extension_ui_request",
                    "id": "ui-request-1",
                    "method": "confirm",
                    "title": "PI_AA_TOOL_APPROVAL_V1",
                    "message": json.dumps(
                        {
                            "toolName": tool["name"],
                            "toolInput": tool["arguments"],
                            "toolCallId": tool["id"],
                            "cwd": os.getcwd(),
                            "mode": mode,
                        }
                    ),
                }
            )
    elif not issue_ui_if_needed():
        settle_after_ui()


def handle_command(command: dict) -> None:
    log_command(command)
    command_type = command.get("type")
    request_id = command.get("id")
    if command_type == "get_state":
        emit(
            {
                "id": request_id,
                "type": "response",
                "command": "get_state",
                "success": True,
                "data": state_data(),
            }
        )
    elif command_type == "prompt" and str(command.get("message", "")).startswith("/hold-dialog"):
        # An extension command: its handler awaits a dialog before Pi answers.
        ensure_header()
        STATE["heldPrompt"] = request_id
        emit(
            {
                "type": "extension_ui_request",
                "id": "held-dialog",
                "method": "select",
                "title": "Held dialog",
                "options": ["alpha", "beta"],
            }
        )
    elif command_type == "prompt":
        emit(
            {
                "id": request_id,
                "type": "response",
                "command": "prompt",
                "success": True,
                "data": {"disposition": "started"},
            }
        )
        handle_prompt(command)
    elif command_type == "compact":
        STATE["isCompacting"] = True
        emit({"type": "compaction_start", "reason": "manual"})
        ensure_header()
        append(
            {
                "type": "compaction",
                "id": uuid.uuid4().hex[:8],
                "parentId": last_entry_id(),
                "timestamp": "2026-01-01T00:00:03.000Z",
                "summary": "Compacted: " + str(command.get("customInstructions") or "all"),
                "firstKeptEntryId": last_entry_id(),
                "tokensBefore": 1000,
            }
        )
        STATE["isCompacting"] = False
        emit({"type": "compaction_end", "reason": "manual", "aborted": False})
        emit(
            {
                "id": request_id,
                "type": "response",
                "command": "compact",
                "success": True,
                "data": {"summary": "Compacted", "tokensBefore": 1000, "estimatedTokensAfter": 200},
            }
        )
    elif command_type == "steer":
        emit({"id": request_id, "type": "response", "command": "steer", "success": True})
    elif command_type == "abort":
        STATE["isStreaming"] = False
        emit({"id": request_id, "type": "response", "command": "abort", "success": True})
        emit({"type": "agent_settled"})
    elif command_type == "set_model":
        model = dict(STATE["model"])  # type: ignore[arg-type]
        if isinstance(command.get("modelId"), str):
            model["id"] = command["modelId"]
        if isinstance(command.get("provider"), str):
            model["provider"] = command["provider"]
        STATE["model"] = model
        emit(
            {
                "id": request_id,
                "type": "response",
                "command": "set_model",
                "success": True,
                "data": model,
            }
        )
    elif command_type == "set_thinking_level":
        STATE["thinkingLevel"] = command.get("level")
        emit(
            {
                "id": request_id,
                "type": "response",
                "command": "set_thinking_level",
                "success": True,
                "data": {"level": STATE["thinkingLevel"]},
            }
        )
        emit({"type": "thinking_level_changed", "level": STATE["thinkingLevel"]})
    elif command_type == "set_session_name":
        name = command.get("name")
        STATE["sessionName"] = name
        emit(
            {
                "id": request_id,
                "type": "response",
                "command": "set_session_name",
                "success": True,
                "data": {"name": name},
            }
        )
        emit({"type": "session_info_changed", "name": name})
    elif command_type == "get_available_models":
        emit(
            {
                "id": request_id,
                "type": "response",
                "command": "get_available_models",
                "success": True,
                "data": {
                    "models": [
                        dict(STATE["model"]),  # type: ignore[arg-type]
                        {
                            "id": "other-model",
                            "name": "Other Model",
                            "provider": "test",
                        },
                        # Same model name under another provider: pi allows
                        # it, so the catalog must keep ids unique and label
                        # the titles.
                        {
                            "id": "test-model",
                            "name": "Test Model",
                            "provider": "alt",
                        },
                    ]
                },
            }
        )
    elif command_type == "get_entries":
        since = command.get("since")
        known = STATE["knownIds"]
        if since is not None and since not in known:  # type: ignore[operator]
            emit(
                {
                    "id": request_id,
                    "type": "response",
                    "command": "get_entries",
                    "success": False,
                    "error": f"Entry not found: {since}",
                }
            )
        else:
            emit(
                {
                    "id": request_id,
                    "type": "response",
                    "command": "get_entries",
                    "success": True,
                    "data": {"entries": [], "leafId": last_entry_id()},
                }
            )
    elif command_type == "get_commands":
        emit(
            {
                "id": request_id,
                "type": "response",
                "command": "get_commands",
                "success": True,
                "data": {
                    "commands": [
                        {
                            "name": "fix-tests",
                            "description": "Fix failing tests",
                            "source": "prompt",
                        }
                    ]
                },
            }
        )
    elif command_type == "extension_ui_response" and STATE["heldPrompt"] is not None:
        held = STATE["heldPrompt"]
        STATE["heldPrompt"] = None
        # Like pi.sendMessage outside a run: message events, then the entry.
        custom = {
            "role": "custom",
            "customType": "held-dialog",
            "content": "held dialog answered: " + str(command.get("value")),
            "display": True,
            "timestamp": time.time_ns() // 1_000_000,
        }
        emit({"type": "message_start", "message": custom})
        emit({"type": "message_end", "message": custom})
        append(
            {
                "type": "custom_message",
                "id": uuid.uuid4().hex[:8],
                "parentId": last_entry_id(),
                "timestamp": "2026-01-01T00:00:04.000Z",
                "customType": "held-dialog",
                "content": "held dialog answered: " + str(command.get("value")),
                "display": True,
            }
        )
        emit(
            {
                "id": held,
                "type": "response",
                "command": "prompt",
                "success": True,
                "data": {"disposition": "handled"},
            }
        )
    elif command_type == "extension_ui_response":
        if STATE["waitingUi"]:
            STATE["waitingUi"] = False
            tool = STATE["pendingTool"]
            STATE["pendingTool"] = None
            if isinstance(tool, dict):
                finish_tool(tool, command.get("confirmed") is True)
            else:
                settle_after_ui()
    else:
        emit(
            {
                "id": request_id,
                "type": "response",
                "command": command_type,
                "success": False,
                "error": f"unsupported fake command {command_type!r}",
            }
        )


def run_rpc() -> int:
    for line in sys.stdin:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            command = json.loads(stripped)
        except json.JSONDecodeError:
            continue
        if not isinstance(command, dict):
            continue
        handle_command(command)
    return 0


def main() -> int:
    argv = sys.argv[1:]
    if "--version" in argv or "-V" in argv:
        print(VERSION)
        return 0
    if "--mode" in argv and "rpc" in argv:
        # Accept the same resource/session flags as real Pi, and honor the
        # resumed path so restart tests cannot pass through an env-only shortcut.
        for flag in ("--session", "--session-dir", "--extension", "-e"):
            if flag in argv:
                index = argv.index(flag)
                if index + 1 >= len(argv):
                    return 2
                if flag == "--session":
                    STATE["sessionFile"] = argv[index + 1]
                    resumed = Path(argv[index + 1])
                    if resumed.is_file():
                        for line in resumed.read_text(encoding="utf-8").splitlines():
                            try:
                                record = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            if isinstance(record.get("id"), str) and record.get("type") != "session":
                                STATE["knownIds"].add(record["id"])  # type: ignore[union-attr]
        log_command(
            {
                "type": "startup",
                "argv": argv,
                "permissionMode": os.environ.get("PI_AA_PERMISSION_MODE"),
            }
        )
        return run_rpc()
    print(f"fake pi: unsupported arguments {argv!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
