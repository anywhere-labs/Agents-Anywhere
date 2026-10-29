"""Deterministic ACP v1 peer for direct functional checks; never a user Profile."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

pending: dict[str, asyncio.Future] = {}
sequence = 0


def write_marker(text):
    with Path(sys.argv[1]).open("a", encoding="utf8") as output:
        output.write(text + "\n")


def send(value):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", **value}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def permission(title):
    global sequence
    sequence += 1
    identifier = f"agent-permission-{sequence}"
    pending[identifier] = asyncio.get_running_loop().create_future()
    send(
        {
            "id": identifier,
            "method": "session/request_permission",
            "params": {
                "sessionId": "controlled-native",
                "toolCall": {
                    "toolCallId": identifier,
                    "title": title,
                    "status": "pending",
                    "kind": "other",
                },
                "options": [
                    {"optionId": "allow", "name": "允许一次", "kind": "allow_once"},
                    {"optionId": "deny", "name": "拒绝", "kind": "reject_once"},
                ],
            },
        }
    )
    try:
        return await pending[identifier]
    finally:
        pending.pop(identifier, None)


async def handle(message):
    method, params = message["method"], message.get("params", {})
    if method == "initialize":
        result = {
            "protocolVersion": 1,
            "agentInfo": {"name": "controlled", "version": "fixture"},
            "agentCapabilities": {
                "loadSession": False,
                "sessionCapabilities": {"close": {}},
            },
            "authMethods": [],
        }
    elif method == "session/new":
        await permission("创建中的扩展确认")
        result = {
            "sessionId": "controlled-native",
            "configOptions": [
                {
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "type": "select",
                    "currentValue": "fixture",
                    "options": [{"value": "fixture", "name": "Controlled model"}],
                }
            ],
        }
    elif method == "session/prompt":
        text = params["prompt"][0]["text"]
        if text == "form":
            identifier = "controlled-form"
            pending[identifier] = asyncio.get_running_loop().create_future()
            send(
                {
                    "id": identifier,
                    "method": "elicitation/create",
                    "params": {
                        "sessionId": "controlled-native",
                        "mode": "form",
                        "message": "受控多字段表单",
                        "requestedSchema": {
                            "type": "object",
                            "properties": {
                                "empty": {"type": "string"},
                                "enabled": {"type": "boolean"},
                                "count": {"type": "number"},
                                "lines": {"type": "string"},
                            },
                            "required": ["empty", "enabled", "count", "lines"],
                        },
                    },
                }
            )
            answer = await pending[identifier]
            pending.pop(identifier)
            await asyncio.to_thread(
                write_marker,
                json.dumps(answer["content"], ensure_ascii=False, sort_keys=True),
            )
        if text == "hang":
            await permission("等待期间杀死执行者")
            await asyncio.Future()
        answer = await permission("允许受控文件写入？")
        if answer["outcome"].get("optionId") != "allow":
            result = {"stopReason": "cancelled"}
        else:
            await asyncio.to_thread(write_marker, text)
            for delta in ("受控 ", "输出\u2028完成"):
                send(
                    {
                        "method": "session/update",
                        "params": {
                            "sessionId": "controlled-native",
                            "update": {
                                "sessionUpdate": "agent_message_chunk",
                                "content": {"type": "text", "text": delta},
                            },
                        },
                    }
                )
                await asyncio.sleep(0.03)
            result = {"stopReason": "end_turn"}
    elif method == "session/close":
        result = {}
    elif method == "session/cancel":
        return
    elif method == "session/set_config_option":
        result = {
            "configOptions": [
                {
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "type": "select",
                    "currentValue": params["value"],
                    "options": [{"value": "fixture", "name": "Controlled model"}],
                }
            ]
        }
    else:
        send({"id": message["id"], "error": {"code": -32601, "message": "unsupported"}})
        return
    if "id" in message:
        send({"id": message["id"], "result": result})


async def main():
    tasks = set()
    while line := await asyncio.to_thread(sys.stdin.buffer.readline):
        message = json.loads(line)
        if "method" in message:
            task = asyncio.create_task(handle(message))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
        elif message.get("id") in pending:
            future = pending[message["id"]]
            if not future.done():
                future.set_result(message.get("result", {}))


if __name__ == "__main__":
    asyncio.run(main())
