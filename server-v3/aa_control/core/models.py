from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from aa_control.core.config import AuthMode
from aa_control.core.entitlements import EntitlementValue

DeviceMode = Literal["normal", "encrypted"]
DevicePlatform = Literal["macos", "linux", "windows"]
ClientPlatform = Literal["ios", "android", "desktop", "web"]
PresenceState = Literal["online", "offline"]
SessionState = Literal["idle", "running", "error", "disconnected", "waiting"]
DeviceResultStatus = Literal["ok", "offline", "timeout", "error", "encrypted"]
PushEventType = Literal["approval", "activity", "error"]
McpScope = Literal["devices:read", "sessions:read", "sessions:write", "approvals:answer"]

ALL_MCP_SCOPES: tuple[McpScope, ...] = (
    "devices:read",
    "sessions:read",
    "sessions:write",
    "approvals:answer",
)
DEFAULT_CHECKED_MCP_SCOPES: tuple[McpScope, ...] = (
    "devices:read",
    "sessions:read",
    "sessions:write",
)


# ---------------------------------------------------------------------------
# Contracts aligned with contracts/aa-v3/1.0/control.schema.json
# ---------------------------------------------------------------------------


class DeviceError(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=1)
    message: str


class NormalDeviceSummary(BaseModel):
    """Reported ONLY by normal-mode devices. Encrypted devices MUST omit this."""

    model_config = ConfigDict(extra="forbid")

    runtimes: list[str] = Field(default_factory=list)
    active_sessions: int = Field(default=0, ge=0)
    pending_approvals: int = Field(default=0, ge=0)


class DeviceRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=128)
    platform: DevicePlatform
    connector_version: str = Field(min_length=1, max_length=64)
    mode_hint: DeviceMode
    presence: PresenceState
    created_at: str
    last_seen_at: str
    summary: NormalDeviceSummary | None = None
    e2e_public_key_hint: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{43}$")


class PresenceReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str = Field(min_length=1, max_length=128)
    platform: DevicePlatform
    connector_version: str = Field(min_length=1, max_length=64)
    mode_hint: DeviceMode
    sent_at: str
    summary: NormalDeviceSummary | None = None
    e2e_public_key_hint: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{43}$")


class WatchDevicesEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["snapshot", "upsert", "remove"]
    devices: list[DeviceRecord] | None = None
    device: DeviceRecord | None = None
    device_id: str | None = None

    def to_contract_dict(self) -> dict:
        if self.type == "snapshot":
            return {
                "type": "snapshot",
                "devices": [d.model_dump(exclude_none=True) for d in (self.devices or [])],
            }
        if self.type == "upsert":
            assert self.device is not None
            return {"type": "upsert", "device": self.device.model_dump(exclude_none=True)}
        return {"type": "remove", "device_id": self.device_id}


class OpenTunnelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str = Field(min_length=1, max_length=128)
    client_id: str | None = Field(default=None, min_length=1, max_length=128)
    e2e_key: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{43}$")


class OpenTunnelResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    router_url: str
    credential: str = Field(pattern=r"^mtun_")
    tunnel_id: str = Field(min_length=1, max_length=128)
    expires_at: str
    mode: DeviceMode


class RevokeTunnelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str = Field(min_length=1, max_length=128)
    tunnel_id: str = Field(min_length=1, max_length=128)


class RevokeTunnelResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revoked: bool
    device_notified: bool = False


class SessionSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    title: str
    agent: str = Field(min_length=1)
    device_id: str = Field(min_length=1, max_length=128)
    cwd: str
    state: SessionState
    unread: bool
    pinned: bool
    updated_at: str


class SessionListPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sessions: list[SessionSummary] = Field(default_factory=list)
    projects: list[str] = Field(default_factory=list)


class DeviceSessionResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str = Field(min_length=1, max_length=128)
    status: DeviceResultStatus
    value: SessionListPayload | None = None
    error: DeviceError | None = None


class ListSessionsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_ids: list[str] | None = None
    limit_per_device: int | None = Field(default=None, ge=1, le=500)


class ListSessionsOnceResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    results: list[DeviceSessionResult]


class DeviceAdminPingResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: Literal[True] = True
    server_time: str


class DeviceAdminCloseTunnelSessionsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tunnel_id: str = Field(min_length=1, max_length=128)


class DeviceAdminCheckUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel: str | None = None


class DeviceAdminRenameRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=128)


class PushNotificationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str = Field(min_length=1, max_length=128)
    event_type: PushEventType
    session_id: str | None = Field(default=None, min_length=1, max_length=128)
    title: str | None = Field(default=None, max_length=160)
    body: str | None = Field(default=None, max_length=512)


class PushNotificationAck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    queued: int
    content_stripped: bool


class RegisterClientPushRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    client_id: str = Field(min_length=1, max_length=128)
    platform: ClientPlatform
    push_token: str | None = Field(default=None, max_length=512)
    label: str | None = Field(default=None, max_length=128)


# ---------------------------------------------------------------------------
# Control RPC helper request/response models
# ---------------------------------------------------------------------------


class EmptyRequest(BaseModel):
    pass


class OkResponse(BaseModel):
    ok: bool = True


class ListDevicesResponse(BaseModel):
    devices: list[DeviceRecord]


class DeviceIdRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=128)


class RenameDeviceRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=128)


class CheckUpdateControlRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=128)
    channel: str | None = None


class PresenceAck(BaseModel):
    accepted: int


# ---------------------------------------------------------------------------
# FastAPI HTTP auth & bootstrap models
# ---------------------------------------------------------------------------


class UserView(BaseModel):
    id: str
    email: str | None = None
    display_name: str
    role: str
    created_at: str
    plan: str | None = None
    entitlements: dict[str, EntitlementValue] = Field(default_factory=dict)
    active_context: dict[str, Any] | None = None


class OidcPublicConfig(BaseModel):
    issuer: str
    client_id: str | None = None
    scopes: str
    authorization_endpoint: str | None = None
    token_endpoint: str | None = None
    userinfo_endpoint: str | None = None
    jwks_uri: str | None = None
    end_session_endpoint: str | None = None


class AuthConfigResponse(BaseModel):
    auth_mode: AuthMode = "local"
    needs_bootstrap: bool
    registration_open: bool
    oauth_enabled: bool
    oauth_provider_label: str | None = None
    oidc: OidcPublicConfig | None = None
    server_time: str


class RegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=8, max_length=256)
    display_name: str = Field(default="", max_length=128)
    setup_token: str | None = None
    client_id: str | None = Field(default=None, max_length=128)
    client_platform: ClientPlatform = "web"


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256)
    client_id: str | None = Field(default=None, max_length=128)
    client_platform: ClientPlatform = "web"


class AuthTokenResponse(BaseModel):
    user: UserView
    access_token: str
    refresh_token: str
    expires_in: int
    client_id: str


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=16)


class LogoutRequest(BaseModel):
    refresh_token: str = Field(min_length=16)


class ClientRouterTokenRequest(BaseModel):
    client_id: str = Field(min_length=1, max_length=128)
    platform: ClientPlatform = "web"


class RouterTokenEntry(BaseModel):
    router_id: str
    router_url: str
    token: str
    token_id: str
    expires_at: str


class ClientRouterTokenResponse(BaseModel):
    principal: str
    tokens: list[RouterTokenEntry]


class RegisterDeviceRequest(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    platform: DevicePlatform
    mode_hint: DeviceMode = "normal"
    connector_version: str = Field(default="3.0.0", min_length=1, max_length=64)
    e2e_public_key_hint: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{43}$")


class RegisterDeviceResponse(BaseModel):
    device: DeviceRecord
    device_secret: str
    notice: str = "Device name is visible to the control plane server."


class DeviceRouterTokenRequest(BaseModel):
    device_id: str = Field(min_length=1, max_length=128)
    device_secret: str = Field(min_length=16)


class DeviceRouterTokenResponse(BaseModel):
    device_id: str
    principal: str
    tokens: list[RouterTokenEntry]
