from __future__ import annotations

import asyncio
import base64
import json
import math
import secrets
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass

from agent_server.infra.redis_coordinator import RedisCoordinator

DEFAULT_TRANSFER_TTL_SECONDS = 300.0
TRANSFER_CHUNK_BYTES = 64 * 1024
TRANSFER_QUEUE_CHUNKS = 8
_END_MESSAGE = "end"
_ERROR_MESSAGE = "error"


@dataclass(slots=True)
class FsDownloadTransfer:
    transfer_id: str
    token: str
    connector_id: str
    root: str
    path: str
    name: str
    size: int
    sha256: str
    media_type: str
    expires_at_monotonic: float
    queue: asyncio.Queue[bytes | None] | None = None

    def _payload(self) -> dict[str, str | int]:
        return {
            "transfer_id": self.transfer_id,
            "token": self.token,
            "connector_id": self.connector_id,
            "root": self.root,
            "path": self.path,
            "name": self.name,
            "size": self.size,
            "sha256": self.sha256,
            "media_type": self.media_type,
        }


class FsDownloadRelayManager:
    """Bounded, ephemeral relay for connector-to-browser file downloads."""

    def __init__(
        self,
        coordinator: RedisCoordinator | None = None,
        *,
        ttl_seconds: float = DEFAULT_TRANSFER_TTL_SECONDS,
        clock=time.monotonic,
    ) -> None:
        self._coordinator = coordinator or RedisCoordinator()
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        self._transfers: dict[str, FsDownloadTransfer] = {}

    async def create(
        self,
        *,
        connector_id: str,
        root: str,
        path: str,
        name: str,
        size: int,
        sha256: str,
        media_type: str,
    ) -> FsDownloadTransfer:
        self.expire()
        transfer_id = f"fsdl_{secrets.token_urlsafe(18)}"
        transfer = FsDownloadTransfer(
            transfer_id=transfer_id,
            token=secrets.token_urlsafe(32),
            connector_id=connector_id,
            root=root,
            path=path,
            name=name,
            size=size,
            sha256=sha256,
            media_type=media_type,
            expires_at_monotonic=self._clock() + self._ttl_seconds,
            queue=None
            if self._coordinator.distributed
            else asyncio.Queue(maxsize=TRANSFER_QUEUE_CHUNKS),
        )
        if self._coordinator.distributed:
            await self._coordinator.client.set(
                self._metadata_key(transfer_id),
                json.dumps(
                    transfer._payload(), ensure_ascii=False, separators=(",", ":")
                ),
                px=max(1, math.ceil(self._ttl_seconds * 1000)),
            )
        else:
            self._transfers[transfer_id] = transfer
        return transfer

    async def get(self, transfer_id: str, token: str) -> FsDownloadTransfer | None:
        if self._coordinator.distributed:
            raw = await self._coordinator.client.get(self._metadata_key(transfer_id))
            if not isinstance(raw, (str, bytes)):
                return None
            try:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                payload = json.loads(raw)
                if not isinstance(payload, dict) or not secrets.compare_digest(
                    str(payload["token"]), token
                ):
                    return None
                ttl_ms = await self._coordinator.client.pttl(
                    self._metadata_key(transfer_id)
                )
                if not isinstance(ttl_ms, int) or ttl_ms <= 0:
                    return None
                return FsDownloadTransfer(
                    transfer_id=str(payload["transfer_id"]),
                    token=str(payload["token"]),
                    connector_id=str(payload["connector_id"]),
                    root=str(payload["root"]),
                    path=str(payload["path"]),
                    name=str(payload["name"]),
                    size=int(payload["size"]),
                    sha256=str(payload["sha256"]),
                    media_type=str(payload["media_type"]),
                    expires_at_monotonic=self._clock() + (ttl_ms / 1000),
                )
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                return None
        self.expire()
        transfer = self._transfers.get(transfer_id)
        if transfer is None or not secrets.compare_digest(transfer.token, token):
            return None
        return transfer

    async def upload(
        self,
        *,
        transfer_id: str,
        token: str,
        chunks: AsyncIterator[bytes],
    ) -> bool:
        transfer = await self.get(transfer_id, token)
        if transfer is None:
            return False
        if not self._coordinator.distributed:
            assert transfer.queue is not None
            try:
                async for chunk in chunks:
                    if chunk:
                        await transfer.queue.put(chunk)
                await transfer.queue.put(None)
                return True
            except Exception:
                await transfer.queue.put(None)
                raise

        try:
            async for chunk in chunks:
                for offset in range(0, len(chunk), TRANSFER_CHUNK_BYTES):
                    part = chunk[offset : offset + TRANSFER_CHUNK_BYTES]
                    if part and not await self._enqueue_distributed(
                        transfer,
                        "data:" + base64.b64encode(part).decode("ascii"),
                    ):
                        return False
            return await self._enqueue_distributed(transfer, _END_MESSAGE)
        except Exception:
            await self._coordinator.client.rpush(
                self._queue_key(transfer_id), _ERROR_MESSAGE
            )
            await self._coordinator.client.pexpire(
                self._queue_key(transfer_id),
                max(1, math.ceil(self._ttl_seconds * 1000)),
            )
            raise

    async def stream(self, *, transfer_id: str, token: str) -> AsyncIterator[bytes]:
        transfer = await self.get(transfer_id, token)
        if transfer is None:
            return
        if not self._coordinator.distributed:
            assert transfer.queue is not None
            try:
                while True:
                    remaining = max(transfer.expires_at_monotonic - self._clock(), 0.0)
                    if remaining <= 0:
                        break
                    try:
                        chunk = await asyncio.wait_for(
                            transfer.queue.get(), timeout=remaining
                        )
                    except TimeoutError:
                        break
                    if chunk is None:
                        break
                    yield chunk
            finally:
                self._transfers.pop(transfer_id, None)
            return

        queue_key = self._queue_key(transfer_id)
        try:
            while True:
                remaining = max(transfer.expires_at_monotonic - self._clock(), 0.0)
                if remaining <= 0:
                    break
                item = await self._coordinator.client.blpop(
                    queue_key, timeout=remaining
                )
                if item is None:
                    break
                message = item[1]
                if isinstance(message, bytes):
                    message = message.decode("utf-8")
                if message == _END_MESSAGE or message == _ERROR_MESSAGE:
                    break
                if isinstance(message, str) and message.startswith("data:"):
                    try:
                        yield base64.b64decode(message[5:], validate=True)
                    except ValueError:
                        break
        finally:
            await self._coordinator.client.delete(
                self._metadata_key(transfer_id), queue_key
            )

    async def _enqueue_distributed(
        self,
        transfer: FsDownloadTransfer,
        message: str,
    ) -> bool:
        queue_key = self._queue_key(transfer.transfer_id)
        while self._clock() < transfer.expires_at_monotonic:
            if not await self._coordinator.client.exists(
                self._metadata_key(transfer.transfer_id)
            ):
                return False
            if await self._coordinator.client.llen(queue_key) < TRANSFER_QUEUE_CHUNKS:
                await self._coordinator.client.rpush(queue_key, message)
                remaining_ms = max(
                    1,
                    math.ceil((transfer.expires_at_monotonic - self._clock()) * 1000),
                )
                await self._coordinator.client.pexpire(queue_key, remaining_ms)
                return True
            await asyncio.sleep(0.01)
        return False

    def expire(self) -> None:
        if self._coordinator.distributed:
            return
        now = self._clock()
        for transfer_id, transfer in list(self._transfers.items()):
            if transfer.expires_at_monotonic < now:
                assert transfer.queue is not None
                try:
                    transfer.queue.put_nowait(None)
                except asyncio.QueueFull:
                    pass
                self._transfers.pop(transfer_id, None)

    def _metadata_key(self, transfer_id: str) -> str:
        return self._coordinator.key("fs-download", transfer_id)

    def _queue_key(self, transfer_id: str) -> str:
        return self._coordinator.key("fs-download", transfer_id, "chunks")
