"""A fake v3 device that serves ``aa.device.v1.*`` on a MeshCall Router.

Used by the S5 benchmark and the Server tests: it plays the Connector side of
``contracts/device-meshcall/1.0`` closely enough to exercise the Server
(attach heartbeats, a durable outbox, snapshots, watch streams, commands with
durable receipts). It is not a Connector: content lives in memory.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import itertools
import json
import zlib
from collections.abc import AsyncIterator, Callable
from typing import Any

from meshcall import (
    Mesh,
    MeshCallError,
    ReconnectPolicy,
    RetryPolicy,
    Router,
    RouterCredentials,
    RpcContext,
    mutates,
    query,
    service,
    stream,
)
from pydantic import BaseModel, ConfigDict

from agent_server.core.device_meshcall import (
    COMMAND_METHODS,
    CONNECTION_ID_METADATA,
    MESH_MAX_FRAME_BYTES,
    ChangesEvent,
    ChangesSinceResponse,
    CommandAck,
    CommandStatusResponse,
    LinkAttachItem,
    LinkError,
    OutboxItem,
    StoreReadResponse,
    StreamChunk,
    command_route,
)

SERVICE_PREFIX = "aa.device.v1"


class Payload(BaseModel):
    model_config = ConfigDict(extra="allow")


class Empty(BaseModel):
    pass


class FakeSession:
    def __init__(self, session_id: str, items: list[dict[str, Any]] | None = None) -> None:
        self.session_id = session_id
        self.items: list[dict[str, Any]] = list(items or [])
        self.head_seq = len(self.items)
        self.reset_seq = 0
        self.watchers: set[asyncio.Queue[ChangesEvent]] = set()

    def append(self, item: dict[str, Any]) -> ChangesEvent:
        from_seq = self.head_seq
        self.head_seq += 1
        item = {**item, "updatedSeq": self.head_seq}
        self.items.append(item)
        event = ChangesEvent(
            sessionId=self.session_id,
            fromSeq=from_seq,
            toSeq=self.head_seq,
            resetSeq=self.reset_seq,
            events=[
                {
                    "type": "timeline.item_created",
                    "sessionId": self.session_id,
                    "seq": self.head_seq,
                    "payload": {"item": item},
                }
            ],
        )
        for queue in tuple(self.watchers):
            queue.put_nowait(event)
        return event


class FakeDeviceState:
    """Everything a fake device knows; tests inspect and drive it directly."""

    def __init__(self, device_id: str) -> None:
        self.device_id = device_id
        self.connection_id = ""
        self.sessions: dict[str, FakeSession] = {}
        self.outbox: list[OutboxItem] = []
        self._oids = itertools.count(1)
        self.outbox_changed = asyncio.Event()
        self.acked_oid = 0
        self.events: asyncio.Queue[LinkAttachItem] = asyncio.Queue()
        self.heartbeat_interval = 20.0
        self.receipts: dict[str, CommandAck] = {}
        self.command_log: list[tuple[str, dict[str, Any]]] = []
        self.command_handler: Callable[[str, dict[str, Any]], Any] | None = None
        self.command_delay = 0.0
        self.attach_opened = asyncio.Event()
        self.outbox_opened = asyncio.Event()
        self.read_delay = 0.0
        self.calls: list[str] = []

    def session(self, session_id: str) -> FakeSession:
        if session_id not in self.sessions:
            self.sessions[session_id] = FakeSession(session_id)
        return self.sessions[session_id]

    def push_outbox(self, method: str, payload: dict[str, Any]) -> OutboxItem:
        item = OutboxItem(oid=next(self._oids), m=method, p=payload)
        self.outbox.append(item)
        self.outbox_changed.set()
        return item

    def emit(self, method: str, payload: dict[str, Any]) -> None:
        self.events.put_nowait(LinkAttachItem(kind="event", m=method, p=payload))

    def check_connection(self, ctx: RpcContext) -> None:
        got = ctx.metadata.get(CONNECTION_ID_METADATA)
        if self.connection_id and got != self.connection_id:
            raise MeshCallError(
                "failed_precondition",
                "stale connection id",
                details={"source": "device", "reason": "connection_replaced"},
            )


def _make_services(state: FakeDeviceState) -> list[object]:
    @service(f"{SERVICE_PREFIX}.Link", targeted=True)
    class Link:
        """Presence, lossy events and the durable outbox."""

        @stream
        async def attach(self, connectionId: str, ctx: RpcContext) -> AsyncIterator[LinkAttachItem]:
            """Heartbeat every 20 s plus lossy events."""
            state.check_connection(ctx)
            state.attach_opened.set()
            yield LinkAttachItem(kind="heartbeat")
            while True:
                try:
                    item = await asyncio.wait_for(state.events.get(), state.heartbeat_interval)
                except TimeoutError:
                    item = LinkAttachItem(kind="heartbeat")
                yield item

        @stream
        async def outbox(self, connectionId: str, ctx: RpcContext) -> AsyncIterator[OutboxItem]:
            """Resend from the lowest unacknowledged oid, then follow new items."""
            state.check_connection(ctx)
            state.outbox_opened.set()
            sent = 0
            while True:
                pending = [item for item in state.outbox if item.oid > max(sent, state.acked_oid)]
                for item in pending:
                    sent = item.oid
                    yield item
                state.outbox_changed.clear()
                await state.outbox_changed.wait()

        @mutates(idempotent=True)
        async def ackOutbox(self, oid: int, ctx: RpcContext) -> Empty:
            """Cumulative acknowledgement."""
            state.acked_oid = max(state.acked_oid, oid)
            state.outbox = [item for item in state.outbox if item.oid > state.acked_oid]
            return Empty()

    @service(f"{SERVICE_PREFIX}.Sessions", targeted=True)
    class Sessions:
        """Client-shaped reads and watch streams."""

        @stream
        async def snapshot(
            self,
            sessionId: str,
            ctx: RpcContext,
            limit: int = 100,
            byteBudget: int = 1024 * 1024,
            encoding: str | None = None,
        ) -> AsyncIterator[StreamChunk]:
            """Snapshot body in chunks."""
            state.calls.append("snapshot")
            if state.read_delay:
                await asyncio.sleep(state.read_delay)
            session = state.session(sessionId)
            items = session.items[-limit:]
            body = {
                "timeline": {
                    "items": items,
                    "nextSeq": session.head_seq,
                    "hasMore": len(session.items) > limit,
                },
                "notices": [],
                "eventCursor": f"seq:{session.head_seq}",
            }
            if encoding == "deflate":
                packed = base64.b64encode(zlib.compress(json.dumps(body).encode(), 6)).decode()
                yield StreamChunk(seq=0, chunk=packed, end=True)
                return
            yield StreamChunk(seq=0, chunk=body, end=True)

        @stream
        async def watch(self, sessionId: str, afterSeq: int, ctx: RpcContext) -> AsyncIterator[ChangesEvent]:
            """Opening subscribes, cancelling unsubscribes."""
            state.calls.append("watch")
            session = state.session(sessionId)
            queue: asyncio.Queue[ChangesEvent] = asyncio.Queue()
            session.watchers.add(queue)
            try:
                while True:
                    yield await queue.get()
            finally:
                session.watchers.discard(queue)

        @query
        async def notices(self, sessionId: str) -> Payload:
            """Pending notices."""
            return Payload(notices=[])

        @query
        async def state(self, sessionId: str) -> Payload:
            """Runtime state."""
            return Payload(status="idle")

        @query
        async def capabilities(self, sessionId: str) -> Payload:
            """Runtime capabilities."""
            return Payload(capabilities={})

        @query
        async def queue(self, sessionId: str) -> Payload:
            """Queued messages."""
            return Payload(items=[])

    @service(f"{SERVICE_PREFIX}.Store", targeted=True)
    class Store:
        """Timeline reads."""

        @query
        async def read(
            self,
            sessionId: str,
            mode: str,
            cursor: int | None = None,
            limit: int = 100,
            byteBudget: int = 1024 * 1024,
        ) -> StoreReadResponse:
            """Read a page."""
            state.calls.append("read")
            if state.read_delay:
                await asyncio.sleep(state.read_delay)
            session = state.session(sessionId)
            items = session.items
            if mode == "before" and cursor is not None:
                items = [item for item in items if item.get("orderSeq", 0) < cursor]
            page = items[-limit:]
            return StoreReadResponse(
                items=page,
                headSeq=session.head_seq,
                resetSeq=session.reset_seq,
                hasMore=len(items) > len(page),
                oldestOrderSeq=page[0].get("orderSeq") if page else None,
            )

        @query
        async def changesSince(
            self, sessionId: str, afterSeq: int, limit: int = 500, byteBudget: int = 1024 * 1024
        ) -> ChangesSinceResponse:
            """Changes after a cursor."""
            state.calls.append("changesSince")
            session = state.session(sessionId)
            if afterSeq < session.reset_seq:
                return ChangesSinceResponse(
                    toSeq=session.head_seq, resetSeq=session.reset_seq, complete=False, snapshotRequired=True
                )
            changed = [item for item in session.items if item.get("updatedSeq", 0) > afterSeq][:limit]
            events = [
                {
                    "type": "timeline.item_updated",
                    "sessionId": sessionId,
                    "seq": item["updatedSeq"],
                    "payload": {"item": item},
                }
                for item in changed
            ]
            return ChangesSinceResponse(
                events=events,
                toSeq=changed[-1]["updatedSeq"] if changed else max(afterSeq, session.head_seq),
                resetSeq=session.reset_seq,
                complete=True,
            )

    async def run_command(
        method: str, commandId: str, deadline: str, inputDigest: str | None, p: dict[str, Any]
    ) -> CommandAck:
        state.calls.append(method)
        if commandId in state.receipts:
            return state.receipts[commandId]
        if state.command_delay:
            await asyncio.sleep(state.command_delay)
        state.command_log.append((method, p))
        result: Any = {"ok": True}
        if state.command_handler is not None:
            result = state.command_handler(method, p)
            if asyncio.iscoroutine(result):
                result = await result
        if isinstance(result, LinkError):
            ack = CommandAck(outcome="rejected", e=result)
        else:
            ack = CommandAck(outcome="accepted", r=result)
        state.receipts[commandId] = ack
        return ack

    namespace: dict[str, Any] = {"__doc__": "State-changing commands with durable receipts."}
    for business in COMMAND_METHODS:
        name = command_route(business).method

        def make(business_method: str, method_name: str) -> Any:
            async def handler(
                self: Any,
                commandId: str,
                deadline: str,
                ctx: RpcContext,
                inputDigest: str | None = None,
                p: dict[str, Any] | None = None,
            ) -> CommandAck:
                state.check_connection(ctx)
                return await run_command(business_method, commandId, deadline, inputDigest, p or {})

            handler.__name__ = method_name
            handler.__qualname__ = f"Commands.{method_name}"
            handler.__doc__ = f"Command {business_method}."
            return mutates(handler)

        namespace[name] = make(business, name)

    async def status(self: Any, commandId: str) -> CommandStatusResponse:
        ack = state.receipts.get(commandId)
        if ack is None:
            return CommandStatusResponse(commandId=commandId, known=False)
        return CommandStatusResponse(commandId=commandId, known=True, outcome=ack.outcome, r=ack.r, e=ack.e)

    status.__qualname__ = "Commands.status"
    status.__doc__ = "Look up a command receipt."
    namespace["status"] = query(status)
    commands = service(f"{SERVICE_PREFIX}.Commands", targeted=True)(type("Commands", (), namespace))

    return [Link(), Sessions(), Store(), commands()]


class FakeDevice:
    """One device on one Router connection."""

    def __init__(self, device_id: str, router_url: str, token: str) -> None:
        self.state = FakeDeviceState(device_id)
        self.router_url = router_url
        self.token = token
        self.mesh: Mesh | None = None
        self._serve: Any = None
        self.server: Any = None

    async def start(self) -> None:
        self.mesh = Mesh(
            Router(self.router_url),
            credentials=RouterCredentials.bearer(self.token),
            reconnect=ReconnectPolicy(enabled=False),
            retry=RetryPolicy(enabled=False),
            max_frame_size=MESH_MAX_FRAME_BYTES,
        )
        self.mesh.mount(*_make_services(self.state), instance_id=self.state.device_id)
        self._serve = self.mesh.serve(access_log=False, log_level="WARNING", drain_timeout=0.5)
        self.server = await self._serve.__aenter__()

    async def stop(self) -> None:
        if self._serve is not None:
            serve, self._serve = self._serve, None
            with contextlib.suppress(Exception):
                await serve.__aexit__(None, None, None)
        if self.mesh is not None:
            mesh, self.mesh = self.mesh, None
            with contextlib.suppress(Exception):
                await mesh.close()
