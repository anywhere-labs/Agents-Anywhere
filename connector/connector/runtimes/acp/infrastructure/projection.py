from __future__ import annotations

from ..domain.definitions import fingerprint


class Projection:
    """Connection-local ACP v1 identities; never merge them across replays."""

    def __init__(self, session_id: str, epoch: str, *, runtime_type: str):
        self.session_id, self.epoch = session_id, epoch
        self.runtime_type = runtime_type
        self.items: dict[str, dict] = {}
        self.message_index = 0
        self.current_kind = None

    def apply(self, update: dict) -> dict | None:
        native = update.get("_meta", {}).get("aa", {}).get("timelineItem")
        if native and update.get("aaProjectionVerified"):
            if not isinstance(native.get("id"), str) or native.get("type") not in {
                "message",
                "tool",
            }:
                raise ValueError("Invalid AA native projection identity")
            old = self.items.get(native["id"])
            if old and native["revision"] <= old["revision"]:
                return None
            item = {
                **native,
                "sessionId": self.session_id,
                "source": {**native["source"], "runtime": self.runtime_type},
            }
            item["contentHash"] = "sha256:" + fingerprint(
                {
                    key: item[key]
                    for key in ("type", "status", "role", "content", "source")
                }
            )
            self.items[item["id"]] = item
            return item
        kind = update.get("sessionUpdate")
        if kind in {"agent_message_chunk", "agent_thought_chunk", "user_message_chunk"}:
            if self.current_kind != kind:
                self.message_index += 1
                self.current_kind = kind
            message_id = update.get("messageId")
            key = fingerprint([self.session_id, kind, message_id]) if message_id and update.get("aaProjectionVerified") else fingerprint([self.session_id, self.epoch, kind, self.message_index])
            old = self.items.get(key, {})
            content = update.get("content", {})
            if content.get("type") != "text":
                return None
            text = old.get("content", {}).get("text", "") + content.get("text", "")
            item = {
                "id": key,
                "sessionId": self.session_id,
                "type": "message",
                "role": "user" if kind == "user_message_chunk" else "assistant",
                "status": "cancelled" if update.get("_meta", {}).get("aa", {}).get("stopReason") == "aborted" else "failed" if update.get("_meta", {}).get("aa", {}).get("stopReason") == "error" else "done" if update.get("_meta", {}).get("aa", {}).get("boundary") else "running",
                "content": {
                    "kind": "markdown",
                    "format": "markdown",
                    "text": text,
                    "isThinking": kind == "agent_thought_chunk",
                    **({"clientMessageId": update["_meta"]["aa"]["clientMessageId"]}
                       if update.get("_meta", {}).get("aa", {}).get("clientMessageId") else {}),
                    **({"attachments": update["_meta"]["aa"]["attachments"]}
                       if update.get("_meta", {}).get("aa", {}).get("attachments") else {}),
                },
            }
        elif kind in {"tool_call", "tool_call_update"}:
            self.current_kind = None
            tool_id = update["toolCallId"]
            key = fingerprint([self.session_id, "tool", tool_id]) if update.get("aaProjectionVerified") else fingerprint([self.session_id, self.epoch, "tool", tool_id])
            old = self.items.get(key, {})
            content = {
                **old.get("content", {}),
                **{
                    key: value
                    for key, value in update.items()
                    if key != "sessionUpdate"
                },
            }
            content = {
                **content,
                "toolKind": update.get("kind", old.get("content", {}).get("toolKind")),
                "kind": "tool_call",
                "title": content.get("title", "Agent tool"),
            }
            raw_input = content.get("rawInput") or {}
            if not isinstance(raw_input, dict):
                raw_input = {}
            acp_kind = content.get("toolKind") or update.get("kind")
            if acp_kind == "execute":
                content["kind"] = "command"
                if isinstance(raw_input.get("command"), str):
                    content["command"] = raw_input["command"]
            if isinstance(content.get("rawOutput"), dict) and isinstance(content["rawOutput"].get("output"), str):
                content["output"] = content["rawOutput"]["output"]
            blocks = content.get("content")
            diffs = [block for block in blocks if isinstance(block, dict) and block.get("type") == "diff"] if isinstance(blocks, list) else []
            if diffs:
                content["kind"] = "file_change"
                content["changes"] = [{
                    "path": block.get("path", ""),
                    "kind": "add" if block.get("oldText") is None else "update",
                    "diff": "\n".join([*("-" + line for line in (block.get("oldText") or "").splitlines()), *("+" + line for line in (block.get("newText") or "").splitlines())]),
                    "contextual": False,
                } for block in diffs]
            status = {
                "in_progress": "running",
                "completed": "done",
                "failed": "failed",
                "pending": "pending",
            }.get(update.get("status"), old.get("status", "pending"))
            item = {
                "id": key,
                "sessionId": self.session_id,
                "type": "tool",
                "role": "tool",
                "status": status,
                "content": content,
            }
        else:
            return None
        item["source"] = {"runtime": self.runtime_type, "epoch": self.epoch}
        item.update(
            orderSeq=old.get("orderSeq", len(self.items) + 1),
            revision=old.get("revision", 0) + 1,
            contentHash="sha256:"
            + fingerprint(
                {
                    key: item[key]
                    for key in ("type", "status", "role", "content", "source")
                }
            ),
        )
        self.items[key] = item
        return item

    def finish(self) -> list[dict]:
        result = []
        for item in self.items.values():
            if item["type"] == "message" and item["status"] == "running":
                item["status"] = "done"
                item["revision"] += 1
                item["contentHash"] = "sha256:" + fingerprint(
                    {
                        key: item[key]
                        for key in ("type", "status", "role", "content", "source")
                    }
                )
                result.append(dict(item))
        self.current_kind = None
        return result
