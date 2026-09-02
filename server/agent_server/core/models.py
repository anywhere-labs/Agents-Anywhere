from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    WithJsonSchema,
    model_validator,
)

from agent_server.core.runtime_identity import (
    RuntimeIdentity,
    RuntimeIdentityError,
    validate_runtime_type,
)

_PROTOCOL_1_RUNTIME_NAMES = ("codex", "claude", "opencode", "acp", "dsh")
LegacyRuntimeName = Literal["codex", "claude", "opencode", "acp", "dsh"]


def _validate_runtime_name(value: str) -> str:
    try:
        return str(validate_runtime_type(value))
    except RuntimeIdentityError as exc:
        raise ValueError(str(exc)) from exc


# Runtime Control 2.0 can discover new normalized provider keys. Protocol 1.0
# keeps its original advertised enum until the additive 1.1 contract ships.
RuntimeName = Annotated[
    str,
    AfterValidator(_validate_runtime_name),
    WithJsonSchema(
        {
            "enum": list(_PROTOCOL_1_RUNTIME_NAMES),
            "type": "string",
        }
    ),
]
ConnectorStatus = Literal["offline", "online"]
ConnectorDeviceOs = Literal["macos", "windows", "linux"]
SessionStatus = Literal[
    "idle",
    "waiting",
    "pending",
    "running",
    "stopping",
    "waiting_approval",
    "error",
    "blocked",
]
TimelineType = Literal[
    "message",
    "tool",
    "artifact",
    "marker",
    "system",
]
TimelineStatus = Literal[
    "pending",
    "running",
    "waiting_approval",
    "done",
    "failed",
    "cancelled",
    "interrupted",
]
TimelineRole = Literal["user", "assistant", "system", "tool"]
ApprovalStatus = Literal[
    "pending",
    "approved",
    "approved_for_session",
    "rejected",
    "cancelled",
    "expired",
]
ApprovalKind = Literal[
    "command",
    "file_change",
    "permission",
    "tool_call",
    "input_request",
    "unknown",
]


class ConnectorView(BaseModel):
    id: str
    userId: str
    name: str
    deviceOs: ConnectorDeviceOs | None = None
    status: ConnectorStatus
    lastSeenAt: str | None = None
    createdAt: str
    updatedAt: str


class ConnectorCreateRequest(BaseModel):
    name: str = "Codex Connector"


class ConnectorUpdateRequest(BaseModel):
    name: str | None = None


class ConnectorResponse(BaseModel):
    connector: ConnectorView
    serverTime: str


class ConnectorCreateResponse(BaseModel):
    connector: ConnectorView
    connectorToken: str
    tokenPrefix: str


class ConnectorRevokeResponse(BaseModel):
    connector: ConnectorView
    connectorToken: str
    tokenPrefix: str
    serverTime: str


class ConnectorListResponse(BaseModel):
    connectors: list[ConnectorView]
    serverTime: str


UserRoleName = Literal["admin", "member"]


class AuthRequest(BaseModel):
    userId: str
    password: str | None = None
    passwordVerifier: str | None = None
    passwordSalt: str | None = None
    # Only required for the first-run bootstrap call. The token is printed to
    # the server log on startup (and every time it expires); see SetupToken.
    setupToken: str | None = None


class AuthPasswordSaltRequest(BaseModel):
    userId: str


class AuthPasswordSaltResponse(BaseModel):
    salt: str
    serverTime: str


class UserView(BaseModel):
    userId: str
    role: UserRoleName
    disabled: bool
    avatar: str | None = None
    createdAt: str
    updatedAt: str


class AuthResponse(BaseModel):
    userId: str
    role: UserRoleName
    accessToken: str
    tokenType: str = "bearer"
    serverTime: str


class AuthMeResponse(BaseModel):
    userId: str
    role: UserRoleName
    disabled: bool
    avatar: str | None = None
    serverTime: str


class AuthConfigResponse(BaseModel):
    needsBootstrap: bool
    registrationOpen: bool
    oauthRegistrationOpen: bool = False
    oauthEnabled: bool = False
    oauthProviderLabel: str | None = None
    # ISO-8601 UTC, only present when needsBootstrap is true. Lets the setup
    # page show a countdown / "expired, check log" hint without ever exposing
    # the token value itself.
    setupTokenExpiresAt: str | None = None
    serverTime: str


class ChangePasswordRequest(BaseModel):
    oldPassword: str | None = None
    oldPasswordVerifier: str | None = None
    newPassword: str | None = None
    newPasswordVerifier: str | None = None
    newPasswordSalt: str | None = None


class UpdateAvatarRequest(BaseModel):
    avatar: str = Field(min_length=1)


class ServiceInfoResponse(BaseModel):
    endpoint: str
    version: str
    database: str
    databasePath: str | None = None
    databaseSchemaVersion: str
    coordination: Literal["memory", "redis"]
    instanceId: str
    startedAt: str
    uptimeSeconds: int
    serverTime: str


class AdminUserCreateRequest(BaseModel):
    userId: str
    password: str | None = None
    passwordVerifier: str | None = None
    passwordSalt: str | None = None
    role: UserRoleName = "member"


class AdminUserUpdateRequest(BaseModel):
    role: UserRoleName | None = None
    disabled: bool | None = None
    password: str | None = None
    passwordVerifier: str | None = None
    passwordSalt: str | None = None


class AdminUserListResponse(BaseModel):
    users: list[UserView]
    serverTime: str


class DashboardIntensitySettings(BaseModel):
    basis: Literal["messages"] = "messages"
    lightMax: int = Field(default=10, ge=0)
    mediumMax: int = Field(default=50, ge=0)


class DashboardHistogramSettings(BaseModel):
    messages: list[int] = Field(default_factory=lambda: [0, 5, 20, 100])
    sessions: list[int] = Field(default_factory=lambda: [0, 1, 5, 20])


class DashboardSettingsView(BaseModel):
    intensity: DashboardIntensitySettings = Field(default_factory=DashboardIntensitySettings)
    histogramBins: DashboardHistogramSettings = Field(default_factory=DashboardHistogramSettings)
    serverTime: str | None = None


class DashboardSettingsUpdateRequest(BaseModel):
    intensity: DashboardIntensitySettings | None = None
    histogramBins: DashboardHistogramSettings | None = None


class DashboardRange(BaseModel):
    fromDate: str
    toDate: str
    timezone: str


class DashboardSummary(BaseModel):
    totalUsers: int = 0
    newUsers: int = 0
    dau: int = 0
    activeUsers: int = 0
    wau: int = 0
    mau: int = 0
    totalMessages: int = 0
    activeSessions: int = 0
    avgMessagesPerActiveUser: float = 0
    avgActiveSessionsPerActiveUser: float = 0
    totalDevices: int = 0
    avgDevicesPerUser: float = 0


class DashboardSeriesPoint(BaseModel):
    date: str
    totalUsers: int = 0
    newUsers: int = 0
    dau: int = 0
    activeUsers: int = 0
    wau: int = 0
    mau: int = 0
    totalMessages: int = 0
    activeSessions: int = 0
    avgMessagesPerActiveUser: float = 0
    avgActiveSessionsPerActiveUser: float = 0
    totalDevices: int = 0
    avgDevicesPerUser: float = 0


class DashboardBreakdownItem(BaseModel):
    key: str
    label: str
    value: float
    percent: float = 0


class DashboardHistogramBucket(BaseModel):
    key: str
    label: str
    count: int
    min: int | None = None
    max: int | None = None


class DashboardUserSegmentItem(BaseModel):
    segment: Literal["light", "medium", "heavy"]
    label: str
    count: int


class DashboardOverviewResponse(BaseModel):
    range: DashboardRange
    summary: DashboardSummary
    series: list[DashboardSeriesPoint]
    messageHistogram: list[DashboardHistogramBucket]
    sessionHistogram: list[DashboardHistogramBucket]
    userSegments: list[DashboardUserSegmentItem]
    deviceBreakdown: list[DashboardBreakdownItem]
    agentBreakdown: list[DashboardBreakdownItem]
    sessionAgentBreakdown: list[DashboardBreakdownItem]
    settings: DashboardSettingsView
    serverTime: str


class DashboardSnapshotResponse(BaseModel):
    date: str
    computedAt: str
    metrics: int
    users: int
    serverTime: str


class OAuthProviderPublicConfig(BaseModel):
    enabled: bool = False
    provider: str = "oidc"
    label: str = "OAuth"
    authorizeUrl: str = ""
    tokenUrl: str = ""
    userInfoUrl: str = ""
    clientId: str = ""
    scopes: str = "openid profile email"
    usernameClaim: str = "preferred_username"
    subjectClaim: str = "sub"
    emailClaim: str = "email"
    nameClaim: str = "name"


class OAuthProviderConfigUpdate(OAuthProviderPublicConfig):
    clientSecret: str | None = None


class InstanceSettingsView(BaseModel):
    registrationOpen: bool
    oauthRegistrationOpen: bool = False
    oauth: OAuthProviderPublicConfig | None = None


class InstanceSettingsUpdateRequest(BaseModel):
    registrationOpen: bool | None = None
    oauthRegistrationOpen: bool | None = None
    oauth: OAuthProviderConfigUpdate | None = None


class OAuthStartResponse(BaseModel):
    authorizeUrl: str
    serverTime: str


class OAuthCallbackResponse(BaseModel):
    status: Literal["authenticated", "needs_password", "needs_registration"]
    provider: str
    providerLabel: str
    pendingToken: str | None = None
    suggestedUserId: str | None = None
    email: str | None = None
    displayName: str | None = None
    auth: AuthResponse | None = None
    serverTime: str


class OAuthFinalizeRequest(BaseModel):
    pendingToken: str
    userId: str | None = None
    password: str | None = None
    passwordVerifier: str | None = None
    passwordSalt: str | None = None
    setPassword: bool = False


class OAuthFinalizeResponse(BaseModel):
    auth: AuthResponse
    serverTime: str


class OAuthClientView(BaseModel):
    clientId: str
    name: str
    redirectUris: list[str]
    createdAt: str
    updatedAt: str


class OAuthClientCreateRequest(BaseModel):
    name: str
    redirectUris: list[str] = Field(min_length=1)


class OAuthClientListResponse(BaseModel):
    clients: list[OAuthClientView]
    serverTime: str


class OAuthTokenResponse(BaseModel):
    access_token: str
    token_type: str = "Bearer"
    expires_in: int
    scope: str = ""
    refresh_token: str | None = None


class OAuthAuthorizeRequest(BaseModel):
    response_type: str
    client_id: str
    redirect_uri: str
    code_challenge: str
    code_challenge_method: str = "S256"
    scope: str = ""
    state: str | None = None


class OAuthAuthorizeResponse(BaseModel):
    redirectUrl: str
    serverTime: str


class OAuthMetadataResponse(BaseModel):
    issuer: str
    authorization_endpoint: str
    token_endpoint: str
    response_types_supported: list[str]
    grant_types_supported: list[str]
    code_challenge_methods_supported: list[str]


class MobileLoginQrCreateResponse(BaseModel):
    userId: str
    loginToken: str
    expiresAt: str
    serverTime: str


class MobileLoginRequestRequest(BaseModel):
    userId: str
    loginToken: str
    deviceName: str | None = None


class MobileLoginStatusRequest(BaseModel):
    loginToken: str


class MobileLoginStatusResponse(BaseModel):
    status: Literal["pending_scan", "pending_web_confirm", "approved", "rejected", "expired", "consumed"]
    userId: str | None = None
    deviceName: str | None = None
    expiresAt: str | None = None
    requestedAt: str | None = None
    approvedAt: str | None = None
    serverTime: str


class MobileLoginConfirmRequest(BaseModel):
    loginToken: str
    approved: bool = True


class MobileLoginExchangeRequest(BaseModel):
    userId: str
    loginToken: str


class MobileLoginExchangeResponse(BaseModel):
    auth: AuthResponse
    refreshToken: str
    expiresAt: str
    serverTime: str


class ConnectorAuthResponse(BaseModel):
    accessToken: str
    expiresIn: int


class ConnectorNotification(BaseModel):
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


class ConnectorIngestRequest(BaseModel):
    notifications: list[ConnectorNotification] = Field(min_length=1)


class ConnectorIngestRejectedNotification(BaseModel):
    index: int
    method: str
    code: str
    message: str
    errorType: str | None = None


class ConnectorIngestResponse(BaseModel):
    accepted: int
    rejected: list[ConnectorIngestRejectedNotification] = Field(default_factory=list)
    serverTime: str


class ConnectorConfigBundle(BaseModel):
    serverUrl: str
    connectorId: str
    connectorToken: str


class PairingStartRequest(BaseModel):
    serverUrl: str | None = None
    ttlSeconds: int = 600


class PairingStartResponse(BaseModel):
    pairingId: str
    code: str
    expiresAt: str
    serverTime: str


class PairingClaimRequest(BaseModel):
    code: str
    name: str = "Codex Connector"
    serverUrl: str | None = None
    connectorId: str | None = None
    connectorToken: str | None = None


class PairingClaimResponse(BaseModel):
    status: str
    connector: ConnectorView | None = None


class PairingPollRequest(BaseModel):
    pairingId: str


class PairingPollResponse(BaseModel):
    status: str
    config: ConnectorConfigBundle | None = None
    expiresAt: str | None = None


class SessionCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    connectorId: str
    runtime: RuntimeName = "codex"
    runtimeId: str | None = None
    externalSessionId: str | None = None
    title: str | None = None
    cwd: str | None = None
    selections: dict[str, str | None] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _validate_runtime_identity(self) -> SessionCreateRequest:
        identity = RuntimeIdentity.create(
            runtime_type=self.runtime,
            runtime_id=self.runtimeId or self.runtime,
        )
        self.runtimeId = str(identity.runtime_id)
        return self


class AttachmentRef(BaseModel):
    fileId: str = Field(min_length=1, max_length=64)


class InlineAttachmentRef(BaseModel):
    fileId: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=512)
    mediaType: str = Field(default="application/octet-stream", max_length=255)
    size: int | None = Field(default=None, ge=0)
    sha256: str | None = Field(default=None, max_length=128)
    contentBase64: str = Field(min_length=1)


class SessionCreateAndStartRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    connectorId: str
    runtime: RuntimeName = "codex"
    runtimeId: str | None = None
    title: str | None = None
    cwd: str | None = None
    content: str
    selections: dict[str, str | None] = Field(default_factory=dict)
    attachments: list[InlineAttachmentRef] = Field(default_factory=list, max_length=10)
    clientMessageId: str | None = None

    @model_validator(mode="after")
    def _validate_runtime_identity(self) -> SessionCreateAndStartRequest:
        identity = RuntimeIdentity.create(
            runtime_type=self.runtime,
            runtime_id=self.runtimeId or self.runtime,
        )
        self.runtimeId = str(identity.runtime_id)
        return self


class SessionView(BaseModel):
    id: str
    connectorId: str
    connectorStatus: ConnectorStatus
    runtime: RuntimeName
    runtimeId: str | None = None
    runtimeType: RuntimeName | None = None
    runtimeName: str | None = None
    runtimeTypeDisplayName: str | None = None
    externalSessionId: str | None = None
    title: str | None = None
    cwd: str | None = None
    status: SessionStatus
    takeover: bool
    pinned: bool = False
    pinnedAt: str | None = None
    archived: bool = False
    archivedAt: str | None = None
    userArchived: bool = False
    sourceAvailability: Literal[
        "available",
        "archived",
        "unavailable",
        "deleted",
        "missing",
        "unknown",
    ] = "available"
    sourceAvailabilityReason: str | None = None
    sourceAvailabilityUpdatedAt: str | None = None
    sourceObservationOrigin: Literal["event", "inventory", "operation"] | None = None
    archiveSource: Literal["user", "runtime", "both"] | None = None
    unread: bool = False
    lastReadSeq: int = 0
    latestTurnEndSeq: int = 0
    lastSyncedAt: str | None = None
    sourceObservedAt: str | None = None
    lastActivityAt: str | None = None
    lastItemAt: str | None = None
    lastItemOrderSeq: int | None = None
    sortAt: str | None = None
    updatedSeq: int

    @model_validator(mode="after")
    def _normalize_runtime_identity(self) -> SessionView:
        identity = RuntimeIdentity.create(
            runtime_type=self.runtime,
            runtime_id=self.runtimeId or self.runtime,
        )
        self.runtimeId = str(identity.runtime_id)
        self.runtimeType = self.runtime
        return self


class SessionRuntimeState(BaseModel):
    sessionId: str
    runtime: RuntimeName
    runtimeId: str | None = None
    runtimeType: RuntimeName | None = None
    externalSessionId: str | None = None
    status: SessionStatus = "idle"
    selections: dict[str, str | None] = Field(default_factory=dict)
    statusReason: str | None = None
    error: dict[str, Any] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    updatedSeq: int
    createdAt: str
    updatedAt: str

    @model_validator(mode="after")
    def _normalize_runtime_identity(self) -> SessionRuntimeState:
        identity = RuntimeIdentity.create(
            runtime_type=self.runtime,
            runtime_id=self.runtimeId or self.runtime,
        )
        self.runtimeId = str(identity.runtime_id)
        self.runtimeType = self.runtime
        return self


class SessionRuntimeStateResponse(BaseModel):
    state: SessionRuntimeState
    serverTime: str


class SessionSelectionPatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    selections: dict[str, str | None] = Field(min_length=1, max_length=32)


class SessionSelectionPatchResponse(BaseModel):
    ok: bool
    state: SessionRuntimeState | None = None
    connectorResult: dict[str, Any] | None = None
    serverTime: str


class SessionPatchRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    pinned: bool | None = None
    archived: bool | None = None


class BulkArchiveRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=200)
    archived: bool


class BulkArchiveResponse(BaseModel):
    sessions: list[SessionView]
    notFound: list[str]
    serverTime: str


ArchiveAllScope = Literal["active", "archived", "all"]


class ArchiveAllRequest(BaseModel):
    archived: bool
    scope: ArchiveAllScope = "active"


class ArchiveAllResponse(BaseModel):
    sessions: list[SessionView]
    affected: int
    serverTime: str


class SessionResponse(BaseModel):
    session: SessionView
    serverTime: str


SessionShareScope = Literal["message", "session"]


class SessionShareCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scope: SessionShareScope
    itemIds: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def _validate_item_ids(self) -> SessionShareCreateRequest:
        if self.scope == "message" and not self.itemIds:
            raise ValueError("itemIds is required when sharing a reply")
        if self.scope == "session" and self.itemIds:
            raise ValueError("itemIds must be empty when sharing a session")
        if len(set(self.itemIds)) != len(self.itemIds):
            raise ValueError("itemIds must not contain duplicates")
        return self


class SessionShareCreateResponse(BaseModel):
    shareId: str
    sharePath: str
    shareUrl: str
    scope: SessionShareScope
    createdAt: str


class PublicSharedSession(BaseModel):
    id: str
    title: str | None = None
    runtime: RuntimeName
    runtimeName: str | None = None
    cwd: str | None = None


class TimelineSource(BaseModel):
    runtime: RuntimeName | Literal["platform"]
    sessionId: str | None = None
    itemId: str | None = None
    itemType: str | None = None
    event: str | None = None
    derivedKey: str | None = None
    clientMessageId: str | None = None


class TimelineItemIn(BaseModel):
    id: str
    sessionId: str
    type: TimelineType
    status: TimelineStatus
    role: TimelineRole | None = None
    content: Any = Field(default_factory=dict)
    source: TimelineSource
    orderSeq: int
    revision: int = 1
    contentHash: str
    createdAt: str | None = None
    updatedAt: str | None = None
    completedAt: str | None = None


class TimelineItem(TimelineItemIn):
    updatedSeq: int
    createdAt: str
    updatedAt: str


class PublicSessionShareResponse(BaseModel):
    shareId: str
    scope: SessionShareScope
    session: PublicSharedSession
    items: list[TimelineItem]
    createdAt: str
    serverTime: str


class ApprovalSource(BaseModel):
    runtime: RuntimeName
    requestId: str | int
    sessionId: str | None = None
    itemId: str | None = None
    method: str | None = None


class ApprovalIn(BaseModel):
    id: str
    sessionId: str
    status: ApprovalStatus = "pending"
    kind: ApprovalKind = "unknown"
    targetItemId: str | None = None
    title: str
    description: str | None = None
    payload: Any = Field(default_factory=dict)
    choices: list[Literal["approve", "approve_for_session", "reject", "cancel"]]
    source: ApprovalSource
    createdAt: str | None = None
    resolvedAt: str | None = None


class Approval(ApprovalIn):
    updatedSeq: int
    createdAt: str


NoticeType = Literal["notification", "interaction"]
NoticeSeverity = Literal["info", "success", "warning", "error"]
NoticeStatus = Literal[
    "open",
    "responding",
    "response_accepted",
    "resolving",
    "resolved",
    "closed",
    "expired",
    "cancelled",
    "failed",
]
InteractionType = Literal["approval", "execution_error", "confirmation", "input_request", "unknown"]
NoticeActionStyle = Literal["primary", "secondary", "danger"]


class NoticeBlocking(BaseModel):
    scope: Literal["session"]
    targetId: str


class NoticeActionInput(BaseModel):
    required: bool = False
    schema_: dict[str, Any] | None = Field(default=None, alias="schema")
    uiSchema: dict[str, Any] | None = None

    model_config = ConfigDict(populate_by_name=True)


class NoticeAction(BaseModel):
    actionId: str
    label: str
    style: NoticeActionStyle = "secondary"
    input: NoticeActionInput = Field(default_factory=NoticeActionInput)


class NoticeSource(BaseModel):
    runtime: RuntimeName | Literal["platform"] | None = None
    component: str | None = None
    approvalId: str | None = None
    timelineItemId: str | None = None
    operationId: str | None = None


class NoticeIn(BaseModel):
    noticeId: str
    type: NoticeType
    sessionId: str
    source: NoticeSource = Field(default_factory=NoticeSource)
    title: str
    message: str | None = None
    severity: NoticeSeverity = "info"
    status: NoticeStatus = "open"
    interactionType: InteractionType | None = None
    blocking: NoticeBlocking | None = None
    responseRequired: bool = False
    actions: list[NoticeAction] = Field(default_factory=list)
    context: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    expiresAt: str | None = None
    revision: int = 1
    createdAt: str | None = None
    resolvedAt: str | None = None


class Notice(NoticeIn):
    updatedSeq: int
    createdAt: str
    updatedAt: str


class RuntimeNoticeListResponse(BaseModel):
    notices: list[NoticeIn] = Field(default_factory=list)
    serverTime: str


class NoticeListResponse(BaseModel):
    notices: list[Notice] = Field(default_factory=list)
    serverTime: str


class InteractionRespondRequest(BaseModel):
    actionId: str
    input: dict[str, Any] | None = None


class MessageCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str
    attachments: list[AttachmentRef] = Field(default_factory=list, max_length=10)
    # Client-generated id (e.g. optimistic temp id). Forwarded to the connector;
    # the connector tags the resulting timeline item so the frontend can
    # dedupe its optimistic placeholder against the real server item.
    clientMessageId: str | None = None


class SessionCommandRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z][A-Za-z0-9_-]*$")
    args: list[str] = Field(default_factory=list, max_length=32)
    raw: str | None = Field(default=None, max_length=4096)


class RuntimeCommandView(BaseModel):
    id: str
    title: str
    description: str | None = None
    aliases: list[str] = Field(default_factory=list)
    category: str | None = None
    scope: str = "session"
    enabled: bool = True
    disabledReason: str | None = None
    acceptsArgs: bool = False
    argsSchema: dict[str, Any] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SessionCommandListResponse(BaseModel):
    commands: list[RuntimeCommandView] = Field(default_factory=list)
    serverTime: str


class RuntimeCommandListResponse(BaseModel):
    commands: list[RuntimeCommandView] = Field(default_factory=list)
    serverTime: str


class SessionCommandResponse(BaseModel):
    command: str
    ok: bool = True
    code: str | None = None
    message: str | None = None
    result: Any = None
    session: SessionView | None = None
    serverTime: str


class SessionSteerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str
    attachments: list[AttachmentRef] = Field(default_factory=list, max_length=10)
    clientMessageId: str | None = None


class ConnectorPreferencesResponse(BaseModel):
    connectorId: str
    preferences: dict[str, Any]
    serverTime: str


class ConnectorFsListRequest(BaseModel):
    root: str = Field(min_length=1)
    path: str | None = Field(default=None, min_length=1)


class UploadedAttachment(BaseModel):
    fileId: str
    sessionId: str
    name: str
    size: int
    sha256: str
    mediaType: str
    createdAt: str
    downloadUrl: str
    openUrl: str


class UserUploadResponse(BaseModel):
    """Result of POST /sessions/{id}/attachments — one entry per uploaded file."""

    attachments: list[UploadedAttachment]
    serverTime: str


class FsReadRequest(BaseModel):
    path: str = Field(min_length=1)


class FsPreviewTokenCreateResponse(BaseModel):
    previewToken: str
    expiresAt: str
    serverTime: str


class FsPreviewSessionRequest(BaseModel):
    previewToken: str = Field(min_length=1)


class FsPreviewSessionResponse(BaseModel):
    previewAccessToken: str
    expiresAt: str
    connectorId: str
    root: str
    path: str
    serverTime: str


class FsPreviewReadTextRequest(BaseModel):
    previewAccessToken: str = Field(min_length=1)
    maxBytes: int = Field(default=1_048_576, ge=1, le=4_194_304)


class FsPreviewReadRequest(BaseModel):
    previewAccessToken: str = Field(min_length=1)


class FsDownloadResponse(BaseModel):
    fileId: str
    sessionId: str
    path: str
    name: str
    size: int
    sha256: str
    contentBase64: str
    createdAt: str
    serverTime: str


class FsWriteRequest(BaseModel):
    path: str = Field(min_length=1)
    content: str
    encoding: Literal["utf8", "utf-8"] = "utf8"
    # Optional optimistic-concurrency token. When provided, the connector
    # checks that the on-disk file still hashes to this value before writing.
    # Mismatch → HTTP 412.
    ifMatch: str | None = Field(default=None, min_length=64, max_length=64)


class FsListRequest(BaseModel):
    path: str | None = Field(default=None, min_length=1)


class FsReadTextRequest(BaseModel):
    path: str = Field(min_length=1)
    # Max bytes to return inline. Larger files come back with `truncated: true`
    # and the caller is expected to fall back to the upload/download path.
    maxBytes: int = Field(default=1_048_576, ge=1, le=4_194_304)


class FsReadTextResponse(BaseModel):
    path: str
    name: str
    size: int
    sha256: str
    encoding: str
    content: str
    truncated: bool
    binary: bool
    serverTime: str


class ShellExecRequest(BaseModel):
    command: str = Field(min_length=1)
    cwd: str | None = None
    timeoutMs: int = Field(ge=1, le=300_000)


class ShellTaskStartResponse(BaseModel):
    taskId: str
    sessionId: str
    command: str
    cwd: str
    timeoutMs: int
    status: str
    result: Any = None
    error: Any = None
    serverTime: str


class ShellTaskWaitResponse(BaseModel):
    taskId: str
    sessionId: str
    command: str
    cwd: str
    timeoutMs: int
    status: str
    result: Any = None
    error: Any = None
    serverTime: str


class TerminalView(BaseModel):
    terminalId: str
    sessionId: str
    label: str
    root: str
    cwd: str
    cols: int
    rows: int
    purpose: Literal["user"] = "user"
    pid: int | None = None
    status: Literal["starting", "running", "exited"] = "running"
    exitCode: int | None = None
    scrollbackBytes: int = 0
    scrollbackSeq: int = 0
    ephemeralGroupId: str | None = None
    createdAt: str


class TerminalCreateRequest(BaseModel):
    cwd: str | None = None
    shell: str | None = None
    command: str | None = Field(default=None, min_length=1)
    args: list[str] | None = Field(default=None, max_length=100)
    profile: str | None = Field(default=None, max_length=64)
    cols: int = Field(default=80, ge=1, le=500)
    rows: int = Field(default=24, ge=1, le=200)
    label: str | None = Field(default=None, max_length=64)
    ephemeralGroupId: str | None = Field(default=None, min_length=1, max_length=96)
    env: dict[str, str] | None = None


class TerminalPatchRequest(BaseModel):
    label: str = Field(min_length=1, max_length=64)


class TerminalResizeRequest(BaseModel):
    cols: int = Field(ge=1, le=500)
    rows: int = Field(ge=1, le=200)


class TerminalListResponse(BaseModel):
    terminals: list[TerminalView]
    serverTime: str


class TerminalResponse(BaseModel):
    terminal: TerminalView
    serverTime: str


class TakeoverResponse(BaseModel):
    session: SessionView


class RpcError(BaseModel):
    code: str
    message: str


class RpcResponsePayload(BaseModel):
    ok: bool
    result: Any = None
    error: RpcError | None = None


AppReleasePlatform = Literal["android", "desktop"]


class AppUpdateCheckResponse(BaseModel):
    platform: AppReleasePlatform
    updateAvailable: bool
    latestVersionCode: int
    latestVersionName: str
    downloadUrl: str | None = None


class AppReleaseCreateRequest(BaseModel):
    platform: AppReleasePlatform
    versionCode: int = Field(ge=1)
    versionName: str = Field(min_length=1, max_length=64, pattern=r".*\S.*")
    downloadUrl: str = Field(min_length=1, max_length=2048, pattern=r"^https?://\S+$")
    published: bool = True


class AppReleaseView(BaseModel):
    platform: AppReleasePlatform
    versionCode: int
    versionName: str
    downloadUrl: str | None = None
    published: bool
    createdAt: str
    updatedAt: str


class AppReleaseListResponse(BaseModel):
    releases: list[AppReleaseView]
    serverTime: str
