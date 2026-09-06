from __future__ import annotations

import asyncio
import json
from collections import defaultdict
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

from agent_server.infra.redis_coordinator import RedisCoordinator


@dataclass
class _ClientState:
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    queue: asyncio.Queue[dict[str, Any]] = field(
        default_factory=lambda: asyncio.Queue(maxsize=128)
    )
    last_seq: int = 0
    overflow: bool = False
    writer: asyncio.Task[None] | None = None


class TerminalStreamHub:
    """Ephemeral fanout for connector-owned terminals.

    The connector remains the source of truth for terminal lifecycle and
    scrollback. This hub only tracks currently attached browser sockets so
    relay frames can be delivered over WebSocket without polling. Each client
    has a bounded writer queue so a slow browser cannot stall relay ingestion.
    """

    def __init__(self, coordinator: RedisCoordinator | None = None) -> None:
        self._coordinator = coordinator or RedisCoordinator()
        self._clients: dict[tuple[str, str], dict[WebSocket, _ClientState]] = (
            defaultdict(dict)
        )
        self._lock = asyncio.Lock()
        self._pubsub = None
        self._listener_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if not self._coordinator.distributed or self._listener_task is not None:
            return
        self._pubsub = self._coordinator.client.pubsub()
        await self._pubsub.psubscribe(self._coordinator.channel("terminal-stream", "*"))
        self._listener_task = asyncio.create_task(
            self._listen(), name="redis-terminal-stream-listener"
        )

    async def close(self) -> None:
        for (connector_id, terminal_id), clients in list(self._clients.items()):
            for websocket in list(clients):
                await self.detach(connector_id, terminal_id, websocket)
        if self._listener_task is not None:
            self._listener_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._listener_task
            self._listener_task = None
        if self._pubsub is not None:
            await self._pubsub.aclose()
            self._pubsub = None

    async def attach(
        self, connector_id: str, terminal_id: str, websocket: WebSocket
    ) -> None:
        async with self._lock:
            state = _ClientState()
            self._clients[(connector_id, terminal_id)][websocket] = state
            state.writer = asyncio.create_task(
                self._write_client(connector_id, terminal_id, websocket, state)
            )

    async def mark_ready(
        self,
        connector_id: str,
        terminal_id: str,
        websocket: WebSocket,
        *,
        snapshot_seq: int = 0,
    ) -> None:
        async with self._lock:
            state = self._clients.get((connector_id, terminal_id), {}).get(websocket)
            if state is None:
                return
            state.last_seq = snapshot_seq
            state.ready.set()

    async def detach(
        self, connector_id: str, terminal_id: str, websocket: WebSocket
    ) -> None:
        async with self._lock:
            key = (connector_id, terminal_id)
            clients = self._clients.get(key)
            if clients is None:
                return
            state = clients.pop(websocket, None)
            if not clients:
                self._clients.pop(key, None)
        if (
            state is not None
            and state.writer is not None
            and state.writer is not asyncio.current_task()
        ):
            state.writer.cancel()
            with suppress(asyncio.CancelledError):
                await state.writer

    async def publish_output(self, connector_id: str, params: dict[str, Any]) -> None:
        terminal_id = params.get("terminalId")
        data_b64 = params.get("dataBase64")
        seq = params.get("seq")
        if (
            not isinstance(terminal_id, str)
            or not isinstance(data_b64, str)
            or not isinstance(seq, int)
        ):
            return
        await self._publish(
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
        await self._publish(
            connector_id,
            terminal_id,
            {
                "type": "exit",
                "exitCode": exit_code if isinstance(exit_code, int) else None,
                "reason": reason if isinstance(reason, str) else "exit",
            },
        )

    async def publish_relay(
        self, connector_id: str, terminal_id: str, payload: dict[str, Any]
    ) -> None:
        if payload.get("type") in {"output", "replay", "exit", "error"}:
            await self._publish(connector_id, terminal_id, payload)

    async def _publish(
        self,
        connector_id: str,
        terminal_id: str,
        payload: dict[str, Any],
    ) -> None:
        if self._coordinator.distributed:
            await self._coordinator.client.publish(
                self._coordinator.channel("terminal-stream", connector_id),
                json.dumps(
                    {"terminalId": terminal_id, "payload": payload},
                    separators=(",", ":"),
                ),
            )
            return
        await self._send(connector_id, terminal_id, payload)

    async def _listen(self) -> None:
        assert self._pubsub is not None
        channel_prefix = self._coordinator.channel("terminal-stream", "")
        async for event in self._pubsub.listen():
            if event.get("type") != "pmessage":
                continue
            channel = self._as_text(event.get("channel"))
            if not channel.startswith(channel_prefix):
                continue
            try:
                message = json.loads(self._as_text(event.get("data")))
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            terminal_id = (
                message.get("terminalId") if isinstance(message, dict) else None
            )
            payload = message.get("payload") if isinstance(message, dict) else None
            if isinstance(terminal_id, str) and isinstance(payload, dict):
                await self._send(channel[len(channel_prefix) :], terminal_id, payload)

    async def _send(
        self, connector_id: str, terminal_id: str, payload: dict[str, Any]
    ) -> None:
        key = (connector_id, terminal_id)
        async with self._lock:
            clients = dict(self._clients.get(key, {}))
        for state in clients.values():
            try:
                state.queue.put_nowait(payload)
            except asyncio.QueueFull:
                state.overflow = True
                state.ready.set()

    async def _write_client(
        self,
        connector_id: str,
        terminal_id: str,
        websocket: WebSocket,
        state: _ClientState,
    ) -> None:
        try:
            await state.ready.wait()
            while True:
                if state.overflow:
                    return
                payload = await state.queue.get()
                if payload.get("type") in {"output", "replay"}:
                    seq = payload.get("seq")
                    if not isinstance(seq, int) or seq <= state.last_seq:
                        continue
                    state.last_seq = seq
                await asyncio.wait_for(websocket.send_json(payload), timeout=5)
        except Exception:
            pass
        finally:
            await self.detach(connector_id, terminal_id, websocket)
            with suppress(Exception):
                await asyncio.wait_for(websocket.close(code=1013), timeout=1)

    @staticmethod
    def _as_text(value: object) -> str:
        if isinstance(value, bytes):
            return value.decode("utf-8")
        return str(value)
