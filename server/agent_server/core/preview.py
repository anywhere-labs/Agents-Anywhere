"""Port preview 1.0: client API, device commands and events.

Control plane is in the AA Server; the data plane is frp (frps next to the
Server, frpc managed by the Connector). See ``docs/v3/09-port-preview.md``.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

PREVIEW_VERSION = "1.0"
DEFAULT_TTL_HOURS = 24
MAX_LINK_TTL_DAYS = 7
MAX_OPEN_PREVIEWS_PER_DEVICE = 8
TICKET_TTL_SECONDS = 60
COOKIE_TTL_HOURS = 8

NonEmpty = Annotated[str, Field(min_length=1)]
Port = Annotated[int, Field(ge=1, le=65535)]

PreviewVisibility = Literal["private", "link"]
PreviewState = Literal["opening", "open", "closed"]
PreviewCloseReason = Literal["port_closed", "user_closed", "expired", "device_offline", "revoked"]


def _omit_default_additional_properties(schema: dict[str, Any]) -> None:
    schema.pop("additionalProperties", None)


class PreviewModel(BaseModel):
    model_config = ConfigDict(
        json_schema_serialization_defaults_required=True,
        extra="allow",
        json_schema_extra=_omit_default_additional_properties,
    )


class CreatePreviewRequest(PreviewModel):
    deviceId: NonEmpty
    port: Port
    sessionId: str | None = None
    visibility: PreviewVisibility = "private"
    ttlHours: int | None = Field(default=None, ge=1, le=MAX_LINK_TTL_DAYS * 24)


class PreviewView(PreviewModel):
    previewId: NonEmpty
    slug: NonEmpty
    deviceId: NonEmpty
    sessionId: str | None = None
    port: Port
    visibility: PreviewVisibility
    state: PreviewState
    closeReason: PreviewCloseReason | None = None
    url: str | None = None
    expiresAt: str
    plaintextNotice: bool = Field(
        default=False,
        description="true in E2EE mode: preview traffic is not end-to-end encrypted",
    )


class PreviewListResponse(PreviewModel):
    previews: list[PreviewView] = Field(default_factory=list)


class PreviewTicketResponse(PreviewModel):
    ticketUrl: NonEmpty
    expiresAt: str


class ListeningPort(PreviewModel):
    port: Port
    pid: int | None = None
    processName: str | None = None
    sessionId: str | None = None
    url: str | None = None


class PortListeningEvent(PreviewModel):
    """Device ``evt`` ``port.listening``."""

    deviceId: NonEmpty
    ports: list[ListeningPort] = Field(default_factory=list)


class PortClosedEvent(PreviewModel):
    deviceId: NonEmpty
    port: Port


class PreviewOpenCommand(PreviewModel):
    """Server -> device ``cmd`` ``preview.open``."""

    previewId: NonEmpty
    slug: NonEmpty
    port: Port
    frpsAddr: NonEmpty
    frpToken: NonEmpty
    tokenExpiresAt: str


class PreviewCloseCommand(PreviewModel):
    previewId: NonEmpty
    slug: NonEmpty
