"""Device MeshCall services 1.0: the contract between the Server and a v3 Connector.

Server <-> Connector runs on MeshCall (decision D9, Effi notes M20/M6) and
replaces the v2 Connector WebSocket and ingest endpoints. The device registers
targeted ``aa.device.v1.*`` services on the MeshCall Router with
``instance_id = deviceId``; the Server calls them. Only the token handshake is
plain HTTP (``POST /api/v3/device/hello`` and ``/ready``). MeshCall supplies
framing, multiplexing, flow control and keepalive; this module defines the
service payloads plus the business rules MeshCall has no equivalent for:
durable command receipts, the persistent outbox, the per-session clock floor,
offline semantics and display envelopes. See
``contracts/device-meshcall/1.0/README.md``.

Design rules encoded here:

* The device owns session content and the per-session clock. The Server keeps
  no timeline, plan or goal content and never buffers events.
* Events the device sends are already shaped for clients (``ProtocolEventEnvelope``);
  the Server wraps and forwards them without parsing items.
* Display content (titles, latest item previews, working directories) travels in
  ``DisplayEnvelope`` values that the Server stores but never interprets.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from agent_server.core.protocol import PROTOCOL_MAX_REVISION, ProtocolEventEnvelope

DEVICE_MESHCALL_VERSION = "1.0"
DeviceContractVersion = Literal["1.0"]

MESHCALL_PROTOCOL = "meshcall/1"
MESH_SERVICE_PREFIX = "aa.device.v1"
# Router --max-frame-size; clients and the Router must agree or a larger frame closes the connection (1009).
MESH_MAX_FRAME_BYTES = 4 * 1024 * 1024
DEFAULT_BYTE_BUDGET = 1024 * 1024
SEQ_CEILING_STRIDE = 1024
ATTACH_HEARTBEAT_SECONDS = 20
PRESENCE_LEASE_SECONDS = 60
# A heartbeat the device could not write for this long (no stream credit) means the holder is stuck.
ATTACH_STALL_SECONDS = 2 * ATTACH_HEARTBEAT_SECONDS
READY_RETRY_MAX_SECONDS = 30
CONNECTION_ID_METADATA = "aa-connection-id"

Seq = Annotated[int, Field(ge=0, le=PROTOCOL_MAX_REVISION)]
NonEmpty = Annotated[str, Field(min_length=1)]


def _omit_default_additional_properties(schema: dict[str, Any]) -> None:
    schema.pop("additionalProperties", None)


class DeviceModel(BaseModel):
    model_config = ConfigDict(
        json_schema_serialization_defaults_required=True,
        extra="allow",
        json_schema_extra=_omit_default_additional_properties,
    )


# ---------------------------------------------------------------------------
# Shared value objects
# ---------------------------------------------------------------------------


class LinkError(DeviceModel):
    code: NonEmpty
    message: str = ""
    retryable: bool = False


class DisplayEnvelope(DeviceModel):
    """Human-facing content the Server stores but never reads.

    ``plain``: ``payload`` is a JSON object (normal mode).
    ``sealed``: ``payload`` is base64 ciphertext encrypted with the device's
    directory key identified by ``keyId`` (E2EE mode).
    """

    mode: Literal["plain", "sealed"]
    keyId: str | None = None
    payload: dict[str, Any] | str


class SessionHead(DeviceModel):
    sessionId: NonEmpty
    headSeq: Seq
    resetSeq: Seq


class LatestItemFacts(DeviceModel):
    """Scheduling facts about the latest timeline item; no text."""

    id: NonEmpty
    type: NonEmpty
    role: str | None = None
    status: str | None = None
    time: str | None = None


SessionStatusValue = Literal[
    "idle",
    "pending",
    "running",
    "waiting",
    "waiting_approval",
    "blocked",
    "stopping",
    "error",
    "unknown",
]
PlanStateValue = Literal["none", "planning", "awaiting_review"]
GoalStateValue = Literal["none", "active", "paused", "completed"]
SourceAvailability = Literal["available", "archived", "deleted", "missing", "unknown"]
E2eeMode = Literal["off", "required"]


class SessionSummary(DeviceModel):
    """Reported fields of a session directory entry (device is the only writer)."""

    sessionId: NonEmpty
    runtimeId: NonEmpty
    runtimeType: NonEmpty
    externalSessionId: str | None = None
    status: SessionStatusValue
    sortAt: str
    lastActivityAt: str | None = None
    latestItem: LatestItemFacts | None = None
    latestTurnEndSeq: Seq | None = None
    headSeq: Seq
    resetSeq: Seq
    sourceAvailability: SourceAvailability = "available"
    planState: PlanStateValue = "none"
    goalState: GoalStateValue = "none"
    displayDevice: DisplayEnvelope
    #: E2EE required mode: the Server-issued project the session was created in (the device keeps it
    #: from ``create-and-start``). Not content. Used only when the Server first creates the row;
    #: sessions the device found itself omit it and a client assigns their project later.
    projectId: str | None = None


# ---------------------------------------------------------------------------
# MeshCall carriage: what replaces the 1.0 draft's frames
# ---------------------------------------------------------------------------
#
# req/res        -> unary calls (read methods are ``read_only``)
# stream/credit  -> ``server_stream`` with MeshCall item credit
# cmd/ack        -> unary ``Commands/*`` with ``idempotency_key = commandId``;
#                   durable receipts stay ours (``CommandAck``, ``command.result``)
# evt            -> items on ``Link/attach``; ``changes`` -> ``Sessions/watch``
# out/oack       -> ``Link/outbox`` stream + unary ``Link/ackOutbox``
# tun            -> duplex ``Secure/channel`` (E2EE ``required`` only)
# ping/pong      -> MeshCall keepalive


CommandOutcome = Literal["accepted", "rejected", "unknown"]


class Empty(DeviceModel):
    pass


class MethodPayload(DeviceModel):
    """Payload of a method whose model is defined by its owning contract (runtime-control, preview...)."""


class CommandCall(DeviceModel):
    """Request of every ``Commands/*`` call: a state-changing intent with a durable receipt."""

    commandId: NonEmpty = Field(description="equals clientMessageId/operationId when the client supplied one")
    deadline: str
    inputDigest: str | None = Field(
        default=None,
        description="Client-computed digest of the plaintext input; the Server only compares it",
    )
    p: dict[str, Any] = Field(default_factory=dict)


class CommandAck(DeviceModel):
    """Response of a ``Commands/*`` call. ``accepted`` only after the device committed it to disk.

    ``unknown`` never travels: the Server derives it from transport errors after the call opened.
    """

    outcome: Literal["accepted", "rejected"]
    r: dict[str, Any] | None = None
    e: LinkError | None = None


class PendingCommand(CommandCall):
    """A command the Server still waits on, replayed in ``LinkWelcome.pendingCommands``."""

    m: NonEmpty


class StreamChunk(DeviceModel):
    """One item of a large read (``Sessions/snapshot``, ``Store/readBlob``...)."""

    seq: Seq
    chunk: dict[str, Any] | str
    end: bool = False


class LinkAttachRequest(DeviceModel):
    connectionId: NonEmpty


class LinkAttachItem(DeviceModel):
    """Item on ``Link/attach``: a heartbeat every 20 s, or a lossy event (``EVENT_METHODS`` minus ``changes``)."""

    kind: Literal["heartbeat", "event"]
    m: str | None = None
    p: dict[str, Any] = Field(default_factory=dict)


class OutboxOpenRequest(DeviceModel):
    connectionId: NonEmpty


class OutboxItem(DeviceModel):
    """Persistent outbox message; every ``Link/outbox`` open resends from the lowest unacknowledged ``oid``."""

    oid: Seq
    m: NonEmpty
    p: dict[str, Any] = Field(default_factory=dict)


class OutboxAck(DeviceModel):
    """Cumulative: everything up to and including ``oid`` may be deleted."""

    oid: Seq


class SessionWatchRequest(DeviceModel):
    """``Sessions/watch``: opening the stream subscribes, cancelling it unsubscribes."""

    sessionId: NonEmpty
    afterSeq: Seq


class SecureChannelOpen(DeviceModel):
    """Request of the duplex ``Secure/channel``: one call per client channel."""

    clientId: NonEmpty
    ch: NonEmpty


class SecureChannelItem(DeviceModel):
    """Noise transport message in either direction; ``n`` is the per-direction counter."""

    n: Seq
    ct: str = Field(description="base64 Noise transport message")


# ---------------------------------------------------------------------------
# Handshake
# ---------------------------------------------------------------------------


class LinkHello(DeviceModel):
    """``POST /api/v3/device/hello`` (device credentials in the HTTP headers)."""

    deviceId: NonEmpty
    connectorVersion: NonEmpty
    contractVersions: list[DeviceContractVersion] = Field(min_length=1)
    os: NonEmpty
    host: Literal["desktop", "cli", "dsh-plugin"]
    capabilities: list[str] = Field(default_factory=list)
    sessionsHead: list[SessionHead] = Field(default_factory=list)


class DesiredState(DeviceModel):
    runtimes: list[dict[str, Any]] = Field(default_factory=list)
    deviceSettings: dict[str, Any] = Field(default_factory=dict)
    channelSwitches: list[dict[str, Any]] = Field(default_factory=list)


class MeshCredentials(DeviceModel):
    """Where and how the device registers its services; the token may register only ``instanceId``."""

    routerUrl: NonEmpty
    token: NonEmpty
    tokenId: NonEmpty
    expiresAt: str
    instanceId: NonEmpty = Field(description="always the deviceId")
    services: list[NonEmpty] = Field(default_factory=list, description="services the token grants")
    maxFrameBytes: int = MESH_MAX_FRAME_BYTES


class LinkWelcome(DeviceModel):
    """Response to ``/device/hello``. Issuing it revokes the device's previous Mesh token."""

    contractVersion: DeviceContractVersion
    serverVersion: NonEmpty
    connectionId: NonEmpty
    seqFloors: dict[str, Seq] = Field(
        default_factory=dict,
        description="sessionId -> max(head_seq, seq_ceiling); the device clock must restart above it",
    )
    e2eeMode: E2eeMode = "off"
    desired: DesiredState = Field(default_factory=DesiredState)
    pendingCommands: list[PendingCommand] = Field(default_factory=list)
    mesh: MeshCredentials


class LinkReady(DeviceModel):
    """``POST /api/v3/device/ready`` once the services are registered; the Server then opens
    ``Link/attach`` and ``Link/outbox``. Presence is the Server-held ``attach`` stream."""

    connectionId: NonEmpty


# ---------------------------------------------------------------------------
# Events (``Link/attach`` items; ``changes`` on ``Sessions/watch``)
# ---------------------------------------------------------------------------


class ChangesEvent(DeviceModel):
    """Item of ``Sessions/watch``: client-shaped events for a watched session."""

    sessionId: NonEmpty
    fromSeq: Seq
    toSeq: Seq
    resetSeq: Seq
    events: list[ProtocolEventEnvelope] = Field(default_factory=list)


class RuntimeStatusEvent(DeviceModel):
    runtimeId: NonEmpty
    status: dict[str, Any] = Field(default_factory=dict)
    capabilities: dict[str, Any] | None = None


# ---------------------------------------------------------------------------
# Outbox messages (``OutboxItem.p`` by ``OutboxItem.m``)
# ---------------------------------------------------------------------------


class SessionSummaryOut(DeviceModel):
    summary: SessionSummary


class SessionInventoryOut(DeviceModel):
    scanId: NonEmpty
    runtimeId: NonEmpty
    complete: bool
    sessions: list[SessionSummary] = Field(default_factory=list)


class CommandResultOut(DeviceModel):
    commandId: NonEmpty
    outcome: Literal["accepted", "rejected"]
    r: dict[str, Any] | None = None
    e: LinkError | None = None


class AttachmentConsumedOut(DeviceModel):
    fileId: NonEmpty
    sha256: NonEmpty


class UsageCounter(DeviceModel):
    name: NonEmpty
    value: int = Field(ge=0)
    runtimeId: str | None = None
    sessionId: str | None = None


class UsageReportOut(DeviceModel):
    periodStart: str
    periodEnd: str
    counters: list[UsageCounter] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Read requests (Server -> device)
# ---------------------------------------------------------------------------


class ClientSnapshotRequest(DeviceModel):
    sessionId: NonEmpty
    limit: int = Field(default=100, ge=1, le=500)
    byteBudget: int = Field(default=1024 * 1024, ge=4096)


class StoreReadRequest(DeviceModel):
    sessionId: NonEmpty
    mode: Literal["latest", "before", "after"]
    cursor: Seq | None = None
    limit: int = Field(default=100, ge=1, le=500)
    byteBudget: int = Field(default=1024 * 1024, ge=4096)


class StoreReadResponse(DeviceModel):
    items: list[dict[str, Any]] = Field(default_factory=list)
    headSeq: Seq
    resetSeq: Seq
    hasMore: bool
    oldestOrderSeq: int | None = None


class ChangesSinceRequest(DeviceModel):
    sessionId: NonEmpty
    afterSeq: Seq
    limit: int = Field(default=500, ge=1, le=2000)
    byteBudget: int = Field(default=1024 * 1024, ge=4096)


class ChangesSinceResponse(DeviceModel):
    events: list[ProtocolEventEnvelope] = Field(default_factory=list)
    toSeq: Seq
    resetSeq: Seq
    complete: bool
    snapshotRequired: bool = False


class CommandStatusRequest(DeviceModel):
    commandId: NonEmpty


class CommandStatusResponse(DeviceModel):
    commandId: NonEmpty
    known: bool
    outcome: CommandOutcome | None = None
    r: dict[str, Any] | None = None
    e: LinkError | None = None


# ---------------------------------------------------------------------------
# Command payloads (``CommandCall.p``)
# ---------------------------------------------------------------------------


class AttachmentRef(DeviceModel):
    fileId: NonEmpty
    name: str
    mediaType: str
    size: int = Field(ge=0)
    sha256: str | None = None
    encrypted: bool = False


class SendMessageCommand(DeviceModel):
    sessionId: NonEmpty
    clientMessageId: NonEmpty
    content: str
    attachments: list[AttachmentRef] = Field(default_factory=list)
    queue: Literal["never", "auto", "interrupt"] | None = None


MeshShape = Literal["unary", "server_stream", "duplex"]


class MeshRoute(BaseModel):
    """Where a business method lives on MeshCall."""

    model_config = ConfigDict(frozen=True)

    service: str
    method: str
    shape: MeshShape = "unary"


def _r(service: str, method: str, shape: MeshShape = "unary") -> MeshRoute:
    return MeshRoute(service=f"{MESH_SERVICE_PREFIX}.{service}", method=method, shape=shape)


# Business method -> MeshCall route. Server and Connector must agree.
REQUEST_METHODS: dict[str, MeshRoute] = {
    "client.snapshot": _r("Sessions", "snapshot", "server_stream"),
    "session.watch": _r("Sessions", "watch", "server_stream"),
    "session.notices": _r("Sessions", "notices"),
    "session.state": _r("Sessions", "state"),
    "session.capabilities": _r("Sessions", "capabilities"),
    "session.queue": _r("Sessions", "queue"),
    "store.read": _r("Store", "read"),
    "store.changesSince": _r("Store", "changesSince"),
    "store.readBlob": _r("Store", "readBlob", "server_stream"),
    "store.exportShare": _r("Store", "exportShare", "server_stream"),
    "store.planDocument": _r("Store", "planDocument"),
    "runtime.catalogs": _r("Runtime", "catalogs"),
    "command.status": _r("Commands", "status"),
    # v2 critical-channel reads (#484): creation and workspace preparation progress.
    "session.creation.get": _r("Sessions", "creationGet"),
    "workspace.preparation.get": _r("Sessions", "workspacePreparationGet"),
}

COMMAND_METHODS: tuple[str, ...] = (
    "session.sendMessage",
    "session.steer",
    "session.interrupt",
    "session.respondNotice",
    "session.select",
    "session.creation.begin",
    "session.creation.respond",
    "session.creation.cancel",
    "workspace.preparation.respond",
    "workspace.preparation.cancel",
    "session.planning",
    "session.goal",
    "session.queue.update",
    "session.queue.delete",
    "session.queue.retry",
    "session.queue.sendNow",
    "session.queue.resume",
    "session.queue.reorder",
    "session.queue.clear",
    "session.sync",
    "runtime.apply",
    "device.settings.apply",
    "channel.switch",
    "preview.open",
    "preview.close",
)


def command_route(method: str) -> MeshRoute:
    """``session.queue.sendNow`` -> ``aa.device.v1.Commands/sessionQueueSendNow``."""

    head, *rest = method.split(".")
    name = head + "".join(part[:1].upper() + part[1:] for part in rest)
    return _r("Commands", name)


# The v2 critical channel (#484, ``connector/server/rpc.py`` CRITICAL_RPC_METHODS): the device
# serves these from a reserved lane so long reads cannot starve approvals and creation prompts.
# ``interaction.respond`` is ``session.respondNotice`` here.
CRITICAL_METHODS: tuple[str, ...] = (
    "session.respondNotice",
    "session.notices",
    "session.creation.get",
    "session.creation.respond",
    "session.creation.cancel",
    "workspace.preparation.get",
    "workspace.preparation.respond",
    "workspace.preparation.cancel",
)

LINK_ROUTES: dict[str, MeshRoute] = {
    "link.attach": _r("Link", "attach", "server_stream"),
    "link.outbox": _r("Link", "outbox", "server_stream"),
    "link.ackOutbox": _r("Link", "ackOutbox"),
    "secure.channel": _r("Secure", "channel", "duplex"),
}

# ``Link/attach`` item methods (``changes`` travels on ``Sessions/watch``).
EVENT_METHODS: tuple[str, ...] = (
    "runtime.status",
    "runtime.notice.updated",
    "runtime.queue.updated",
    "port.listening",
    "port.closed",
)

OUTBOX_METHODS: tuple[str, ...] = (
    "session.summary",
    "session.inventory",
    "command.result",
    "attachment.consumed",
    "usage.report",
)


# ---------------------------------------------------------------------------
# E2EE ``required`` mode: what the device registers and what may leave it in plaintext
# ---------------------------------------------------------------------------
#
# In ``required`` mode the device registers only the routes below. Everything a user starts
# (reads, subscriptions, every other command, catalogs) goes through ``Secure/channel`` instead, so
# the Server has no plaintext target even if it wanted one (docs/v3/06-protocols.md §2.6).
E2EE_REQUEST_METHODS: tuple[str, ...] = ("command.status",)
E2EE_COMMAND_METHODS: tuple[str, ...] = (
    "runtime.apply",
    "device.settings.apply",
    "channel.switch",
    "preview.open",
    "preview.close",
)
# ``runtime.notice.updated`` and ``runtime.queue.updated`` carry notice and queued-message text, so
# in ``required`` mode they go only to the channels that subscribed to the session.
E2EE_EVENT_METHODS: tuple[str, ...] = ("runtime.status", "port.listening", "port.closed")


def registered_routes(mode: E2eeMode) -> tuple[MeshRoute, ...]:
    """Routes the device registers on the Router in the given mode."""

    if mode == "off":
        routes = [r for name, r in LINK_ROUTES.items() if name != "secure.channel"]
        routes += REQUEST_METHODS.values()
        routes += [command_route(name) for name in COMMAND_METHODS]
        return tuple(routes)
    routes = list(LINK_ROUTES.values())
    routes += [REQUEST_METHODS[name] for name in E2EE_REQUEST_METHODS]
    routes += [command_route(name) for name in E2EE_COMMAND_METHODS]
    return tuple(routes)


def registered_services(mode: E2eeMode) -> dict[str, list[str]]:
    """``{service: [method, …]}`` for ``server.register`` and for the Mesh token scopes."""

    services: dict[str, list[str]] = {}
    for route in registered_routes(mode):
        services.setdefault(route.service, []).append(route.method)
    return services


def scrub_for_e2ee(method: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Drop content a device must not send in ``required`` mode, before the Server stores or logs it.

    Defence in depth for E-1: a correct device already sends nothing here. Applies to outbox
    messages (``OUTBOX_METHODS``) and command receipts (``CommandAck``, ``CommandStatusResponse``).
    """

    out = dict(payload)
    if method in {"command.result", "command.ack", "command.status"}:
        out["r"] = None
        error = out.get("e")
        if isinstance(error, dict):
            out["e"] = {"code": error.get("code", "error"), "message": "", "retryable": bool(error.get("retryable"))}
    return out


# MeshCall error -> how the Server reports it. ``not_delivered``: the call never reached the
# device (offline semantics). ``outcome_unknown``: it may have run; never reported as offline
# and never retried automatically (t4wefan's #441 review).
FailureClass = Literal["not_delivered", "outcome_unknown", "application"]


class MeshErrorRule(BaseModel):
    model_config = ConfigDict(frozen=True)

    code: str
    reason: str | None = None
    failure: FailureClass
    readError: str = Field(description="AA error for read methods")
    commandError: str = Field(description="AA error for Commands/*")


MESH_ERROR_RULES: tuple[MeshErrorRule, ...] = (
    MeshErrorRule(code="unavailable", reason="no_instances", failure="not_delivered",
                  readError="deviceOffline", commandError="connector_offline"),
    MeshErrorRule(code="unavailable", reason="instance_unknown", failure="not_delivered",
                  readError="deviceOffline", commandError="connector_offline"),
    MeshErrorRule(code="unavailable", reason="instance_draining", failure="not_delivered",
                  readError="deviceOffline", commandError="connector_offline"),
    MeshErrorRule(code="resource_exhausted", reason="overloaded", failure="not_delivered",
                  readError="device_read_timeout", commandError="connector_offline"),
    MeshErrorRule(code="unavailable", reason="instance_lost", failure="outcome_unknown",
                  readError="device_read_timeout", commandError="command_outcome_unknown"),
    MeshErrorRule(code="deadline_exceeded", failure="outcome_unknown",
                  readError="device_read_timeout", commandError="command_outcome_unknown"),
    MeshErrorRule(code="cancelled", failure="outcome_unknown",
                  readError="device_read_timeout", commandError="command_outcome_unknown"),
    # Any other ``unavailable`` after the call opened (connection to the Router lost mid-call,
    # router_draining, router_shutdown): the device may have run it.
    MeshErrorRule(code="unavailable", failure="outcome_unknown",
                  readError="device_read_timeout", commandError="command_outcome_unknown"),
    MeshErrorRule(code="internal", failure="application",
                  readError="internal", commandError="internal"),
)


def classify_mesh_error(code: str, reason: str | None, *, opened: bool) -> FailureClass:
    """``opened``: the Router accepted ``call.open`` (a connect failure is never ``outcome_unknown``)."""

    if not opened:
        return "not_delivered"
    for rule in MESH_ERROR_RULES:
        if rule.code == code and (rule.reason is None or rule.reason == reason):
            return rule.failure
    return "application"


def next_seq_ceiling(current_ceiling: int, to_seq: int) -> int | None:
    """Return the new ceiling to persist before forwarding ``to_seq``, or None."""

    if to_seq <= current_ceiling:
        return None
    return min(to_seq + SEQ_CEILING_STRIDE, PROTOCOL_MAX_REVISION)


def seq_floor(head_seq: int, seq_ceiling: int) -> int:
    return max(head_seq, seq_ceiling)
