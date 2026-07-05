from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket


@dataclass
class _ClientState:
    ready: bool = False
    pending: list[dict[str, Any]] = field(default_factory=list)


class TerminalStreamHub:
    """Ephemeral fanout for connector-owned terminals.

    The connector remains the source of truth for terminal lifecycle and
    scrollback. This hub only tracks currently attached browser sockets so
    connector notifications can be delivered over WebSocket without polling.
    """

    def __init__(self) -> None:
        self._clients: dict[tuple[str, str], dict[WebSocket, _ClientState]] = defaultdict(dict)
        self._lock = asyncio.Lock()

    async def attach(self, connector_id: str, terminal_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            self._clients[(connector_id, terminal_id)][websocket] = _ClientState()

    async def mark_ready(self, connector_id: str, terminal_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            state = self._clients.get((connector_id, terminal_id), {}).get(websocket)
            if state is None:
                return
            state.ready = True
            pending = list(state.pending)
            state.pending.clear()
        for payload in pending:
            await self._send_one(connector_id, terminal_id, websocket, payload)

    async def detach(self, connector_id: str, terminal_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            key = (connector_id, terminal_id)
            clients = self._clients.get(key)
            if clients is None:
                return
            clients.pop(websocket, None)
            if not clients:
                self._clients.pop(key, None)

    async def publish_output(self, connector_id: str, params: dict[str, Any]) -> None:
        terminal_id = params.get("terminalId")
        data_b64 = params.get("dataBase64")
        seq = params.get("seq")
        if not isinstance(terminal_id, str) or not isinstance(data_b64, str) or not isinstance(seq, int):
            return
        await self._send(
            connector_id,
            terminal_id,
            {"type": "output", "data": data_b64, "seq": seq},
        )

    async def publish_exit(self, connector_id: str, params: dict[str, Any]) -> None:
        terminal_id = params.get("terminalId")
        if not isinstance(terminal_id, str):
            return
        exit_code = params.get("exitCode")
        reason = params.get("reason")
        await self._send(
            connector_id,
            terminal_id,
            {
                "type": "exit",
                "exitCode": exit_code if isinstance(exit_code, int) else None,
                "reason": reason if isinstance(reason, str) else "exit",
            },
        )

    async def _send(self, connector_id: str, terminal_id: str, payload: dict[str, Any]) -> None:
        key = (connector_id, terminal_id)
        async with self._lock:
            clients = dict(self._clients.get(key, {}))
            for websocket, state in clients.items():
                if not state.ready:
                    state.pending.append(payload)
        ready_clients = [websocket for websocket, state in clients.items() if state.ready]
        if not ready_clients:
            return

        dead: list[WebSocket] = []
        for websocket in ready_clients:
            if not await self._send_one(connector_id, terminal_id, websocket, payload):
                dead.append(websocket)
        if dead:
            async with self._lock:
                live = self._clients.get(key)
                if live is None:
                    return
                for websocket in dead:
                    live.pop(websocket, None)
                if not live:
                    self._clients.pop(key, None)

    async def _send_one(
        self,
        connector_id: str,
        terminal_id: str,
        websocket: WebSocket,
        payload: dict[str, Any],
    ) -> bool:
        try:
            await websocket.send_json(payload)
            return True
        except Exception:
            await self.detach(connector_id, terminal_id, websocket)
            return False
