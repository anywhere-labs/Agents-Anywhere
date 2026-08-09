from __future__ import annotations

import re
from dataclasses import dataclass, field

from connector.logging import logger

_MAX_STDERR_LINES = 80
_MAX_STDERR_CHARS = 8000
_SECRET_RE = re.compile(
    r"(?i)(api[_-]?key|auth[_-]?token|authorization|bearer|token|password|secret)([=:\s]+)([^\s,;]+)"
)


@dataclass(slots=True)
class ClaudeStderrBuffer:
    session_id: str
    lines: list[str] = field(default_factory=list)

    def record(self, line: str) -> None:
        cleaned = redact_secret(line.strip())
        if not cleaned:
            return
        self.lines.append(cleaned)
        if len(self.lines) > _MAX_STDERR_LINES:
            del self.lines[: len(self.lines) - _MAX_STDERR_LINES]
        logger.warning(
            "claude sdk stderr session_id={} line={}",
            self.session_id,
            cleaned,
        )

    def excerpt(self) -> str | None:
        if not self.lines:
            return None
        text = "\n".join(self.lines[-_MAX_STDERR_LINES:])
        if len(text) > _MAX_STDERR_CHARS:
            return "..." + text[-_MAX_STDERR_CHARS:]
        return text

    def failure_message(self, exc: Exception) -> str:
        message = str(exc) or exc.__class__.__name__
        stderr = self.excerpt()
        if stderr:
            return f"{message}\n\nClaude stderr:\n{stderr}"
        return message


def redact_secret(value: str) -> str:
    return _SECRET_RE.sub(lambda match: f"{match.group(1)}{match.group(2)}***", value)
