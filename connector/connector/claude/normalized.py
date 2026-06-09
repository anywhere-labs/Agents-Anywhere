from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal


@dataclass(slots=True)
class NormalizedClaudeEvent:
    claudeSessionId: str
    sourceEventId: str
    messageId: str | None = None
    role: Literal["user", "assistant", "tool", "system"] | None = None
    blockIndex: int | None = None
    blockType: str | None = None
    text: str | None = None
    toolUseId: str | None = None
    toolName: str | None = None
    toolInput: Any = None
    toolResult: Any = None
    timestamp: str | None = None
    clientMessageId: str | None = None
    attachments: list[dict[str, Any]] | None = None
