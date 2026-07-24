"""Scripted Fake ACP agent for contract tests.

Reads newline-delimited JSON-RPC from stdin and writes responses/notifications
to stdout. Behavior is controlled by FAKE_ACP_SCENARIO:

- basic_text (default): session/new + session/prompt streams one assistant message
- tool_permission: prompt triggers request_permission, waits for client decision
- cancel: long-running prompt that watches for session/cancel
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time


def _write(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _respond(req_id, result) -> None:
    _write({"jsonrpc": "2.0", "id": req_id, "result": result})


def main() -> None:
    scenario = os.environ.get("FAKE_ACP_SCENARIO", "basic_text")
    session_id = "acp_sess_fake_1"
    cancelled = threading.Event()
    next_server_id = 9000
    # Pending permission bridge: wait for client response before finishing prompt.
    pending_permission: dict | None = None
    # interactive_auth: require authenticate before session/new succeeds.
    authenticated = scenario != "interactive_auth"

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(msg, dict):
            continue

        # Client replies to our server request (permission decision).
        if (
            pending_permission is not None
            and "id" in msg
            and msg.get("id") == pending_permission["server_id"]
            and ("result" in msg or "error" in msg)
        ):
            prompt_id = pending_permission["prompt_id"]
            pending_permission = None
            _write(
                {
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": session_id,
                        "update": {
                            "sessionUpdate": "tool_call_update",
                            "toolCallId": "call_1",
                            "status": "completed",
                            "content": [
                                {
                                    "type": "content",
                                    "content": {"type": "text", "text": "ok"},
                                }
                            ],
                        },
                    },
                }
            )
            _write(
                {
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": session_id,
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "messageId": "msg_2",
                            "content": {"type": "text", "text": "done"},
                        },
                    },
                }
            )
            _respond(prompt_id, {"stopReason": "end_turn"})
            continue

        method = msg.get("method")
        req_id = msg.get("id")
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}

        if method == "initialize":
            auth_methods = (
                [
                    {"id": "iOA", "name": "Login with iOA"},
                    {"id": "external", "name": "Login with Google/Github"},
                ]
                if scenario == "interactive_auth"
                else []
            )
            _respond(
                req_id,
                {
                    "protocolVersion": 1,
                    "agentCapabilities": {
                        "loadSession": False,
                        "sessionCapabilities": {},
                    },
                    "authMethods": auth_methods,
                    "agentInfo": {"name": "fake-acp", "version": "0.0.1"},
                },
            )
            continue
        if method == "authenticate":
            if scenario == "interactive_auth":
                method_id = str(params.get("methodId") or "")
                if method_id in {"iOA", "external"}:
                    authenticated = True
            _respond(req_id, {})
            continue
        if method == "session/new":
            if scenario == "interactive_auth" and not authenticated:
                _write(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {"code": -32000, "message": "Authentication required"},
                    }
                )
                continue
            result: dict = {"sessionId": session_id}
            if scenario == "interactive_auth":
                result["configOptions"] = [
                    {
                        "id": "model",
                        "category": "model",
                        "options": [
                            {"value": "live-model-a", "name": "Live Model A"},
                            {"value": "live-model-b", "name": "Live Model B"},
                        ],
                    }
                ]
            _respond(req_id, result)
            continue
        if method == "session/cancel":
            cancelled.set()
            continue
        if method == "session/prompt":
            if scenario == "tool_permission":
                server_id = next_server_id
                next_server_id += 1
                _write(
                    {
                        "jsonrpc": "2.0",
                        "method": "session/update",
                        "params": {
                            "sessionId": session_id,
                            "update": {
                                "sessionUpdate": "tool_call",
                                "toolCallId": "call_1",
                                "title": "Run shell",
                                "kind": "execute",
                                "status": "pending",
                            },
                        },
                    }
                )
                _write(
                    {
                        "jsonrpc": "2.0",
                        "id": server_id,
                        "method": "session/request_permission",
                        "params": {
                            "sessionId": session_id,
                            "toolCall": {
                                "toolCallId": "call_1",
                                "title": "Run shell",
                                "kind": "execute",
                            },
                            "options": [
                                {
                                    "optionId": "allow-once",
                                    "name": "Allow once",
                                    "kind": "allow_once",
                                },
                                {
                                    "optionId": "reject-once",
                                    "name": "Reject",
                                    "kind": "reject_once",
                                },
                            ],
                        },
                    }
                )
                pending_permission = {"server_id": server_id, "prompt_id": req_id}
                continue
            if scenario == "cancel":
                _handle_cancelable(req_id, session_id, cancelled)
                continue
            _write(
                {
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": session_id,
                        "update": {
                            "sessionUpdate": "agent_message_chunk",
                            "messageId": "msg_1",
                            "content": {"type": "text", "text": "PONG"},
                        },
                    },
                }
            )
            _respond(req_id, {"stopReason": "end_turn"})
            continue
        if method == "session/list":
            _respond(req_id, {"sessions": []})
            continue
        if req_id is not None and method is not None:
            _respond(req_id, {})


def _handle_cancelable(req_id, session_id: str, cancelled: threading.Event) -> None:
    _write(
        {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": session_id,
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "msg_long",
                    "content": {"type": "text", "text": "working"},
                },
            },
        }
    )
    for _ in range(50):
        if cancelled.is_set():
            _respond(req_id, {"stopReason": "cancelled"})
            return
        time.sleep(0.05)
    _respond(req_id, {"stopReason": "end_turn"})


if __name__ == "__main__":
    main()
