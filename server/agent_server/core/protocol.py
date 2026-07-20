from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Literal

from pydantic import BaseModel, Field

from agent_server.core.models import Approval, RuntimeName, SessionView, TimelineItem


PROTOCOL_VERSION_1 = "1.0"
SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION_1]

ProtocolVersion = Literal["1.0"]
ProtocolCapabilityScope = Literal["adapter", "runtime", "session"]


class ProtocolAdapterIdentity(BaseModel):
    runtime: RuntimeName
    adapterVersion: str


class ProtocolHandshakeRequest(BaseModel):
    protocolVersions: list[str] = Field(min_length=1)
    connectorVersion: str
    adapters: list[ProtocolAdapterIdentity] = Field(default_factory=list)


class ProtocolHandshakeResponse(BaseModel):
    selectedProtocolVersion: ProtocolVersion
    serverVersion: str


class ProtocolCapability(BaseModel):
    capabilityId: str
    version: str = "1"
    scope: ProtocolCapabilityScope = "runtime"
    runtime: RuntimeName | None = None
    sessionId: str | None = None
    supported: bool = True
    available: bool = True
    allowed: bool = True
    unavailableReason: str | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)


class ProtocolCapabilitySet(BaseModel):
    revision: int = Field(ge=0)
    capabilities: list[ProtocolCapability] = Field(default_factory=list)


class ProtocolCapabilitiesResponse(BaseModel):
    connectorId: str
    capabilitySet: ProtocolCapabilitySet
    serverTime: str


class ProtocolReasoningItem(BaseModel):
    displayName: str
    id: str
    fullModelId: str | None = None
    selectionId: str
    description: str | None = None
    default: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProtocolModelItem(BaseModel):
    displayName: str
    id: str
    selectionId: str | None = None
    description: str | None = None
    default: bool = False
    reasoningItems: list[ProtocolReasoningItem] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProtocolModelCatalog(BaseModel):
    runtime: RuntimeName
    revision: int = Field(ge=0)
    models: list[ProtocolModelItem] = Field(default_factory=list)


class ProtocolModelCatalogResponse(BaseModel):
    catalog: ProtocolModelCatalog
    serverTime: str


class ProtocolPermissionItem(BaseModel):
    displayName: str
    id: str
    selectionId: str
    description: str | None = None
    default: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProtocolPermissionCatalog(BaseModel):
    runtime: RuntimeName
    revision: int = Field(ge=0)
    permissions: list[ProtocolPermissionItem] = Field(default_factory=list)


class ProtocolPermissionCatalogResponse(BaseModel):
    catalog: ProtocolPermissionCatalog
    serverTime: str


class ProtocolTimelineSnapshot(BaseModel):
    items: list[TimelineItem] = Field(default_factory=list)
    nextSeq: int
    hasMore: bool = False


class ProtocolSessionSnapshotResponse(BaseModel):
    session: SessionView
    timeline: ProtocolTimelineSnapshot
    approvals: list[Approval] = Field(default_factory=list)
    effectiveCapabilities: ProtocolCapabilitySet
    runtimeCapabilities: ProtocolCapabilitySet
    catalogs: dict[str, Any] = Field(default_factory=dict)
    eventCursor: str
    serverTime: str


def protocol_selection_id(runtime: str, catalog_type: str, identity: dict[str, Any]) -> str:
    canonical_identity = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    raw = f"1:{runtime}:{catalog_type}:{canonical_identity}".encode()
    digest = base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode().rstrip("=")
    return f"sel_{catalog_type}_{digest[:24]}"
