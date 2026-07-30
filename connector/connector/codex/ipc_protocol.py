from __future__ import annotations

from types import MappingProxyType
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StrictStr,
    TypeAdapter,
    model_validator,
)

CODEX_IPC_MAX_FRAME_BYTES = 256 * 1024 * 1024
CODEX_IPC_INITIALIZING_CLIENT_ID = "initializing-client"
CODEX_IPC_LOCAL_HOST_ID = "local"

# Codex returns version 0 for methods absent from this table. These values were
# recovered from the 26.721.41059 IDE extension and must be treated as an
# internal compatibility contract, not as a public OpenAI API.
CODEX_IPC_METHOD_VERSIONS = MappingProxyType(
    {
        "thread-stream-state-changed": 11,
        "thread-stream-following-changed": 1,
        "thread-stream-following-status-requested": 1,
        "ipc-connection-reset": 1,
        "thread-read-state-changed": 2,
        "thread-archived": 2,
        "thread-unarchived": 1,
        "thread-follower-start-turn": 1,
        "thread-follower-load-complete-history": 1,
        "thread-follower-compact-thread": 1,
        "thread-follower-steer-turn": 1,
        "thread-follower-interrupt-turn": 3,
        "thread-follower-update-thread-settings": 1,
        "thread-follower-edit-last-user-turn": 2,
        "thread-follower-command-approval-decision": 1,
        "thread-follower-file-approval-decision": 1,
        "thread-follower-permissions-request-approval-response": 1,
        "thread-follower-submit-user-input": 1,
        "thread-follower-submit-mcp-server-elicitation-response": 1,
        "thread-follower-set-queued-follow-ups-state": 1,
        "thread-queued-followups-changed": 1,
    }
)

CodexIpcMessageType = Literal[
    "broadcast",
    "request",
    "response",
    "client-discovery-request",
    "client-discovery-response",
]
CodexIpcResponseType = Literal["success", "error"]
CodexIpcClientStatus = Literal["connected", "disconnected"]
CodexIpcPatchPathSegment = StrictStr | StrictInt


def codex_ipc_method_version(method: str) -> int:
    return CODEX_IPC_METHOD_VERSIONS.get(method, 0)


class CodexIpcModel(BaseModel):
    """Base for an internal Codex contract that may gain additive fields."""

    model_config = ConfigDict(extra="allow")


class CodexIpcBroadcast(CodexIpcModel):
    type: Literal["broadcast"] = "broadcast"
    method: str
    sourceClientId: str
    params: dict[str, Any] = Field(default_factory=dict)
    version: int = Field(default=0, ge=0)
    targetClientIds: list[str] | None = None


class CodexIpcRequest(CodexIpcModel):
    type: Literal["request"] = "request"
    requestId: str
    sourceClientId: str
    method: str
    params: dict[str, Any] = Field(default_factory=dict)
    version: int = Field(default=0, ge=0)
    targetClientId: str | None = None
    timeoutMs: int | None = Field(default=None, ge=0)


class CodexIpcResponse(CodexIpcModel):
    type: Literal["response"] = "response"
    requestId: str
    resultType: CodexIpcResponseType
    method: str | None = None
    handledByClientId: str | None = None
    result: Any = None
    error: str | None = None

    @model_validator(mode="after")
    def validate_result_shape(self) -> CodexIpcResponse:
        if self.resultType == "success" and self.error is not None:
            raise ValueError("successful IPC responses cannot contain error")
        if self.resultType == "error" and not self.error:
            raise ValueError("error IPC responses require error")
        return self


class CodexIpcClientDiscoveryRequest(CodexIpcModel):
    type: Literal["client-discovery-request"] = "client-discovery-request"
    requestId: str
    request: CodexIpcRequest


class CodexIpcClientDiscoveryDecision(CodexIpcModel):
    canHandle: bool


class CodexIpcClientDiscoveryResponse(CodexIpcModel):
    type: Literal["client-discovery-response"] = "client-discovery-response"
    requestId: str
    response: CodexIpcClientDiscoveryDecision


CodexIpcRouterMessage = Annotated[
    CodexIpcBroadcast
    | CodexIpcRequest
    | CodexIpcResponse
    | CodexIpcClientDiscoveryRequest
    | CodexIpcClientDiscoveryResponse,
    Field(discriminator="type"),
]
CODEX_IPC_ROUTER_MESSAGE_ADAPTER = TypeAdapter(CodexIpcRouterMessage)


class CodexIpcInitializeParams(CodexIpcModel):
    clientType: str


class CodexIpcInitializeResult(CodexIpcModel):
    clientId: str


class CodexIpcInitializeRequest(CodexIpcRequest):
    sourceClientId: Literal["initializing-client"] = CODEX_IPC_INITIALIZING_CLIENT_ID
    method: Literal["initialize"] = "initialize"
    params: CodexIpcInitializeParams
    version: Literal[0] = 0


class CodexIpcClientStatusChangedParams(CodexIpcModel):
    clientId: str
    clientType: str
    status: CodexIpcClientStatus
    isSelf: bool | None = None


class CodexIpcClientStatusChangedBroadcast(CodexIpcBroadcast):
    method: Literal["client-status-changed"] = "client-status-changed"
    params: CodexIpcClientStatusChangedParams
    version: Literal[0] = 0


class CodexIpcConnectionResetParams(CodexIpcModel):
    pass


class CodexIpcConnectionResetBroadcast(CodexIpcBroadcast):
    method: Literal["ipc-connection-reset"] = "ipc-connection-reset"
    params: CodexIpcConnectionResetParams = Field(
        default_factory=CodexIpcConnectionResetParams
    )
    version: Literal[1] = 1


class CodexIpcFollowingParams(CodexIpcModel):
    conversationId: str
    hostId: str = CODEX_IPC_LOCAL_HOST_ID
    following: bool


class CodexIpcFollowingChangedBroadcast(CodexIpcBroadcast):
    method: Literal["thread-stream-following-changed"] = (
        "thread-stream-following-changed"
    )
    params: CodexIpcFollowingParams
    version: Literal[1] = 1


class CodexIpcFollowingStatusRequestedParams(CodexIpcModel):
    conversationId: str
    hostId: str = CODEX_IPC_LOCAL_HOST_ID


class CodexIpcFollowingStatusRequestedBroadcast(CodexIpcBroadcast):
    method: Literal["thread-stream-following-status-requested"] = (
        "thread-stream-following-status-requested"
    )
    params: CodexIpcFollowingStatusRequestedParams
    version: Literal[1] = 1


class CodexIpcItem(CodexIpcModel):
    id: str | None = None
    type: str
    status: str | None = None


class CodexIpcTurn(CodexIpcModel):
    turnId: str
    status: str | dict[str, Any] | None = None
    items: list[CodexIpcItem] = Field(default_factory=list)
    turnStartedAtMs: int | float | None = None
    firstTurnWorkItemStartedAtMs: int | float | None = None
    finalAssistantStartedAtMs: int | float | None = None
    durationMs: int | float | None = None
    error: Any = None
    diff: str | None = None
    params: dict[str, Any] | None = None


class CodexIpcHistoryEntry(CodexIpcModel):
    key: str
    value: str


class CodexIpcHistoryBoundary(CodexIpcModel):
    status: str
    boundaryId: str


class CodexIpcHistoryIsland(CodexIpcModel):
    id: str
    entries: list[CodexIpcHistoryEntry] = Field(default_factory=list)
    olderBoundary: CodexIpcHistoryBoundary | None = None
    newerBoundary: CodexIpcHistoryBoundary | None = None


class CodexIpcCanonicalHistory(CodexIpcModel):
    entitiesByKey: dict[str, CodexIpcTurn] = Field(default_factory=dict)
    generation: int = Field(default=0, ge=0)
    isComplete: bool = False
    islands: list[CodexIpcHistoryIsland] = Field(default_factory=list)


class CodexIpcCanonicalTurnHistory(CodexIpcModel):
    kind: Literal["canonical"] = "canonical"
    history: CodexIpcCanonicalHistory


class CodexIpcConversationState(CodexIpcModel):
    """State replicated by Codex IPC v11.

    The stable integration boundary is the conversation identity and canonical
    turn history. Remaining fields belong to Codex UI state and are retained as
    additive extras so an extension update does not discard them.
    """

    id: str
    hostId: str = CODEX_IPC_LOCAL_HOST_ID
    sessionId: str | None = None
    title: str | None = None
    cwd: str | None = None
    createdAt: str | int | float | None = None
    updatedAt: str | int | float | None = None
    recencyAt: str | int | float | None = None
    ephemeral: bool = False
    resumeState: str | None = None
    threadRuntimeStatus: Any = None
    requests: list[Any] | dict[str, Any] = Field(default_factory=list)
    turns: list[CodexIpcTurn] = Field(default_factory=list)
    turnHistory: CodexIpcCanonicalTurnHistory | None = None


class CodexIpcAddPatch(CodexIpcModel):
    op: Literal["add"] = "add"
    path: list[CodexIpcPatchPathSegment]
    value: Any


class CodexIpcReplacePatch(CodexIpcModel):
    op: Literal["replace"] = "replace"
    path: list[CodexIpcPatchPathSegment]
    value: Any


class CodexIpcRemovePatch(CodexIpcModel):
    op: Literal["remove"] = "remove"
    path: list[CodexIpcPatchPathSegment]


CodexIpcPatch = Annotated[
    CodexIpcAddPatch | CodexIpcReplacePatch | CodexIpcRemovePatch,
    Field(discriminator="op"),
]


class CodexIpcSnapshotChange(CodexIpcModel):
    type: Literal["snapshot"] = "snapshot"
    revision: int = Field(ge=0)
    conversationState: CodexIpcConversationState


class CodexIpcPatchesChange(CodexIpcModel):
    type: Literal["patches"] = "patches"
    baseRevision: int = Field(ge=0)
    revision: int = Field(ge=1)
    patches: list[CodexIpcPatch] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_revision_step(self) -> CodexIpcPatchesChange:
        if self.revision != self.baseRevision + 1:
            raise ValueError("Codex IPC patch revision must advance by exactly one")
        return self


CodexIpcStreamChange = Annotated[
    CodexIpcSnapshotChange | CodexIpcPatchesChange,
    Field(discriminator="type"),
]


class CodexIpcStreamStateParams(CodexIpcModel):
    conversationId: str
    hostId: str = CODEX_IPC_LOCAL_HOST_ID
    change: CodexIpcStreamChange

    @model_validator(mode="after")
    def validate_conversation_identity(self) -> CodexIpcStreamStateParams:
        if (
            isinstance(self.change, CodexIpcSnapshotChange)
            and self.change.conversationState.id != self.conversationId
        ):
            raise ValueError(
                "snapshot conversation id does not match broadcast conversation id"
            )
        return self


class CodexIpcStreamStateChangedBroadcast(CodexIpcBroadcast):
    method: Literal["thread-stream-state-changed"] = "thread-stream-state-changed"
    params: CodexIpcStreamStateParams
    version: Literal[11] = 11


CodexIpcCoordinationBroadcast = Annotated[
    CodexIpcClientStatusChangedBroadcast
    | CodexIpcConnectionResetBroadcast
    | CodexIpcFollowingChangedBroadcast
    | CodexIpcFollowingStatusRequestedBroadcast
    | CodexIpcStreamStateChangedBroadcast,
    Field(discriminator="method"),
]
CODEX_IPC_COORDINATION_BROADCAST_ADAPTER = TypeAdapter(CodexIpcCoordinationBroadcast)
