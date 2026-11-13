from __future__ import annotations

import asyncio
import time

import pytest

from agent_server.infra.fs_downloads import (
    TRANSFER_QUEUE_CHUNKS,
    FsDownloadRelayManager,
)


async def _transfer(manager):
    return await manager.create(
        connector_id="conn_1",
        root="/repo",
        path="/repo/file.txt",
        name="file.txt",
        size=12,
        sha256="abc",
        media_type="text/plain",
    )


@pytest.mark.parametrize("ending", ["download_closed", "expired", "deadline"])
def test_local_upload_exits_when_full_queue_transfer_ends(ending):
    async def exercise():
        now = [0.0]
        manager = FsDownloadRelayManager(
            ttl_seconds=0.05 if ending == "deadline" else 300,
            clock=time.monotonic if ending == "deadline" else lambda: now[0],
        )
        transfer = await _transfer(manager)
        stream = manager.stream(transfer_id=transfer.transfer_id, token=transfer.token)
        await transfer.queue.put(b"a")
        assert await anext(stream) == b"a"
        blocked = asyncio.Event()

        async def chunks():
            for index in range(TRANSFER_QUEUE_CHUNKS + 1):
                if index == TRANSFER_QUEUE_CHUNKS:
                    blocked.set()
                yield b"b"

        task = asyncio.create_task(
            manager.upload(
                transfer_id=transfer.transfer_id,
                token=transfer.token,
                chunks=chunks(),
            )
        )
        try:
            await asyncio.wait_for(blocked.wait(), timeout=1)
            assert transfer.queue.full()
            assert not task.done()
            if ending == "download_closed":
                await stream.aclose()
            elif ending == "expired":
                now[0] = 301
                manager.expire()
            assert await asyncio.wait_for(task, timeout=1) is False
            if ending != "deadline":
                assert await manager.get(transfer.transfer_id, transfer.token) is None
        finally:
            await stream.aclose()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(exercise())


def test_local_upload_keeps_backpressure_and_completes_without_data_loss():
    async def exercise():
        manager = FsDownloadRelayManager()
        transfer = await _transfer(manager)
        blocked = asyncio.Event()
        expected = [bytes([index]) for index in range(12)]

        async def chunks():
            for index, chunk in enumerate(expected):
                if index == TRANSFER_QUEUE_CHUNKS:
                    blocked.set()
                yield chunk

        task = asyncio.create_task(
            manager.upload(
                transfer_id=transfer.transfer_id,
                token=transfer.token,
                chunks=chunks(),
            )
        )
        try:
            await asyncio.wait_for(blocked.wait(), timeout=1)
            assert transfer.queue.qsize() == TRANSFER_QUEUE_CHUNKS
            assert not task.done()
            received = [
                chunk
                async for chunk in manager.stream(
                    transfer_id=transfer.transfer_id,
                    token=transfer.token,
                )
            ]
            assert await asyncio.wait_for(task, timeout=1) is True
            assert received == expected
            assert await manager.get(transfer.transfer_id, transfer.token) is None
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(exercise())


def test_local_upload_error_does_not_hang_after_consumer_closes():
    async def exercise():
        manager = FsDownloadRelayManager()
        transfer = await _transfer(manager)
        stream = manager.stream(transfer_id=transfer.transfer_id, token=transfer.token)
        await transfer.queue.put(b"a")
        assert await anext(stream) == b"a"
        failed = asyncio.Event()

        async def chunks():
            for _ in range(TRANSFER_QUEUE_CHUNKS):
                yield b"b"
            failed.set()
            raise ValueError("upload failed")

        task = asyncio.create_task(
            manager.upload(
                transfer_id=transfer.transfer_id,
                token=transfer.token,
                chunks=chunks(),
            )
        )
        try:
            await asyncio.wait_for(failed.wait(), timeout=1)
            assert transfer.queue.full()
            await stream.aclose()
            with pytest.raises(ValueError, match="upload failed"):
                await asyncio.wait_for(task, timeout=1)
        finally:
            await stream.aclose()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    asyncio.run(exercise())


def test_cancelling_local_upload_leaves_no_queue_waiters():
    async def exercise():
        manager = FsDownloadRelayManager()
        transfer = await _transfer(manager)
        for _ in range(TRANSFER_QUEUE_CHUNKS):
            transfer.queue.put_nowait(b"a")
        started = asyncio.Event()

        async def chunks():
            started.set()
            yield b"b"

        task = asyncio.create_task(
            manager.upload(
                transfer_id=transfer.transfer_id,
                token=transfer.token,
                chunks=chunks(),
            )
        )
        await asyncio.wait_for(started.wait(), timeout=1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not [
            task for task in asyncio.all_tasks() if task is not asyncio.current_task()
        ]

    asyncio.run(exercise())
