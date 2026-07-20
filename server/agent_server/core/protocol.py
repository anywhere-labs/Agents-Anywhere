from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

from agent_server.core.models import RuntimeName


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
