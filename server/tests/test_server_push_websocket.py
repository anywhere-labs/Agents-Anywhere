from __future__ import annotations

import asyncio
from typing import Any, cast

import pytest
from fastapi import WebSocket

from agent_server.api.server_push_websocket import (
    run_server_push_until_disconnect,
)


class FakeWebSocket:
    def __init__(self) -> None:
        self.inbound: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def receive(self) -> dict[str, Any]:
        return await self.inbound.get()


def test_disconnect_cancels_outbound_stream() -> None:
    async def exercise() -> None:
        websocket = FakeWebSocket()
        stream_cancelled = asyncio.Event()

        async def outbound_stream() -> None:
            try:
                await asyncio.Event().wait()
            finally:
                stream_cancelled.set()

        websocket.inbound.put_nowait(
            {"type": "websocket.disconnect", "code": 1000}
        )
        await run_server_push_until_disconnect(
            cast(WebSocket, websocket),
            outbound_stream(),
        )
        await asyncio.sleep(0)

        assert stream_cancelled.is_set()

    asyncio.run(exercise())


@pytest.mark.parametrize(
    "message",
    [
        'Cannot call "send" once a close message has been sent.',
        (
            "Unexpected ASGI message 'websocket.send', after sending "
            "'websocket.close'."
        ),
    ],
)
def test_send_after_close_is_a_normal_disconnect(message: str) -> None:
    async def exercise() -> None:
        websocket = FakeWebSocket()

        async def outbound_stream() -> None:
            raise RuntimeError(message)

        await run_server_push_until_disconnect(
            cast(WebSocket, websocket),
            outbound_stream(),
        )

    asyncio.run(exercise())


def test_unexpected_outbound_error_is_not_hidden() -> None:
    async def exercise() -> None:
        websocket = FakeWebSocket()

        async def outbound_stream() -> None:
            raise RuntimeError("snapshot projection failed")

        with pytest.raises(RuntimeError, match="snapshot projection failed"):
            await run_server_push_until_disconnect(
                cast(WebSocket, websocket),
                outbound_stream(),
            )

    asyncio.run(exercise())


def test_external_cancellation_still_propagates() -> None:
    async def exercise() -> None:
        websocket = FakeWebSocket()

        async def outbound_stream() -> None:
            await asyncio.Event().wait()

        stream_task = asyncio.create_task(
            run_server_push_until_disconnect(
                cast(WebSocket, websocket),
                outbound_stream(),
            )
        )
        await asyncio.sleep(0)
        stream_task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await stream_task

    asyncio.run(exercise())
