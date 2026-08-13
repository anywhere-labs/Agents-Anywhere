from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from agent_server.core.models import (
    Approval,
    NoticeIn,
    SessionRuntimeState,
    SessionView,
    TimelineItem,
)
from agent_server.core.runtime_identity import RuntimeId

PROTOCOL_VERSION_1 = "1.0"
SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION_1]
PROTOCOL_MAX_REVISION = 9_007_199_254_740_991

ProtocolVersion = Literal["1.0"]
ProtocolCapabilityScope = Literal["runtime", "session"]


class ProtocolWireModel(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)


class ProtocolRuntimeIdentity(ProtocolWireModel):
    runtime: RuntimeId
    runtimeVersion: str


class ProtocolHandshakeRequest(ProtocolWireModel):
    protocolVersions: list[str] = Field(min_length=1)
    connectorVersion: str
    runtimes: list[ProtocolRuntimeIdentity] = Field(default_factory=list)


class ProtocolHandshakeResponse(ProtocolWireModel):
    selectedProtocolVersion: ProtocolVersion
    serverVersion: str


class ProtocolCapability(ProtocolWireModel):
    capabilityId: str
    version: str = "1"
    scope: ProtocolCapabilityScope = "runtime"
    runtime: RuntimeId | None = None
    sessionId: str | None = None
    supported: bool = True
    available: bool = True
    allowed: bool = True
    unavailableReason: str | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)


class ProtocolCapabilitySet(ProtocolWireModel):
    revision: int = Field(ge=0, le=PROTOCOL_MAX_REVISION)
    capabilities: list[ProtocolCapability] = Field(default_factory=list)


class ProtocolCapabilitiesResponse(ProtocolWireModel):
    connectorId: str
    capabilitySet: ProtocolCapabilitySet
    serverTime: str


class ProtocolReasoningItem(ProtocolWireModel):
    displayName: str
    id: str
    fullModelId: str | None = None
    selectionId: str
    description: str | None = None
    default: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProtocolModelItem(ProtocolWireModel):
    displayName: str
    id: str
    selectionId: str | None = None
    description: str | None = None
    default: bool = False
    reasoningItems: list[ProtocolReasoningItem] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProtocolModelCatalog(ProtocolWireModel):
    runtime: RuntimeId
    revision: int = Field(ge=0, le=PROTOCOL_MAX_REVISION)
    models: list[ProtocolModelItem] = Field(default_factory=list)


class ProtocolModelCatalogResponse(ProtocolWireModel):
    catalog: ProtocolModelCatalog
    serverTime: str


class ProtocolPermissionItem(ProtocolWireModel):
    displayName: str
    id: str
    selectionId: str
    description: str | None = None
    default: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProtocolPermissionCatalog(ProtocolWireModel):
    runtime: RuntimeId
    revision: int = Field(ge=0, le=PROTOCOL_MAX_REVISION)
    permissions: list[ProtocolPermissionItem] = Field(default_factory=list)


class ProtocolPermissionCatalogResponse(ProtocolWireModel):
    catalog: ProtocolPermissionCatalog
    serverTime: str


class ProtocolTimelineSnapshot(ProtocolWireModel):
    items: list[TimelineItem] = Field(default_factory=list)
    nextSeq: int
    hasMore: bool = False


class ProtocolTimelineResponse(ProtocolWireModel):
    sessionId: str
    items: list[TimelineItem] = Field(default_factory=list)
    nextSeq: int
    hasMore: bool = False
    serverTime: str


class ProtocolSessionSnapshotResponse(ProtocolWireModel):
    session: SessionView
    state: SessionRuntimeState | None = None
    timeline: ProtocolTimelineSnapshot
    approvals: list[Approval] = Field(default_factory=list)
    notices: list[NoticeIn] = Field(default_factory=list)
    effectiveCapabilities: ProtocolCapabilitySet
    runtimeCapabilities: ProtocolCapabilitySet
    catalogs: dict[str, Any] = Field(default_factory=dict)
    eventCursor: str = Field(pattern=r"^seq:(0|[1-9][0-9]*)$")
    serverTime: str


class ProtocolWsTicketScope(ProtocolWireModel):
    sessionId: str | None = None
    dashboard: bool = False

    @model_validator(mode="after")
    def validate_single_scope(self) -> ProtocolWsTicketScope:
        has_session = self.sessionId is not None
        if has_session == self.dashboard:
            raise ValueError("exactly one WebSocket ticket scope is required")
        return self


class ProtocolWsTicketRequest(ProtocolWireModel):
    clientId: str
    scope: ProtocolWsTicketScope


class ProtocolWsTicketResponse(ProtocolWireModel):
    ticket: str
    expiresAt: str
    serverTime: str


class ProtocolEventEnvelope(ProtocolWireModel):
    protocolVersion: ProtocolVersion = PROTOCOL_VERSION_1
    eventId: str = Field(min_length=1)
    sequence: int = Field(ge=0, le=PROTOCOL_MAX_REVISION)
    cursor: str = Field(pattern=r"^seq:(0|[1-9][0-9]*)$")
    type: str = Field(min_length=1)
    sessionId: str = Field(min_length=1)
    emittedAt: str
    payload: dict[str, Any] = Field(default_factory=dict)


class ProtocolEventRecoveryResponse(ProtocolWireModel):
    events: list[ProtocolEventEnvelope] = Field(default_factory=list)
    nextCursor: str = Field(pattern=r"^seq:(0|[1-9][0-9]*)$")
    snapshotRequired: bool = False
    serverTime: str


def protocol_selection_id(runtime: str, catalog_type: str, identity: dict[str, Any]) -> str:
    canonical_identity = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    raw = f"1:{runtime}:{catalog_type}:{canonical_identity}".encode()
    digest = base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode().rstrip("=")
    return f"sel_{catalog_type}_{digest[:24]}"
