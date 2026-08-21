from __future__ import annotations

import asyncio
import json
from typing import Any

import websockets

from connector.logging import logger
from connector.server.urls import api_v2_path, is_loopback_url
from connector.server.urls import ws_url as build_ws_url


class TerminalRelayRunner:
    def __init__(self, server_url: str, local_ops: Any) -> None:
        self.server_url = server_url
        self.local_ops = local_ops

    async def run(self, terminal_id: str, token: str) -> None:
        relay_url = build_ws_url(
            self.server_url,
            api_v2_path(f"/connector/terminals/{terminal_id}/relay"),
        )
        relay_url = f"{relay_url}?token={token}"
        logger.info("connecting terminal relay terminal_id={}", terminal_id)
        send_lock = asyncio.Lock()
        async with websockets.connect(
            relay_url,
            proxy=None if is_loopback_url(self.server_url) else True,
        ) as ws:
            start_raw = await ws.recv()
            start = json.loads(start_raw)
            if not isinstance(start, dict) or start.get("type") != "start":
                raise RuntimeError("terminal relay missing start frame")

            async def send_frame(frame: dict[str, Any]) -> None:
                async with send_lock:
                    await ws.send(json.dumps(frame, ensure_ascii=False))

            async def output(method: str, params: dict[str, Any]) -> None:
                if method == "terminal.output":
                    await send_frame(
                        {
                            "type": "output",
                            "seq": params.get("seq"),
                            "data": params.get("dataBase64"),
                        }
                    )
                elif method == "terminal.exited":
                    await send_frame(
                        {
                            "type": "exit",
                            "exitCode": params.get("exitCode"),
                            "reason": params.get("reason"),
                        }
                    )

            created = await self.local_ops.terminal.create(start, output=output)
            await send_frame({"type": "ready", "pid": created.get("pid")})
            try:
                async for raw in ws:
                    message = json.loads(raw)
                    if not isinstance(message, dict):
                        continue
                    mtype = message.get("type")
                    if mtype == "input":
                        data = message.get("data")
                        if isinstance(data, str):
                            await self.local_ops.terminal.write(
                                {"terminalId": terminal_id, "dataBase64": data}
                            )
                    elif mtype == "resize":
                        await self.local_ops.terminal.resize(
                            {
                                "terminalId": terminal_id,
                                "cols": message.get("cols"),
                                "rows": message.get("rows"),
                            }
                        )
                    elif mtype == "close":
                        await self.local_ops.terminal.close({"terminalId": terminal_id})
                        break
            finally:
                await self.local_ops.terminal.release({"terminalId": terminal_id})
