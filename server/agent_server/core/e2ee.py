"""E2EE 1.0: pairing payloads and trust messages for the optional Noise mode.

These models describe what travels *inside* or *alongside* the Noise channel
between a client and a device. Clients send ``ClientTunnelFrame`` on the
Server's tunnel WebSocket; the worker that holds it forwards ``n``/``ct`` on a
duplex ``aa.device.v1.Secure/channel`` call
(``agent_server.core.device_meshcall.SecureChannelItem``). The Server reads only the
route and the counter, stores the non-content ``CommandRegistration`` and never
sees the plaintext of anything else here.
See ``contracts/e2ee/1.0/README.md`` and ``docs/v3/11-e2ee-noise.md``.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

E2EE_VERSION = "1.0"
PAIRING_TTL_SECONDS = 600
MAX_OPEN_PAIRINGS = 3
REKEY_INTERVAL_SECONDS = 3600
REKEY_INTERVAL_FRAMES = 1 << 20

NonEmpty = Annotated[str, Field(min_length=1)]
Base64 = Annotated[str, Field(min_length=1, description="base64url without padding")]

NoiseHandshakePattern = Literal["XXpsk0", "KK"]


def _omit_default_additional_properties(schema: dict[str, Any]) -> None:
    schema.pop("additionalProperties", None)


class E2eeModel(BaseModel):
    model_config = ConfigDict(
        json_schema_serialization_defaults_required=True,
        extra="allow",
        json_schema_extra=_omit_default_additional_properties,
    )


class PairingPayload(E2eeModel):
    """Encoded in the QR code shown by the device: ``aa-pair://<base64url(json)>``."""

    v: Literal[1] = 1
    deviceId: NonEmpty
    deviceIdentityPub: Base64
    pairingId: NonEmpty
    psk: Base64 = Field(description="32 random bytes, single use, expires after 10 minutes")
    serverUrl: NonEmpty
    e2eeMode: Literal["off", "required"]
    expiresAt: str


class HandshakeEnvelope(E2eeModel):
    """Handshake messages ride in ``tun`` frames on a dedicated channel id."""

    pattern: NoiseHandshakePattern
    pairingId: str | None = Field(default=None, description="present only for XXpsk0 pairing")
    step: int = Field(ge=0, le=2)
    message: Base64


class DirectoryKeyGrant(E2eeModel):
    """Sent by the device to a client inside the channel after pairing or rotation."""

    deviceId: NonEmpty
    keyId: NonEmpty
    epoch: int = Field(ge=0)
    key: Base64


class ClientGrantView(E2eeModel):
    clientId: NonEmpty
    label: str
    identityPubFingerprint: NonEmpty
    grantedAt: str
    grantedBy: Literal["qr", "approval", "local"]
    revokedAt: str | None = None


class ApproveClientRequest(E2eeModel):
    """An authorised client asks the device to trust another client's key."""

    clientIdentityPub: Base64
    label: str


class RevokeClientRequest(E2eeModel):
    clientId: NonEmpty


class TrustListResponse(E2eeModel):
    deviceId: NonEmpty
    grants: list[ClientGrantView] = Field(default_factory=list)
    directoryKeyId: NonEmpty
    directoryKeyEpoch: int = Field(ge=0)


class TunnelRoute(E2eeModel):
    deviceId: NonEmpty
    clientId: NonEmpty
    ch: NonEmpty


class ClientTunnelFrame(BaseModel):
    """Client <-> Server frame on ``WS /api/v3/tunnel``; ``ct`` is opaque to the Server."""

    model_config = ConfigDict(json_schema_serialization_defaults_required=True, extra="forbid")

    t: Literal["tun"]
    route: TunnelRoute
    n: int = Field(ge=0)
    ct: str = Field(description="base64 Noise transport message")


class TunnelRequest(E2eeModel):
    """Plaintext inside the channel: the same client API call as normal mode."""

    kind: Literal["request"] = "request"
    id: NonEmpty
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
    path: NonEmpty = Field(description="client API path, e.g. /api/v2/sessions/{id}/snapshot")
    body: Any = None


class TunnelResponse(E2eeModel):
    kind: Literal["response"] = "response"
    id: NonEmpty
    status: int = Field(ge=100, le=599)
    body: Any = None


class TunnelEvent(E2eeModel):
    """A realtime client event (same envelope as normal mode) pushed through the channel."""

    kind: Literal["event"] = "event"
    event: dict[str, Any]


class CommandRegistration(E2eeModel):
    """Plaintext side-channel so the Server can keep idempotency for encrypted commands."""

    commandId: NonEmpty
    deviceId: NonEmpty
    inputDigest: NonEmpty
