"""Outbox 同步的毒通知剔除：永久拒绝不得卡死整批（2026-11-03 事故回归）。"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from connector.runtimes.acp.application.synchronization import SynchronizationService
from connector.server.ingest import ConnectorIngestRejectedError


class FakeStore:
    def __init__(self, rows):
        self.rows = list(rows)

    def pending(self, limit: int = 128):
        return [(seq, key, value) for seq, key, value in self.rows[:limit]]

    def acknowledge(self, keys):
        drop = set(keys)
        self.rows = [r for r in self.rows if r[1] not in drop]

    class _Tx:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def transaction(self):
        return self._Tx()


def _response(status: int) -> httpx.Response:
    return httpx.Response(status, request=httpx.Request("POST", "https://x/api"))


def test_flush_drops_poison_and_delivers_rest():
    """一条被拒通知只丢自己，同批其余照常投递。"""
    rows = [
        (1, "a", {"method": "session.state.updated", "params": {"sessionId": "s1"}}),
        (2, "b", {"method": "session.meta.upsert", "params": {"sessionId": "poison"}}),
        (3, "c", {"method": "session.state.updated", "params": {"sessionId": "s2"}}),
    ]
    store = FakeStore(rows)
    delivered = []

    async def publish(notices):
        if any(
            (n.get("params") or {}).get("sessionId") == "poison" for n in notices
        ):
            raise httpx.HTTPStatusError(
                "400", request=httpx.Request("POST", "https://x"), response=_response(400)
            )
        delivered.extend(notices)

    sync = SynchronizationService(store, publish)
    asyncio.run(sync.flush())

    assert store.rows == []
    sessions = {(n.get("params") or {}).get("sessionId") for n in delivered}
    assert sessions == {"s1", "s2"}


def test_flush_rejects_entire_batch_response_are_dropped():
    """HTTP 200 但逐条拒收（ConnectorIngestRejectedError）同样跳过毒条。"""
    rows = [
        (1, "a", {"method": "timeline.itemUpsert", "params": {"sessionId": "s1"}}),
        (2, "b", {"method": "session.meta.upsert", "params": {"sessionId": "bad"}}),
    ]
    store = FakeStore(rows)

    async def publish(notices):
        if any((n.get("params") or {}).get("sessionId") == "bad" for n in notices):
            raise ConnectorIngestRejectedError("rejected 1")

    sync = SynchronizationService(store, publish)
    asyncio.run(sync.flush())
    assert store.rows == []


def test_flush_transient_error_keeps_rows_for_retry():
    """网络类瞬时错误必须抛出并保留队列（不得误删）。"""
    rows = [
        (1, "a", {"method": "session.state.updated", "params": {"sessionId": "s1"}}),
    ]
    store = FakeStore(rows)

    async def publish(notices):
        raise RuntimeError("backend ingest request failed: boom")

    sync = SynchronizationService(store, publish)
    with pytest.raises(RuntimeError):
        asyncio.run(sync.flush())
    assert len(store.rows) == 1
