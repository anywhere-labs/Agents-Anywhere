"""Server-owned session message queue: client operations and dispatch.

Messages sent while a session is busy wait in the session's queue. The
dispatcher sends the head as an ordinary ``session.send_message`` once the
session is idle again. Runtimes never see the queue.

Dispatch never runs inside the caller's coroutine: ``wake`` only schedules a
background task. The connector notification path calls ``wake`` when a
session leaves a busy state, and must not wait for a connector RPC to the same
connector while it is processing that connector's notifications.
"""

from __future__ import annotations

import asyncio
import contextvars
import secrets
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

from loguru import logger

from agent_server.core.message_queue import (
    MessageQueueError,
    QueueItemNotFoundError,
)

# A send whose dispatcher stopped renewing its claim for this long is turned
# into a failure; the runtime may have received it, so it is never resent.
STALE_SEND_SECONDS = 120.0
SWEEP_INTERVAL_SECONDS = 30.0
_CLAIM_RENEW_SECONDS = 20.0
_REDIS_CLAIM_TTL_SECONDS = 60.0
# The turn ended in an error: the queue waits for the user unless they asked
# to go on (retry, send now or resume).
_DISPATCHABLE_STATUSES = frozenset({"idle", "error"})


class MessageQueueRepository(Protocol):
    async def get_session(self, session_id: str, *, user_id: str | None = None) -> Any: ...
    async def get_session_seq(self, session_id: str) -> int: ...
    async def get_session_queue(self, session_id: str) -> dict[str, Any]: ...
    async def get_session_queue_head(self, session_id: str) -> dict[str, Any] | None: ...
    async def list_sessions_with_queued_messages(
        self, *, connector_id: str | None = None, limit: int = 500
    ) -> list[str]: ...
    async def update_session_queue_item(
        self, session_id: str, message_id: str, *, content: str | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]: ...
    async def delete_session_queue_item(self, session_id: str, message_id: str) -> dict[str, Any]: ...
    async def clear_session_queue(self, session_id: str) -> dict[str, Any]: ...
    async def retry_session_queue_item(self, session_id: str, message_id: str) -> dict[str, Any]: ...
    async def send_session_queue_item_now(self, session_id: str, message_id: str) -> dict[str, Any]: ...
    async def resume_session_queue(self, session_id: str) -> dict[str, Any]: ...
    async def reorder_session_queue(self, session_id: str, message_ids: list[str]) -> dict[str, Any]: ...
    async def claim_session_queue_head(
        self, session_id: str, message_id: str, *, owner: str
    ) -> dict[str, Any] | None: ...
    async def release_session_queue_claim(
        self, session_id: str, message_id: str, *, owner: str
    ) -> bool: ...
    async def finish_session_queue_item(
        self, session_id: str, message_id: str, *, owner: str
    ) -> bool: ...
    async def fail_session_queue_item(
        self, session_id: str, message_id: str, *, code: str, message: str,
        owner: str | None = None,
    ) -> bool: ...
    async def mark_session_queue_interrupt_attempted(
        self, session_id: str, message_id: str
    ) -> bool: ...
    async def cancel_session_queue_interrupt(
        self, session_id: str, message_id: str
    ) -> dict[str, Any]: ...
    async def fail_stale_session_queue_sends(self, *, older_than_seconds: float) -> list[str]: ...
    async def renew_session_queue_claim(self, message_id: str, *, owner: str) -> None: ...
    async def read_uploaded_file(
        self, *, session_id: str, file_id: str, user_id: str
    ) -> dict[str, Any]: ...


class QueuePublisher(Protocol):
    async def publish(self, session_id: str, payload: dict) -> None: ...


class QueueRunner(Protocol):
    """The parts of the session run service the dispatcher uses."""

    async def read_session_runtime_status(self, session: Any) -> str: ...

    async def dispatch_queued_message(
        self, session_id: str, item: dict[str, Any], *, user_id: str
    ) -> None: ...

    async def interrupt_session_internal(self, session_id: str, *, user_id: str) -> Any: ...


class QueueNotReadyError(RuntimeError):
    """The session became busy between the claim and the send."""


class QueueDispatchFailure(RuntimeError):
    """The runtime refused the queued message."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def publish_queue_state(
    store: MessageQueueRepository,
    broker: QueuePublisher | None,
    session_id: str,
    queue: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Broadcast the whole queue; clients replace theirs by ``revision``."""
    if queue is None:
        queue = await store.get_session_queue(session_id)
    if broker is None:
        return queue
    try:
        sequence = await store.get_session_seq(session_id)
        await broker.publish(
            session_id,
            {"sessionId": session_id, "nextSeq": sequence, "queueState": queue},
        )
    except Exception:  # noqa: BLE001 - snapshots and recovery carry the queue too
        logger.exception("message queue publish failed session_id={}", session_id)
    return queue


class MessageQueueService:
    """Client changes to one session's queue."""

    def __init__(
        self,
        store: MessageQueueRepository,
        broker: QueuePublisher | None,
        dispatcher: MessageQueueDispatcher | None = None,
    ) -> None:
        self._store = store
        self._broker = broker
        self._dispatcher = dispatcher

    async def read(self, session_id: str, *, user_id: str) -> dict[str, Any]:
        await self._owned(session_id, user_id=user_id, control=False)
        return await self._store.get_session_queue(session_id)

    async def update(
        self,
        session_id: str,
        message_id: str,
        *,
        user_id: str,
        content: str | None,
        attachment_ids: list[str] | None,
    ) -> dict[str, Any]:
        await self._owned(session_id, user_id=user_id)
        attachments = None
        if attachment_ids is not None:
            attachments = []
            for file_id in attachment_ids:
                try:
                    metadata = await self._store.read_uploaded_file(
                        session_id=session_id, file_id=file_id, user_id=user_id,
                    )
                except (KeyError, ValueError):
                    raise QueueItemNotFoundError(f"attachment not found: {file_id}") from None
                attachments.append({
                    "fileId": metadata.get("fileId") or file_id,
                    "name": metadata.get("name") or file_id,
                    "mediaType": metadata.get("mediaType") or "",
                    "size": metadata.get("size"),
                })
        queue = await self._store.update_session_queue_item(
            session_id, message_id, content=content, attachments=attachments,
        )
        return await publish_queue_state(self._store, self._broker, session_id, queue)

    async def delete(self, session_id: str, message_id: str, *, user_id: str) -> dict[str, Any]:
        await self._owned(session_id, user_id=user_id)
        queue = await self._store.delete_session_queue_item(session_id, message_id)
        await publish_queue_state(self._store, self._broker, session_id, queue)
        self._wake(session_id)
        return queue

    async def clear(self, session_id: str, *, user_id: str) -> dict[str, Any]:
        await self._owned(session_id, user_id=user_id)
        queue = await self._store.clear_session_queue(session_id)
        return await publish_queue_state(self._store, self._broker, session_id, queue)

    async def retry(self, session_id: str, message_id: str, *, user_id: str) -> dict[str, Any]:
        await self._owned(session_id, user_id=user_id)
        queue = await self._store.retry_session_queue_item(session_id, message_id)
        await publish_queue_state(self._store, self._broker, session_id, queue)
        self._wake(session_id)
        return queue

    async def send_now(self, session_id: str, message_id: str, *, user_id: str) -> dict[str, Any]:
        await self._owned(session_id, user_id=user_id)
        queue = await self._store.send_session_queue_item_now(session_id, message_id)
        await publish_queue_state(self._store, self._broker, session_id, queue)
        self._wake(session_id)
        return queue

    async def resume(self, session_id: str, *, user_id: str) -> dict[str, Any]:
        await self._owned(session_id, user_id=user_id)
        queue = await self._store.resume_session_queue(session_id)
        await publish_queue_state(self._store, self._broker, session_id, queue)
        self._wake(session_id)
        return queue

    async def reorder(
        self, session_id: str, message_ids: list[str], *, user_id: str
    ) -> dict[str, Any]:
        await self._owned(session_id, user_id=user_id)
        queue = await self._store.reorder_session_queue(session_id, message_ids)
        await publish_queue_state(self._store, self._broker, session_id, queue)
        self._wake(session_id)
        return queue

    def _wake(self, session_id: str) -> None:
        if self._dispatcher is not None:
            self._dispatcher.wake(session_id)

    async def _owned(self, session_id: str, *, user_id: str, control: bool = True) -> Any:
        try:
            session = await self._store.get_session(session_id, user_id=user_id)
        except KeyError:
            raise QueueItemNotFoundError("session not found") from None
        if control and not session.takeover:
            raise MessageQueueError("session is read-only until takeover is enabled")
        return session


class MessageQueueDispatcher:
    """Sends queued messages; at most one dispatch per session at a time.

    Within one process a session has at most one task. Across workers a Redis
    claim (when configured) keeps others away, and the head row's
    ``queued -> sending`` transition is the final guard: only one claimant
    ever sends a given message.
    """

    def __init__(
        self,
        store: MessageQueueRepository,
        broker: QueuePublisher | None,
        runner_factory: Callable[[], QueueRunner],
        *,
        coordinator: Any = None,
        is_online: Callable[[str], Awaitable[bool]] | None = None,
        max_concurrency: int = 16,
    ) -> None:
        self._store = store
        self._broker = broker
        self._runner_factory = runner_factory
        self._coordinator = (
            coordinator if coordinator is not None and getattr(coordinator, "distributed", False) else None
        )
        self._is_online = is_online
        self._slots = asyncio.Semaphore(max_concurrency)
        self._tasks: dict[str, asyncio.Task[None]] = {}
        # A wake that arrives while a drain runs makes the drain look again.
        self._again: set[str] = set()
        self._sweeper: asyncio.Task[None] | None = None
        self._closed = False

    # -- triggers ------------------------------------------------------------

    def wake(self, session_id: str) -> None:
        """Schedule a dispatch attempt; never blocks the caller."""
        if self._closed:
            return
        current = self._tasks.get(session_id)
        if current is not None and not current.done():
            self._again.add(session_id)
            return
        # A fresh context: the caller may hold a coordinator lock (tracked in a
        # context variable) that must not appear held inside this task.
        task = asyncio.create_task(
            self._run(session_id),
            name=f"message-queue-{session_id}",
            context=contextvars.Context(),
        )
        self._tasks[session_id] = task

        def completed(finished: asyncio.Task[None]) -> None:
            if self._tasks.get(session_id) is finished:
                self._tasks.pop(session_id, None)
            if not finished.cancelled() and (error := finished.exception()) is not None:
                logger.opt(exception=error).error(
                    "message queue dispatch crashed session_id={}", session_id
                )

        task.add_done_callback(completed)

    async def session_left_busy(self, session_id: str) -> None:
        self.wake(session_id)

    async def connector_ready(self, connector_id: str) -> None:
        for session_id in await self._store.list_sessions_with_queued_messages(
            connector_id=connector_id
        ):
            self.wake(session_id)

    def start(self) -> None:
        if self._sweeper is None:
            self._sweeper = asyncio.create_task(
                self._sweep_forever(), name="message-queue-sweep", context=contextvars.Context(),
            )

    async def close(self) -> None:
        self._closed = True
        tasks = [task for task in self._tasks.values() if not task.done()]
        if self._sweeper is not None:
            tasks.append(self._sweeper)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def sweep(self) -> None:
        """Recover stale sends and retry sessions whose wake-up was missed."""
        for session_id in await self._store.fail_stale_session_queue_sends(
            older_than_seconds=STALE_SEND_SECONDS
        ):
            await publish_queue_state(self._store, self._broker, session_id)
        for session_id in await self._store.list_sessions_with_queued_messages():
            self.wake(session_id)

    async def drain_now(self, session_id: str) -> None:
        """Run one dispatch attempt in the caller (tests and tools)."""
        await self._attempt(session_id)

    # -- internals -----------------------------------------------------------

    async def _sweep_forever(self) -> None:
        while True:
            await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
            try:
                await self.sweep()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the next sweep tries again
                logger.exception("message queue sweep failed")

    async def _run(self, session_id: str) -> None:
        async with self._slots:
            while True:
                self._again.discard(session_id)
                owner = secrets.token_urlsafe(18)
                claim_key = None
                if self._coordinator is not None:
                    claim_key = self._coordinator.key("message-queue-dispatch", session_id)
                    try:
                        if not await self._coordinator.claim(
                            claim_key, owner, ttl_seconds=_REDIS_CLAIM_TTL_SECONDS
                        ):
                            return
                    except Exception:  # noqa: BLE001 - the row claim still guards
                        claim_key = None
                try:
                    await self._attempt(session_id, owner=owner)
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001 - failures stay in the queue
                    logger.exception("message queue dispatch failed session_id={}", session_id)
                finally:
                    if claim_key is not None:
                        try:
                            await self._coordinator.delete_if_value(claim_key, owner)
                        except Exception:  # noqa: BLE001 - the claim expires on its own
                            logger.debug("message queue claim release failed session_id={}", session_id)
                if session_id not in self._again:
                    return

    async def _attempt(self, session_id: str, *, owner: str | None = None) -> None:
        owner = owner or secrets.token_urlsafe(18)
        head = await self._store.get_session_queue_head(session_id)
        if head is None or head["status"] != "queued":
            # Empty, or paused behind a failure / a send in flight.
            return
        try:
            session = await self._store.get_session(session_id)
        except KeyError:
            return
        if getattr(session, "archived", False):
            queue = await self._store.clear_session_queue(session_id)
            await publish_queue_state(self._store, self._broker, session_id, queue)
            return
        if not session.takeover:
            return
        if self._is_online is not None and not await self._is_online(session.connectorId):
            return

        runner = self._runner_factory()
        try:
            status = await runner.read_session_runtime_status(session)
        except Exception:  # noqa: BLE001 - offline or slow: the next wake retries
            logger.info("message queue status read failed session_id={}", session_id)
            return

        if status not in _DISPATCHABLE_STATUSES:
            if head["interruptRequested"] and status != "stopping":
                await self._interrupt(runner, session_id, head)
            return
        if status == "error" and not head["resumeRequested"]:
            return

        claimed = await self._store.claim_session_queue_head(
            session_id, head["messageId"], owner=owner
        )
        if claimed is None:
            return
        await publish_queue_state(self._store, self._broker, session_id)
        renewer = asyncio.create_task(self._renew(head["messageId"], owner))
        try:
            await runner.dispatch_queued_message(
                session_id, claimed, user_id=claimed["createdBy"]
            )
        except QueueNotReadyError:
            await self._store.release_session_queue_claim(
                session_id, head["messageId"], owner=owner
            )
            await publish_queue_state(self._store, self._broker, session_id)
            return
        except QueueDispatchFailure as exc:
            await self._fail(session_id, head["messageId"], owner, exc.code, exc.message)
            return
        except asyncio.CancelledError:
            # Shutdown mid-send: leave the row ``sending``; the sweep turns it
            # into a visible failure instead of risking a duplicate.
            raise
        except Exception as exc:  # noqa: BLE001 - keep the message, surface the error
            logger.exception("queued message dispatch failed session_id={}", session_id)
            await self._fail(
                session_id, head["messageId"], owner, "queue_dispatch_failed",
                str(exc) or "The queued message could not be sent.",
            )
            return
        finally:
            renewer.cancel()
            await asyncio.gather(renewer, return_exceptions=True)
        await self._store.finish_session_queue_item(
            session_id, head["messageId"], owner=owner
        )
        await publish_queue_state(self._store, self._broker, session_id)

    async def _interrupt(self, runner: QueueRunner, session_id: str, head: dict[str, Any]) -> None:
        if not await self._store.mark_session_queue_interrupt_attempted(
            session_id, head["messageId"]
        ):
            return
        try:
            await runner.interrupt_session_internal(session_id, user_id=head["createdBy"])
        except Exception:  # noqa: BLE001 - fall back to waiting in line
            logger.info("queued interrupt failed session_id={}", session_id)
            queue = await self._store.cancel_session_queue_interrupt(
                session_id, head["messageId"]
            )
            await publish_queue_state(self._store, self._broker, session_id, queue)

    async def _fail(
        self, session_id: str, message_id: str, owner: str, code: str, message: str
    ) -> None:
        await self._store.fail_session_queue_item(
            session_id, message_id, code=code, message=message, owner=owner,
        )
        await publish_queue_state(self._store, self._broker, session_id)

    async def _renew(self, message_id: str, owner: str) -> None:
        while True:
            await asyncio.sleep(_CLAIM_RENEW_SECONDS)
            try:
                await self._store.renew_session_queue_claim(message_id, owner=owner)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - the next renewal tries again
                logger.warning("message queue claim renewal failed message_id={}", message_id)
