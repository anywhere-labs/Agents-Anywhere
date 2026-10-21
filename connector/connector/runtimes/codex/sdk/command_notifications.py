"""Route native command turns without competing with ordinary SDK turn streams."""

from __future__ import annotations

import threading
from collections.abc import AsyncIterator, Mapping
from typing import Any

from openai_codex.models import Notification, UnknownNotification
from pydantic import BaseModel

from connector.runtimes.codex.sdk.events import CodexSdkEvent


def notification_parts(message: Any) -> tuple[str, dict[str, Any]]:
    if isinstance(message, CodexSdkEvent):
        return message.event_type, message.params
    if isinstance(message, Mapping):
        params = message.get("params")
        return str(message.get("method", "")), dict(params) if isinstance(
            params, Mapping
        ) else {}
    if isinstance(message, Notification):
        if isinstance(message.payload, UnknownNotification):
            return message.method, dict(message.payload.params)
        if isinstance(message.payload, BaseModel):
            # Keep explicit null settings; omission is different from null.
            return message.method, message.payload.model_dump(
                mode="json", by_alias=True, exclude_unset=True
            )
    return "", {}


def turn_identity(message: Any) -> tuple[str, str, str]:
    method, params = notification_parts(message)
    turn = params.get("turn")
    turn_id = params.get("turnId") or (
        turn.get("id") if isinstance(turn, dict) else None
    )
    thread_id = params.get("threadId")
    return (
        method,
        thread_id if isinstance(thread_id, str) else "",
        turn_id if isinstance(turn_id, str) else "",
    )


class LowLevelTurnHandle:
    """Control a turn without constructing another SDK event subscription.

    Ordinary turn/start already owns a low-level consumer. Reuse it when
    streaming; native command turns use only the control methods and keep all
    their events in the global notification path.
    """

    def __init__(self, client: Any, thread_id: str, turn_id: str) -> None:
        self._client = client
        self.thread_id = thread_id
        self.id = turn_id

    async def interrupt(self) -> Any:
        return await self._client.turn_interrupt(self.thread_id, self.id)

    async def steer(self, content: str) -> Any:
        return await self._client.turn_steer(self.thread_id, self.id, content)

    async def stream(self) -> AsyncIterator[Any]:
        self._client.register_turn_notifications(self.id)
        try:
            while True:
                event = await self._client.next_turn_notification(self.id)
                yield event
                method, _, turn_id = turn_identity(event)
                if turn_id == self.id and method in {
                    "turn/completed",
                    "turn/failed",
                    "turn/interrupted",
                    "turn/cancelled",
                }:
                    return
        finally:
            self._client.unregister_turn_notifications(self.id)


class CommandNotifications:
    """SDK 0.144 buffers unregistered turns and drops their terminal events.

    Divert command turns into its global queue before that buffering. Ordinary
    turn/start still owns its SDK stream; early events wait for the start ACK so
    their physical turn ID, rather than timing, determines their destination.
    The reader thread and asyncio caller synchronize only this routing state.
    """

    def __init__(self, router: Any) -> None:
        self.router = router
        self._lock = threading.Lock()
        self._threads: set[str] = set()
        self._ordinary: set[tuple[str, str]] = set()
        self._starting: dict[str, list[Any]] = {}

    @classmethod
    def for_client(cls, client: Any) -> CommandNotifications | None:
        router = getattr(
            getattr(getattr(client, "_client", None), "_sync", None), "_router", None
        )
        if not callable(getattr(router, "route_notification", None)) or not callable(
            getattr(getattr(router, "_global_notifications", None), "put", None)
        ):
            return None
        return cls(router)

    def enable(self, thread_id: str, ordinary_turn_ids: tuple[str, ...] = ()) -> None:
        with self._lock:
            self._threads.add(thread_id)
            self._ordinary.update((thread_id, turn_id) for turn_id in ordinary_turn_ids)

    def clear(self) -> None:
        with self._lock:
            self._threads.clear()
            self._ordinary.clear()
            self._starting.clear()

    def route(self, notification: Any) -> bool:
        method, thread_id, turn_id = turn_identity(notification)
        with self._lock:
            if thread_id not in self._threads or not turn_id:
                return False
            if thread_id in self._starting:
                self._starting[thread_id].append(notification)
                return True
            if (thread_id, turn_id) in self._ordinary:
                if method in {
                    "turn/completed",
                    "turn/failed",
                    "turn/interrupted",
                    "turn/cancelled",
                }:
                    self._ordinary.discard((thread_id, turn_id))
                return False
            self.router._global_notifications.put(notification)
            return True

    def begin_turn(self, thread_id: str) -> None:
        with self._lock:
            # A first command can enable observation while turn/start is waiting
            # for its ACK. Keep this boundary even before commands are enabled.
            if thread_id in self._starting:
                raise RuntimeError("An ordinary Codex turn is already starting")
            self._starting[thread_id] = []

    def finish_turn(self, thread_id: str, turn_id: str | None) -> None:
        with self._lock:
            events = self._starting.pop(thread_id, None)
            if events is None:
                return
            if turn_id and thread_id in self._threads:
                self._ordinary.add((thread_id, turn_id))
            for notification in events:
                method, _, observed_id = turn_identity(notification)
                if observed_id == turn_id:
                    self.router.route_notification(notification)
                    if method in {
                        "turn/completed",
                        "turn/failed",
                        "turn/interrupted",
                        "turn/cancelled",
                    }:
                        self._ordinary.discard((thread_id, turn_id))
                else:
                    self.router._global_notifications.put(notification)
