"""Background service that keeps the Connector following Codex IPC threads.

Ties the IPC client, the thread follower and the session projector together:
once the client is initialized it probes candidate threads (writer-lock files
and recent sessions) once, follows the ones that have a reachable owner, and
afterwards only re-probes when another IPC client announces activity (a window
opening a thread, a new window connecting) or when the runtime asks for a
scan. There is no periodic rescan unless ``scan_interval`` is set.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import sys
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path

from connector.logging import logger
from connector.runtimes.codex.ipc.candidates import candidate_thread_ids
from connector.runtimes.codex.ipc.client import CodexIpcClient, IpcBroadcast
from connector.runtimes.codex.ipc.follower import FollowerEvent, ThreadFollower

DEFAULT_SCAN_INTERVAL: float | None = None
DEFAULT_RETRY_INTERVAL = 300.0
DEFAULT_HELD_RETRY_INTERVAL = 20.0
DEFAULT_ANNOUNCE_RETRY_DELAY = 3.0
DEFAULT_ANNOUNCE_RETRY_ATTEMPTS = 3
DEFAULT_DISCOVERY_CONCURRENCY = 8
WRITER_LOCK_DIRECTORY = "thread-writer-locks"

ScanHook = Callable[[], Awaitable[None]]


@dataclass(slots=True)
class CodexIpcService:
    client: CodexIpcClient
    codex_home: Path
    on_event: Callable[[FollowerEvent], Awaitable[None]]
    scan_interval: float | None = DEFAULT_SCAN_INTERVAL
    retry_interval: float = DEFAULT_RETRY_INTERVAL
    held_retry_interval: float = DEFAULT_HELD_RETRY_INTERVAL
    announce_retry_delay: float = DEFAULT_ANNOUNCE_RETRY_DELAY
    announce_retry_attempts: int = DEFAULT_ANNOUNCE_RETRY_ATTEMPTS
    recent_limit: int = 10
    discovery_concurrency: int = DEFAULT_DISCOVERY_CONCURRENCY
    follower: ThreadFollower = field(init=False)
    _announce_retries: dict[str, int] = field(default_factory=dict, init=False)
    _retry_handles: dict[str, asyncio.TimerHandle] = field(default_factory=dict, init=False)
    _task: asyncio.Task[None] | None = field(default=None, init=False)
    _wake: asyncio.Event = field(default_factory=asyncio.Event, init=False)
    _extra_candidates: set[str] = field(default_factory=set, init=False)
    _last_probe: dict[str, float] = field(default_factory=dict, init=False)
    _unsubscribe: list[Callable[[], None]] = field(default_factory=list, init=False)
    _scan_count: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        self.follower = ThreadFollower(client=self.client)

    @property
    def scan_count(self) -> int:
        return self._scan_count

    async def start(self) -> None:
        if self._task is not None:
            return
        self.follower.attach()
        self.follower.add_listener(self.on_event)
        self._unsubscribe.append(
            self.client.add_broadcast_handler(
                "thread-stream-following-changed", self._on_following_changed
            )
        )
        self._unsubscribe.append(
            self.client.add_any_broadcast_handler(self._on_any_broadcast)
        )
        self._task = asyncio.create_task(self._run(), name="codex-ipc-service")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        for unsubscribe in self._unsubscribe:
            unsubscribe()
        self._unsubscribe.clear()
        for handle in self._retry_handles.values():
            handle.cancel()
        self._retry_handles.clear()
        self.follower.detach()

    def request_scan(self) -> None:
        self._wake.set()

    def thread_is_held(self, thread_id: str) -> bool:
        """Whether another process currently holds the thread's writer lock."""

        return writer_lock_held(self.codex_home / WRITER_LOCK_DIRECTORY / f"{thread_id}.lock")

    def _schedule_announce_retry(self, thread_id: str) -> None:
        attempts = self._announce_retries.get(thread_id, 0)
        if attempts >= self.announce_retry_attempts or thread_id in self._retry_handles:
            return
        self._announce_retries[thread_id] = attempts + 1
        loop = asyncio.get_running_loop()

        def fire() -> None:
            self._retry_handles.pop(thread_id, None)
            self._extra_candidates.add(thread_id)
            self.request_scan()

        self._retry_handles[thread_id] = loop.call_later(self.announce_retry_delay, fire)

    async def scan_once(self) -> None:
        """Probe every candidate thread that is not already followed."""

        loop_time = asyncio.get_running_loop().time()
        # Take the announced ids atomically so announcements that arrive while
        # this scan is running are picked up by the next one.
        extras, self._extra_candidates = self._extra_candidates, set()
        candidates = list(extras)
        candidates.extend(
            await asyncio.to_thread(
                candidate_thread_ids, self.codex_home, recent_limit=self.recent_limit
            )
        )
        semaphore = asyncio.Semaphore(self.discovery_concurrency)
        seen: set[str] = set()

        async def probe(thread_id: str) -> None:
            async with semaphore:
                try:
                    thread = await self.follower.follow(thread_id)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "codex ipc follow failed thread={} error={}", thread_id, exc
                    )
                    thread = None
                self._last_probe[thread_id] = asyncio.get_running_loop().time()
                if thread is not None and thread.status == "following":
                    self._announce_retries.pop(thread_id, None)
                elif thread_id in extras:
                    # A window announced this thread but did not claim it yet
                    # (ownership is registered after its resume completes).
                    self._schedule_announce_retry(thread_id)

        tasks = []
        for thread_id in candidates:
            if thread_id in seen:
                continue
            seen.add(thread_id)
            current = self.follower.get(thread_id)
            if current is not None and current.status == "following":
                continue
            last = self._last_probe.get(thread_id)
            interval = (
                self.held_retry_interval
                if self.thread_is_held(thread_id)
                else self.retry_interval
            )
            if (
                current is not None
                and current.status in {"no_owner", "unreachable"}
                and last is not None
                and loop_time - last < interval
                and thread_id not in extras
            ):
                continue
            tasks.append(asyncio.create_task(probe(thread_id)))
        if tasks:
            await asyncio.gather(*tasks)
        self._scan_count += 1

    async def _run(self) -> None:
        while True:
            # Clear before scanning: a wake-up requested during the scan must
            # trigger another pass instead of being lost.
            self._wake.clear()
            try:
                await self.client.wait_until_initialized()
                await self.scan_once()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("codex ipc scan failed error={}", exc)
            if self.scan_interval is None:
                await self._wake.wait()
                continue
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=self.scan_interval)

    async def _on_following_changed(self, broadcast: IpcBroadcast) -> None:
        # Another window announcing a thread tells us that thread is alive.
        params = broadcast.params if isinstance(broadcast.params, Mapping) else {}
        thread_id = params.get("conversationId")
        if not isinstance(thread_id, str) or broadcast.source_client_id == self.client.client_id:
            return
        current = self.follower.get(thread_id)
        if current is not None and current.status == "following":
            return
        self._extra_candidates.add(thread_id)
        self.request_scan()

    async def _on_any_broadcast(self, broadcast: IpcBroadcast) -> None:
        if broadcast.method == "thread-stream-following-status-requested":
            await self._on_owner_announced(broadcast)
            return
        if broadcast.method != "client-status-changed":
            return
        params = broadcast.params if isinstance(broadcast.params, Mapping) else {}
        if params.get("status") == "connected" and not params.get("isSelf"):
            # A new window may own threads we could not reach before.
            for thread_id, thread in self.follower.threads.items():
                if thread.status in {"no_owner", "unreachable", "owner_lost"}:
                    self._extra_candidates.add(thread_id)
            self.request_scan()


    async def _on_owner_announced(self, broadcast: IpcBroadcast) -> None:
        # A window that starts owning a thread without followers (a thread just
        # created or opened in the App) asks followers to announce. The startup
        # scan never saw such a thread, so follow it now instead of waiting for
        # the next Connector restart.
        params = broadcast.params if isinstance(broadcast.params, Mapping) else {}
        thread_id = params.get("conversationId")
        if not isinstance(thread_id, str) or broadcast.source_client_id == self.client.client_id:
            return
        current = self.follower.get(thread_id)
        if current is not None and current.status == "following":
            return
        logger.info(
            "codex ipc owner announced new thread thread={} owner={}",
            thread_id,
            broadcast.source_client_id,
        )
        self._extra_candidates.add(thread_id)
        self.request_scan()


def writer_lock_held(path: Path) -> bool:
    """Probe a Codex writer-lock file with a non-blocking exclusive flock.

    Codex keeps the lock file around after the holder exits, so existence alone
    says nothing; taking (and immediately releasing) the flock tells whether
    some process still holds it. Platforms without ``fcntl`` fall back to
    existence.
    """

    if sys.platform == "win32":
        return _windows_lock_held(path)
    try:
        import fcntl
    except ImportError:  # pragma: no cover
        return path.exists()
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        except OSError:
            return path.exists()
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def _windows_lock_held(path: Path) -> bool:
    """Codex locks the file with LockFileEx; a held lock refuses our byte lock."""

    import msvcrt

    try:
        fd = os.open(path, os.O_RDWR)
    except FileNotFoundError:
        return False
    except OSError:
        return True
    try:
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError:
            return True
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        return False
    finally:
        os.close(fd)
