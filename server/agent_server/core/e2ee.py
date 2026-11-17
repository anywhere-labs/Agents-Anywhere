"""E2EE 1.0: pairing, Noise channel framing and trust messages for the optional encrypted mode.

These models describe what travels *inside* or *alongside* the Noise channel
between a client and a device. Clients send ``ClientTunnelFrame`` on the
Server's tunnel WebSocket; the worker that holds it forwards ``n``/``ct`` on a
duplex ``aa.device.v1.Secure/channel`` call
(``agent_server.core.device_meshcall.SecureChannelItem``). The Server reads only the
route and the counter, stores the non-content ``CommandRegistration`` and never
sees the plaintext of anything else here.

The byte-level rules (Noise suite, prologues, frame flags, client ids, sealed
display envelopes and attachments, input digests) are pinned by the helpers at
the bottom of this module and by ``contracts/e2ee/1.0/vectors``; TS, Kotlin and
Swift implement the same rules and run the same vectors.
See ``contracts/e2ee/1.0/README.md`` and ``docs/v3/11-e2ee-noise.md``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

E2EE_VERSION = "1.0"
PAIRING_TTL_SECONDS = 600
MAX_OPEN_PAIRINGS = 3
REKEY_INTERVAL_SECONDS = 3600
REKEY_INTERVAL_FRAMES = 1 << 20

# --- Noise (S8) ---------------------------------------------------------------
NOISE_SUITE = "25519_AESGCM_SHA256"
NOISE_PAIRING_PROTOCOL = f"Noise_XXpsk0_{NOISE_SUITE}"
NOISE_RECONNECT_PROTOCOL = f"Noise_KK_{NOISE_SUITE}"
PROLOGUE_LABEL = "aa-e2ee/1.0"
NOISE_MAX_MESSAGE_BYTES = 65535
NOISE_TAG_BYTES = 16

# --- Channel framing -----------------------------------------------------------
# Plaintext of every transport message: one flag byte, then the body.
FRAME_CONTINUE = 0x00  # body is a fragment; more fragments of the same message follow
FRAME_FINAL = 0x01  # body is the last fragment; the reassembled bytes are one UTF-8 JSON ChannelMessage
FRAME_REKEY = 0x02  # empty body; the sender rekeys its send CipherState right after, the receiver right after reading
FRAME_MAX_BODY_BYTES = NOISE_MAX_MESSAGE_BYTES - NOISE_TAG_BYTES - 1
CHANNEL_MAX_MESSAGE_BYTES = 16 * 1024 * 1024

# --- Identifiers -----------------------------------------------------------------
PAIRING_URI_PREFIX = "aa-pair://"
CLIENT_ID_PATTERN = r"^cli_[a-z2-7]{26}$"
CHANNEL_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
TRUST_PATH_PREFIX = "/e2ee/v1/"

# --- Sealed content --------------------------------------------------------------
SEALED_SEGMENT_BYTES = 64 * 1024
DIRECTORY_KEY_BYTES = 32
#: Encrypted uploads: ``POST /api/v2/sessions/{id}/attachments`` with this header; the body is the segment
#: ciphertexts concatenated in order (every segment but the last is SEALED_SEGMENT_BYTES + 16 bytes).
SEALED_UPLOAD_HEADER = "x-aa-sealed"
SEALED_UPLOAD_VALUE = "segments-v1"
#: Largest plaintext slice of one file read through the channel (``TunnelFileChunk``).
FILE_CHUNK_MAX_BYTES = 8 * 1024 * 1024

NonEmpty = Annotated[str, Field(min_length=1)]
Base64 = Annotated[str, Field(min_length=1, description="base64url without padding")]
Key32 = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{43}$", description="32 bytes, base64url without padding")]
ClientId = Annotated[str, Field(pattern=CLIENT_ID_PATTERN, description="client_id_for(identity public key)")]
ChannelId = Annotated[str, Field(pattern=CHANNEL_ID_PATTERN)]

NoiseHandshakePattern = Literal["XXpsk0", "KK"]
ClientPlatform = Literal["web", "desktop", "android", "ios", "cli"]


def _omit_default_additional_properties(schema: dict[str, Any]) -> None:
    schema.pop("additionalProperties", None)


class E2eeModel(BaseModel):
    model_config = ConfigDict(
        json_schema_serialization_defaults_required=True,
        extra="allow",
        json_schema_extra=_omit_default_additional_properties,
    )


# ---------------------------------------------------------------------------
# Pairing and handshake
# ---------------------------------------------------------------------------


class PairingPayload(E2eeModel):
    """Encoded in the QR code shown by the device: ``aa-pair://<base64url(json)>``."""

    v: Literal[1] = 1
    deviceId: NonEmpty
    deviceIdentityPub: Key32
    pairingId: NonEmpty
    psk: Key32 = Field(description="32 random bytes, single use, expires after 10 minutes")
    serverUrl: NonEmpty
    e2eeMode: Literal["off", "required"]
    expiresAt: str


class HandshakeEnvelope(E2eeModel):
    """A Noise handshake message. While a channel handshakes, ``ct`` of its frames is
    ``base64url(utf8(json(HandshakeEnvelope)))`` and ``n`` is ``step``; afterwards ``ct`` is a
    Noise transport message and ``n`` its nonce."""

    pattern: NoiseHandshakePattern
    pairingId: str | None = Field(default=None, description="present only for XXpsk0 pairing")
    step: int = Field(ge=0, le=2)
    message: Base64


class PairingDeviceHello(E2eeModel):
    """Payload of XXpsk0 message 2 (device -> client). The client checks ``deviceId`` and that the
    static key in the same message equals ``PairingPayload.deviceIdentityPub``."""

    deviceId: NonEmpty
    label: str = ""


class PairingClientHello(E2eeModel):
    """Payload of XXpsk0 message 3 (client -> device)."""

    label: str
    platform: ClientPlatform
    appVersion: str | None = None


class DirectoryKeyGrant(E2eeModel):
    """Sent by the device to a client inside the channel after pairing or rotation."""

    deviceId: NonEmpty
    keyId: NonEmpty
    epoch: int = Field(ge=0)
    key: Key32


# ---------------------------------------------------------------------------
# Channel messages (JSON inside FRAME_FINAL)
# ---------------------------------------------------------------------------


class PairCommitted(E2eeModel):
    """Device -> client right after XXpsk0: the grant is on disk. If it is lost, the client
    retries with KK; a successful KK proves the grant exists."""

    kind: Literal["pair.committed"] = "pair.committed"
    deviceId: NonEmpty
    clientId: ClientId
    grantedAt: str
    directoryKey: DirectoryKeyGrant


class ChannelReady(E2eeModel):
    """Device -> client, first transport message after KK (and after ``pair.committed``).
    The client sends no request before it. The device re-checked policy and the grant."""

    kind: Literal["ready"] = "ready"
    deviceId: NonEmpty
    clientId: ClientId
    directoryKeyId: NonEmpty
    directoryKeyEpoch: int = Field(ge=0)


class ChannelClose(E2eeModel):
    kind: Literal["close"] = "close"
    reason: Literal["revoked", "not_paired", "policy", "shutdown", "protocol_error", "too_large"]
    message: str = ""


class TunnelRequest(E2eeModel):
    """Plaintext inside the channel: the same client API call as normal mode."""

    kind: Literal["request"] = "request"
    id: NonEmpty
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
    path: NonEmpty = Field(description="client API path, e.g. /api/v2/sessions/{id}/snapshot, or /e2ee/v1/…")
    body: Any = None


class TunnelResponse(E2eeModel):
    kind: Literal["response"] = "response"
    id: NonEmpty
    status: int = Field(ge=100, le=599)
    body: Any = None


class TunnelSubscribe(E2eeModel):
    """Same as opening a realtime WebSocket in normal mode.

    ``stream: "session"``: the session WebSocket of ``sessionId`` (events after ``afterCursor`` are replayed
    first). ``stream: "terminal"``: the stream of device terminal ``terminalId``
    (``/api/v2/connectors/{deviceId}/terminals-v2/{terminalId}/stream`` in normal mode); every
    ``TunnelEvent.event`` is one message of that WebSocket, and input, resize and close stay ``request``s to the
    same paths as normal mode.
    """

    kind: Literal["subscribe"] = "subscribe"
    id: NonEmpty
    stream: Literal["session", "terminal"] = "session"
    sessionId: str | None = Field(default=None, description="required when stream is session")
    terminalId: str | None = Field(default=None, description="required when stream is terminal")
    afterCursor: str | None = Field(default=None, description="seq:N; events after it are replayed first")

    @model_validator(mode="after")
    def _target(self) -> TunnelSubscribe:
        if self.stream == "session" and not self.sessionId:
            raise ValueError("sessionId is required for a session stream")
        if self.stream == "terminal" and not self.terminalId:
            raise ValueError("terminalId is required for a terminal stream")
        return self


class TunnelUnsubscribe(E2eeModel):
    kind: Literal["unsubscribe"] = "unsubscribe"
    id: NonEmpty


class TunnelEvent(E2eeModel):
    """A realtime client event (same envelope as normal mode) pushed through the channel.

    ``sub`` names the subscription it belongs to; channel-level events (``e2ee.*``) have none.
    """

    kind: Literal["event"] = "event"
    sub: str | None = None
    event: dict[str, Any]


# ---------------------------------------------------------------------------
# Trust management (TunnelRequest paths under /e2ee/v1/)
# ---------------------------------------------------------------------------


class ClientGrantView(E2eeModel):
    clientId: ClientId
    label: str
    platform: ClientPlatform | None = None
    identityPubFingerprint: NonEmpty
    grantedAt: str
    grantedBy: Literal["qr", "approval", "local"]
    revokedAt: str | None = None


class ApproveClientRequest(E2eeModel):
    """``POST /e2ee/v1/trust/approve``: an authorised client asks the device to trust another
    client's key (§7.2). The device confirms locally unless its policy allows otherwise."""

    clientIdentityPub: Key32
    label: str
    platform: ClientPlatform | None = None


class RevokeClientRequest(E2eeModel):
    """``POST /e2ee/v1/trust/revoke``."""

    clientId: ClientId


class TrustListResponse(E2eeModel):
    """``GET /e2ee/v1/trust``."""

    deviceId: NonEmpty
    grants: list[ClientGrantView] = Field(default_factory=list)
    directoryKeyId: NonEmpty
    directoryKeyEpoch: int = Field(ge=0)


TRUST_ROUTES: dict[str, tuple[type[BaseModel] | None, type[BaseModel]]] = {
    "GET /e2ee/v1/trust": (None, TrustListResponse),
    "POST /e2ee/v1/trust/approve": (ApproveClientRequest, ClientGrantView),
    "POST /e2ee/v1/trust/revoke": (RevokeClientRequest, TrustListResponse),
    "GET /e2ee/v1/directory-key": (None, DirectoryKeyGrant),
}

# TunnelEvent.event["type"] for channel-level pushes.
E2EE_EVENTS: dict[str, type[BaseModel]] = {
    "e2ee.directory_key": DirectoryKeyGrant,
    "e2ee.trust_changed": TrustListResponse,
}


class SealedAttachmentKey(E2eeModel):
    """Travels inside the channel with the request that references an encrypted upload: the request body
    carries ``sealedAttachmentKeys: [SealedAttachmentKey]`` next to its usual ``attachments``. The Server only
    ever holds the ciphertext.

    The upload's segments are sealed before the Server assigns ``fileId``, so their AD uses
    ``objectId = sha256`` (``sealed_segment_ad("attachment", sha256, i, final)``); the key is random per file,
    so a swapped upload fails to open either way. The device checks ``size`` and ``sha256`` after opening.
    """

    fileId: NonEmpty
    key: Key32
    size: int = Field(ge=0, description="plaintext size")
    sha256: Annotated[str, Field(pattern=r"^[0-9a-f]{64}$", description="hex SHA-256 of the plaintext; also the segment AD objectId")]
    name: str | None = Field(default=None, description="real file name; the upload itself is named attachment.bin")
    mimeType: str | None = Field(default=None, description="real media type; the upload itself is application/octet-stream")


class TunnelFileChunk(E2eeModel):
    """Response body of a file read through the channel:
    ``GET /api/v2/connectors/{deviceId}/fs/read?root=…&path=…&offset=…&length=…`` (the normal-mode query plus
    ``offset`` and ``length``; ``length`` at most
    ``FILE_CHUNK_MAX_BYTES``; the device may return less). Large files are read chunk by chunk; each chunk is a
    normal channel message, so it is encrypted and fragmented like any other."""

    encoding: Literal["base64"] = "base64"
    data: str = Field(description="base64 (standard alphabet) of the bytes at [offset, offset + len)")
    offset: int = Field(ge=0)
    size: int = Field(ge=0, description="total file size")
    eof: bool


# ---------------------------------------------------------------------------
# Tunnel transport and plaintext side channel
# ---------------------------------------------------------------------------


class TunnelRoute(E2eeModel):
    deviceId: NonEmpty
    clientId: ClientId
    ch: ChannelId


class ClientTunnelFrame(BaseModel):
    """Client <-> Server frame on ``WS /api/v3/tunnel``; ``ct`` is opaque to the Server."""

    model_config = ConfigDict(json_schema_serialization_defaults_required=True, extra="forbid")

    t: Literal["tun"]
    route: TunnelRoute
    n: int = Field(ge=0)
    ct: str = Field(description="base64url Noise message (see HandshakeEnvelope for the handshake phase)")


TunnelEndCode = Literal[
    "closed",
    "e2ee_not_paired",
    "pairing_expired",
    "e2ee_handshake_failed",
    "e2ee_protocol_error",
    "too_large",
    "connector_offline",
    "e2ee_required",
]


class ClientTunnelEnd(BaseModel):
    """Ends one channel on ``WS /api/v3/tunnel``.

    Server -> client: the device ended its ``Secure/channel`` call (``code`` is the call's error code) or the
    device went offline. Client -> Server: cancel the call. The Server cannot forge anything worse than a
    disconnect with it: a client never relaxes encryption because of an ``end``.
    """

    model_config = ConfigDict(json_schema_serialization_defaults_required=True, extra="forbid")

    t: Literal["end"]
    route: TunnelRoute
    code: TunnelEndCode = "closed"


class CommandRegistration(E2eeModel):
    """``POST /api/v3/e2ee/commands`` before the command goes through the channel, so the Server
    keeps idempotency for encrypted commands. ``inputDigest`` is keyed (see ``input_digest``):
    the Server can compare it but cannot confirm a guessed input."""

    commandId: NonEmpty
    deviceId: NonEmpty
    inputDigest: Annotated[str, Field(pattern=r"^hmac-sha256:[A-Za-z0-9_-]{43}$")]


# ---------------------------------------------------------------------------
# Byte-level rules shared by all implementations (pinned by vectors/aa-formats.json)
# ---------------------------------------------------------------------------


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _label(*fields: str) -> bytes:
    for value in fields:
        if "\0" in value:
            raise ValueError("binding fields must not contain NUL")
    return "\0".join((PROLOGUE_LABEL, *fields)).encode()


def client_id_for(identity_pub: bytes) -> str:
    """``cli_`` + the first 26 base32 (lowercase, RFC 4648) chars of SHA-256(label || pub)."""

    digest = hashlib.sha256(_label("client-id") + b"\0" + identity_pub).digest()
    return "cli_" + base64.b32encode(digest).decode().lower()[:26]


def identity_fingerprint(identity_pub: bytes) -> str:
    """What people compare out of band: 8 groups of 4 hex digits of SHA-256(pub)."""

    digest = hashlib.sha256(identity_pub).hexdigest()[:32]
    return " ".join(digest[i : i + 4] for i in range(0, 32, 4))


def pairing_prologue(device_id: str, pairing_id: str, client_id: str, ch: str) -> bytes:
    return _label("pair", device_id, pairing_id, client_id, ch)


def connect_prologue(device_id: str, client_id: str, ch: str) -> bytes:
    return _label("connect", device_id, client_id, ch)


def display_envelope_ad(device_id: str, session_id: str, slot: Literal["device", "user"], key_id: str) -> bytes:
    """AES-GCM associated data of a sealed ``DisplayEnvelope``; binds it to its row so the Server
    cannot move a title from one session (or slot) to another."""

    return _label("display", device_id, session_id, slot, key_id)


def sealed_segment_ad(purpose: Literal["attachment", "share"], object_id: str, index: int, final: bool) -> bytes:
    return _label(purpose, object_id, str(index)) + (b"\0\x01" if final else b"\0\x00")


def input_digest_key(directory_key: bytes) -> bytes:
    return hmac.new(directory_key, _label("input-digest"), hashlib.sha256).digest()


def input_digest(directory_key: bytes, body: bytes) -> str:
    """Keyed digest of the exact request body bytes the client sends through the channel."""

    mac = hmac.new(input_digest_key(directory_key), body, hashlib.sha256).digest()
    return "hmac-sha256:" + b64url(mac)


def is_client_id(value: str) -> bool:
    return re.fullmatch(CLIENT_ID_PATTERN, value) is not None


def is_channel_id(value: str) -> bool:
    return re.fullmatch(CHANNEL_ID_PATTERN, value) is not None
