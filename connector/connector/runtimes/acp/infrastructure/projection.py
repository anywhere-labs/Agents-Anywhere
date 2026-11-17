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

    def _reset_segment(self):
        self.current_kind = None
        self.current_thought_identity = None
        self.current_thought_key = None

    @staticmethod
    def _status(aa_metadata: dict) -> str:
        stop_reason = aa_metadata.get("stopReason")
        if stop_reason == "aborted":
            return "cancelled"
        if stop_reason == "error":
            return "failed"
        return "done" if aa_metadata.get("boundary") else "running"

    def _thought_occurrence(self, kind: str, verified_id: str) -> int:
        """Number of segments already stored for this ID.

        Derived from self.items rather than a connection-local counter, so live,
        replay (runtime.py snapshot) and recover (sessions.py) all agree.
        """
        # Occurrence 0 is the pre-segmentation key; later segments are stored
        # under ``occurrence N`` with the same N this scan returns, so the probe
        # has to start at 1 and advance by one rather than skipping ahead.
        if fingerprint([self.session_id, kind, verified_id]) not in self.items:
            return 0
        occurrence = 1
        while (
            fingerprint(
                [self.session_id, kind, verified_id, "occurrence", occurrence]
            )
            in self.items
        ):
            occurrence += 1
        return occurrence

    def _thought_key(self, kind: str, verified_id: str | None) -> str:
        if verified_id is None:
            return fingerprint(
                [self.session_id, self.epoch, kind, self.message_index]
            )
        occurrence = self._thought_occurrence(kind, verified_id)
        if occurrence == 0:
            # Items written before segmented thoughts existed use this key.
            # Keeping it for the first segment lets the upgrade upsert them in
            # place instead of duplicating them.
            return fingerprint([self.session_id, kind, verified_id])
        return fingerprint(
            [self.session_id, kind, verified_id, "occurrence", occurrence]
        )

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
            if not chunk_text and is_thought:
                # A thought delta carries nothing on its own; other chunks may
                # still end a message or attach files with empty text.
                return None

            message_id = update.get("messageId")
            usable_message_id = (
                message_id
                if is_thought and isinstance(message_id, str) and message_id
                else None
            )
            verified_message_id = (
                usable_message_id
                if usable_message_id is not None
                and update.get("aaProjectionVerified")
                else None
            )
            # ACP v1: every chunk of one message shares messageId, and a change
            # means a new message started. That holds inside one connection
            # whether or not the Runtime also promises the ID survives a replay,
            # so an unverified ID still marks a segment boundary. Only key
            # generation needs the replay-stable form; unverified IDs fall back
            # to epoch and message index there.
            thought_identity = (
                ("verified", verified_message_id)
                if verified_message_id is not None
                else ("message", usable_message_id)
                if is_thought and usable_message_id is not None
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
                self._reset_segment()
                self.current_kind = kind
                if is_thought:
                    self.current_thought_identity = thought_identity
                    self.current_thought_key = self._thought_key(
                        kind, verified_message_id
                    )
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
                "status": self._status(aa_metadata),
                "content": {
                    "kind": "reasoning" if is_thought else "markdown",
                    "format": "markdown",
                    "text": text,
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
            self._reset_segment()
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
        self._reset_segment()
        return result
