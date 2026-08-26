from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from connector.logging import logger

NotificationSender = Callable[[str, dict[str, Any]], Awaitable[None]]

TIMELINE_ITEM_UPSERT = "timeline.itemUpsert"
DEFAULT_TIMELINE_COALESCE_WINDOW_SECONDS = 0.1


class TimelineItemNotificationCoalescer:
    """Limit assistant text snapshots while preserving session event ordering."""

    def __init__(
        self,
        sender: NotificationSender,
        *,
        window_seconds: float = DEFAULT_TIMELINE_COALESCE_WINDOW_SECONDS,
    ) -> None:
        self._sender = sender
        self._window_seconds = window_seconds
        self._pending: dict[str, dict[str, dict[str, Any]]] = {}
        self._flush_tasks: dict[str, asyncio.Task[None]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    async def send(self, method: str, params: dict[str, Any]) -> None:
        session_id = _session_id(params)
        if session_id is None:
            await self._sender(method, params)
            return

        lock = self._locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            if _is_assistant_message_upsert(method, params):
                item = params["item"]
                item_id = item["id"]
                self._pending.setdefault(session_id, {})[item_id] = params
                self._schedule_flush(session_id)
                return

            await self._flush_locked(session_id)
            await self._sender(method, params)

    async def flush(self, session_id: str) -> None:
        lock = self._locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            await self._flush_locked(session_id)

    async def close(self) -> None:
        session_ids = set(self._pending) | set(self._flush_tasks)
        for session_id in session_ids:
            await self.flush(session_id)

    def _schedule_flush(self, session_id: str) -> None:
        task = self._flush_tasks.get(session_id)
        if task is not None and not task.done():
            return
        self._flush_tasks[session_id] = asyncio.create_task(
            self._flush_after_window(session_id),
            name=f"timeline-coalesce-{session_id}",
        )

    async def _flush_after_window(self, session_id: str) -> None:
        try:
            await asyncio.sleep(self._window_seconds)
            lock = self._locks.setdefault(session_id, asyncio.Lock())
            async with lock:
                await self._flush_locked(session_id)
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001 - background delivery must not stop Connector
            logger.exception(
                "coalesced timeline notification flush failed session_id={}",
                session_id,
            )

    async def _flush_locked(self, session_id: str) -> None:
        task = self._flush_tasks.pop(session_id, None)
        current_task = asyncio.current_task()
        if task is not None and task is not current_task and not task.done():
            task.cancel()

        pending = self._pending.pop(session_id, {})
        for params in pending.values():
            await self._sender(TIMELINE_ITEM_UPSERT, params)


def _session_id(params: dict[str, Any]) -> str | None:
    session_id = params.get("sessionId")
    return session_id if isinstance(session_id, str) and session_id else None


def _is_assistant_message_upsert(
    method: str,
    params: dict[str, Any],
) -> bool:
    if method != TIMELINE_ITEM_UPSERT:
        return False
    item = params.get("item")
    return bool(
        isinstance(item, dict)
        and isinstance(item.get("id"), str)
        and item.get("type") == "message"
        and item.get("role") == "assistant"
    )
