"""In-memory broker for interactive PTY terminals.

The backend doesn't run the PTY itself — that's the connector's job. The
broker:

  * holds metadata (id, sessionId, label, cols/rows, status, exitCode)
  * keeps a bounded scrollback buffer per terminal so browsers that
    connect (or reconnect) can replay history
  * fans terminal.output chunks out to every connected browser WebSocket
  * surfaces lifecycle events (exit) to clients

Everything is in-process; restarting the server drops all terminal state,
which is fine for v1 — the connector kills its PTY children when the
backend WS drops.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Deque

from fastapi import WebSocket


SCROLLBACK_MAX_BYTES = 256 * 1024  # 256 KiB per terminal


@dataclass
class _Chunk:
    seq: int
    data: bytes


@dataclass
class Terminal:
    id: str
    session_id: str
    connector_id: str
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
    connector_socket: WebSocket | None = None
    connector_ready: asyncio.Event = field(default_factory=asyncio.Event)
    purpose: str = "user"
    launch_signature: str | None = None
    ephemeral_group_id: str | None = None
    pid: int | None = None
    status: str = "starting"  # starting | running | exited
    exit_code: int | None = None
    created_at: float = field(default_factory=time.time)
    last_seq: int = 0
    scrollback: Deque[_Chunk] = field(default_factory=deque)
    scrollback_bytes: int = 0
    clients: set[WebSocket] = field(default_factory=set)

    def append(self, data: bytes, seq: int) -> None:
        self.last_seq = seq
        self.scrollback.append(_Chunk(seq=seq, data=data))
        self.scrollback_bytes += len(data)
        # Evict oldest chunks until we're under the cap.
        while self.scrollback_bytes > SCROLLBACK_MAX_BYTES and self.scrollback:
            evicted = self.scrollback.popleft()
            self.scrollback_bytes -= len(evicted.data)

    def replay_bytes(self, *, from_seq: int = 0) -> bytes:
        # Concatenate all retained chunks with seq > from_seq.
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


def _iso(ts: float) -> str:
    import datetime as _dt
    return _dt.datetime.fromtimestamp(ts, tz=_dt.timezone.utc).isoformat().replace("+00:00", "Z")


class TerminalBroker:
    def __init__(self) -> None:
        self._terminals: dict[str, Terminal] = {}
        self._lock = asyncio.Lock()
        self._session_locks: dict[str, asyncio.Lock] = {}

    @asynccontextmanager
    async def session_lock(self, session_id: str) -> AsyncIterator[None]:
        async with self._lock:
            lock = self._session_locks.get(session_id)
            if lock is None:
                lock = asyncio.Lock()
                self._session_locks[session_id] = lock
        async with lock:
            yield

    # ── lifecycle ─────────────────────────────────────────────────────────

    async def register(
        self,
        *,
        session_id: str,
        connector_id: str,
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
        async with self._lock:
            terminal_id = f"trm_{secrets.token_urlsafe(10)}"
            term = Terminal(
                id=terminal_id,
                session_id=session_id,
                connector_id=connector_id,
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
            self._terminals[terminal_id] = term
            return term

    def get(self, terminal_id: str) -> Terminal | None:
        return self._terminals.get(terminal_id)

    def get_for_session(self, session_id: str) -> list[Terminal]:
        return [t for t in self._terminals.values() if t.session_id == session_id]

    async def mark_running(self, terminal_id: str, *, pid: int | None) -> Terminal | None:
        term = self._terminals.get(terminal_id)
        if term is None:
            return None
        term.pid = pid
        term.status = "running"
        return term

    async def rename(self, terminal_id: str, label: str) -> Terminal | None:
        term = self._terminals.get(terminal_id)
        if term is None:
            return None
        term.label = label
        return term

    async def resize(self, terminal_id: str, cols: int, rows: int) -> Terminal | None:
        term = self._terminals.get(terminal_id)
        if term is None:
            return None
        term.cols = cols
        term.rows = rows
        return term

    async def remove(self, terminal_id: str) -> Terminal | None:
        term = self._terminals.pop(terminal_id, None)
        if term is None:
            return None
        # Notify any still-connected clients and drop refs.
        for client in list(term.clients):
            try:
                await client.send_json({"type": "exit", "exitCode": term.exit_code, "reason": "closed"})
            except Exception:
                pass
            try:
                await client.close()
            except Exception:
                pass
        term.clients.clear()
        if term.connector_socket is not None:
            try:
                await term.connector_socket.close()
            except Exception:
                pass
            term.connector_socket = None
        return term

    async def remove_ephemeral_for_connector(self, connector_id: str) -> list[Terminal]:
        removed: list[Terminal] = []
        terminal_ids = [
            term.id
            for term in self._terminals.values()
            if term.connector_id == connector_id and term.purpose == "user"
        ]
        for terminal_id in terminal_ids:
            term = await self.remove(terminal_id)
            if term is not None:
                removed.append(term)
        return removed

    # ── output broadcasting ───────────────────────────────────────────────

    async def on_output(self, terminal_id: str, *, data: bytes, seq: int) -> None:
        term = self._terminals.get(terminal_id)
        if term is None:
            return
        term.append(data, seq)
        import base64
        payload = {
            "type": "output",
            "seq": seq,
            "data": base64.b64encode(data).decode("ascii"),
        }
        for client in list(term.clients):
            try:
                await client.send_json(payload)
            except Exception:
                # Drop the client; the WS handler will GC on its end.
                term.clients.discard(client)

    async def on_exited(self, terminal_id: str, *, exit_code: int | None, reason: str | None) -> None:
        term = self._terminals.get(terminal_id)
        if term is None:
            return
        term.status = "exited"
        term.exit_code = exit_code
        payload = {"type": "exit", "exitCode": exit_code, "reason": reason or "exit"}
        for client in list(term.clients):
            try:
                await client.send_json(payload)
            except Exception:
                term.clients.discard(client)

    # ── browser client connection ─────────────────────────────────────────

    async def attach_client(self, terminal_id: str, websocket: WebSocket, *, from_seq: int = 0) -> Terminal | None:
        term = self._terminals.get(terminal_id)
        if term is None:
            return None
        term.clients.add(websocket)
        # Send the replay frame immediately so the user sees history.
        if term.scrollback_bytes > 0:
            import base64
            replay_bytes = term.replay_bytes(from_seq=from_seq)
            await websocket.send_json(
                {
                    "type": "replay",
                    "data": base64.b64encode(replay_bytes).decode("ascii"),
                    "seq": term.last_seq,
                }
            )
        if term.status == "exited":
            await websocket.send_json(
                {"type": "exit", "exitCode": term.exit_code, "reason": "exit"}
            )
        return term

    def detach_client(self, terminal_id: str, websocket: WebSocket) -> None:
        term = self._terminals.get(terminal_id)
        if term is None:
            return
        term.clients.discard(websocket)

    async def attach_connector(
        self,
        terminal_id: str,
        token: str,
        websocket: WebSocket,
    ) -> Terminal | None:
        term = self._terminals.get(terminal_id)
        if term is None or term.relay_token != token:
            return None
        if term.connector_socket is not None and term.connector_socket is not websocket:
            try:
                await term.connector_socket.close()
            except Exception:
                pass
        term.connector_socket = websocket
        term.connector_ready.set()
        return term

    def detach_connector(self, terminal_id: str, websocket: WebSocket) -> None:
        term = self._terminals.get(terminal_id)
        if term is None or term.connector_socket is not websocket:
            return
        term.connector_socket = None
        term.connector_ready.clear()

    async def wait_connector(self, terminal_id: str, *, timeout: float) -> Terminal | None:
        term = self._terminals.get(terminal_id)
        if term is None:
            return None
        try:
            await asyncio.wait_for(term.connector_ready.wait(), timeout=timeout)
        except TimeoutError:
            return None
        if term.connector_socket is None:
            return None
        return term

    async def send_to_connector(self, terminal_id: str, payload: dict[str, Any]) -> bool:
        term = self._terminals.get(terminal_id)
        if term is None or term.connector_socket is None:
            return False
        try:
            await term.connector_socket.send_json(payload)
            return True
        except Exception:
            term.connector_socket = None
            term.connector_ready.clear()
            return False
