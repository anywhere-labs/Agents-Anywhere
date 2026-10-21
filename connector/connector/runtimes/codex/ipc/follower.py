"""Thread follower for the Codex IPC owner/follower protocol.

For every thread of interest the follower asks the router who owns it
(``thread-owner-discovery``), announces that it follows the thread
(``thread-stream-following-changed``) and then keeps a local copy of the
owner's ``conversationState`` by applying the ``thread-stream-state-changed``
snapshot and patch broadcasts. It never answers discovery with ``canHandle``
and never claims ownership; a thread without a reachable owner is reported as
such so the runtime can decide whether to resume it in its own app-server.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field, replace
from typing import Any, Literal

from connector.logging import logger
from connector.runtimes.codex.ipc.client import (
    CodexIpcClient,
    IpcBroadcast,
    IpcClientError,
    IpcRequestTimeoutError,
)
from connector.runtimes.codex.ipc.jsonpatch import JsonPatchError, apply_patches

FollowStatus = Literal[
    "following",  # owner found, following announced, waiting for or holding state
    "no_owner",  # nobody holds the thread (resume it yourself if needed)
    "unreachable",  # the router itself did not answer discovery in time
    "owner_lost",  # the owner disconnected after we followed it
    "offline",  # our own IPC connection is down
]

FollowerEventKind = Literal["snapshot", "patches", "status"]

LOCAL_HOST_ID = "local"
DEFAULT_DISCOVERY_TIMEOUT_MS = 12_000


@dataclass(frozen=True, slots=True)
class FollowedThread:
    thread_id: str
    status: FollowStatus
    owner_client_id: str | None = None
    revision: int | None = None
    state: Mapping[str, Any] | None = None
    host_id: str = LOCAL_HOST_ID
    error: str | None = None
    updated_at: float = 0.0

    @property
    def has_state(self) -> bool:
        return self.state is not None


@dataclass(frozen=True, slots=True)
class FollowerEvent:
    kind: FollowerEventKind
    thread: FollowedThread
    patches: tuple[Mapping[str, Any], ...] = ()
    accepted_text_changes: tuple[Mapping[str, Any], ...] = ()
    previous: FollowedThread | None = None


FollowerListener = Callable[[FollowerEvent], Awaitable[None]]


@dataclass(slots=True)
class ThreadFollower:
    client: CodexIpcClient
    discovery_timeout_ms: int = DEFAULT_DISCOVERY_TIMEOUT_MS
    host_id: str = LOCAL_HOST_ID
    _threads: dict[str, FollowedThread] = field(default_factory=dict, init=False)
    _listeners: list[FollowerListener] = field(default_factory=list, init=False)
    _unsubscribe: list[Callable[[], None]] = field(default_factory=list, init=False)
    _locks: dict[str, asyncio.Lock] = field(default_factory=dict, init=False)
    _attached: bool = field(default=False, init=False)

    # -- lifecycle -----------------------------------------------------------

    def attach(self) -> None:
        """Register the broadcast handlers on the IPC client."""

        if self._attached:
            return
        self._attached = True
        self._unsubscribe.extend(
            (
                self.client.add_broadcast_handler(
                    "thread-stream-state-changed", self._on_state_changed
                ),
                self.client.add_broadcast_handler(
                    "thread-stream-following-status-requested",
                    self._on_following_status_requested,
                ),
                self.client.add_broadcast_handler(
                    "client-status-changed", self._on_client_status_changed
                ),
                self.client.add_broadcast_handler(
                    "ipc-connection-reset", self._on_connection_reset
                ),
            )
        )

    def detach(self) -> None:
        for unsubscribe in self._unsubscribe:
            unsubscribe()
        self._unsubscribe.clear()
        self._attached = False

    def add_listener(self, listener: FollowerListener) -> Callable[[], None]:
        self._listeners.append(listener)

        def remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return remove

    # -- queries -------------------------------------------------------------

    @property
    def threads(self) -> Mapping[str, FollowedThread]:
        return dict(self._threads)

    def get(self, thread_id: str) -> FollowedThread | None:
        return self._threads.get(thread_id)

    # -- commands ------------------------------------------------------------

    async def follow(
        self,
        thread_id: str,
        *,
        discovery_timeout_ms: int | None = None,
    ) -> FollowedThread:
        """Discover the owner of ``thread_id`` and start following it.

        Side effects:
        - sends ``thread-owner-discovery`` and ``thread-stream-following-changed``
        - notifies listeners with a ``status`` event when the status changes
        """

        lock = self._locks.setdefault(thread_id, asyncio.Lock())
        async with lock:
            return await self._follow_locked(
                thread_id, discovery_timeout_ms or self.discovery_timeout_ms
            )

    async def _follow_locked(
        self, thread_id: str, discovery_timeout_ms: int
    ) -> FollowedThread:
        previous = self._threads.get(thread_id)
        if not self.client.initialized:
            return await self._set(thread_id, status="offline", error="ipc not connected")
        started = time.monotonic()
        try:
            response = await self.client.request(
                "thread-owner-discovery",
                {"hostId": self.host_id, "conversationId": thread_id},
                timeout_ms=discovery_timeout_ms,
            )
        except IpcRequestTimeoutError:
            return await self._set(thread_id, status="unreachable", error="discovery timed out")
        except IpcClientError as exc:
            return await self._set(thread_id, status="offline", error=str(exc))
        elapsed = time.monotonic() - started
        if not response.ok:
            # Codex windows only answer discovery for threads they own; for every
            # other thread the router reports no-client-found after its own
            # timeout. Either way nobody reachable owns the thread.
            return await self._set(
                thread_id,
                status="no_owner",
                error=f"{response.error} after {elapsed:.1f}s",
            )
        owner = response.handled_by_client_id
        if not owner:
            return await self._set(thread_id, status="no_owner", error="owner without id")
        keep_state = previous is not None and previous.owner_client_id == owner
        thread = await self._set(
            thread_id,
            status="following",
            owner_client_id=owner,
            revision=previous.revision if keep_state and previous else None,
            state=previous.state if keep_state and previous else None,
            error=None,
        )
        await self._announce(thread_id, owner, following=True)
        return thread

    async def unfollow(self, thread_id: str) -> None:
        thread = self._threads.pop(thread_id, None)
        self._locks.pop(thread_id, None)
        if thread is not None and thread.owner_client_id and self.client.initialized:
            await self._announce(thread_id, thread.owner_client_id, following=False)

    async def resync(self, thread_id: str) -> None:
        """Ask the owner for a fresh snapshot by re-announcing the follow."""

        thread = self._threads.get(thread_id)
        if thread is None or thread.owner_client_id is None:
            return
        await self._announce(thread_id, thread.owner_client_id, following=True)

    async def refollow_all(self) -> None:
        for thread_id in list(self._threads):
            try:
                await self.follow(thread_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning("codex ipc refollow failed thread={} error={}", thread_id, exc)

    # -- broadcast handlers --------------------------------------------------

    async def _on_state_changed(self, broadcast: IpcBroadcast) -> None:
        params = broadcast.params if isinstance(broadcast.params, Mapping) else {}
        thread_id = params.get("conversationId")
        change = params.get("change")
        if not isinstance(thread_id, str) or not isinstance(change, Mapping):
            return
        if params.get("hostId") != self.host_id:
            return
        thread = self._threads.get(thread_id)
        if thread is None:
            return
        source = broadcast.source_client_id
        kind = change.get("type")
        if kind == "snapshot":
            state = change.get("conversationState")
            revision = change.get("revision")
            if not isinstance(state, Mapping) or not isinstance(revision, int):
                return
            updated = await self._set(
                thread_id,
                status="following",
                owner_client_id=source or thread.owner_client_id,
                revision=revision,
                state=dict(state),
                error=None,
                kind="snapshot",
            )
            logger.debug(
                "codex ipc snapshot thread={} revision={} owner={}",
                thread_id,
                updated.revision,
                updated.owner_client_id,
            )
            return
        if kind != "patches":
            return
        if thread.owner_client_id != source or thread.state is None:
            return
        base = change.get("baseRevision")
        revision = change.get("revision")
        patches = change.get("patches")
        if (
            not isinstance(base, int)
            or not isinstance(revision, int)
            or not isinstance(patches, list)
        ):
            return
        if base != thread.revision:
            logger.info(
                "codex ipc patch base mismatch thread={} expected={} got={}; resyncing",
                thread_id,
                thread.revision,
                base,
            )
            await self.resync(thread_id)
            return
        try:
            state = apply_patches(thread.state, patches)
        except JsonPatchError as exc:
            logger.warning(
                "codex ipc patch failed thread={} revision={} error={}; resyncing",
                thread_id,
                revision,
                exc,
            )
            await self.resync(thread_id)
            return
        text_changes = change.get("acceptedTextChanges")
        await self._set(
            thread_id,
            status="following",
            owner_client_id=thread.owner_client_id,
            revision=revision,
            state=state,
            error=None,
            kind="patches",
            patches=tuple(patches),
            accepted_text_changes=tuple(text_changes) if isinstance(text_changes, list) else (),
        )

    async def _on_following_status_requested(self, broadcast: IpcBroadcast) -> None:
        params = broadcast.params if isinstance(broadcast.params, Mapping) else {}
        thread_id = params.get("conversationId")
        if not isinstance(thread_id, str) or params.get("hostId") != self.host_id:
            return
        thread = self._threads.get(thread_id)
        if thread is None or thread.status != "following":
            return
        target = broadcast.source_client_id or thread.owner_client_id
        if target:
            await self._announce(thread_id, target, following=True)

    async def _on_client_status_changed(self, broadcast: IpcBroadcast) -> None:
        params = broadcast.params if isinstance(broadcast.params, Mapping) else {}
        status = params.get("status")
        client_id = params.get("clientId")
        if params.get("isSelf") and status == "connected":
            await self.refollow_all()
            return
        if status != "disconnected" or not isinstance(client_id, str):
            return
        for thread_id, thread in list(self._threads.items()):
            if thread.owner_client_id == client_id:
                await self._set(
                    thread_id,
                    status="owner_lost",
                    owner_client_id=None,
                    error="owner disconnected",
                )

    async def _on_connection_reset(self, broadcast: IpcBroadcast) -> None:
        for thread_id, thread in list(self._threads.items()):
            if thread.status == "offline":
                continue
            await self._set(
                thread_id,
                status="offline",
                owner_client_id=None,
                error="ipc connection reset",
            )

    # -- helpers -------------------------------------------------------------

    async def _announce(self, thread_id: str, target: str, *, following: bool) -> None:
        try:
            await self.client.broadcast(
                "thread-stream-following-changed",
                {"conversationId": thread_id, "hostId": self.host_id, "following": following},
                target_client_ids=[target],
            )
        except IpcClientError as exc:
            logger.debug("codex ipc following announce failed thread={} error={}", thread_id, exc)

    async def _set(
        self,
        thread_id: str,
        *,
        status: FollowStatus,
        owner_client_id: str | None = None,
        revision: int | None = None,
        state: Mapping[str, Any] | None = None,
        error: str | None = None,
        kind: FollowerEventKind = "status",
        patches: tuple[Mapping[str, Any], ...] = (),
        accepted_text_changes: tuple[Mapping[str, Any], ...] = (),
    ) -> FollowedThread:
        previous = self._threads.get(thread_id)
        if (
            status == "following"
            and state is None
            and previous is not None
            and previous.owner_client_id == owner_client_id
        ):
            # Keep the last known state while waiting for a fresh snapshot.
            revision = previous.revision
            state = previous.state
        thread = FollowedThread(
            thread_id=thread_id,
            status=status,
            owner_client_id=owner_client_id,
            revision=revision,
            state=state,
            host_id=self.host_id,
            error=error,
            updated_at=time.time(),
        )
        if (
            previous is not None
            and kind == "status"
            and replace(previous, updated_at=thread.updated_at) == thread
        ):
            self._threads[thread_id] = thread
            return thread
        self._threads[thread_id] = thread
        event = FollowerEvent(
            kind=kind,
            thread=thread,
            patches=patches,
            accepted_text_changes=accepted_text_changes,
            previous=previous,
        )
        for listener in list(self._listeners):
            try:
                await listener(event)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "codex ipc follower listener failed thread={} kind={} error={}",
                    thread_id,
                    kind,
                    exc,
                )
        return thread
