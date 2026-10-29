from __future__ import annotations

from typing import Any

from ...domain.definitions import AcpError


def wire(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True, exclude_none=True)
    if isinstance(value, dict):
        return {key: wire(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [wire(item) for item in value]
    return value


def require_version(response: dict) -> None:
    if response.get("protocolVersion") != 1:
        raise AcpError("unsupported_acp_version", "该入口只启用了 ACP v1。")


def completed_prompt(response: dict) -> dict:
    return {
        "accepted": True,
        "evidence": "v1_prompt_completed",
        "stopReason": response["stopReason"],
    }
