"""Complete owned transport cleanup before propagating caller cancellation."""

from __future__ import annotations

import asyncio

from anyio import CancelScope


async def complete_cleanup(work):
    task = asyncio.ensure_future(work)
    cancellation = None
    with CancelScope(shield=True):
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError as error:
                if task.cancelled():
                    raise
                cancellation = error
        result = task.result()
    if cancellation is not None:
        raise cancellation
    return result
