"""Per-broadcast derived data shared by local subscribers, with no global cache."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Self

from agent_server.core.events import (
    capability_event_semantic_fingerprint,
    events_from_invalidation,
)


@dataclass(frozen=True, slots=True)
class PreparedSessionEvent:
    event_id: str
    event_type: str
    catalog_type: str | None
    capability_fingerprint: str | None
    encoded_json: str


def prepare_session_events(message: str) -> tuple[PreparedSessionEvent, ...]:
    try:
        invalidation = json.loads(message)
    except json.JSONDecodeError:
        return ()
    if not isinstance(invalidation, dict):
        return ()
    return tuple(
        PreparedSessionEvent(
            event_id=event.eventId,
            event_type=event.type,
            catalog_type=event.payload.get("catalogType"),
            capability_fingerprint=capability_event_semantic_fingerprint(event),
            encoded_json=json.dumps(
                event.model_dump(mode="json"),
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            ),
        )
        for event in events_from_invalidation(invalidation)
    )


class SharedMessage(str):
    """Retain the raw broker API while preparing each received message once.

    Identical strings from two publications are distinct objects. In particular
    no same-sequence state transition is suppressed by this cache.
    """

    def __new__(
        cls,
        raw: str,
        tasks: set[asyncio.Task[Any]] | None = None,
        prepare_events: Callable[[str], Awaitable[tuple[PreparedSessionEvent, ...]]]
        | None = None,
    ) -> Self:
        value = super().__new__(cls, raw)
        value._preparation: asyncio.Task[Any] | None = None
        value._tasks = tasks
        value._prepare_events = prepare_events
        return value

    async def prepared(self, build: Callable[[], Awaitable[Any]]) -> Any:
        if self._preparation is None:
            self._preparation = asyncio.create_task(build())
            if self._tasks is not None:
                self._tasks.add(self._preparation)
                self._preparation.add_done_callback(self._tasks.discard)
            # Consume exceptions even if the last waiting socket disconnects.
            self._preparation.add_done_callback(_observe_completion)
        return await asyncio.shield(self._preparation)

    async def prepared_events(self) -> tuple[PreparedSessionEvent, ...]:
        async def build() -> tuple[PreparedSessionEvent, ...]:
            if self._prepare_events is not None:
                return await self._prepare_events(self)
            return prepare_session_events(self)

        return await self.prepared(build)


def _observe_completion(task: asyncio.Task[Any]) -> None:
    if not task.cancelled():
        task.exception()
