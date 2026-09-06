from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus

from connector.local.terminal import TerminalNotFoundError
from connector.logging import logger
from connector.server.urls import api_v2_path, is_loopback_url
from connector.server.urls import ws_url as build_ws_url


class TerminalRelayRunner:
    def __init__(self, server_url: str, local_ops: Any) -> None:
        self.server_url = server_url
        self.local_ops = local_ops

    async def run(self, terminal_id: str, token: str, *, attach: bool = False) -> None:
        relay_url = build_ws_url(
            self.server_url, api_v2_path(f"/connector/terminals/{terminal_id}/relay")
        )
        relay_url = f"{relay_url}?token={token}"
        delay = 0.5
        while True:
            try:
                await self._connect(relay_url, terminal_id)
            except asyncio.CancelledError:
                raise
            except TerminalNotFoundError:
                return
            except ConnectionClosed as exc:
                if exc.rcvd is not None and exc.rcvd.code in {1008, 4401, 4404}:
                    return
                if not attach:
                    raise
            except InvalidStatus as exc:
                if not attach or exc.response.status_code < 500:
                    raise
            except (OSError, TimeoutError):
                if not attach:
                    raise
            else:
                if not attach:
                    return
            if attach:
                # A transport failure does not destroy the PTY or enable the
                # control-channel notification fallback.
                try:
                    await self.local_ops.terminal.snapshot({"terminalId": terminal_id})
                except KeyError:
                    return
            logger.info("reconnecting terminal relay terminal_id={}", terminal_id)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 5)

    async def _connect(self, relay_url: str, terminal_id: str) -> None:
        async with websockets.connect(
            relay_url,
            proxy=None if is_loopback_url(self.server_url) else True,
            max_size=4 * 1024 * 1024,
        ) as ws:
            start = json.loads(await ws.recv())
            if not isinstance(start, dict) or start.get("type") != "start":
                raise RuntimeError("terminal relay missing start frame")
            if start.get("terminalId") != terminal_id:
                raise RuntimeError("terminal relay identity mismatch")
            send_lock = asyncio.Lock()
            changed = asyncio.Event()
            exit_event: dict[str, Any] | None = None

            async def send_frame(frame: dict[str, Any]) -> None:
                async with send_lock:
                    await ws.send(json.dumps(frame, ensure_ascii=False))

            async def output(method: str, params: dict[str, Any]) -> None:
                nonlocal exit_event
                if method == "terminal.exited":
                    exit_event = params
                # The PTY reader never awaits network I/O. The bounded local
                # scrollback is also the source for catch-up after reconnect.
                changed.set()

            backend = self.local_ops.terminal
            if start.get("mode") == "attach":
                snapshot = await backend.attach(start, output=output)
            else:
                await backend.create(start, output=output)
                snapshot = await backend.snapshot({"terminalId": terminal_id})
            writer: asyncio.Task[None] | None = None
            reader: asyncio.Task[None] | None = None
            try:
                await send_frame(
                    {"type": "ready", "pid": snapshot["terminal"].get("pid")}
                )
                await send_frame(
                    {
                        "type": "replay",
                        "seq": snapshot["seq"],
                        "data": snapshot["dataBase64"],
                    }
                )

                async def write_output() -> None:
                    last_seq = snapshot["seq"]
                    exited = False
                    changed.set()
                    while True:
                        # Closed records expire even when no more PTY output
                        # arrives. Release their relay after the local TTL.
                        with suppress(TimeoutError):
                            await asyncio.wait_for(changed.wait(), timeout=30)
                        changed.clear()
                        try:
                            current = await backend.snapshot(
                                {"terminalId": terminal_id, "fromSeq": last_seq},
                                include_scrollback=False,
                            )
                        except KeyError:
                            await send_frame(
                                {"type": "exit", "exitCode": None, "reason": "closed"}
                            )
                            return
                        if last_seq < current["baseSeq"]:
                            await send_frame(
                                {
                                    "type": "replay",
                                    "seq": current["seq"],
                                    "data": current["dataBase64"],
                                }
                            )
                            last_seq = current["seq"]
                        else:
                            for chunk in current["outputs"]:
                                await send_frame(
                                    {
                                        "type": "output",
                                        "seq": chunk["seq"],
                                        "data": chunk["dataBase64"],
                                    }
                                )
                                last_seq = chunk["seq"]
                        if not exited and (
                            exit_event is not None
                            or current["terminal"]["status"] == "exited"
                        ):
                            event = exit_event or current["terminal"]
                            await send_frame(
                                {
                                    "type": "exit",
                                    "exitCode": event.get("exitCode"),
                                    "reason": event.get("reason", "exit"),
                                }
                            )
                            exited = True

                async def read_commands() -> None:
                    async for raw in ws:
                        message = json.loads(raw)
                        if not isinstance(message, dict):
                            continue
                        mtype = message.get("type")
                        request_id = message.get("requestId")
                        try:
                            if mtype == "input":
                                result = await backend.write(
                                    {
                                        "terminalId": terminal_id,
                                        "dataBase64": message.get("data"),
                                    }
                                )
                            elif mtype == "resize":
                                result = await backend.resize(
                                    {
                                        "terminalId": terminal_id,
                                        "cols": message.get("cols"),
                                        "rows": message.get("rows"),
                                    }
                                )
                            elif mtype == "snapshot":
                                result = await backend.snapshot(
                                    {
                                        "terminalId": terminal_id,
                                        "fromSeq": message.get("fromSeq", 0),
                                    }
                                )
                            elif mtype == "close":
                                result = await backend.close(
                                    {"terminalId": terminal_id}
                                )
                            else:
                                continue
                            if isinstance(request_id, str):
                                await send_frame(
                                    {
                                        "type": "response",
                                        "requestId": request_id,
                                        "ok": True,
                                        "result": result,
                                    }
                                )
                            if mtype == "close":
                                return
                        except (KeyError, ValueError) as exc:
                            error = {
                                "type": "error",
                                "code": 404 if isinstance(exc, KeyError) else 422,
                                "message": str(exc),
                            }
                            if isinstance(request_id, str):
                                await send_frame(
                                    {
                                        "type": "response",
                                        "requestId": request_id,
                                        "ok": False,
                                        "error": error,
                                    }
                                )
                            else:
                                await send_frame(error)

                writer = asyncio.create_task(write_output())
                reader = asyncio.create_task(read_commands())
                done, _ = await asyncio.wait(
                    {writer, reader}, return_when=asyncio.FIRST_COMPLETED
                )
                for task in done:
                    await task
            finally:
                for task in (writer, reader):
                    if task is not None:
                        task.cancel()
                for task in (writer, reader):
                    if task is not None:
                        with suppress(asyncio.CancelledError, Exception):
                            await task
                await backend.release({"terminalId": terminal_id}, output=output)
