from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel


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
