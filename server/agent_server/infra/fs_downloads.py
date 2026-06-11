from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass
from typing import AsyncIterator


DEFAULT_TRANSFER_TTL_SECONDS = 300.0


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
    queue: asyncio.Queue[bytes | None]


class FsDownloadRelayManager:
    def __init__(
        self,
        *,
        ttl_seconds: float = DEFAULT_TRANSFER_TTL_SECONDS,
        clock=time.monotonic,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        self._transfers: dict[str, FsDownloadTransfer] = {}

    def create(
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
            queue=asyncio.Queue(maxsize=8),
        )
        self._transfers[transfer_id] = transfer
        return transfer

    def get(self, transfer_id: str, token: str) -> FsDownloadTransfer | None:
        self.expire()
        transfer = self._transfers.get(transfer_id)
        if transfer is None or transfer.token != token:
            return None
        return transfer

    async def upload(
        self,
        *,
        transfer_id: str,
        token: str,
        chunks: AsyncIterator[bytes],
    ) -> bool:
        transfer = self.get(transfer_id, token)
        if transfer is None:
            return False
        try:
            async for chunk in chunks:
                if chunk:
                    await transfer.queue.put(chunk)
            await transfer.queue.put(None)
            return True
        except Exception:
            await transfer.queue.put(None)
            raise

    async def stream(self, *, transfer_id: str, token: str) -> AsyncIterator[bytes]:
        transfer = self.get(transfer_id, token)
        if transfer is None:
            return
        try:
            while True:
                remaining = max(transfer.expires_at_monotonic - self._clock(), 0.0)
                if remaining <= 0:
                    break
                try:
                    chunk = await asyncio.wait_for(transfer.queue.get(), timeout=remaining)
                except TimeoutError:
                    break
                if chunk is None:
                    break
                yield chunk
        finally:
            self._transfers.pop(transfer_id, None)

    def expire(self) -> None:
        now = self._clock()
        for transfer_id, transfer in list(self._transfers.items()):
            if transfer.expires_at_monotonic < now:
                try:
                    transfer.queue.put_nowait(None)
                except asyncio.QueueFull:
                    pass
                self._transfers.pop(transfer_id, None)
