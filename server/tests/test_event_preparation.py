from __future__ import annotations

import asyncio
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from agent_server.infra import event_preparation
from agent_server.infra.event_preparation import (
    EventPreparationCapacityError,
    EventPreparationPool,
)

RAW = json.dumps(
    {
        "sessionId": "session",
        "nextSeq": 7,
        "items": [
            {
                "id": "item",
                "updatedSeq": 7,
                "revision": 2,
                "content": {"text": "正文" * 100_000},
            }
        ],
    }
)


def test_process_pool_preserves_complete_wire_event():
    async def exercise():
        pool = EventPreparationPool(workers=1, threshold_bytes=1)
        await pool.start()
        try:
            events = await pool.prepare(RAW)
            encoded = json.loads(events[0].encoded_json)
            assert encoded["sequence"] == 7
            assert encoded["payload"]["item"] == json.loads(RAW)["items"][0]
            assert pool.pending == 0 and pool.pending_bytes == 0
        finally:
            await pool.close()

    asyncio.run(exercise())


def test_admission_is_bounded_and_cancelled_work_keeps_its_slot(monkeypatch):
    # A controlled thread worker exercises the same Future/cancellation path
    # without timing-dependent sleeps or communicating test gates through IPC.
    monkeypatch.setattr(
        event_preparation,
        "ProcessPoolExecutor",
        lambda *, max_workers, mp_context: ThreadPoolExecutor(max_workers=max_workers),
    )

    async def exercise():
        pool = EventPreparationPool(workers=1, threshold_bytes=1, max_pending=2)
        await pool.start()
        started, release = threading.Event(), threading.Event()

        def blocked(raw):
            started.set()
            assert release.wait(timeout=5)
            return ()

        monkeypatch.setattr(event_preparation, "prepare_session_events", blocked)
        first = asyncio.create_task(pool.prepare(RAW))
        await asyncio.to_thread(started.wait, 5)
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        assert pool.pending == 1
        second = asyncio.create_task(pool.prepare(RAW))
        await asyncio.sleep(0)
        assert pool.pending == 2
        with pytest.raises(EventPreparationCapacityError):
            await pool.prepare(RAW)
        second.cancel()
        await asyncio.gather(second, return_exceptions=True)
        assert pool.pending == 1
        release.set()
        await pool.close()
        assert pool.pending == 0 and pool.pending_bytes == 0

    asyncio.run(exercise())


def test_byte_budget_rejects_before_submission_and_small_events_stay_inline():
    async def exercise():
        pool = EventPreparationPool(workers=1, threshold_bytes=16, max_pending_bytes=32)
        # Small keepalive/empty inputs need neither a worker nor an allocation.
        assert await pool.prepare("null") == ()
        # Install a sentinel only to verify admission happens before submission.
        pool._executor = object()
        with pytest.raises(EventPreparationCapacityError):
            await pool.prepare(RAW)
        assert pool.pending == 0 and pool.pending_bytes == 0
        pool._executor = None
        await pool.close()

    asyncio.run(exercise())


def test_shutdown_rejects_waiting_jobs_without_using_the_default_executor(monkeypatch):
    monkeypatch.setattr(
        event_preparation,
        "ProcessPoolExecutor",
        lambda *, max_workers, mp_context: ThreadPoolExecutor(max_workers=max_workers),
    )

    async def exercise():
        pool = EventPreparationPool(workers=1, threshold_bytes=1)
        await pool.start()
        started, release = threading.Event(), threading.Event()
        calls = 0

        def blocked(raw):
            nonlocal calls
            calls += 1
            started.set()
            assert release.wait(timeout=5)
            return ()

        monkeypatch.setattr(event_preparation, "prepare_session_events", blocked)
        first = asyncio.create_task(pool.prepare(RAW))
        assert await asyncio.to_thread(started.wait, 5)
        waiting = asyncio.create_task(pool.prepare(RAW))
        await asyncio.sleep(0)
        assert pool.pending == 2
        closing = asyncio.create_task(pool.close())
        await asyncio.sleep(0)
        release.set()
        await first
        with pytest.raises(EventPreparationCapacityError):
            await waiting
        await closing
        assert calls == 1
        assert pool.pending == 0 and pool.pending_bytes == 0

    asyncio.run(exercise())
