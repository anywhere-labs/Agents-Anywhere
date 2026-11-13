from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field

from acp import RequestError

HISTORY_RESET = "codex/session/history_reset"


@dataclass
class Replay:
    revision: str
    updates: list[dict] = field(default_factory=list)
    size: int = 0


class HistoryReplacement:
    """A negotiated, bounded replay; only commit reaches the durable projection."""

    max_bytes = 64 * 1024 * 1024
    max_updates = 100_000

    def __init__(self, emit):
        self.emit = emit
        self.enabled = False
        self.lock = asyncio.Lock()
        self.pending: dict[str, Replay] = {}
        self.failed: set[str] = set()
        self.completed: set[tuple[str, str]] = set()

    async def reset(self, params, *, request=False):
        if not self.enabled:
            raise RequestError.method_not_found(HISTORY_RESET)
        if not isinstance(params, dict):
            raise RequestError(-32602, "Invalid history replacement")
        session_id, revision, phase = (params.get(key) for key in ("sessionId", "revision", "phase"))
        if (
            not all(isinstance(value, str) and 0 < len(value) <= 256 for value in (session_id, revision))
            or phase not in ({"begin"} if request else {"commit", "abort"})
        ):
            raise RequestError(-32602, "Invalid history replacement")
        async with self.lock:
            current = self.pending.get(session_id)
            if phase == "begin":
                if current is not None or (session_id, revision) in self.completed or session_id in self.failed or len(self.completed) >= 4096:
                    raise RequestError(-32602, "History replacement requires a fresh revision and connection")
                await self.emit(session_id, {"sessionUpdate": "aa_history_reset", "phase": "begin", "revision": revision})
                self.pending[session_id] = Replay(revision)
                return {"revision": revision, "ready": True}
            if current is None or current.revision != revision:
                raise RequestError(-32602, "History replacement revision does not match")
            if phase == "abort":
                await self.abort(session_id)
                return None
            try:
                await self.emit(session_id, {
                    "sessionUpdate": "aa_history_replace", "revision": revision, "updates": current.updates,
                })
            except BaseException:
                await self.abort(session_id)
                raise
            self.pending.pop(session_id, None)
            self.completed.add((session_id, revision))
        return None

    async def capture(self, session_id: str, value: dict) -> bool:
        """Caller holds lock, shared with begin/commit and ordinary updates."""
        if session_id in self.failed:
            return True
        current = self.pending.get(session_id)
        if current is None:
            return False
        try:
            encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
            size = len(encoded.encode("utf-8"))
            if len(current.updates) >= self.max_updates or current.size + size > self.max_bytes:
                raise ValueError("History replacement exceeds the replay limit")
            current.updates.append(json.loads(encoded))
            current.size += size
        except Exception:
            await self.abort(session_id)
            raise
        return True

    async def abort(self, session_id: str):
        current = self.pending.pop(session_id, None)
        if current is None:
            return
        self.failed.add(session_id)
        await self.emit(session_id, {"sessionUpdate": "aa_history_reset", "phase": "abort", "revision": current.revision})

    async def close(self):
        async with self.lock:
            for session_id in list(self.pending):
                await self.abort(session_id)
