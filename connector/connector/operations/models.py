from __future__ import annotations

import hashlib
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class OperationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operationId: str = Field(min_length=1, max_length=128)
    type: Literal["workspace.create"] = "workspace.create"
    server: str = Field(min_length=1, max_length=512)
    userId: str = Field(min_length=1, max_length=128)
    connectorId: str = Field(min_length=1, max_length=128)
    runtimeId: str = Field(min_length=1, max_length=128)
    runtime: str = Field(min_length=1, max_length=64)
    configRevision: int = Field(ge=0)
    name: str = Field(min_length=1, max_length=512)
    path: str = Field(min_length=1, max_length=8192)

    def fingerprint(self) -> str:
        data = json.dumps(
            self.model_dump(), sort_keys=True, ensure_ascii=True, separators=(",", ":")
        )
        return hashlib.sha256(data.encode()).hexdigest()


class ProtocolInfo(BaseModel):
    protocolVersion: Literal["1.0"] = "1.0"


class OperationResult(BaseModel):
    nativeProjectId: str = Field(min_length=1)
    name: str = ""
    roots: list[str] = Field(default_factory=list)
    identityKind: str = "native"


class OperationRecord(BaseModel):
    request: OperationRequest
    status: Literal[
        "queued", "accepted", "running", "reconciling", "succeeded", "failed", "unknown"
    ]
    result: OperationResult | None = None
    message: str | None = None
    resultReceived: bool = False

    @model_validator(mode="after")
    def successful_result_required(self) -> OperationRecord:
        if self.status == "succeeded" and self.result is None:
            raise ValueError("Successful operations require a native result")
        return self
