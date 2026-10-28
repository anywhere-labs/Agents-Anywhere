"""Flow-controlled large envelopes on the existing worker Pub/Sub channels.

Only one incoming transfer pulls data at a time. Small requests/replies keep
their original envelope and bypass that queue. There are no Redis storage keys,
operation results, or automatic retransmissions in this framing layer.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import math
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from meshcall.transport import DEFAULT_MAX_FRAME_SIZE
from redis.asyncio import Redis
from redis.asyncio.retry import Retry
from redis.backoff import NoBackoff
from redis.exceptions import RedisError

from agent_server.infra.connector_control_log import control_log, error_fields
from agent_server.infra.redis_coordinator import RedisCoordinator

CHUNK_BYTES = 256 * 1024
MAX_ENVELOPE_BYTES = DEFAULT_MAX_FRAME_SIZE + 64 * 1024
TRANSFER_SECONDS = 30.0
CHUNK_WAIT_SECONDS = 5.0
_FRAME_TYPES = frozenset({"relay.open", "relay.pull", "relay.data", "relay.abort"})


@dataclass
class _Outbound:
    receiver: str
    data: bytes
    done: asyncio.Future[int]
    next_chunk: int = 0


class ConnectorRpcFrames:
    def __init__(self, coordinator: RedisCoordinator, instance_id: str,
                 deliver: Callable[[dict[str, Any]], None]) -> None:
        self._coordinator, self._instance_id, self._deliver = coordinator, instance_id, deliver
        self._outbound: dict[str, _Outbound] = {}
        self._incoming: dict[str, dict] = {}
        self._waiting: dict[str, tuple[int, str, asyncio.Future]] = {}
        self._queue: asyncio.Queue[dict] = asyncio.Queue()
        self._reader: asyncio.Task | None = None
        self._writers: set[asyncio.Task] = set()
        self._closed = False

    async def _publish(self, receiver: str, payload: dict | bytes) -> int:
        encoded = payload if isinstance(payload, bytes) else json.dumps(payload, separators=(",", ":")).encode()
        client = self._coordinator.client
        channel = self._coordinator.channel("connector-rpc", receiver)
        if not isinstance(client, Redis):
            return await client.publish(channel, encoded)
        # A single-connection client exclusively leases this pool connection.
        # Changing its retry policy cannot affect concurrent commands. PUBLISH
        # must never replay an envelope after a lost command response.
        async with client.client() as publisher:
            connection = publisher.connection
            previous = connection.retry
            connection.retry = Retry(NoBackoff(), 0)
            try:
                return await publisher.publish(channel, encoded)
            finally:
                connection.retry = previous

    async def publish(self, receiver: str, payload: dict, *, timeout: float = TRANSFER_SECONDS) -> int:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        if len(encoded) > MAX_ENVELOPE_BYTES:
            raise RedisError("connector relay envelope exceeds the control frame budget")
        if self._closed:
            raise RedisError("connector relay is closed")
        if len(encoded) <= CHUNK_BYTES:
            async with asyncio.timeout(timeout):
                return await self._publish(receiver, encoded)
        identity = f"xfr_{secrets.token_urlsafe(18)}"
        done = asyncio.get_running_loop().create_future()
        # Observe failures even if the request's deadline simultaneously detaches.
        done.add_done_callback(lambda future: None if future.cancelled() else future.exception())
        outgoing = _Outbound(receiver, encoded, done)
        self._outbound[identity] = outgoing
        fields = {"routeRequestId": identity, "callId": payload.get("controlCallId"), "phase": "framing",
                  "sourceWorkerId": self._instance_id, "targetWorkerId": receiver}
        control_log("redis.transfer.started", level="DEBUG", **fields)
        try:
            async with asyncio.timeout(timeout):
                subscribers = await self._publish(receiver, {
                    "type": "relay.open", "transferId": identity, "sender": self._instance_id,
                    "size": len(encoded), "expiresAt": time.time() + timeout})
                if not subscribers:
                    if outgoing.next_chunk:
                        raise RedisError("connector relay destination disconnected after transfer started")
                    return 0
                # Each pull is answered once; a lost final publication is never
                # retried as a logical request. Its business outcome is unknown.
                return await done
        finally:
            self._outbound.pop(identity, None)
            if not done.done():
                done.cancel()
            control_log("redis.transfer.finished", level="DEBUG", **fields)

    def accept(self, payload: dict) -> bool:
        kind, identity, sender = payload.get("type"), payload.get("transferId"), payload.get("sender")
        if not isinstance(kind, str) or kind not in _FRAME_TYPES:
            return False
        if self._closed or not isinstance(identity, str) or not isinstance(sender, str):
            return True
        if kind == "relay.open":
            size, expires = payload.get("size"), payload.get("expiresAt")
            if (type(size) is not int or not CHUNK_BYTES < size <= MAX_ENVELOPE_BYTES
                    or not isinstance(expires, (int, float)) or not math.isfinite(expires)
                    or expires <= time.time() or identity in self._incoming):
                return True
            self._incoming[identity] = payload
            self._queue.put_nowait(payload)
            if self._reader is None or self._reader.done():
                self._reader = asyncio.create_task(self._read(), name="connector-relay-reader")
        elif kind == "relay.pull":
            outgoing = self._outbound.get(identity)
            index = payload.get("index")
            if (outgoing is not None and outgoing.receiver == sender and not outgoing.done.done()
                    and type(index) is int and index == outgoing.next_chunk):
                # Advance before publishing. Duplicate pulls/opens cannot replay
                # a completed envelope, including when PUBLISH itself retries.
                outgoing.next_chunk += 1
                task = asyncio.create_task(self._write(identity, index, outgoing), name="connector-relay-writer")
                self._writers.add(task)
                task.add_done_callback(self._writers.discard)
            elif outgoing is None:
                self._spawn_abort(sender, identity)
        else:
            outgoing = self._outbound.get(identity)
            if kind == "relay.abort" and outgoing is not None and outgoing.receiver == sender and not outgoing.done.done():
                outgoing.done.set_exception(RedisError("connector relay transfer aborted"))
            expected = self._waiting.get(identity)
            if expected is not None and expected[1] == sender and not expected[2].done():
                index, _, future = expected
                if kind == "relay.abort":
                    future.set_exception(RedisError("connector relay source unavailable"))
                elif type(payload.get("index")) is int and payload["index"] == index:
                    future.set_result(payload.get("data"))
        return True

    def _spawn_abort(self, receiver: str, identity: str) -> None:
        async def abort() -> None:
            try:
                async with asyncio.timeout(CHUNK_WAIT_SECONDS):
                    await self._publish(receiver, {"type": "relay.abort", "transferId": identity, "sender": self._instance_id})
            except (RedisError, OSError, TimeoutError):
                pass
        task = asyncio.create_task(abort(), name="connector-relay-abort")
        self._writers.add(task)
        task.add_done_callback(self._writers.discard)

    async def _write(self, identity: str, index: int, outgoing: _Outbound) -> None:
        try:
            async with asyncio.timeout(TRANSFER_SECONDS):
                data = outgoing.data[index * CHUNK_BYTES:(index + 1) * CHUNK_BYTES]
                subscribers = await self._publish(outgoing.receiver, {
                    "type": "relay.data", "transferId": identity, "sender": self._instance_id,
                    "index": index, "data": base64.b64encode(data).decode("ascii")})
                if not outgoing.done.done():
                    if not subscribers:
                        outgoing.done.set_exception(RedisError("connector relay destination disconnected"))
                    elif (index + 1) * CHUNK_BYTES >= len(outgoing.data):
                        outgoing.done.set_result(subscribers)
        except Exception as error:  # noqa: BLE001 - settle the waiting publisher, never replay a chunk
            if not outgoing.done.done():
                outgoing.done.set_exception(error)

    async def _read(self) -> None:
        while not self._closed:
            opened = await self._queue.get()
            identity, sender, size = opened["transferId"], opened["sender"], opened["size"]
            try:
                remaining = opened["expiresAt"] - time.time()
                async with asyncio.timeout(remaining):
                    data = bytearray()
                    for index in range((size + CHUNK_BYTES - 1) // CHUNK_BYTES):
                        future = asyncio.get_running_loop().create_future()
                        self._waiting[identity] = (index, sender, future)
                        async with asyncio.timeout(CHUNK_WAIT_SECONDS):
                            subscribers = await self._publish(sender, {
                                "type": "relay.pull", "transferId": identity, "sender": self._instance_id, "index": index})
                            if not subscribers:
                                raise RedisError("connector relay source unavailable")
                            encoded = await future
                        if not isinstance(encoded, str) or len(encoded) > 4 * ((CHUNK_BYTES + 2) // 3):
                            raise RedisError("invalid connector relay chunk")
                        chunk = base64.b64decode(encoded, validate=True)
                        if len(chunk) != min(CHUNK_BYTES, size - len(data)):
                            raise RedisError("invalid connector relay chunk length")
                        data.extend(chunk)
                    message = json.loads(data)
                    if (not isinstance(message, dict) or not isinstance(message.get("type"), str)
                            or message["type"] in _FRAME_TYPES):
                        raise RedisError("invalid connector relay envelope")
                    self._deliver(message)
            except (RedisError, OSError, TimeoutError, ValueError, binascii.Error) as error:
                self._spawn_abort(sender, identity)
                control_log("redis.transfer.failed", level="WARNING", routeRequestId=identity,
                            sourceWorkerId=sender, targetWorkerId=self._instance_id, **error_fields(error, stack=False))
            finally:
                self._waiting.pop(identity, None)
                self._incoming.pop(identity, None)
                self._queue.task_done()

    async def reset(self) -> None:
        """Abort partial transport state on a lost subscription, without replay."""
        tasks = [*self._writers, *([self._reader] if self._reader is not None else [])]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._reader = None
        self._writers.clear()
        self._waiting.clear()
        self._incoming.clear()
        self._queue = asyncio.Queue()
        for outgoing in tuple(self._outbound.values()):
            if not outgoing.done.done():
                outgoing.done.set_exception(RedisError("connector relay subscription disconnected"))

    async def close(self) -> None:
        self._closed = True
        await self.reset()
