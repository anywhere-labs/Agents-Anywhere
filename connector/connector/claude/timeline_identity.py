from __future__ import annotations

import hashlib
import json
from typing import Any


class ClaudeTimelineIdentity:
    @staticmethod
    def message(*, session_id: str, claude_session_id: str, message_id: str) -> str:
        return f"claude_msg_{_short(session_id, claude_session_id, message_id)}"

    @staticmethod
    def tool_call(
        *,
        session_id: str,
        claude_session_id: str,
        message_id: str,
        tool_use_id: str,
    ) -> str:
        return f"claude_tool_{_short(session_id, claude_session_id, message_id, tool_use_id)}"

    @staticmethod
    def tool_result(
        *,
        session_id: str,
        claude_session_id: str,
        tool_use_id: str,
    ) -> str:
        return f"claude_tool_result_{_short(session_id, claude_session_id, tool_use_id)}"

    @staticmethod
    def derived(*values: Any) -> str:
        return f"claude_derived_{_short(*values)}"


def content_hash(*values: Any) -> str:
    payload = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _short(*values: Any) -> str:
    payload = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]
