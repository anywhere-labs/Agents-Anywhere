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
        self.current_thought_identity = None
        self.current_thought_key = None
        self.verified_thought_occurrences: dict[str, int] = {}

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
            is_thought = kind == "agent_thought_chunk"
            content = update.get("content", {})
            if content.get("type") != "text":
                return None
            chunk_text = content.get("text", "")
            if not chunk_text:
                return None

            message_id = update.get("messageId")
            verified_message_id = (
                message_id
                if is_thought
                and update.get("aaProjectionVerified")
                and isinstance(message_id, str)
                and message_id
                else None
            )
            thought_identity = (
                ("verified", verified_message_id)
                if verified_message_id is not None
                else ("unverified", message_id)
                if is_thought and isinstance(message_id, str) and message_id
                else ("fallback", None)
            )
            new_kind = self.current_kind != kind
            new_thought_segment = (
                is_thought
                and not new_kind
                and self.current_thought_identity != thought_identity
            )
            if new_kind or new_thought_segment:
                self.message_index += 1
                self.current_kind = kind
                if is_thought:
                    self.current_thought_identity = thought_identity
                    if verified_message_id is not None:
                        # Occurrences are connection-local: persisted items do
                        # not retain enough data to reconstruct prior segments.
                        # Keep the first observed segment on Pi's key for upserts.
                        occurrence = self.verified_thought_occurrences.get(
                            verified_message_id, 0
                        )
                        self.verified_thought_occurrences[verified_message_id] = (
                            occurrence + 1
                        )
                        self.current_thought_key = (
                            fingerprint(
                                [self.session_id, kind, verified_message_id]
                            )
                            if occurrence == 0
                            else fingerprint(
                                [
                                    self.session_id,
                                    kind,
                                    verified_message_id,
                                    self.message_index,
                                ]
                            )
                        )
                    else:
                        self.current_thought_key = fingerprint(
                            [self.session_id, self.epoch, kind, self.message_index]
                        )
                else:
                    self.current_thought_identity = None
                    self.current_thought_key = None
            if is_thought:
                key = self.current_thought_key
            elif message_id and update.get("aaProjectionVerified"):
                key = fingerprint([self.session_id, kind, message_id])
            else:
                key = fingerprint(
                    [self.session_id, self.epoch, kind, self.message_index]
                )
            old = self.items.get(key, {})
            text = old.get("content", {}).get("text", "") + chunk_text
            aa_metadata = update.get("_meta", {}).get("aa", {})
            status = (
                "cancelled"
                if aa_metadata.get("stopReason") == "aborted"
                else "failed"
                if aa_metadata.get("stopReason") == "error"
                else "done"
                if aa_metadata.get("boundary")
                else "running"
            )
            item = {
                "id": key,
                "sessionId": self.session_id,
                "type": "system" if is_thought else "message",
                "role": (
                    "system"
                    if is_thought
                    else "user"
                    if kind == "user_message_chunk"
                    else "assistant"
                ),
                "status": status,
                "content": {
                    "kind": "reasoning" if is_thought else "markdown",
                    "format": "markdown",
                    "text": text,
                    **({"isThinking": False} if not is_thought else {}),
                    **(
                        {"clientMessageId": aa_metadata["clientMessageId"]}
                        if aa_metadata.get("clientMessageId")
                        else {}
                    ),
                    **(
                        {"attachments": aa_metadata["attachments"]}
                        if aa_metadata.get("attachments")
                        else {}
                    ),
                },
            }
        elif kind in {"tool_call", "tool_call_update"}:
            self.current_kind = None
            self.current_thought_identity = None
            self.current_thought_key = None
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
        if item.get("role") == "user" and item["content"].get("clientMessageId"):
            item["source"]["clientMessageId"] = item["content"]["clientMessageId"]
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
            if item["type"] in {"message", "system"} and item["status"] == "running":
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
        self.current_thought_identity = None
        self.current_thought_key = None
        return result
