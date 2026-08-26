"""Ephemeral coordination for interactive connector-owned PTY terminals."""

from __future__ import annotations

import asyncio
import base64
import json
import secrets
import time
from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

from agent_server.infra.redis_coordinator import RedisCoordinator

SCROLLBACK_MAX_BYTES = 256 * 1024
TERMINAL_TTL_SECONDS = 24 * 60 * 60
EXITED_TERMINAL_TTL_SECONDS = 60 * 60
RELAY_LEASE_SECONDS = 30
RELAY_REFRESH_SECONDS = 10
BROWSER_LEASE_SECONDS = 30


@dataclass
class _Chunk:
    seq: int
    data: bytes


@dataclass
class _BrowserState:
    ready: bool = False
    pending: list[dict[str, Any]] = field(default_factory=list)
    lease_id: str | None = None
    last_seq: int = 0


@dataclass
class _RelayState:
    websocket: WebSocket
    lease_id: str


@dataclass
class Terminal:
    id: str
    session_id: str
    connector_id: str
    connector_connection_id: str | None
    label: str
    root: str
    cwd: str
    shell: str
    cols: int
    rows: int
    command: str | None = None
    args: list[str] = field(default_factory=list)
    profile: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    relay_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    purpose: str = "user"
    launch_signature: str | None = None
    ephemeral_group_id: str | None = None
    pid: int | None = None
    status: str = "starting"
    exit_code: int | None = None
    created_at: float = field(default_factory=time.time)
    last_seq: int = 0
    scrollback: deque[_Chunk] = field(default_factory=deque, repr=False)
    scrollback_bytes: int = 0

    def append(self, data: bytes, seq: int) -> None:
        self.last_seq = seq
        self.scrollback.append(_Chunk(seq=seq, data=data))
        self.scrollback_bytes += len(data)
        while self.scrollback_bytes > SCROLLBACK_MAX_BYTES and self.scrollback:
            evicted = self.scrollback.popleft()
            self.scrollback_bytes -= len(evicted.data)

    def replay_bytes(self, *, from_seq: int = 0) -> bytes:
        return b"".join(chunk.data for chunk in self.scrollback if chunk.seq > from_seq)

    def view(self) -> dict[str, Any]:
        return {
            "terminalId": self.id,
            "sessionId": self.session_id,
            "label": self.label,
            "root": self.root,
            "cwd": self.cwd,
            "cols": self.cols,
            "rows": self.rows,
            "purpose": self.purpose,
            "pid": self.pid,
            "status": self.status,
            "exitCode": self.exit_code,
            "scrollbackBytes": self.scrollback_bytes,
            "scrollbackSeq": self.last_seq,
            "ephemeralGroupId": self.ephemeral_group_id,
            "createdAt": _iso(self.created_at),
        }

    def _payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "connector_id": self.connector_id,
            "connector_connection_id": self.connector_connection_id,
            "label": self.label,
            "root": self.root,
            "cwd": self.cwd,
            "shell": self.shell,
            "cols": self.cols,
            "rows": self.rows,
            "command": self.command,
            "args": self.args,
            "profile": self.profile,
            "env": self.env,
            "relay_token": self.relay_token,
            "purpose": self.purpose,
            "launch_signature": self.launch_signature,
            "ephemeral_group_id": self.ephemeral_group_id,
            "pid": self.pid,
            "status": self.status,
            "exit_code": self.exit_code,
            "created_at": self.created_at,
            "last_seq": self.last_seq,
            "scrollback_bytes": self.scrollback_bytes,
        }

    @classmethod
    def _from_payload(cls, payload: dict[str, Any]) -> Terminal:
        return cls(
            id=str(payload["id"]),
            session_id=str(payload["session_id"]),
            connector_id=str(payload["connector_id"]),
            connector_connection_id=payload.get("connector_connection_id"),
            label=str(payload["label"]),
            root=str(payload["root"]),
            cwd=str(payload["cwd"]),
            shell=str(payload["shell"]),
            cols=int(payload["cols"]),
            rows=int(payload["rows"]),
            command=payload.get("command"),
            args=list(payload.get("args") or []),
            profile=payload.get("profile"),
            env=dict(payload.get("env") or {}),
            relay_token=str(payload["relay_token"]),
            purpose=str(payload.get("purpose") or "user"),
            launch_signature=payload.get("launch_signature"),
            ephemeral_group_id=payload.get("ephemeral_group_id"),
            pid=payload.get("pid"),
            status=str(payload.get("status") or "starting"),
            exit_code=payload.get("exit_code"),
            created_at=float(payload["created_at"]),
            last_seq=int(payload.get("last_seq") or 0),
            scrollback_bytes=int(payload.get("scrollback_bytes") or 0),
        )


def _iso(ts: float) -> str:
    import datetime as _dt

    return _dt.datetime.fromtimestamp(ts, tz=_dt.UTC).isoformat().replace("+00:00", "Z")


class TerminalBroker:
    def __init__(
        self,
        coordinator: RedisCoordinator | None = None,
        *,
        instance_id: str | None = None,
    ) -> None:
        self._coordinator = coordinator or RedisCoordinator()
        self.instance_id = instance_id or f"srv_{secrets.token_urlsafe(12)}"
        self._terminals: dict[str, Terminal] = {}
        self._clients: dict[str, dict[WebSocket, _BrowserState]] = {}
        self._relay_sockets: dict[str, _RelayState] = {}
        self._relay_ready: dict[str, asyncio.Event] = {}
        self._lock = asyncio.Lock()
        self._session_locks: dict[str, asyncio.Lock] = {}
        self._pubsub = None
        self._listener_task: asyncio.Task[None] | None = None
        self._refresh_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if not self._coordinator.distributed or self._listener_task is not None:
            return
        self._pubsub = self._coordinator.client.pubsub()
        await self._pubsub.subscribe(self._event_channel())
        self._listener_task = asyncio.create_task(
            self._listen(), name=f"terminal-broker-{self.instance_id}"
        )
        self._refresh_task = asyncio.create_task(
            self._refresh_relays(), name=f"terminal-relays-{self.instance_id}"
        )

    async def close(self) -> None:
        tasks = [
            task
            for task in (self._listener_task, self._refresh_task)
            if task is not None
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._listener_task = None
        self._refresh_task = None
        for terminal_id, relay in list(self._relay_sockets.items()):
            if self._coordinator.distributed:
                await self._coordinator.delete_if_value(
                    self._relay_key(terminal_id), relay.lease_id
                )
            with suppress(Exception):
                await relay.websocket.close()
        self._relay_sockets.clear()
        if self._coordinator.distributed:
            async with self._coordinator.client.pipeline(transaction=True) as pipeline:
                for terminal_id, clients in self._clients.items():
                    for state in clients.values():
                        if state.lease_id is not None:
                            pipeline.zrem(
                                self._browser_key(terminal_id), state.lease_id
                            )
                await pipeline.execute()
        if self._pubsub is not None:
            await self._pubsub.aclose()
            self._pubsub = None

    @asynccontextmanager
    async def session_lock(self, session_id: str) -> AsyncIterator[None]:
        if self._coordinator.distributed:
            async with self._coordinator.lock(
                f"terminal-session:{session_id}", timeout_seconds=60
            ):
                yield
            return
        async with self._lock:
            lock = self._session_locks.get(session_id)
            if lock is None:
                lock = asyncio.Lock()
                self._session_locks[session_id] = lock
        async with lock:
            yield

    async def register(
        self,
        *,
        session_id: str,
        connector_id: str,
        connector_connection_id: str | None = None,
        label: str,
        cwd: str,
        root: str | None = None,
        shell: str,
        cols: int,
        rows: int,
        command: str | None = None,
        args: list[str] | None = None,
        profile: str | None = None,
        env: dict[str, str] | None = None,
        purpose: str = "user",
        launch_signature: str | None = None,
        ephemeral_group_id: str | None = None,
    ) -> Terminal:
        term = Terminal(
            id=f"trm_{secrets.token_urlsafe(10)}",
            session_id=session_id,
            connector_id=connector_id,
            connector_connection_id=connector_connection_id,
            label=label,
            root=root or cwd,
            cwd=cwd,
            shell=shell,
            cols=cols,
            rows=rows,
            command=command,
            args=list(args or []),
            profile=profile,
            env=dict(env or {}),
            purpose=purpose,
            launch_signature=launch_signature,
            ephemeral_group_id=ephemeral_group_id,
        )
        if self._coordinator.distributed:
            async with self._coordinator.client.pipeline(transaction=True) as pipeline:
                pipeline.set(
                    self._terminal_key(term.id),
                    self._serialize(term),
                    ex=TERMINAL_TTL_SECONDS,
                )
                pipeline.sadd(self._session_key(session_id), term.id)
                pipeline.expire(self._session_key(session_id), TERMINAL_TTL_SECONDS)
                pipeline.sadd(self._connector_key(connector_id), term.id)
                pipeline.expire(self._connector_key(connector_id), TERMINAL_TTL_SECONDS)
                await pipeline.execute()
        else:
            async with self._lock:
                self._terminals[term.id] = term
        return term

    async def get(self, terminal_id: str) -> Terminal | None:
        if not self._coordinator.distributed:
            return self._terminals.get(terminal_id)
        raw = await self._coordinator.client.get(self._terminal_key(terminal_id))
        return self._deserialize(raw)

    async def get_for_session(self, session_id: str) -> list[Terminal]:
        if not self._coordinator.distributed:
            return [
                term
                for term in self._terminals.values()
                if term.session_id == session_id
            ]
        return await self._get_indexed(self._session_key(session_id))

    async def mark_running(
        self, terminal_id: str, *, pid: int | None
    ) -> Terminal | None:
        return await self._mutate(
            terminal_id,
            lambda term: (
                setattr(term, "pid", pid),
                setattr(term, "status", "running"),
            ),
        )

    async def bind_connection(
        self,
        terminal_id: str,
        connection_id: str,
    ) -> Terminal | None:
        return await self._mutate(
            terminal_id,
            lambda term: setattr(term, "connector_connection_id", connection_id),
        )

    async def rename(self, terminal_id: str, label: str) -> Terminal | None:
        return await self._mutate(
            terminal_id, lambda term: setattr(term, "label", label)
        )

    async def resize(self, terminal_id: str, cols: int, rows: int) -> Terminal | None:
        return await self._mutate(
            terminal_id,
            lambda term: (setattr(term, "cols", cols), setattr(term, "rows", rows)),
        )

    async def remove(self, terminal_id: str) -> Terminal | None:
        if self._coordinator.distributed:
            async with self._coordinator.lock(
                f"terminal-meta:{terminal_id}", timeout_seconds=5
            ):
                term = await self.get(terminal_id)
                if term is None:
                    return None
                async with self._coordinator.client.pipeline(
                    transaction=True
                ) as pipeline:
                    pipeline.delete(
                        self._terminal_key(terminal_id),
                        self._scrollback_key(terminal_id),
                        self._relay_key(terminal_id),
                        self._browser_key(terminal_id),
                    )
                    pipeline.srem(self._session_key(term.session_id), terminal_id)
                    pipeline.srem(self._connector_key(term.connector_id), terminal_id)
                    await pipeline.execute()
            await self._publish("remove", terminal_id, {"exitCode": term.exit_code})
        else:
            term = await self.get(terminal_id)
            if term is None:
                return None
            self._terminals.pop(terminal_id, None)
        await self._close_local(terminal_id, exit_code=term.exit_code)
        return term

    async def remove_ephemeral_for_connector(
        self,
        connector_id: str,
        *,
        connection_id: str | None = None,
    ) -> list[Terminal]:
        if self._coordinator.distributed:
            terminals = await self._get_indexed(self._connector_key(connector_id))
        else:
            terminals = list(self._terminals.values())
        removed: list[Terminal] = []
        for term in terminals:
            if (
                term.connector_id != connector_id
                or term.purpose != "user"
                or (
                    connection_id is not None
                    and term.connector_connection_id != connection_id
                )
            ):
                continue
            current = await self.remove(term.id)
            if current is not None:
                removed.append(current)
        return removed

    async def on_output(self, terminal_id: str, *, data: bytes, seq: int) -> None:
        if not self._coordinator.distributed:
            term = self._terminals.get(terminal_id)
            if term is None:
                return
            if seq <= term.last_seq:
                return
            term.append(data, seq)
            await self._fan_out(
                terminal_id,
                {"type": "output", "seq": seq, "data": self._encode(data)},
            )
            return

        async with self._coordinator.lock(
            f"terminal-meta:{terminal_id}", timeout_seconds=5
        ):
            term = await self.get(terminal_id)
            if term is None:
                return
            if seq <= term.last_seq:
                return
            chunk = json.dumps(
                {"seq": seq, "data": self._encode(data), "size": len(data)},
                separators=(",", ":"),
            )
            await self._coordinator.client.rpush(
                self._scrollback_key(terminal_id), chunk
            )
            term.last_seq = seq
            term.scrollback_bytes += len(data)
            while term.scrollback_bytes > SCROLLBACK_MAX_BYTES:
                evicted = await self._coordinator.client.lpop(
                    self._scrollback_key(terminal_id)
                )
                if not isinstance(evicted, (str, bytes)):
                    term.scrollback_bytes = 0
                    break
                try:
                    term.scrollback_bytes -= int(
                        json.loads(self._as_text(evicted)).get("size") or 0
                    )
                except (TypeError, ValueError, json.JSONDecodeError):
                    term.scrollback_bytes = 0
            await self._store(term)
            await self._coordinator.client.expire(
                self._scrollback_key(terminal_id), TERMINAL_TTL_SECONDS
            )
        await self._publish(
            "output",
            terminal_id,
            {"type": "output", "seq": seq, "data": self._encode(data)},
        )

    async def on_exited(
        self,
        terminal_id: str,
        *,
        exit_code: int | None,
        reason: str | None,
    ) -> None:
        term = await self._mutate(
            terminal_id,
            lambda item: (
                setattr(item, "status", "exited"),
                setattr(item, "exit_code", exit_code),
            ),
            ttl_seconds=EXITED_TERMINAL_TTL_SECONDS,
        )
        if term is None:
            return
        payload = {"type": "exit", "exitCode": exit_code, "reason": reason or "exit"}
        if self._coordinator.distributed:
            await self._coordinator.client.expire(
                self._scrollback_key(terminal_id), EXITED_TERMINAL_TTL_SECONDS
            )
            await self._publish("exit", terminal_id, payload)
        else:
            await self._fan_out(terminal_id, payload)

    async def attach_client(
        self,
        terminal_id: str,
        websocket: WebSocket,
        *,
        from_seq: int = 0,
    ) -> Terminal | None:
        if await self.get(terminal_id) is None:
            return None
        lease_id = (
            f"{self.instance_id}:{secrets.token_urlsafe(18)}"
            if self._coordinator.distributed
            else None
        )
        async with self._lock:
            self._clients.setdefault(terminal_id, {})[websocket] = _BrowserState(
                lease_id=lease_id
            )
        if lease_id is not None:
            await self._coordinator.client.zadd(
                self._browser_key(terminal_id),
                {lease_id: time.time() + BROWSER_LEASE_SECONDS},
            )
            await self._coordinator.client.expire(
                self._browser_key(terminal_id), BROWSER_LEASE_SECONDS * 2
            )
        term = await self.get(terminal_id)
        if term is None:
            await self.detach_client(terminal_id, websocket)
            return None
        snapshot_seq = term.last_seq
        if self._coordinator.distributed:
            replay = await self._distributed_replay(
                terminal_id, from_seq=from_seq, through_seq=snapshot_seq
            )
        else:
            replay = term.replay_bytes(from_seq=from_seq)
        if replay:
            await websocket.send_json(
                {"type": "replay", "data": self._encode(replay), "seq": snapshot_seq}
            )
        snapshot_exited = term.status == "exited"
        if snapshot_exited:
            await websocket.send_json(
                {"type": "exit", "exitCode": term.exit_code, "reason": "exit"}
            )
        await self._mark_client_ready(
            terminal_id,
            websocket,
            snapshot_seq=snapshot_seq,
            snapshot_exited=snapshot_exited,
        )
        return term

    async def detach_client(self, terminal_id: str, websocket: WebSocket) -> None:
        async with self._lock:
            clients = self._clients.get(terminal_id)
            if clients is None:
                return
            state = clients.pop(websocket, None)
            if not clients:
                self._clients.pop(terminal_id, None)
        if (
            self._coordinator.distributed
            and state is not None
            and state.lease_id is not None
        ):
            await self._coordinator.client.zrem(
                self._browser_key(terminal_id), state.lease_id
            )

    async def has_clients(self, terminal_id: str) -> bool:
        if self._coordinator.distributed:
            key = self._browser_key(terminal_id)
            await self._coordinator.client.zremrangebyscore(key, "-inf", time.time())
            return bool(await self._coordinator.client.zcard(key))
        async with self._lock:
            return bool(self._clients.get(terminal_id))

    async def attach_connector(
        self,
        terminal_id: str,
        token: str,
        websocket: WebSocket,
    ) -> Terminal | None:
        term = await self.get(terminal_id)
        if term is None or not secrets.compare_digest(term.relay_token, token):
            return None
        old = self._relay_sockets.get(terminal_id)
        if old is not None and old.websocket is not websocket:
            with suppress(Exception):
                await old.websocket.close()
        lease_id = f"{self.instance_id}:{secrets.token_urlsafe(18)}"
        self._relay_sockets[terminal_id] = _RelayState(websocket, lease_id)
        if self._coordinator.distributed:
            await self._coordinator.client.set(
                self._relay_key(terminal_id),
                lease_id,
                ex=RELAY_LEASE_SECONDS,
            )
        self._relay_ready.setdefault(terminal_id, asyncio.Event()).set()
        if self._coordinator.distributed:
            await self._coordinator.client.publish(
                self._ready_channel(terminal_id), "ready"
            )
        return term

    async def detach_connector(self, terminal_id: str, websocket: WebSocket) -> None:
        relay = self._relay_sockets.get(terminal_id)
        if relay is None or relay.websocket is not websocket:
            return
        self._relay_sockets.pop(terminal_id, None)
        self._relay_ready.setdefault(terminal_id, asyncio.Event()).clear()
        if self._coordinator.distributed:
            await self._coordinator.delete_if_value(
                self._relay_key(terminal_id), relay.lease_id
            )

    async def wait_connector(
        self, terminal_id: str, *, timeout: float
    ) -> Terminal | None:
        term = await self.get(terminal_id)
        if term is None:
            return None
        if not self._coordinator.distributed:
            event = self._relay_ready.setdefault(terminal_id, asyncio.Event())
            try:
                await asyncio.wait_for(event.wait(), timeout=timeout)
            except TimeoutError:
                return None
            return term if terminal_id in self._relay_sockets else None

        pubsub = self._coordinator.client.pubsub()
        channel = self._ready_channel(terminal_id)
        await pubsub.subscribe(channel)
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                if await self._coordinator.client.exists(self._relay_key(terminal_id)):
                    return await self.get(terminal_id)
                remaining = deadline - time.monotonic()
                await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=max(0, remaining)
                )
            return None
        finally:
            with suppress(Exception):
                await pubsub.unsubscribe(channel)
            await pubsub.aclose()

    async def send_to_connector(
        self, terminal_id: str, payload: dict[str, Any]
    ) -> bool:
        if await self.get(terminal_id) is None:
            return False
        if not self._coordinator.distributed:
            relay = self._relay_sockets.get(terminal_id)
            if relay is None:
                return False
            return await self._send_relay(terminal_id, relay, payload)
        if not await self._coordinator.client.exists(self._relay_key(terminal_id)):
            return False
        await self._publish("command", terminal_id, payload)
        return True

    async def _mutate(
        self,
        terminal_id: str,
        change: Any,
        *,
        ttl_seconds: int = TERMINAL_TTL_SECONDS,
    ) -> Terminal | None:
        if not self._coordinator.distributed:
            term = self._terminals.get(terminal_id)
            if term is None:
                return None
            change(term)
            return term
        async with self._coordinator.lock(
            f"terminal-meta:{terminal_id}", timeout_seconds=5
        ):
            term = await self.get(terminal_id)
            if term is None:
                return None
            change(term)
            await self._store(term, ttl_seconds=ttl_seconds)
            return term

    async def _store(
        self, term: Terminal, *, ttl_seconds: int = TERMINAL_TTL_SECONDS
    ) -> None:
        await self._coordinator.client.set(
            self._terminal_key(term.id), self._serialize(term), ex=ttl_seconds
        )

    async def _get_indexed(self, key: str) -> list[Terminal]:
        terminal_ids = await self._coordinator.client.smembers(key)
        terminals: list[Terminal] = []
        stale: list[str] = []
        for value in terminal_ids:
            terminal_id = self._as_text(value)
            term = await self.get(terminal_id)
            if term is None:
                stale.append(terminal_id)
            else:
                terminals.append(term)
        if stale:
            await self._coordinator.client.srem(key, *stale)
        return sorted(terminals, key=lambda term: term.created_at)

    async def _distributed_replay(
        self, terminal_id: str, *, from_seq: int, through_seq: int
    ) -> bytes:
        raw_chunks = await self._coordinator.client.lrange(
            self._scrollback_key(terminal_id), 0, -1
        )
        chunks: list[bytes] = []
        for raw in raw_chunks:
            try:
                payload = json.loads(self._as_text(raw))
                seq = int(payload["seq"])
                if from_seq < seq <= through_seq:
                    chunks.append(base64.b64decode(payload["data"], validate=True))
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                continue
        return b"".join(chunks)

    async def _publish(
        self, kind: str, terminal_id: str, payload: dict[str, Any]
    ) -> None:
        await self._coordinator.client.publish(
            self._event_channel(),
            json.dumps(
                {"kind": kind, "terminalId": terminal_id, "payload": payload},
                separators=(",", ":"),
            ),
        )

    async def _listen(self) -> None:
        assert self._pubsub is not None
        async for event in self._pubsub.listen():
            if event.get("type") != "message":
                continue
            try:
                message = json.loads(self._as_text(event.get("data")))
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            if not isinstance(message, dict):
                continue
            terminal_id = message.get("terminalId")
            kind = message.get("kind")
            payload = message.get("payload")
            if not isinstance(terminal_id, str) or not isinstance(payload, dict):
                continue
            if kind == "command":
                relay = self._relay_sockets.get(terminal_id)
                if relay is not None:
                    owner = await self._coordinator.client.get(
                        self._relay_key(terminal_id)
                    )
                    if self._as_text(owner) == relay.lease_id:
                        await self._send_relay(terminal_id, relay, payload)
            elif kind in {"output", "exit"}:
                await self._fan_out(terminal_id, payload)
            elif kind == "remove":
                await self._close_local(terminal_id, exit_code=payload.get("exitCode"))

    async def _refresh_relays(self) -> None:
        while True:
            await asyncio.sleep(RELAY_REFRESH_SECONDS)
            for terminal_id, relay in list(self._relay_sockets.items()):
                if not await self._coordinator.refresh_if_value(
                    self._relay_key(terminal_id),
                    relay.lease_id,
                    ttl_seconds=RELAY_LEASE_SECONDS,
                ):
                    self._relay_sockets.pop(terminal_id, None)
                    self._relay_ready.setdefault(terminal_id, asyncio.Event()).clear()
                    with suppress(Exception):
                        await relay.websocket.close()
            async with self._lock:
                browser_leases = [
                    (terminal_id, state.lease_id)
                    for terminal_id, clients in self._clients.items()
                    for state in clients.values()
                    if state.lease_id is not None
                ]
            if browser_leases:
                async with self._coordinator.client.pipeline(
                    transaction=True
                ) as pipeline:
                    expires_at = time.time() + BROWSER_LEASE_SECONDS
                    for terminal_id, lease_id in browser_leases:
                        pipeline.zadd(
                            self._browser_key(terminal_id), {lease_id: expires_at}
                        )
                        pipeline.expire(
                            self._browser_key(terminal_id), BROWSER_LEASE_SECONDS * 2
                        )
                    await pipeline.execute()

    async def _send_relay(
        self,
        terminal_id: str,
        relay: _RelayState,
        payload: dict[str, Any],
    ) -> bool:
        try:
            await relay.websocket.send_json(payload)
            return True
        except Exception:
            await self.detach_connector(terminal_id, relay.websocket)
            return False

    async def _fan_out(self, terminal_id: str, payload: dict[str, Any]) -> None:
        async with self._lock:
            ready_clients: list[WebSocket] = []
            for websocket, state in self._clients.get(terminal_id, {}).items():
                if not state.ready:
                    state.pending.append(payload)
                    continue
                if payload.get("type") == "output":
                    seq = int(payload.get("seq") or 0)
                    if seq <= state.last_seq:
                        continue
                    state.last_seq = seq
                ready_clients.append(websocket)
        dead: list[WebSocket] = []
        for websocket in ready_clients:
            if not await self._send_client(websocket, payload):
                dead.append(websocket)
        for websocket in dead:
            await self.detach_client(terminal_id, websocket)

    async def _mark_client_ready(
        self,
        terminal_id: str,
        websocket: WebSocket,
        *,
        snapshot_seq: int,
        snapshot_exited: bool,
    ) -> None:
        async with self._lock:
            state = self._clients.get(terminal_id, {}).get(websocket)
            if state is None:
                return
            state.last_seq = snapshot_seq
        while True:
            async with self._lock:
                state = self._clients.get(terminal_id, {}).get(websocket)
                if state is None:
                    return
                pending = list(state.pending)
                state.pending.clear()
                if not pending:
                    state.ready = True
                    return
            for payload in pending:
                if payload.get("type") == "output":
                    seq = int(payload.get("seq") or 0)
                    if seq <= state.last_seq:
                        continue
                    state.last_seq = seq
                if payload.get("type") == "exit" and snapshot_exited:
                    continue
                if not await self._send_client(websocket, payload):
                    await self.detach_client(terminal_id, websocket)
                    return

    async def _close_local(self, terminal_id: str, *, exit_code: Any) -> None:
        async with self._lock:
            clients = list(self._clients.pop(terminal_id, {}))
        for client in clients:
            with suppress(Exception):
                await client.send_json(
                    {"type": "exit", "exitCode": exit_code, "reason": "closed"}
                )
            with suppress(Exception):
                await client.close()
        relay = self._relay_sockets.pop(terminal_id, None)
        self._relay_ready.setdefault(terminal_id, asyncio.Event()).clear()
        if relay is not None:
            with suppress(Exception):
                await relay.websocket.close()

    @staticmethod
    async def _send_client(websocket: WebSocket, payload: dict[str, Any]) -> bool:
        try:
            await websocket.send_json(payload)
            return True
        except Exception:
            return False

    @staticmethod
    def _serialize(term: Terminal) -> str:
        return json.dumps(term._payload(), ensure_ascii=False, separators=(",", ":"))

    @staticmethod
    def _deserialize(raw: Any) -> Terminal | None:
        if not isinstance(raw, (str, bytes)):
            return None
        try:
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8")
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                return None
            return Terminal._from_payload(payload)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            return None

    @staticmethod
    def _encode(data: bytes) -> str:
        return base64.b64encode(data).decode("ascii")

    @staticmethod
    def _as_text(value: Any) -> str:
        if isinstance(value, bytes):
            return value.decode("utf-8")
        return value if isinstance(value, str) else ""

    def _terminal_key(self, terminal_id: str) -> str:
        return self._coordinator.key("terminal", terminal_id)

    def _scrollback_key(self, terminal_id: str) -> str:
        return self._coordinator.key("terminal", terminal_id, "scrollback")

    def _session_key(self, session_id: str) -> str:
        return self._coordinator.key("terminal-session", session_id)

    def _connector_key(self, connector_id: str) -> str:
        return self._coordinator.key("terminal-connector", connector_id)

    def _relay_key(self, terminal_id: str) -> str:
        return self._coordinator.key("terminal-relay", terminal_id)

    def _browser_key(self, terminal_id: str) -> str:
        return self._coordinator.key("terminal-browser", terminal_id)

    def _event_channel(self) -> str:
        return self._coordinator.channel("terminal-broker")

    def _ready_channel(self, terminal_id: str) -> str:
        return self._coordinator.channel("terminal-ready", terminal_id)
