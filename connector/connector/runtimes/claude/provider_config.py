from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from connector.launch import LaunchTarget
from connector.runtime_protocol import RuntimeInvalidRequestError

PROTECTED_ENV_PREFIXES = ("AGENT_CONNECTOR_", "AGENT_SERVER_")
PROTECTED_ENV_NAMES = {
    "AGENT_CONNECTOR_ID",
    "AGENT_CONNECTOR_TOKEN",
    "AGENT_CONNECTOR_CONFIG",
    "AGENT_CONNECTOR_DATA_DIR",
    "AGENT_CONNECTOR_STATE_FILE",
    "AGENT_SERVER_URL",
}


def claude_config_schema(target: LaunchTarget | None) -> dict[str, Any]:
    executable: dict[str, Any] = {
        "type": "string",
        "minLength": 1,
        "title": "Claude executable path",
        "description": "Optional path to the Claude Code CLI used by claude-agent-sdk.",
    }
    if target is not None:
        executable["default"] = target.path
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "executablePath": executable,
            "environment": {
                "type": "object",
                "title": "Environment variables",
                "description": "Override inherited variables with strings, or remove them with null.",
                "propertyNames": {"pattern": "^[^=\\u0000]+$"},
                "additionalProperties": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                },
                "default": {},
            },
        },
        "additionalProperties": False,
    }


def claude_capabilities() -> dict[str, bool]:
    return {
        "modelCatalog": False,
        "permissionCatalog": True,
        "sessionDiscovery": True,
        "sessionSnapshot": True,
        "sessionState": True,
        "sessionNotices": True,
        "createAndStartSession": True,
        "startTurn": True,
        "steerTurn": True,
        "interruptTurn": True,
        "commands": False,
        "interactions": True,
        "attachments": True,
        "ipc": False,
    }


def merge_environment(raw: Any) -> dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise RuntimeInvalidRequestError("environment must be an object")
    environment: dict[str, str] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not key:
            raise RuntimeInvalidRequestError("environment keys must be non-empty strings")
        if key in PROTECTED_ENV_NAMES or any(
            key.startswith(prefix) for prefix in PROTECTED_ENV_PREFIXES
        ):
            raise RuntimeInvalidRequestError(
                f"environment variable {key} is managed by the connector"
            )
        if value is None:
            continue
        if not isinstance(value, str):
            raise RuntimeInvalidRequestError(
                f"environment variable {key} must be a string or null"
            )
        environment[key] = value
    return environment
