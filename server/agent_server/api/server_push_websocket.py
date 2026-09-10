from __future__ import annotations

import asyncio
from collections.abc import Coroutine

from fastapi import WebSocket, WebSocketDisconnect

_CLOSED_SEND_ERRORS = frozenset(
    {
        'Cannot call "send" once a close message has been sent.',
        (
            "Unexpected ASGI message 'websocket.send', after sending "
            "'websocket.close'."
        ),
    }
)


def is_closed_websocket_send_error(error: RuntimeError) -> bool:
    """Return whether an ASGI server rejected a send after closing the socket."""

    return str(error) in _CLOSED_SEND_ERRORS


def consume_cancelled_task_result(task: asyncio.Task[None]) -> None:
    """Retrieve the terminal state of a task cancelled during socket shutdown."""

    if task.cancelled():
        return
    task.exception()


def cancel_websocket_task(task: asyncio.Task[None]) -> None:
    """Request cancellation without delaying the WebSocket disconnect path."""

    if task.done():
        return
    task.add_done_callback(consume_cancelled_task_result)
    task.cancel()


async def wait_for_websocket_disconnect(websocket: WebSocket) -> None:
    """Consume inbound frames until the client disconnects.

    Server-push streams do not define client messages, so non-disconnect frames
    are intentionally ignored.
    """

    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return


async def run_server_push_until_disconnect(
    websocket: WebSocket,
    outbound_stream: Coroutine[object, object, None],
) -> None:
    """Run an outbound stream while monitoring the client connection.

    Side effects:
    - consumes inbound WebSocket frames
    - cancels the unfinished task when the other side completes
    """

    outbound_task = asyncio.create_task(outbound_stream)
    disconnect_task = asyncio.create_task(wait_for_websocket_disconnect(websocket))
    tasks = (outbound_task, disconnect_task)

    try:
        completed, _pending = await asyncio.wait(
            tasks,
            return_when=asyncio.FIRST_COMPLETED,
        )

        if disconnect_task in completed:
            try:
                disconnect_task.result()
            except WebSocketDisconnect:
                pass
            if outbound_task.done() and not outbound_task.cancelled():
                complete_outbound_stream(outbound_task)
            else:
                cancel_websocket_task(outbound_task)
            return

        cancel_websocket_task(disconnect_task)
        complete_outbound_stream(outbound_task)
    except asyncio.CancelledError:
        for task in tasks:
            cancel_websocket_task(task)
        raise


def complete_outbound_stream(outbound_task: asyncio.Task[None]) -> None:
    """Raise only errors that do not represent an already closed connection."""

    try:
        outbound_task.result()
    except WebSocketDisconnect:
        return
    except RuntimeError as error:
        if is_closed_websocket_send_error(error):
            return
        raise
