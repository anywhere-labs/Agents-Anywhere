"""Fence notifications from runtime instances whose configuration was deleted."""

from __future__ import annotations

from typing import Any


def notification_runtime_id(params: dict[str, Any]) -> str | None:
    metadata = params.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    value = (
        params.get("runtimeId") or metadata.get("runtimeId") or params.get("runtime")
    )
    return value if isinstance(value, str) and value else None


def notification_runtime_epoch(params: dict[str, Any]) -> int:
    metadata = params.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    value = params.get("runtimeEpoch", metadata.get("runtimeEpoch", 0))
    return value if type(value) is int and value >= 0 else -1


def runtime_notification_is_current(
    params: dict[str, Any], epochs: dict[str, int]
) -> bool:
    runtime_id = notification_runtime_id(params)
    if runtime_id is None:
        # Connector-level control/presence notifications have no runtime binding.
        return not (isinstance(params.get("sessionId"), str) and any(epochs.values()))
    return notification_runtime_epoch(params) == epochs.get(runtime_id, 0)
