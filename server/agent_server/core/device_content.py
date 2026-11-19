"""Routing credentials and RPC payloads for mobile management and device content."""

import json
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, RootModel

from agent_server.core.e2ee import DirectoryKeyGrant

CONTENT_SERVICE = "aa.device.v1.Content"
CONTENT_METHODS = ("pair", "request", "subscribe")
CONTENT_PRINCIPAL = "aa-content-client"
CONTROL_PRINCIPAL = "aa-server-control"
MOBILE_CONTROL_SERVICE = "aa.server.v1.MobileControl"
MOBILE_CONTENT_GRANT_METHOD = "issue_content_tunnel"
MOBILE_DIRECTORY_METHOD = "read_directory"
MOBILE_CONTROL_PRINCIPAL = "aa-mobile-control/"


def mobile_control_principal(user_id: str, family_id: str, public_router_url: str) -> str:
    return MOBILE_CONTROL_PRINCIPAL + json.dumps(
        [user_id, family_id, public_router_url], separators=(",", ":")
    )


def mobile_control_identity(principal: str) -> tuple[str, str, str] | None:
    if not principal.startswith(MOBILE_CONTROL_PRINCIPAL):
        return None
    try:
        values = json.loads(principal[len(MOBILE_CONTROL_PRINCIPAL):])
    except ValueError:
        return None
    if not isinstance(values, list) or len(values) != 3 or not all(
        isinstance(value, str) and value for value in values
    ):
        return None
    return values[0], values[1], values[2]


def content_tunnel_principal(family_id: str) -> str:
    return f"{CONTENT_PRINCIPAL}/{family_id}"


class ContentModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


DeviceID = Annotated[str, Field(min_length=1, max_length=128)]
ConnectionID = Annotated[str, Field(min_length=1, max_length=128)]


class MobileContentTunnelRequest(ContentModel):
    deviceId: DeviceID
    connectionId: ConnectionID | None = None


MobileDirectoryResource = Literal["devices", "projects", "sessions", "runtimes"]


class MobileDirectoryRequest(ContentModel):
    resource: MobileDirectoryResource
    deviceId: DeviceID | None = None
    cursor: Annotated[str, Field(min_length=1, max_length=2048)] | None = None


class MobileDirectoryResult(ContentModel):
    body: dict[str, Any]


class EncryptedTunnelGrant(ContentModel):
    router_url: str
    credential: str = Field(repr=False)
    instance_id: str
    tunnel_id: str
    e2e_key: str
    expires_at_unix_ms: int
    maxFrameBytes: int


class ContentTunnelGrant(EncryptedTunnelGrant):
    connectionId: str


class ContentPairRequest(ContentModel):
    pairingId: str = Field(min_length=1, max_length=128)
    pairingSecret: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$", repr=False)
    clientIdentityPub: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")
    clientSecret: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$", repr=False)
    label: str = Field(min_length=1, max_length=120)
    platform: Literal["android", "ios", "web", "desktop", "cli"]


class ContentPairResult(ContentModel):
    clientId: str
    grantedAt: str
    directoryKey: DirectoryKeyGrant


class ContentRequest(ContentModel):
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
    path: str = Field(min_length=1, max_length=4096)
    body: Any = None


class ContentResult(ContentModel):
    status: int
    body: Any = None
    contentType: str | None = None


class ContentSubscribeRequest(ContentModel):
    stream: Literal["session", "terminal", "trust"] = "session"
    sessionId: str = ""
    afterCursor: str | None = None
    terminalId: str | None = None
    fromSeq: int | None = Field(default=None, ge=0)


class ContentEvent(RootModel[dict[str, Any]]):
    pass
