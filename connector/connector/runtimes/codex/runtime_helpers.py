from __future__ import annotations

import json


def soft_codex_unavailable_reason(error_text: str) -> str | None:
    message = error_text
    try:
        parsed = json.loads(error_text)
        if isinstance(parsed, dict):
            raw = parsed.get("message")
            if isinstance(raw, str):
                message = raw
    except json.JSONDecodeError:
        pass
    normalized = message.lower()
    if "thread not found" in normalized:
        return "thread_not_found"
    if "turn not found" in normalized:
        return "turn_not_found"
    if "no active turn" in normalized:
        return "turn_not_found"
    return None
