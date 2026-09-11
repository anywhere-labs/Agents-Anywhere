"""Guard session ingress without extending the Connector wire protocol."""

from __future__ import annotations

from typing import Any


def notification_runtime_id(params: dict[str, Any]) -> str | None:
    metadata = params.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    value = (
        params.get("runtimeId") or metadata.get("runtimeId") or params.get("runtime")
    )
    return value if isinstance(value, str) and value else None


def runtime_notification_is_allowed(
    method: str, params: dict[str, Any], unconfigured_runtimes: set[str]
) -> bool:
    """Block session writes until the runtime is configured, using the old protocol.

    This cannot distinguish delayed HTTP messages after reconfiguration. Local
    WebSocket queues separately invalidate work accepted before deletion.
    """
    if not method.startswith(("session.", "timeline.")):
        return True
    runtime_id = notification_runtime_id(params)
    if runtime_id is None:
        return not unconfigured_runtimes
    return runtime_id not in unconfigured_runtimes
