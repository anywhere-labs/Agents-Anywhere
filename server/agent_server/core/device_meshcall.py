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

from typing import Annotated, Any, ClassVar, Literal, NamedTuple

from pydantic import (
    BaseModel,
    ConfigDict,
    Discriminator,
    Field,
    RootModel,
    Tag,
    model_serializer,
)

from agent_server.core.client_routes import CLIENT_CALL_ROUTE_IDS, MAX_CHUNK_BYTES
from agent_server.core.device_runtime import RuntimeTypeDescriptor
from agent_server.core.device_settings import ConnectorDeviceSettings
from agent_server.core.goal.models import (
    GoalRequest,
    GoalResponse,
    GoalState,
)
from agent_server.core.message_queue import SessionQueueState
from agent_server.core.models import NoticeIn
from agent_server.core.planning.models import (
    PlanningCreationIntent,
    PlanningRequest,
    PlanningResponse,
    PlanningState,
)
from agent_server.core.preview import (
    PortClosedEvent,
    PortListeningEvent,
    PreviewCloseCommand,
    PreviewOpenCommand,
)
from agent_server.core.protocol import (
    PROTOCOL_MAX_REVISION,
    ProtocolCapabilitySet,
    ProtocolEventEnvelope,
    ProtocolModelCatalog,
    ProtocolPermissionCatalog,
    SessionRuntimeState,
)
from agent_server.core.runtime_workflows import (
    WorkflowInteractionResponse,
    WorkflowState,
)

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


class SparseModel(DeviceModel):
    """A model whose ``SPARSE`` fields are left out of its output while they are None (never sent as null)."""

    SPARSE: ClassVar[frozenset[str]] = frozenset()

    @model_serializer(mode="wrap")
    def _drop_absent(self, handler: Any) -> dict[str, Any]:
        data = handler(self)
        return {key: value for key, value in data.items() if not (key in self.SPARSE and value is None)}


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
    """One item of a large read (``Store/readBlob``, ``Store/exportShare``, ``Client/call``)."""

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


class LinkHello(DeviceModel):
    """``POST /api/v3/device/hello`` (device credentials in the HTTP headers)."""

    deviceId: NonEmpty
    connectorVersion: NonEmpty
    contractVersions: list[DeviceContractVersion] = Field(min_length=1)
    os: NonEmpty
    host: Literal["desktop", "cli", "dsh-plugin"]
    capabilities: list[str] = Field(default_factory=list)
    sessionsHead: list[SessionHead] = Field(default_factory=list)
    meshE2eeKey: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{43}$")


class ModelGateway(SparseModel):
    """The model gateway a Runtime instance uses, as the device takes it (the Server keeps it in the config)."""

    SPARSE: ClassVar[frozenset[str]] = frozenset({"model"})

    baseUrl: NonEmpty
    authToken: NonEmpty
    protocol: NonEmpty
    model: str | None = None


class RuntimeApplyCommand(SparseModel):
    """``runtime.apply``: one desired Runtime instance; also the item of ``LinkWelcome.desired.runtimes``.

    ``config`` holds only the instance's own settings, validated against its type's ``configSchema``
    (Runtime Control 2.1); a model gateway travels as ``modelGateway``. ``revision`` only grows, so a late
    command never undoes a newer one.
    """

    SPARSE: ClassVar[frozenset[str]] = frozenset({"modelGateway", "operationId", "switchRevision"})

    runtimeId: NonEmpty
    runtimeType: NonEmpty
    name: str | None = None
    active: bool
    config: dict[str, Any] | None = None
    revision: int = Field(default=0, ge=0)
    modelGateway: ModelGateway | None = None
    #: ``channel.switch`` only: the Server's switch fence.
    operationId: str | None = None
    switchRevision: int | None = Field(default=None, ge=0)


class ChannelSwitchCommand(RuntimeApplyCommand):
    """``channel.switch``: ``runtime.apply`` fenced by the switch the Server is executing
    (``operationId``, ``switchRevision``; sent when the device declared ``channelReconcileFence``)."""


class DesiredState(DeviceModel):
    runtimes: list[RuntimeApplyCommand] = Field(default_factory=list)
    #: The stored device settings as they are (``ConnectorDeviceSettings``; unknown keys pass through).
    deviceSettings: dict[str, Any] = Field(default_factory=dict)
    channelSwitches: list[ChannelSwitchCommand] = Field(default_factory=list)


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


class RuntimeTypesStatus(DeviceModel):
    """The Runtime types this device build ships (``runtimeId: "*"``); replaces discovery."""

    event: Literal["runtime.types"]
    runtimeTypes: list[RuntimeTypeDescriptor] = Field(default_factory=list)
    features: list[str] = Field(default_factory=list)


class RuntimeInstanceReport(DeviceModel):
    status: NonEmpty
    phase: dict[str, Any] | None = None
    error: LinkError | None = None
    #: Runtime Control 2.1 ``modelConnection`` status of the instance.
    modelConnection: dict[str, Any] | None = None


class RuntimeInstanceStatus(DeviceModel):
    """An instance after the device applied desired state, with the provider's facts beside it."""

    instance: RuntimeInstanceReport
    runtimeType: str | None = None
    enabled: bool | None = None
    installed: bool | None = None
    error: LinkError | None = None


class RuntimeHealthStatus(DeviceModel):
    """The running instance's own health (``ready``, ``degraded``, …)."""

    state: NonEmpty
    error: LinkError | None = None


class CapabilitiesChangedStatus(DeviceModel):
    """The capability set of the instance (no ``sessionId``) or of one session changed; the set is
    ``RuntimeStatusEvent.capabilities`` (``scope: "session"`` items for a session)."""

    event: Literal["capabilities.changed"]


class SlashCommand(DeviceModel):
    name: NonEmpty
    description: str | None = None
    inputHint: str | None = None


class SessionCatalogs(DeviceModel):
    """A session's catalogs: models, permissions, slash commands and the current selections."""

    models: ProtocolModelCatalog | None = None
    permissions: ProtocolPermissionCatalog | None = None
    commands: list[SlashCommand] | None = None
    selections: dict[str, Any] | None = None


class CatalogsChangedStatus(DeviceModel):
    event: Literal["catalogs.changed"]
    catalogs: SessionCatalogs = Field(default_factory=SessionCatalogs)


class SessionStatusChanged(DeviceModel):
    event: Literal["session.status"]
    status: SessionStatusValue


class ConfigUpdatedStatus(DeviceModel):
    """The session's Agent configuration options changed."""

    event: Literal["config.updated"]
    options: list[dict[str, Any]] = Field(default_factory=list)


class CommandsUpdatedStatus(DeviceModel):
    """The session's slash commands as its Runtime reported them last (the whole list)."""

    event: Literal["commands.updated"]
    commands: list[SlashCommand] = Field(default_factory=list)


class RuntimeWriter(DeviceModel):
    """Who writes to the session: this device (``self``), another program (``external``), nobody or unknown."""

    holder: Literal["self", "external", "none", "unknown"]
    #: The external writer (``codex-app``, ``dsh-desktop``, ``terminal``, …).
    by: str | None = None
    execution: Literal["idle", "running", "waiting_for_input", "unknown"] | None = None


class WriterChangedStatus(DeviceModel):
    event: Literal["writer.changed"]
    writer: RuntimeWriter


class RuntimeUsageCost(DeviceModel):
    amount: float
    currency: NonEmpty


class UsageUpdatedStatus(DeviceModel):
    """The session's context usage as its Runtime reported it last."""

    event: Literal["usage.updated"]
    usedTokens: int | None = Field(default=None, ge=0)
    contextWindow: int | None = Field(default=None, ge=0)
    cost: RuntimeUsageCost | None = None


class BackgroundTask(DeviceModel):
    """A background task of a session (a background command, a sub-Agent) and its state."""

    taskId: NonEmpty
    kind: Literal["command", "subagent", "other"]
    title: str
    state: Literal["running", "requires_action", "idle", "completed", "failed", "stopped"]


class BackgroundUpdatedStatus(DeviceModel):
    """One background task of the session changed (the task is nested: a top-level ``state`` is the health fact)."""

    event: Literal["background.updated"]
    task: BackgroundTask


class PlanningStateUpdated(DeviceModel):
    event: Literal["planning.state.updated"]
    revision: Seq
    state: PlanningState


class GoalStateUpdated(DeviceModel):
    event: Literal["goal.state.updated"]
    revision: Seq
    state: GoalState


def _runtime_status_tag(value: Any) -> str | None:
    """``event`` when present; else ``instance`` or ``state`` by which fact the status carries."""

    def get(key: str) -> Any:
        return value.get(key) if isinstance(value, dict) else getattr(value, key, None)

    event = get("event")
    if isinstance(event, str):
        return event
    if get("instance") is not None:
        return "instance"
    if get("state") is not None:
        return "state"
    return None


RuntimeStatusPayload = Annotated[
    Annotated[RuntimeTypesStatus, Tag("runtime.types")]
    | Annotated[RuntimeInstanceStatus, Tag("instance")]
    | Annotated[RuntimeHealthStatus, Tag("state")]
    | Annotated[CapabilitiesChangedStatus, Tag("capabilities.changed")]
    | Annotated[CatalogsChangedStatus, Tag("catalogs.changed")]
    | Annotated[SessionStatusChanged, Tag("session.status")]
    | Annotated[ConfigUpdatedStatus, Tag("config.updated")]
    | Annotated[CommandsUpdatedStatus, Tag("commands.updated")]
    | Annotated[WriterChangedStatus, Tag("writer.changed")]
    | Annotated[UsageUpdatedStatus, Tag("usage.updated")]
    | Annotated[BackgroundUpdatedStatus, Tag("background.updated")]
    | Annotated[PlanningStateUpdated, Tag("planning.state.updated")]
    | Annotated[GoalStateUpdated, Tag("goal.state.updated")],
    Discriminator(_runtime_status_tag),
]


class RuntimeStatusEvent(DeviceModel):
    """``runtime.status``: what the device reports about a Runtime instance (``runtimeId: "*"`` for the
    device's Runtime types) or one of its sessions (``sessionId``)."""

    runtimeId: NonEmpty
    sessionId: str | None = None
    status: RuntimeStatusPayload
    capabilities: ProtocolCapabilitySet | None = None


class RuntimeNoticeUpdatedEvent(DeviceModel):
    """``runtime.notice.updated``: a session notice opened, changed or closed (protocol 1.2 notice)."""

    sessionId: NonEmpty
    notice: NoticeIn


class RuntimeQueueUpdatedEvent(DeviceModel):
    """``runtime.queue.updated``: the session's whole queue after a change (protocol 1.2 queue state)."""

    sessionId: NonEmpty
    queue: SessionQueueState


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


#: Counter names the Server records (``usage_events`` types); it skips a name it does not know.
USAGE_COUNTER_NAMES: tuple[str, ...] = (
    "message.sent",
    "session.created",
    "turn.ended",
    "approval.requested",
    "approval.resolved",
    "runtime.error",
)
# Names, outcomes and runtime types are identifiers, never free text.
_USAGE_TOKEN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$"
MAX_USAGE_COUNTER_VALUE = 10_000


class UsageCounter(DeviceModel):
    """How often one platform activity happened in the report's period, per session, runtime and outcome.

    ``message.sent`` / ``session.created``: messages and sessions the device accepted from the platform (not ones
    typed into the Agent locally). ``turn.ended``: turns of sessions the platform drives, ``outcome`` ``completed`` /
    ``interrupted`` / ``failed``. ``approval.requested`` / ``approval.resolved``: approvals, ``outcome`` ``resolved``
    / ``expired``. ``runtime.error``: errors the Runtime reported. ``durationsMs``: one entry per occurrence whose
    duration is known (turn: start to end; approval: opened to resolved), at most ``value`` entries.
    """

    name: str = Field(pattern=_USAGE_TOKEN)
    value: int = Field(ge=0, le=MAX_USAGE_COUNTER_VALUE)
    runtimeType: str | None = Field(default=None, pattern=_USAGE_TOKEN)
    runtimeId: str | None = Field(default=None, max_length=200)
    sessionId: str | None = Field(default=None, max_length=200)
    outcome: str | None = Field(default=None, pattern=_USAGE_TOKEN)
    durationsMs: list[Annotated[int, Field(ge=0)]] = Field(default_factory=list, max_length=MAX_USAGE_COUNTER_VALUE)


class UsageReportOut(DeviceModel):
    """``usage.report``: the device's platform activity since its previous report, as counters (D1: no content).

    Sent in plaintext in E2EE ``required`` mode too. The Server keys what it records by ``reportId``, so a report
    the outbox resends counts once. Counters belong to the period's end for hourly statistics.
    """

    reportId: str = Field(min_length=1, max_length=200)
    periodStart: str
    periodEnd: str
    counters: list[UsageCounter] = Field(default_factory=list, max_length=1000)


# ---------------------------------------------------------------------------
# Read requests (Server -> device)
# ---------------------------------------------------------------------------


class CommandStatusRequest(DeviceModel):
    commandId: NonEmpty


class CommandStatusResponse(DeviceModel):
    commandId: NonEmpty
    known: bool
    outcome: CommandOutcome | None = None
    r: dict[str, Any] | None = None
    e: LinkError | None = None


class WorkflowTarget(DeviceModel):
    """The Runtime instance a runtime-workflows 1.2 call runs on."""

    runtime: str | None = None
    runtimeId: NonEmpty


class PreparationGetRequest(WorkflowTarget):
    """``Sessions/workspacePreparationGet`` (critical lane)."""

    preparationId: NonEmpty


class CreationGetRequest(WorkflowTarget):
    """``Sessions/creationGet`` (critical lane)."""

    createOperationId: NonEmpty


class BlobTransfer(DeviceModel):
    """Where the device ``PUT``s the bytes (``DEVICE_TRANSFER_PATH``) and the one-time token."""

    transferId: NonEmpty
    token: NonEmpty
    path: NonEmpty


class ReadBlobRequest(DeviceModel):
    """``Store/readBlob``: a stored blob or attachment, relayed over HTTP."""

    sessionId: NonEmpty
    blobRef: NonEmpty
    transfer: BlobTransfer


class BlobHead(DeviceModel):
    """First ``readBlob`` item: the Server starts answering its client with these."""

    name: str
    mediaType: str
    size: int = Field(ge=0)
    sha256: str


class BlobProgress(DeviceModel):
    """Later ``readBlob`` items: progress, then ``done``."""

    progress: int | None = Field(default=None, ge=0)
    done: bool = False


class ReadBlobChunk(StreamChunk):
    chunk: BlobHead | BlobProgress


class ShareSelection(DeviceModel):
    scope: NonEmpty
    itemIds: list[str] = Field(default_factory=list)


class ExportShareRequest(DeviceModel):
    """``Store/exportShare``: an immutable snapshot of the selected items.

    ``byteBudget`` bounds the serialized items of the whole snapshot; a larger selection is refused with
    ``share_too_large`` rather than cut. Each stream chunk stays below the Router frame on its own.
    """

    sessionId: NonEmpty
    selection: ShareSelection
    byteBudget: int = Field(default=DEFAULT_BYTE_BUDGET, ge=4096)


class ShareExportPart(DeviceModel):
    """Chunks are merged in order: ``items`` concatenated, ``attachments`` (file ids) united."""

    items: list[dict[str, Any]] = Field(default_factory=list)
    attachments: list[str] = Field(default_factory=list)


class ExportShareChunk(StreamChunk):
    chunk: ShareExportPart | str


# ---------------------------------------------------------------------------
# Command payloads (``CommandCall.p``) and results (``CommandAck.r``)
# ---------------------------------------------------------------------------


class AttachmentRef(DeviceModel):
    """An attachment the Server holds (staged upload): the device fetches it by ``fileId``."""

    fileId: NonEmpty
    name: str
    mediaType: str
    size: int = Field(ge=0)
    sha256: str | None = None
    encrypted: bool = False


class CommandAttachmentRef(DeviceModel):
    """An attachment in a command: the Server's record; facts it does not have are left out."""

    fileId: NonEmpty
    name: str | None = None
    mediaType: str | None = None
    size: int | None = Field(default=None, ge=0)
    sha256: str | None = None


class SessionCommand(DeviceModel):
    """A command on one session; ``runtime``/``runtimeId`` name the instance when the Server knows it."""

    sessionId: NonEmpty
    runtime: str | None = None
    runtimeId: str | None = None


class CommandResult(DeviceModel):
    """A result whose fields the client route defines (passed through to the client)."""


class SendMessageCommand(DeviceModel):
    sessionId: NonEmpty
    clientMessageId: NonEmpty
    content: str = ""
    attachments: list[CommandAttachmentRef] = Field(default_factory=list)
    queue: Literal["never", "auto", "interrupt"] | None = None


class SendMessageResult(DeviceModel):
    """``accepted``: the turn started; ``queued``: it waits in the session's queue; ``duplicate``: seen before."""

    delivery: Literal["accepted", "queued", "duplicate"]
    clientMessageId: NonEmpty
    queuePosition: int | None = None
    queue: SessionQueueState | None = None
    item: dict[str, Any] | None = None
    state: str | None = None


class SteerCommand(SessionCommand):
    clientMessageId: NonEmpty
    content: str = ""
    attachments: list[CommandAttachmentRef] = Field(default_factory=list)
    externalSessionId: str | None = None
    cwd: str | None = None


class SteerResult(DeviceModel):
    outcome: NonEmpty


class InterruptResult(DeviceModel):
    interrupted: bool


class RespondNoticeCommand(SessionCommand):
    """An approval option (``actionId``), form ``input``, or ``cancel``; ``responseId`` defaults to the commandId."""

    noticeId: NonEmpty
    responseId: str | None = None
    actionId: str | None = None
    input: Any = None
    cancel: bool | None = None


class RespondNoticeResult(DeviceModel):
    """``ok: false`` with ``code``/``message``: the Runtime declined the answer and nothing ran (``status`` says
    whether the notice is still open or expired)."""

    status: NonEmpty
    ok: bool | None = None
    code: str | None = None
    message: str | None = None


class SelectCommand(SessionCommand):
    """``selections`` (catalog type -> selection id; null keeps the current one), or one ``optionId``/``value``."""

    selections: dict[str, str | bool | None] | None = None
    optionId: str | None = None
    value: str | bool | None = None
    externalSessionId: str | None = None


class SelectResult(DeviceModel):
    updated: bool | None = None
    applied: bool | None = None
    sessionId: str | None = None
    externalSessionId: str | None = None
    selections: dict[str, Any] | None = None
    state: SessionRuntimeState | None = None


class CreationBeginCommand(WorkflowTarget):
    """``session.creation.begin``: consumes a reserved workspace preparation (runtime-workflows 1.2)."""

    preparationId: NonEmpty
    createOperationId: NonEmpty
    sessionId: NonEmpty
    clientMessageId: NonEmpty
    content: str = ""
    selections: dict[str, str | None] = Field(default_factory=dict)
    configuration: dict[str, str | bool] | None = None
    planningIntent: PlanningCreationIntent | None = None
    title: str | None = None
    attachments: list[CommandAttachmentRef] = Field(default_factory=list)
    timelineAttachments: list[CommandAttachmentRef] = Field(default_factory=list)


class WorkspacePrepareCommand(WorkflowTarget):
    """``workspace.prepare``: open the Agent session of a workspace before the first message."""

    preparationId: NonEmpty
    clientPreparationId: str | None = None
    cwd: str | None = None
    projectId: str | None = None


class PreparationReserveCommand(WorkflowTarget):
    """``workspace.preparation.reserve``: hold a ready preparation for one creation."""

    preparationId: NonEmpty
    createOperationId: NonEmpty
    platformSessionId: NonEmpty
    expectedRevision: int = Field(ge=0)
    catalogRevision: int = Field(ge=0)
    selections: dict[str, str | None] = Field(default_factory=dict)
    planningIntent: PlanningCreationIntent | None = None
    configuration: dict[str, str | bool] | None = None


class WorkflowFailure(DeviceModel):
    code: NonEmpty
    message: str


class PreparationReserveResult(DeviceModel):
    """``reserved: false`` always carries the ``failure`` the creation is rejected with."""

    reserved: bool
    failure: WorkflowFailure | None = None


class PreparationRespondCommand(WorkflowInteractionResponse):
    """``workspace.preparation.respond``: an answer to an open request of the preparation."""

    model_config = ConfigDict(extra="allow")

    runtime: str | None = None
    runtimeId: NonEmpty
    preparationId: NonEmpty


class CreationRespondCommand(WorkflowInteractionResponse):
    """``session.creation.respond``: an answer to an open request of the creation."""

    model_config = ConfigDict(extra="allow")

    runtime: str | None = None
    runtimeId: NonEmpty
    createOperationId: NonEmpty


class PreparationCancelCommand(WorkflowTarget):
    preparationId: NonEmpty


class CreationCancelCommand(WorkflowTarget):
    createOperationId: NonEmpty
    cancelOperationId: str | None = None


class SessionPlanningCommand(PlanningRequest):
    """``session.planning``: the client's planning request on ``sessionId``."""

    sessionId: NonEmpty


class SessionGoalCommand(GoalRequest):
    """``session.goal``: the client's goal request on ``sessionId``."""

    sessionId: NonEmpty


class QueueItemCommand(SessionCommand):
    """``session.queue.update`` (``content``/``attachments``), ``delete``, ``retry``, ``sendNow``."""

    messageId: NonEmpty
    content: str | None = None
    attachments: list[CommandAttachmentRef] | None = None


class QueueReorderCommand(SessionCommand):
    messageIds: list[str]


class QueueResult(DeviceModel):
    """The whole queue after the operation (``{queue}``, or the queue itself)."""

    queue: SessionQueueState | None = None


class SessionSyncCommand(SessionCommand):
    """``session.sync``: a Server-owned fact of the session the device keeps a copy of."""

    takeover: bool | None = None
    archived: bool | None = None


class SessionSyncResult(DeviceModel):
    headSeq: Seq


# Agent session controls (``runtime-workflows/sessions/{id}/*``): the session's own Agent options, the Agent's
# optional operations, and releasing or reopening the Agent session. ``ownerGeneration`` / ``expectedGeneration``
# name the native session the client saw (``SessionRuntimeState.metadata.ownerGeneration``).


class AgentConfigOptionValue(DeviceModel):
    value: str
    name: str
    description: str | None = None


class AgentConfigOption(DeviceModel):
    """One option of the Agent session as the Agent reports it (the same shape as a prepared workspace's)."""

    id: NonEmpty
    name: str
    description: str | None = None
    category: str
    type: Literal["select", "boolean"]
    currentValue: str | bool
    options: list[AgentConfigOptionValue] | None = None


class AgentConfiguration(DeviceModel):
    """``revision`` changes whenever the options or their values change."""

    revision: Seq
    options: list[AgentConfigOption] = Field(default_factory=list)


class AgentAction(DeviceModel):
    """An Agent operation the session can run now, as the configuration panel lists it."""

    operation: NonEmpty
    title: NonEmpty


class AgentConfigurationView(DeviceModel):
    """``GET runtime-workflows/sessions/{id}/configuration``."""

    configuration: AgentConfiguration
    ownerGeneration: str | None = None
    actions: list[AgentAction] = Field(default_factory=list)


class SessionConfigureCommand(SessionCommand):
    """``session.configuration.update``: Agent options by id, applied only while ``expectedRevision`` is current."""

    operationId: NonEmpty
    expectedRevision: Seq
    values: dict[str, str | bool] = Field(max_length=128)


class SessionConfigureResult(AgentConfigurationView):
    operationId: NonEmpty
    phase: Literal["completed"]


class AgentOperateCommand(SessionCommand):
    """``session.agent.operate``: an operation the Agent declares a capability for (``AgentOperationRequest``)."""

    operation: NonEmpty
    operationId: NonEmpty
    expectedGeneration: NonEmpty
    values: dict[str, Any] = Field(default_factory=dict, max_length=128)


class AgentOperationResult(DeviceModel):
    operationId: NonEmpty
    phase: Literal["accepted", "running", "completed", "rejected", "cancelled", "outcome_unknown"]
    result: dict[str, Any] | None = None
    failure: WorkflowFailure | None = None


class PositionSelectCommand(SessionCommand):
    """``session.position.select``: the leaf of the Agent's session tree the next turn continues from."""

    fileEntriesDigest: NonEmpty
    sourceEpoch: NonEmpty
    positionRevision: Seq
    leafId: str | None = None


class SessionCloseCommand(SessionCommand):
    """``session.close``: releases the Agent session (its native record stays); the next operation reopens it."""

    ownerGeneration: NonEmpty
    closeOperationId: str | None = None


class SessionCloseResult(DeviceModel):
    closed: bool


class SessionRecoverCommand(SessionCommand):
    """``session.recover``: reopens an Agent session the Agent lost, now instead of on the next message."""

    operationId: NonEmpty
    expectedGeneration: NonEmpty
    cliExited: bool = False
    sourceRevision: str | None = None


class SessionRecoverResult(DeviceModel):
    operationId: NonEmpty
    phase: Literal["completed"]
    state: dict[str, Any] | None = None


class RuntimeApplyResult(DeviceModel):
    """The instance after ``runtime.apply`` / ``channel.switch``."""

    runtimeId: NonEmpty
    status: NonEmpty
    revision: int | None = None
    instanceId: str | None = None
    stale: bool | None = None
    capabilities: ProtocolCapabilitySet | None = None
    #: Runtime Control 2.1 ``modelConnection`` status.
    modelConnection: dict[str, Any] | None = None
    error: LinkError | None = None


class DeviceSettingsApplyCommand(DeviceModel):
    """``device.settings.apply``: the whole settings object, as ``LinkWelcome.desired`` has it."""

    settings: ConnectorDeviceSettings


class DeviceSettingsApplyResult(DeviceModel):
    applied: bool


class PreviewOpenResult(DeviceModel):
    previewId: NonEmpty
    port: int
    localIP: str


class PreviewCloseResult(DeviceModel):
    closed: bool


#: Where a device ``PUT``s relayed bytes (``Store/readBlob``, ``Client/call`` ``fs/read``); a path on the Server.
DEVICE_TRANSFER_PATH = "/api/v3/device/transfers/{transfer_id}"


# ---------------------------------------------------------------------------
# Client (normal mode only): the client API a device serves, one route per call
# ---------------------------------------------------------------------------
#
# ``Client/call`` carries one client API request (``core.client_routes``, ``via == "call"``) with the path
# and body the client sent; the device answers with the status and body the client gets. ``Client/subscribe``
# streams a terminal. In E2EE ``required`` mode the service is not registered: the same requests run
# inside ``Secure/channel``, where ``server`` facts do not exist and the device ignores them.

#: Ids of the routes ``Client/call`` serves (``core.client_routes.CLIENT_CALL_ROUTE_IDS``).
ClientRouteId = Literal[CLIENT_CALL_ROUTE_IDS]  # type: ignore[valid-type]
ClientHttpMethod = Literal["GET", "POST", "PUT", "PATCH", "DELETE"]


class ClientCaller(DeviceModel):
    """Who sent the request, as the Server authenticated it."""

    userId: NonEmpty
    clientId: str | None = None
    platform: str | None = None


class ClientCommand(DeviceModel):
    """A command route's receipt identity: the device's inbox replays by ``commandId``."""

    commandId: NonEmpty
    inputDigest: NonEmpty
    deadline: str


class ClientTransfer(BlobTransfer):
    """The relay a ``fs/read`` download goes through: where the device ``PUT``s the bytes, and where the client
    fetches them."""

    downloadUrl: str | None = Field(
        default=None,
        description="the URL the client downloads from (a preview download carries its previewAccessToken); "
        "default the device's own fs/transfers route",
    )


class ClientPreview(DeviceModel):
    """The file a preview token opened, as the Server verified it."""

    root: NonEmpty
    path: NonEmpty


class ClientServerFacts(DeviceModel):
    """Facts the Server owns. The device takes them over whatever the body says, on ``Client/call`` only."""

    sessionId: str | None = Field(default=None, description="create-and-start: the directory row the Server created")
    takeover: bool | None = None
    archived: bool | None = Field(default=None, description="whether the session is archived in the directory")
    attachments: list[AttachmentRef] | None = Field(
        default=None, description="the Server's records of the attachments the body references"
    )
    transfer: ClientTransfer | None = Field(default=None, description="fs/read: where the device PUTs the bytes")
    preview: ClientPreview | None = Field(default=None, description="a preview read: the file its token opened")


class ClientCallRequest(DeviceModel):
    """``Client/call``: one client API request. ``path`` is what the client called (``/api/v2/...``) with the
    query left out; ``route`` names its table entry so the device checks it and picks the lane first."""

    route: ClientRouteId
    method: ClientHttpMethod
    path: NonEmpty
    query: dict[str, str] = Field(default_factory=dict)
    body: Any = None
    caller: ClientCaller
    command: ClientCommand | None = None
    server: ClientServerFacts | None = None
    byteBudget: int | None = Field(default=None, ge=4096)


class ClientCommandOutcome(DeviceModel):
    """How the device settled the command; the Server settles its receipt from it."""

    commandId: NonEmpty
    outcome: Literal["accepted", "rejected"]
    e: LinkError | None = None


class ClientCallHead(DeviceModel):
    """First item of ``Client/call``: the HTTP status the client gets."""

    kind: Literal["head"]
    status: int = Field(ge=100, le=599)
    contentType: str = "application/json"
    command: ClientCommandOutcome | None = None


class ClientCallChunk(StreamChunk):
    """Later items: the body, JSON text split into pieces of at most ``MAX_CHUNK_BYTES`` (``end`` on the last)."""

    kind: Literal["chunk"]
    chunk: dict[str, Any] | str = Field(description=f"at most {MAX_CHUNK_BYTES} UTF-8 bytes")


class ClientCallItem(RootModel[Annotated[ClientCallHead | ClientCallChunk, Field(discriminator="kind")]]):
    """Item of ``Client/call``: one ``head``, then the body's ``chunk``s."""


class ClientSubscribeRequest(DeviceModel):
    """``Client/subscribe``: opening subscribes, cancelling unsubscribes. Input, resize and close are
    ``Client/call`` requests to the same paths as the client's."""

    stream: Literal["terminal"]
    terminalId: NonEmpty
    fromSeq: Seq = 0
    caller: ClientCaller | None = None


class TerminalStreamItem(DeviceModel):
    """A message of the terminal WebSocket, unchanged: ``replay`` (the scrollback, always first and again when
    the reader fell behind), ``output`` in order, then ``exit``."""

    type: Literal["replay", "output", "exit"]
    data: str | None = Field(default=None, description="base64 bytes (replay, output)")
    seq: Seq | None = None
    exitCode: int | None = None
    reason: str | None = None


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
# Business method -> MeshCall route, for what the Server calls on a device. Server and Connector must agree.
# Client reads of session content (snapshot, timeline, notices, state, queue, catalogs, plans) and the device's
# files, terminals and shell are client API routes the device serves through ``Client/call``.
REQUEST_METHODS: dict[str, MeshRoute] = {
    "session.watch": _r("Sessions", "watch", "server_stream"),
    "store.readBlob": _r("Store", "readBlob", "server_stream"),
    "store.exportShare": _r("Store", "exportShare", "server_stream"),
    "command.status": _r("Commands", "status"),
    # Creation and workspace preparation progress (critical lane).
    "session.creation.get": _r("Sessions", "creationGet"),
    "workspace.preparation.get": _r("Sessions", "workspacePreparationGet"),
    # Normal mode only: the client API routes the device serves (``core.client_routes``).
    "client.call": _r("Client", "call", "server_stream"),
    "client.subscribe": _r("Client", "subscribe", "server_stream"),
}

# Commands the device's inbox runs (``CommandCall`` in, ``CommandAck`` out, a durable receipt by ``commandId``).
# The client API reaches the inbox through ``Client/call`` and ``Secure/channel``; ``COMMAND_METHODS`` are the
# ones the Server itself sends as ``Commands/*``.
DEVICE_COMMANDS: tuple[str, ...] = (
    "session.sendMessage",
    "session.steer",
    "session.interrupt",
    "session.respondNotice",
    "session.select",
    "session.creation.begin",
    "session.creation.respond",
    "session.creation.cancel",
    # Workspace preparation (runtime-workflows 1.2): the Agent session opens before the first message.
    "workspace.prepare",
    "workspace.preparation.reserve",
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
    # Agent session controls (runtime-workflows/sessions/{id}/*).
    "session.configuration.update",
    "session.agent.operate",
    "session.position.select",
    "session.close",
    "session.recover",
    "runtime.apply",
    "device.settings.apply",
    "channel.switch",
    "preview.open",
    "preview.close",
)

# Commands the Server sends over MeshCall (``Commands/*``), the only ones a device registers there.
COMMAND_METHODS: tuple[str, ...] = (
    # Workspace preparation and the creation that consumes it (runtime workflows the Server keeps).
    "session.creation.begin",
    "session.creation.respond",
    "session.creation.cancel",
    "workspace.prepare",
    "workspace.preparation.reserve",
    "workspace.preparation.respond",
    "workspace.preparation.cancel",
    # Takeover pushed by the Server.
    "session.sync",
    "runtime.apply",
    "device.settings.apply",
    "channel.switch",
    "preview.open",
    "preview.close",
)
assert set(COMMAND_METHODS) <= set(DEVICE_COMMANDS)

# Commands the device may receive late: a receipt still unsettled when the device says hello is
# replayed in ``LinkWelcome.pendingCommands`` (desired state, not conversation). Only their receipts
# keep the payload; every other receipt keeps ``inputDigest`` and the outcome, never the input (D1).
DEFERRABLE_COMMANDS: frozenset[str] = frozenset({"runtime.apply", "device.settings.apply", "channel.switch"})


# What a deferrable receipt keeps of its payload: identifiers and fences only. Instance config, the
# model gateway and device settings may hold credentials, so they are never copied into a receipt;
# a replay rebuilds them from the current desired state (``LinkWelcome.desired``).
RECEIPT_PAYLOAD_FIELDS: dict[str, tuple[str, ...]] = {
    "runtime.apply": ("runtimeId", "runtimeType", "name", "active", "revision"),
    "channel.switch": ("runtimeId", "runtimeType", "name", "active", "revision", "operationId", "switchRevision"),
    "device.settings.apply": (),
}
assert set(RECEIPT_PAYLOAD_FIELDS) == DEFERRABLE_COMMANDS


def receipt_payload(method: str, payload: dict[str, Any] | None) -> dict[str, Any] | None:
    """What a command receipt may store of the input: the identifiers and fences of a deferrable
    command (``RECEIPT_PAYLOAD_FIELDS``), else nothing."""

    fields = RECEIPT_PAYLOAD_FIELDS.get(method)
    if fields is None:
        return None
    payload = payload or {}
    return {key: payload[key] for key in fields if key in payload}


def replay_payload(
    method: str,
    stored: dict[str, Any] | None,
    *,
    runtimes: list[dict[str, Any]],
    device_settings: dict[str, Any],
) -> dict[str, Any] | None:
    """The payload of a deferrable command replayed in ``LinkWelcome.pendingCommands``.

    Built from the current desired state, so the device always gets the newest config (with its
    ``revision``) and never a stale one; the receipt only contributes the instance and the fences.
    ``None``: nothing left to apply (the instance was deleted).
    """

    stored = stored or {}
    if method == "device.settings.apply":
        return {"settings": device_settings}
    if method not in ("runtime.apply", "channel.switch"):
        return None
    current = next((item for item in runtimes if item.get("runtimeId") == stored.get("runtimeId")), None)
    if current is None:
        return None
    fences = {key: stored[key] for key in ("operationId", "switchRevision") if key in stored}
    return {**current, **fences}


# Status enums of ``r`` a receipt may keep (``session.planning``: whether execution started).
RECEIPT_RESULT_FIELDS: tuple[str, ...] = ("execution",)


def receipt_result(result: dict[str, Any] | None) -> dict[str, Any] | None:
    """What a command receipt may store of the outcome (D1): the error code and status enums only.

    Never the device's ``r`` body (queue contents, states, messages): a caller that needs it takes
    it from the ``CommandAck`` it is waiting on.
    """

    if not isinstance(result, dict):
        return None
    out: dict[str, Any] = {}
    r = result.get("r")
    if isinstance(r, dict):
        kept = {key: r[key] for key in RECEIPT_RESULT_FIELDS if isinstance(r.get(key), str) and len(r[key]) <= 64}
        if kept:
            out["r"] = kept
    error = result.get("e")
    if isinstance(error, dict):
        out["e"] = {"code": str(error.get("code") or "error"), "retryable": bool(error.get("retryable"))}
    return out or None


def command_route(method: str) -> MeshRoute:
    """``session.queue.sendNow`` -> ``aa.device.v1.Commands/sessionQueueSendNow``."""

    head, *rest = method.split(".")
    name = head + "".join(part[:1].upper() + part[1:] for part in rest)
    return _r("Commands", name)


LINK_ROUTES: dict[str, MeshRoute] = {
    "link.attach": _r("Link", "attach", "server_stream"),
    "link.outbox": _r("Link", "outbox", "server_stream"),
    "link.ackOutbox": _r("Link", "ackOutbox"),
    "content.pair": _r("Content", "pair"),
    "content.request": _r("Content", "request"),
    "content.subscribe": _r("Content", "subscribe", "server_stream"),
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
# Business payloads by method
# ---------------------------------------------------------------------------
#
# The MeshCall envelopes (``CommandCall.p``, ``CommandAck.r``, ``LinkAttachItem.p``, ``OutboxItem.p``) stay
# generic objects on the wire; these tables say what each method puts in them. The contract export writes them
# into ``device.meshcall.json`` and ``payloads.json``; the Connector's generated types are keyed by them.


class MethodPayloads(NamedTuple):
    """Request model and response model of a method. For a stream the response is the item model."""

    request: type[BaseModel]
    response: type[BaseModel]


COMMAND_PAYLOADS: dict[str, MethodPayloads] = {
    "session.sendMessage": MethodPayloads(SendMessageCommand, SendMessageResult),
    "session.steer": MethodPayloads(SteerCommand, SteerResult),
    "session.interrupt": MethodPayloads(SessionCommand, InterruptResult),
    "session.respondNotice": MethodPayloads(RespondNoticeCommand, RespondNoticeResult),
    "session.select": MethodPayloads(SelectCommand, SelectResult),
    "session.creation.begin": MethodPayloads(CreationBeginCommand, WorkflowState),
    "session.creation.respond": MethodPayloads(CreationRespondCommand, WorkflowState),
    "session.creation.cancel": MethodPayloads(CreationCancelCommand, WorkflowState),
    "workspace.prepare": MethodPayloads(WorkspacePrepareCommand, WorkflowState),
    "workspace.preparation.reserve": MethodPayloads(PreparationReserveCommand, PreparationReserveResult),
    "workspace.preparation.respond": MethodPayloads(PreparationRespondCommand, WorkflowState),
    "workspace.preparation.cancel": MethodPayloads(PreparationCancelCommand, WorkflowState),
    "session.planning": MethodPayloads(SessionPlanningCommand, PlanningResponse),
    "session.goal": MethodPayloads(SessionGoalCommand, GoalResponse),
    "session.queue.update": MethodPayloads(QueueItemCommand, QueueResult),
    "session.queue.delete": MethodPayloads(QueueItemCommand, QueueResult),
    "session.queue.retry": MethodPayloads(QueueItemCommand, QueueResult),
    "session.queue.sendNow": MethodPayloads(QueueItemCommand, QueueResult),
    "session.queue.resume": MethodPayloads(SessionCommand, QueueResult),
    "session.queue.reorder": MethodPayloads(QueueReorderCommand, QueueResult),
    "session.queue.clear": MethodPayloads(SessionCommand, QueueResult),
    "session.sync": MethodPayloads(SessionSyncCommand, SessionSyncResult),
    "session.configuration.update": MethodPayloads(SessionConfigureCommand, SessionConfigureResult),
    "session.agent.operate": MethodPayloads(AgentOperateCommand, AgentOperationResult),
    "session.position.select": MethodPayloads(PositionSelectCommand, AgentOperationResult),
    "session.close": MethodPayloads(SessionCloseCommand, SessionCloseResult),
    "session.recover": MethodPayloads(SessionRecoverCommand, SessionRecoverResult),
    "runtime.apply": MethodPayloads(RuntimeApplyCommand, RuntimeApplyResult),
    "device.settings.apply": MethodPayloads(DeviceSettingsApplyCommand, DeviceSettingsApplyResult),
    "channel.switch": MethodPayloads(ChannelSwitchCommand, RuntimeApplyResult),
    "preview.open": MethodPayloads(PreviewOpenCommand, PreviewOpenResult),
    "preview.close": MethodPayloads(PreviewCloseCommand, PreviewCloseResult),
}
assert set(COMMAND_PAYLOADS) == set(DEVICE_COMMANDS)

READ_PAYLOADS: dict[str, MethodPayloads] = {
    "session.watch": MethodPayloads(SessionWatchRequest, ChangesEvent),
    "store.readBlob": MethodPayloads(ReadBlobRequest, ReadBlobChunk),
    "store.exportShare": MethodPayloads(ExportShareRequest, ExportShareChunk),
    "command.status": MethodPayloads(CommandStatusRequest, CommandStatusResponse),
    "session.creation.get": MethodPayloads(CreationGetRequest, WorkflowState),
    "workspace.preparation.get": MethodPayloads(PreparationGetRequest, WorkflowState),
    "client.call": MethodPayloads(ClientCallRequest, ClientCallItem),
    "client.subscribe": MethodPayloads(ClientSubscribeRequest, TerminalStreamItem),
}
assert set(READ_PAYLOADS) == set(REQUEST_METHODS)

#: ``LinkAttachItem.p`` by ``LinkAttachItem.m``.
EVENT_PAYLOADS: dict[str, type[BaseModel]] = {
    "runtime.status": RuntimeStatusEvent,
    "runtime.notice.updated": RuntimeNoticeUpdatedEvent,
    "runtime.queue.updated": RuntimeQueueUpdatedEvent,
    "port.listening": PortListeningEvent,
    "port.closed": PortClosedEvent,
}
assert set(EVENT_PAYLOADS) == set(EVENT_METHODS)

#: ``OutboxItem.p`` by ``OutboxItem.m``.
OUTBOX_PAYLOADS: dict[str, type[BaseModel]] = {
    "session.summary": SessionSummaryOut,
    "session.inventory": SessionInventoryOut,
    "command.result": CommandResultOut,
    "attachment.consumed": AttachmentConsumedOut,
    "usage.report": UsageReportOut,
}
assert set(OUTBOX_PAYLOADS) == set(OUTBOX_METHODS)


def validate_command_payload(method: str, payload: dict[str, Any]) -> None:
    """Raise ``pydantic.ValidationError`` when ``payload`` is not ``method``'s request (``COMMAND_PAYLOADS``).

    Only checks: the payload is sent as it is.
    """

    COMMAND_PAYLOADS[method].request.model_validate(payload)


# ---------------------------------------------------------------------------
# E2EE ``required`` mode: what the device registers and what may leave it in plaintext
# ---------------------------------------------------------------------------
#
# In ``required`` mode the device registers only the routes below. Everything a user starts
# (reads, subscriptions, every other command, catalogs) goes through the encrypted Content tunnel.
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
        routes = [r for name, r in LINK_ROUTES.items() if name.startswith("link.")]
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


# What an encrypted-mode ack of a deferrable command keeps of ``r``: the instance status the Server
# needs for its desired state, never free text.
DEFERRABLE_RESULT_FIELDS: tuple[str, ...] = (
    "runtimeId", "instanceId", "status", "revision", "stale", "capabilities", "modelConnection", "applied",
)


def scrub_for_e2ee(method: str, payload: dict[str, Any], *, command: str | None = None) -> dict[str, Any]:
    """Drop content a device must not send in ``required`` mode, before the Server stores or logs it.

    Defence in depth for E-1: a correct device already sends nothing here. Applies to outbox
    messages (``OUTBOX_METHODS``) and command receipts (``CommandAck``, ``CommandStatusResponse``).
    ``command``: the receipt's command. The result of a deferrable command describes Server-owned desired
    state, not conversation content: its ``DEFERRABLE_RESULT_FIELDS`` are kept.
    """

    out = dict(payload)
    if method in {"command.result", "command.ack", "command.status"}:
        r = out.get("r")
        out["r"] = (
            {key: r[key] for key in DEFERRABLE_RESULT_FIELDS if key in r}
            if command in DEFERRABLE_COMMANDS and isinstance(r, dict)
            else None
        )
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
