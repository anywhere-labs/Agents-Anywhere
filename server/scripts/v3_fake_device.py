"""A fake v3 device that serves ``aa.device.v1.*`` on a MeshCall Router.

Used by the S5 benchmark and the Server tests: it plays the Connector side of
``contracts/device-meshcall/1.0`` closely enough to exercise the Server
(attach heartbeats, a durable outbox, snapshots, watch streams, commands with
durable receipts). It is not a Connector: content lives in memory.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import hashlib
import itertools
import json
import re
import threading
import time
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
    generate_e2e_key,
    mutates,
    query,
    service,
    stream,
)
from pydantic import BaseModel, ConfigDict

from agent_server.core.device_content import CONTENT_SERVICE, ContentEvent, ContentPairResult, ContentResult
from agent_server.core.device_meshcall import (
    COMMAND_METHODS,
    CONNECTION_ID_METADATA,
    MAX_CHUNK_BYTES,
    MESH_MAX_FRAME_BYTES,
    ChangesEvent,
    ClientCallItem,
    CommandAck,
    CommandStatusResponse,
    LinkAttachItem,
    LinkError,
    OutboxItem,
    StreamChunk,
    TerminalStreamItem,
    command_route,
    registered_services,
)
from agent_server.core.events import protocol_event

SERVICE_PREFIX = "aa.device.v1"
POLL_SECONDS = 0.01


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
        self.watchers: dict[int, collections.deque[ChangesEvent]] = {}

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
                protocol_event(
                    self.session_id,
                    sequence=self.head_seq,
                    event_type="timeline.item_created",
                    payload={"item": item},
                )
            ],
        )
        for queue in tuple(self.watchers.values()):
            queue.append(event)
        return event


class FakeDeviceState:
    """Everything a fake device knows; tests inspect and drive it directly."""

    def __init__(self, device_id: str) -> None:
        self.device_id = device_id
        self.connection_id = ""
        self.sessions: dict[str, FakeSession] = {}
        # meshcall-py runs handlers on its own worker loop thread: state shared with the test
        # loop uses thread-safe containers and polling, never asyncio primitives.
        self.outbox: list[OutboxItem] = []
        self._oids = itertools.count(1)
        self.acked_oid = 0
        self.events: collections.deque[LinkAttachItem] = collections.deque()
        self.heartbeat_interval = 20.0
        self.receipts: dict[str, CommandAck] = {}
        self.command_log: list[tuple[str, dict[str, Any]]] = []
        self.command_handler: Callable[[str, dict[str, Any]], Any] | None = None
        self.command_delay = 0.0
        self.ack_delay = 0.0
        # Blobs the device holds (fileId -> bytes, name, media type) and how it uploads them:
        # ``blob_uploader(transfer, data)`` returns a concurrent future (the test's loop does the PUT).
        self.blobs: dict[str, tuple[bytes, str, str]] = {}
        self.blob_uploader: Callable[[dict[str, Any], bytes], Any] | None = None
        # ``Store/exportShare`` fails with this application error code when set (``share_too_large``, say).
        self.share_error: str | None = None
        self.attach_opened = threading.Event()
        self.outbox_opened = threading.Event()
        self.calls: list[str] = []
        # ``Client/call``: every request received (``ClientCallRequest`` as a dict) and what answers it.
        # ``client_handler(request)`` returns ``(status, body)``, a ``ClientAnswer`` dict
        # (``{"status", "body", "command", "contentType", "chunks"}``), a ``LinkError`` (a 409 answer that rejects
        # the command), or raises ``MeshCallError``. Without one the device answers 200 with the request echoed.
        # Commands replay by ``command.commandId`` like the device's inbox; ``client_receipts`` holds the heads.
        self.client_calls: list[dict[str, Any]] = []
        self.client_handler: Callable[[dict[str, Any]], Any] | None = None
        self.client_receipts: dict[str, dict[str, Any]] = {}
        self.client_runs: list[str] = []
        self.client_delay = 0.0
        # When set, ``Client/call`` work waits until the test sets this event (a device still running the call).
        self.client_gate: threading.Event | None = None
        self.client_chunk_bytes = MAX_CHUNK_BYTES
        # ``Client/subscribe``: terminal messages to send per terminal (``TerminalStreamItem`` dicts).
        self.client_terminal_items: dict[str, collections.deque[dict[str, Any]]] = collections.defaultdict(
            collections.deque
        )
        self.client_subscriptions: list[dict[str, Any]] = []
        # How many ``Client/subscribe`` streams are open now per terminal.
        self.client_subscribers: collections.Counter[str] = collections.Counter()

    def session(self, session_id: str) -> FakeSession:
        if session_id not in self.sessions:
            self.sessions[session_id] = FakeSession(session_id)
        return self.sessions[session_id]

    def push_outbox(self, method: str, payload: dict[str, Any]) -> OutboxItem:
        item = OutboxItem(oid=next(self._oids), m=method, p=payload)
        self.outbox.append(item)
        return item

    def emit(self, method: str, payload: dict[str, Any]) -> None:
        self.events.append(LinkAttachItem(kind="event", m=method, p=payload))

    def check_connection(self, ctx: RpcContext) -> None:
        got = ctx.metadata.get(CONNECTION_ID_METADATA)
        if self.connection_id and got != self.connection_id:
            raise MeshCallError(
                "failed_precondition",
                "stale connection id",
                details={"source": "device", "reason": "connection_replaced"},
            )


def _make_services(state: FakeDeviceState, *, mode: str = "off") -> list[object]:
    @service(f"{SERVICE_PREFIX}.Link", targeted=True)
    class Link:
        """Presence, lossy events and the durable outbox."""

        @stream
        async def attach(self, connectionId: str, ctx: RpcContext) -> AsyncIterator[LinkAttachItem]:
            """Heartbeat every 20 s plus lossy events."""
            state.check_connection(ctx)
            state.attach_opened.set()
            yield LinkAttachItem(kind="heartbeat")
            last = time.monotonic()
            while True:
                if state.events:
                    yield state.events.popleft()
                    continue
                if time.monotonic() - last >= state.heartbeat_interval:
                    last = time.monotonic()
                    yield LinkAttachItem(kind="heartbeat")
                    continue
                await asyncio.sleep(POLL_SECONDS)

        @stream
        async def outbox(self, connectionId: str, ctx: RpcContext) -> AsyncIterator[OutboxItem]:
            """Resend from the lowest unacknowledged oid, then follow new items."""
            state.check_connection(ctx)
            state.outbox_opened.set()
            sent = 0
            while True:
                pending = [item for item in list(state.outbox) if item.oid > max(sent, state.acked_oid)]
                for item in pending:
                    sent = item.oid
                    yield item
                await asyncio.sleep(POLL_SECONDS)

        @mutates(idempotent=True)
        async def ackOutbox(self, oid: int, ctx: RpcContext) -> Empty:
            """Cumulative acknowledgement."""
            state.acked_oid = max(state.acked_oid, oid)
            state.outbox = [item for item in state.outbox if item.oid > state.acked_oid]
            return Empty()

    @service(f"{SERVICE_PREFIX}.Sessions", targeted=True)
    class Sessions:
        """Per-session change streams."""

        @stream
        async def watch(self, sessionId: str, afterSeq: int, ctx: RpcContext) -> AsyncIterator[ChangesEvent]:
            """Opening subscribes, cancelling unsubscribes."""
            state.calls.append("watch")
            session = state.session(sessionId)
            queue: collections.deque[ChangesEvent] = collections.deque()
            session.watchers[id(queue)] = queue
            try:
                while True:
                    if queue:
                        yield queue.popleft()
                    else:
                        await asyncio.sleep(POLL_SECONDS)
            finally:
                session.watchers.pop(id(queue), None)

    @service(f"{SERVICE_PREFIX}.Store", targeted=True)
    class Store:
        """Blobs and share exports."""

        @stream
        async def readBlob(
            self, sessionId: str, blobRef: str, transfer: dict[str, Any], ctx: RpcContext
        ) -> AsyncIterator[StreamChunk]:
            """A blob: metadata on the stream, bytes over HTTP."""
            state.calls.append("readBlob")
            blob = state.blobs.get(blobRef)
            if blob is None:
                raise MeshCallError("not_found", "no such blob", details={"source": "device"})
            data, name, media_type = blob
            yield StreamChunk(
                seq=0,
                chunk={
                    "name": name,
                    "mediaType": media_type,
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                },
            )
            if state.blob_uploader is None:
                raise MeshCallError("failed_precondition", "no uploader", details={"source": "device"})
            await asyncio.wrap_future(state.blob_uploader(transfer, data))
            yield StreamChunk(seq=1, chunk={"done": True}, end=True)

        @stream
        async def exportShare(
            self, sessionId: str, selection: dict[str, Any], ctx: RpcContext, byteBudget: int = 1024 * 1024
        ) -> AsyncIterator[StreamChunk]:
            """An immutable share snapshot."""
            state.calls.append("exportShare")
            if state.share_error is not None:
                raise MeshCallError(state.share_error, "the device refused the export", details={"source": "device"})
            items = state.session(sessionId).items
            if selection.get("scope") == "message":
                wanted = set(selection.get("itemIds") or [])
                items = [item for item in items if item["id"] in wanted]
            files = sorted(set(re.findall(r'"fileId":\s*"(file_[^"]+)"', json.dumps(items))))
            yield StreamChunk(seq=0, chunk={"items": items, "attachments": files}, end=True)

    def client_answer(request: dict[str, Any]) -> dict[str, Any]:
        """Run the handler once; a command's answer is kept as its receipt."""
        result: Any = (200, {"echo": request})
        if state.client_handler is not None:
            result = state.client_handler(request)
        if isinstance(result, LinkError):
            result = {"status": 409, "body": {"detail": {"code": result.code, "message": result.message}},
                      "command": {"outcome": "rejected", "e": result.model_dump(mode="json")}}
        if isinstance(result, tuple):
            result = {"status": result[0], "body": result[1]}
        answer = dict(result)
        command = request.get("command")
        if command and "command" not in answer:
            answer["command"] = {"outcome": "accepted" if answer.get("status", 200) < 400 else "rejected"}
            if answer["command"]["outcome"] == "rejected":
                body = answer.get("body") or {}
                code = ((body.get("detail") or {}).get("code") if isinstance(body, dict) else None) or "rejected"
                answer["command"]["e"] = {"code": code, "message": code}
        if command and answer.get("command"):
            answer["command"] = {"commandId": command["commandId"], **answer["command"]}
            head = answer["command"]
            state.receipts[command["commandId"]] = CommandAck(
                outcome=head["outcome"], e=LinkError(**head["e"]) if head.get("e") else None
            )
        return answer

    @service(f"{SERVICE_PREFIX}.Client", targeted=True)
    class Client:
        """The client API (normal mode only)."""

        @stream
        async def call(
            self,
            route: str,
            method: str,
            path: str,
            caller: dict[str, Any],
            ctx: RpcContext,
            query: dict[str, str] | None = None,
            body: Any = None,
            command: dict[str, Any] | None = None,
            server: dict[str, Any] | None = None,
            byteBudget: int | None = None,
        ) -> AsyncIterator[ClientCallItem]:
            """One client request: a head, then the body in chunks."""
            state.check_connection(ctx)
            request = {
                "route": route, "method": method, "path": path, "query": query or {}, "body": body,
                "caller": caller, "command": command, "server": server,
            }
            state.client_calls.append(request)
            command_id = (command or {}).get("commandId")
            if command_id and command_id in state.client_receipts:
                answer = state.client_receipts[command_id]
            else:
                async def run() -> dict[str, Any]:
                    if state.client_delay:
                        await asyncio.sleep(state.client_delay)
                    gate = state.client_gate
                    while gate is not None and not gate.is_set():
                        await asyncio.sleep(0.01)
                    state.client_runs.append(route)
                    answer = client_answer(request)
                    if command_id and answer.get("command"):
                        state.client_receipts[command_id] = answer
                    return answer

                # A command outlives its call, as on a device: cancelling the call does not cancel the command.
                work = asyncio.ensure_future(run())
                answer = await (asyncio.shield(work) if command_id else work)
            yield ClientCallItem.model_validate({
                "kind": "head",
                "status": answer.get("status", 200),
                "contentType": answer.get("contentType", "application/json"),
                "command": answer.get("command"),
            })
            chunks = answer.get("chunks")
            if chunks is None:
                if answer.get("body") is None:
                    return
                text = answer["body"] if isinstance(answer["body"], str) else json.dumps(answer["body"])
                size = state.client_chunk_bytes
                chunks = [text[i:i + size] for i in range(0, len(text), size)] or [""]
            for seq, part in enumerate(chunks):
                yield ClientCallItem.model_validate(
                    {"kind": "chunk", "seq": seq, "chunk": part, "end": seq == len(chunks) - 1}
                )

        @stream
        async def subscribe(
            self,
            stream: str,
            terminalId: str,
            ctx: RpcContext,
            fromSeq: int = 0,
            caller: dict[str, Any] | None = None,
        ) -> AsyncIterator[TerminalStreamItem]:
            """Terminal messages queued in ``client_terminal_items``; ends after ``exit``."""
            state.check_connection(ctx)
            state.client_subscriptions.append({"stream": stream, "terminalId": terminalId, "fromSeq": fromSeq})
            if terminalId not in state.client_terminal_items:
                raise MeshCallError(
                    "not_found",
                    f"terminal not found: {terminalId}",
                    details={"source": "device", "aaCode": "terminal_not_found"},
                )
            queue = state.client_terminal_items[terminalId]
            state.client_subscribers[terminalId] += 1
            try:
                while True:
                    if queue:
                        item = TerminalStreamItem.model_validate(queue.popleft())
                        yield item
                        if item.type == "exit":
                            return
                    else:
                        await asyncio.sleep(POLL_SECONDS)
            finally:
                state.client_subscribers[terminalId] -= 1

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
        if state.ack_delay:
            # Committed, but the answer is late: the Server sees an unknown outcome.
            await asyncio.sleep(state.ack_delay)
        return ack

    # What a device registers in this mode (``contracts/device-meshcall/1.0/e2ee-registration.json``).
    registration = registered_services(mode)  # type: ignore[arg-type]
    allowed_commands = set(registration.get(f"{SERVICE_PREFIX}.Commands", ()))
    namespace: dict[str, Any] = {"__doc__": "State-changing commands with durable receipts."}
    for business in COMMAND_METHODS:
        name = command_route(business).method
        if name not in allowed_commands:
            continue

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

    @service(CONTENT_SERVICE, targeted=True)
    class Content:
        """Echo Connector content inside a Router-issued encrypted tunnel."""

        @mutates
        async def pair(self) -> ContentPairResult:
            """Refuse pairing on this test-only echo service."""
            raise MeshCallError("permission_denied", "This test device does not pair")

        @query
        async def request(self, method: str, path: str, ctx: RpcContext, body: Any = None) -> ContentResult:
            """Return the received body after testing the tunnel context."""
            if not ctx.tunnel or not ctx.tunnel.sealed:
                raise MeshCallError("permission_denied", "Encrypted content tunnel required")
            state.calls.append("content.request")
            return ContentResult(status=200, body=body)

        @stream
        async def subscribe(self, ctx: RpcContext) -> AsyncIterator[ContentEvent]:
            """Emit a single subscription event inside the tunnel."""
            if not ctx.tunnel or not ctx.tunnel.sealed:
                raise MeshCallError("permission_denied", "Encrypted content tunnel required")
            yield ContentEvent({"type": "session.subscribed"})

    built = {
        f"{SERVICE_PREFIX}.Link": Link,
        f"{SERVICE_PREFIX}.Sessions": Sessions,
        f"{SERVICE_PREFIX}.Store": Store,
        f"{SERVICE_PREFIX}.Commands": commands,
        f"{SERVICE_PREFIX}.Client": Client,
        CONTENT_SERVICE: Content,
    }
    # Everything follows the registration table.
    return [factory() for name, factory in built.items() if name in registration]


class FakeDevice:
    """One device on one Router connection."""

    def __init__(self, device_id: str, router_url: str, token: str, *, e2ee_mode: str = "off", e2ee_key=None) -> None:
        self.state = FakeDeviceState(device_id)
        self.router_url = router_url
        self.token = token
        self.e2ee_mode = e2ee_mode
        self.e2ee_key = e2ee_key or generate_e2e_key()
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
        self.mesh.mount(
            *_make_services(self.state, mode=self.e2ee_mode),
            instance_id=self.state.device_id,
            accept_tunnels=self.e2ee_mode == "required",
            e2e_private_key=self.e2ee_key.private_key if self.e2ee_mode == "required" else None,
        )
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


async def connect_device(
    client: Any,
    *,
    connector_id: str,
    connector_token: str,
    sessions_head: list[dict[str, Any]] | None = None,
    host: str = "cli",
) -> tuple[FakeDevice, dict[str, Any], str]:
    """Full v3 handshake against a Server: auth, hello, register on the Router, ready.

    ``client`` is an ``httpx.AsyncClient`` on the Server. Returns the device, the
    ``LinkWelcome`` body and the access token. In E2EE ``required`` mode (the welcome's
    ``e2eeMode``) the device mounts only Link, Commands and Content, like a real one.
    """

    auth = await client.post(
        "/api/v3/device/auth", headers={"Authorization": f"Connector {connector_id}:{connector_token}"}
    )
    auth.raise_for_status()
    access = auth.json()["accessToken"]
    headers = {"Authorization": f"Bearer {access}", "X-Device-OS": "macos", "X-Connector-Version": "3.0.0"}
    e2e_key = generate_e2e_key()
    hello = await client.post(
        "/api/v3/device/hello",
        headers=headers,
        json={
            "deviceId": connector_id,
            "connectorVersion": "3.0.0",
            "contractVersions": ["1.0"],
            "os": "macos",
            "host": host,
            "sessionsHead": sessions_head or [],
            "meshE2eeKey": e2e_key.public_key,
        },
    )
    hello.raise_for_status()
    welcome = hello.json()
    device = FakeDevice(
        connector_id,
        welcome["mesh"]["routerUrl"],
        welcome["mesh"]["token"],
        e2ee_mode=str(welcome.get("e2eeMode") or "off"),
        e2ee_key=e2e_key,
    )
    device.state.connection_id = welcome["connectionId"]
    await device.start()
    ready = await client.post("/api/v3/device/ready", headers=headers, json={"connectionId": welcome["connectionId"]})
    ready.raise_for_status()
    return device, welcome, access
