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


# ---------------------------------------------------------------------------
# Quota-limited cloud drive & large-file relay models (T517)
# ---------------------------------------------------------------------------

DrivePurpose = Literal["transfer", "assistant_vfs"]
DriveEncryptionMode = Literal["none", "account_dek", "ephemeral_key"]
DriveFileStatus = Literal["pending", "ready"]
# What an upload or a move does when its target path is taken: pick a free "name (1)" (rename), stop with
# 409 drive_path_conflict (fail), or supersede the file already there (replace; never a folder).
DriveConflictPolicy = Literal["rename", "fail", "replace"]
DriveSystemFolder = Literal["transfers", "orches"]
DriveEntryKind = Literal["file", "folder"]


class PresignedHttpTarget(BaseModel):
    method: Literal["PUT", "GET"]
    url: str
    headers: dict[str, str] = Field(default_factory=dict)
    expires_at: str


class DriveFileView(BaseModel):
    id: str
    purpose: DrivePurpose
    status: DriveFileStatus
    size_bytes: int
    sha256: str
    etag: str | None = None
    filename: str | None = None
    mime_type: str | None = None
    vfs_path: str | None = None
    # Normalized absolute drive path (for a pending upload: where it will land; the final path, possibly with a
    # " (n)" suffix, comes back from /complete), its last name, parent folder and `drive:` text reference.
    path: str
    name: str
    parent_path: str
    ref: str
    # Inside /Orches: written only by Orches' own sync; the drive API can list, download and delete it.
    managed: bool = False
    encryption_mode: DriveEncryptionMode = "none"
    encryption_nonce: str | None = None
    encryption_key_version: int | None = None
    encrypted_meta: str | None = None
    source_device_id: str | None = None
    ttl_seconds: int
    created_at: str
    completed_at: str | None = None
    expires_at: str


class DriveFolderView(BaseModel):
    id: str
    path: str
    name: str
    parent_path: str
    ref: str
    # "transfers" for /Transfers, "orches" for /Orches (clients show localized names); None for other folders.
    system: DriveSystemFolder | None = None
    managed: bool = False
    created_at: str
    updated_at: str


class DriveQuotaView(BaseModel):
    enabled: bool
    rpc_direct_max_bytes: int
    quota_bytes: int | None = None
    used_bytes: int
    reserved_bytes: int
    remaining_bytes: int | None = None
    max_file_bytes: int | None = None
    default_ttl_seconds: int
    max_ttl_seconds: int
    file_count: int
    policy_source: str


class CreateDriveUploadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    purpose: DrivePurpose = "transfer"
    size_bytes: int = Field(gt=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    filename: str | None = Field(default=None, max_length=255)
    mime_type: str | None = Field(default=None, max_length=128)
    vfs_path: str | None = Field(default=None, max_length=512)
    # Where a transfer upload lands. `path` names the file itself (plaintext uploads only: an encrypted upload
    # never puts a name on the server); `folder` only picks the folder and keeps the file name (or the file id).
    # Neither: /Transfers/<filename>. Missing parent folders are created. assistant_vfs uploads always land at
    # /Orches/<vfs_path> and accept neither.
    path: str | None = Field(default=None, min_length=1, max_length=2048)
    folder: str | None = Field(default=None, min_length=1, max_length=2048)
    on_conflict: DriveConflictPolicy | None = None
    ttl_seconds: int | None = Field(default=None, ge=60)
    encryption_mode: DriveEncryptionMode = "none"
    encryption_nonce: str | None = Field(default=None, max_length=64)
    encryption_key_version: int | None = Field(default=None, ge=1)
    encrypted_meta: str | None = Field(default=None, max_length=8192)


class CreateDriveUploadResponse(BaseModel):
    file: DriveFileView
    upload: PresignedHttpTarget


class CompleteDriveUploadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    etag: str | None = Field(default=None, max_length=256)
    # Retry a completion that hit 409 drive_path_conflict with another policy (e.g. "rename").
    on_conflict: DriveConflictPolicy | None = None


class DriveDownloadUrlResponse(BaseModel):
    file: DriveFileView
    download: PresignedHttpTarget


class ListDriveFilesResponse(BaseModel):
    files: list[DriveFileView]
    quota: DriveQuotaView


class DriveEntriesResponse(BaseModel):
    """Direct children of one folder: subfolders, then live files (ready and not expired)."""

    path: str
    ref: str
    folder: DriveFolderView | None = None  # None for the root
    folders: list[DriveFolderView]
    files: list[DriveFileView]
    total_files: int
    quota: DriveQuotaView


class CreateDriveFolderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=2048)
    # Return the folder that is already there (HTTP 200) instead of 409 drive_path_conflict.
    exist_ok: bool = False


class MoveDriveEntryRequest(BaseModel):
    """Rename and/or move a file or folder: `path` is its new full path."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=2048)


class DriveFolderMoveResponse(BaseModel):
    folder: DriveFolderView
    moved_folders: int
    moved_files: int


class DriveFolderDeleteResponse(BaseModel):
    ok: bool
    deleted_folders: int
    deleted_files: int


class DriveResolveResponse(BaseModel):
    kind: DriveEntryKind
    path: str
    ref: str
    folder: DriveFolderView | None = None  # set for folders other than the root
    file: DriveFileView | None = None


class DrivePolicyOverrideView(BaseModel):
    quota_bytes: int | None = None
    max_file_bytes: int | None = None
    default_ttl_seconds: int | None = None
    max_ttl_seconds: int | None = None
    updated_by: str | None = None
    updated_at: str | None = None


class UpdateDrivePolicyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    quota_bytes: int | None = Field(default=None, ge=-1)
    max_file_bytes: int | None = Field(default=None, ge=-1)
    default_ttl_seconds: int | None = Field(default=None, ge=60)
    max_ttl_seconds: int | None = Field(default=None, ge=60)


class AdminDrivePolicyResponse(BaseModel):
    user_id: str
    override: DrivePolicyOverrideView | None = None
    effective: DriveQuotaView


# ---------------------------------------------------------------------------
# Portable assistant sync, KEK/DEK key envelope & Tokens Anywhere models (T516)
# ---------------------------------------------------------------------------

AssistantKdf = Literal["pbkdf2-sha256", "argon2id"]
AssistantWrapAlg = Literal["AES-256-GCM"]
AssistantEventType = Literal["assistant", "assistant_encryption", "assistant_tokens"]


class PutAssistantConversationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    encrypted: bool = False
    updated_at: int = Field(ge=0)
    hash: str = Field(min_length=1, max_length=64)
    device: str = Field(min_length=1, max_length=64)
    # Plaintext fields (forbidden when encrypted=True)
    title: str | None = Field(default=None, max_length=200)
    messages: list[dict[str, Any]] | None = None
    settings: dict[str, Any] | None = None
    # E2EE fields (required when encrypted=True, forbidden when encrypted=False)
    key_version: int | None = Field(default=None, ge=1)
    dek_epoch: int | None = Field(default=None, ge=1)
    nonce: str | None = Field(default=None, max_length=64)
    ciphertext: str | None = None
    encrypted_meta: str | None = None
    meta_nonce: str | None = Field(default=None, max_length=64)


class AssistantConversationMeta(BaseModel):
    id: str
    encrypted: bool = False
    title: str | None = None
    encrypted_meta: str | None = None
    meta_nonce: str | None = None
    key_version: int | None = None
    dek_epoch: int | None = None
    updated_at: int
    hash: str
    device: str
    size: int


class AssistantConversationDetail(AssistantConversationMeta):
    settings: dict[str, Any] | None = None
    messages: list[dict[str, Any]] | None = None
    nonce: str | None = None
    ciphertext: str | None = None


class ListAssistantConversationsResponse(BaseModel):
    conversations: list[AssistantConversationMeta]
    max_conversations: int
    max_conversation_bytes: int


class AssistantStreamEvent(BaseModel):
    event: AssistantEventType
    payload: dict[str, Any]


class AssistantKeyEnvelopePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kdf: AssistantKdf
    kdf_params: dict[str, Any]
    salt: str = Field(min_length=16, max_length=256)
    wrap_alg: AssistantWrapAlg = "AES-256-GCM"
    wrap_nonce: str | None = Field(default=None, max_length=64)
    wrapped_dek: str = Field(min_length=32, max_length=1024)


class PutAssistantKeyEnvelopeRequest(AssistantKeyEnvelopePayload):
    expected_version: int | None = Field(default=None, ge=0)
    device: str | None = Field(default=None, max_length=64)


class ResetAssistantEncryptionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirm_wipe: bool
    new_envelope: AssistantKeyEnvelopePayload | None = None
    wipe_drive_vfs: bool = True
    device: str | None = Field(default=None, max_length=64)


class AssistantKeyEnvelopeView(BaseModel):
    kdf: AssistantKdf
    kdf_params: dict[str, Any]
    salt: str
    wrap_alg: AssistantWrapAlg
    wrap_nonce: str | None = None
    wrapped_dek: str
    key_version: int
    dek_epoch: int
    created_at: str
    updated_at: str


class AssistantEncryptionStatusResponse(BaseModel):
    enabled: bool
    envelope: AssistantKeyEnvelopeView | None = None


class ResetAssistantEncryptionResponse(BaseModel):
    enabled: bool
    envelope: AssistantKeyEnvelopeView | None = None
    wiped_conversations: int
    wiped_drive_files: int


class PutAssistantTokensRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=8, max_length=300)
    refresh: str | None = Field(default=None, max_length=500)


class AssistantTokensView(BaseModel):
    connected: bool
    key: str | None = None
    prefix: str | None = None
    connected_at: str | None = None
    refreshed_at: str | None = None
    kept: bool | None = None
    hint: str | None = None
    tokens_url: str
    client_id: str


class DeleteAssistantTokensResponse(BaseModel):
    connected: bool
    removed: bool
