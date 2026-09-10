from __future__ import annotations

from typing import Any

from connector.core.config import ConnectorConfig


def default_config_payload() -> dict[str, Any]:
    return {
        "serverUrl": "",
        "connectorId": "",
        "connectorToken": "",
        "heartbeatSeconds": 20,
        "reconnectSeconds": 3,
        "syncExistingOnConnect": True,
        "syncIntervalSeconds": 30,
        "statePath": None,
    }


def config_to_payload(config: ConnectorConfig) -> dict[str, Any]:
    return {
        "serverUrl": config.server_url,
        "connectorId": config.connector_id,
        "connectorToken": config.connector_token,
        "heartbeatSeconds": config.heartbeat_seconds,
        "reconnectSeconds": config.reconnect_seconds,
        "syncExistingOnConnect": config.sync_existing_on_connect,
        "syncIntervalSeconds": config.sync_interval_seconds,
        "statePath": config.state_path,
    }


def config_from_params(params: Any) -> ConnectorConfig:
    if not isinstance(params, dict):
        raise ValueError("config params must be an object")
    server_url = str(params.get("serverUrl") or "").strip().rstrip("/")
    connector_id = str(params.get("connectorId") or "").strip()
    connector_token = str(params.get("connectorToken") or "").strip()
    if not server_url or not connector_id or not connector_token:
        raise ValueError("serverUrl, connectorId, and connectorToken are required")
    return ConnectorConfig(
        server_url=server_url,
        connector_id=connector_id,
        connector_token=connector_token,
        heartbeat_seconds=float(params.get("heartbeatSeconds", 20)),
        reconnect_seconds=float(params.get("reconnectSeconds", 3)),
        sync_existing_on_connect=bool(params.get("syncExistingOnConnect", True)),
        sync_interval_seconds=float(params.get("syncIntervalSeconds", 30)),
        state_path=(
            params.get("statePath")
            if isinstance(params.get("statePath"), str)
            else None
        ),
    )


def str_param(params: Any, key: str) -> str | None:
    if not isinstance(params, dict):
        return None
    value = params.get(key)
    return value if isinstance(value, str) and value.strip() else None


def float_param(params: Any, key: str, default: float) -> float:
    if not isinstance(params, dict):
        return default
    try:
        return float(params.get(key, default))
    except (TypeError, ValueError):
        return default
