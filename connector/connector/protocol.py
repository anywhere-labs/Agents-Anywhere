from __future__ import annotations

import base64
import hashlib
import json
from typing import Any, Literal

from pydantic import BaseModel, Field


PROTOCOL_VERSION_1 = "1.0"
SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION_1]

ProtocolVersion = Literal["1.0"]
RuntimeName = Literal["codex", "claude", "opencode", "acp"]
ProtocolCapabilityScope = Literal["adapter", "runtime", "session"]


class RpcRequest(BaseModel):
    id: str
    type: Literal["request"] = "request"
    method: str
    params: Any = None


class RpcResponse(BaseModel):
    id: str
    type: Literal["response"] = "response"
    ok: bool
    result: Any = None
    error: dict[str, str] | None = None


class RpcNotification(BaseModel):
    type: Literal["notification"] = "notification"
    method: str
    params: Any = None


class ProtocolAdapterIdentity(BaseModel):
    runtime: RuntimeName
    adapterVersion: str


class ProtocolHandshakeRequest(BaseModel):
    protocolVersions: list[str] = Field(min_length=1)
    connectorVersion: str
    adapters: list[ProtocolAdapterIdentity] = Field(default_factory=list)


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


def protocol_selection_id(runtime: str, catalog_type: str, identity: dict[str, Any]) -> str:
    canonical_identity = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    raw = f"1:{runtime}:{catalog_type}:{canonical_identity}".encode()
    digest = base64.urlsafe_b64encode(hashlib.sha256(raw).digest()).decode().rstrip("=")
    return f"sel_{catalog_type}_{digest[:24]}"
