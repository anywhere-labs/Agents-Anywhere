from __future__ import annotations

import os
from typing import Any

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


def codex_config_schema() -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "environment": {
                "type": "object",
                "title": "Environment variables",
                "description": "Environment overrides for the Codex SDK runtime.",
                "propertyNames": {"pattern": "^[^=\\u0000]+$"},
                "additionalProperties": {
                    "anyOf": [{"type": "string"}, {"type": "null"}],
                },
                "default": {},
            },
        },
        "additionalProperties": False,
    }


def codex_capabilities() -> dict[str, bool]:
    return {
        "modelCatalog": True,
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
        "attachments": False,
        "ipc": False,
    }


def merge_environment(raw: Any) -> dict[str, str]:
    if raw is None:
        overrides: dict[str, Any] = {}
    elif isinstance(raw, dict):
        overrides = raw
    else:
        raise RuntimeInvalidRequestError("environment must be an object")

    environment = dict(os.environ)
    for key, value in overrides.items():
        if not isinstance(key, str) or not key or "=" in key or "\x00" in key:
            raise RuntimeInvalidRequestError(
                "environment contains an invalid variable name"
            )
        if key in PROTECTED_ENV_NAMES or key.startswith(PROTECTED_ENV_PREFIXES):
            raise RuntimeInvalidRequestError(
                f"environment variable {key!r} is managed by the connector"
            )
        if value is None:
            environment.pop(key, None)
            continue
        if not isinstance(value, str) or "\x00" in value:
            raise RuntimeInvalidRequestError(
                f"environment variable {key!r} must be a string or null"
            )
        environment[key] = value
    return environment
