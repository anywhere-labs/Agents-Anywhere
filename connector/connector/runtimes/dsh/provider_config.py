from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from connector.runtime_protocol import RuntimeInvalidRequestError

DEFAULT_STARTUP_TIMEOUT_MS = 30_000
DEFAULT_REQUEST_TIMEOUT_MS = 60_000
DEFAULT_MAX_RESTART_ATTEMPTS = 3
DEFAULT_RESTART_BACKOFF_MS = 1_000


def dsh_config_schema() -> dict[str, Any]:
    positive_timeout = {"type": "integer", "minimum": 100, "maximum": 600_000}
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "dshHome": {
                "type": "string",
                "minLength": 1,
                "title": "DSH home",
                "description": "Optional absolute DSH_HOME used by the running DSH Web process.",
            },
            "startupTimeoutMs": {
                **positive_timeout,
                "default": DEFAULT_STARTUP_TIMEOUT_MS,
            },
            "requestTimeoutMs": {
                **positive_timeout,
                "default": DEFAULT_REQUEST_TIMEOUT_MS,
            },
            "maxRestartAttempts": {
                "type": "integer",
                "minimum": 0,
                "maximum": 10,
                "default": DEFAULT_MAX_RESTART_ATTEMPTS,
            },
            "restartBackoffMs": {
                **positive_timeout,
                "default": DEFAULT_RESTART_BACKOFF_MS,
            },
        },
        "additionalProperties": False,
    }


def default_config_values() -> dict[str, Any]:
    return {
        "startupTimeoutMs": DEFAULT_STARTUP_TIMEOUT_MS,
        "requestTimeoutMs": DEFAULT_REQUEST_TIMEOUT_MS,
        "maxRestartAttempts": DEFAULT_MAX_RESTART_ATTEMPTS,
        "restartBackoffMs": DEFAULT_RESTART_BACKOFF_MS,
    }


def normalized_config_values(raw: dict[str, Any]) -> dict[str, Any]:
    values = {**default_config_values(), **raw}
    dsh_home = values.get("dshHome")
    if dsh_home is not None:
        if (
            not isinstance(dsh_home, str)
            or not Path(dsh_home).expanduser().is_absolute()
        ):
            raise RuntimeInvalidRequestError("dshHome must be an absolute path")
        values["dshHome"] = canonical_path(dsh_home)
    for key in ("startupTimeoutMs", "requestTimeoutMs", "restartBackoffMs"):
        value = values.get(key)
        if (
            not isinstance(value, int)
            or isinstance(value, bool)
            or not 100 <= value <= 600_000
        ):
            raise RuntimeInvalidRequestError(
                f"{key} must be an integer between 100 and 600000"
            )
    attempts = values.get("maxRestartAttempts")
    if (
        not isinstance(attempts, int)
        or isinstance(attempts, bool)
        or not 0 <= attempts <= 10
    ):
        raise RuntimeInvalidRequestError(
            "maxRestartAttempts must be an integer between 0 and 10"
        )
    return values


def dsh_home(values: dict[str, Any]) -> Path:
    configured = values.get("dshHome")
    path = Path(configured) if isinstance(configured, str) else Path.home() / ".dsh"
    return Path(canonical_path(path))


def endpoint_path(values: dict[str, Any]) -> Path:
    return Path(
        canonical_path(
            dsh_home(values) / "agents-anywhere" / "bridge" / "endpoint.json"
        )
    )


def canonical_path(path: str | Path) -> str:
    return os.path.normcase(str(Path(path).expanduser().resolve(strict=False)))


def dsh_capabilities() -> dict[str, bool]:
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
        "commands": True,
        "interactions": True,
        "attachments": False,
        "ipc": True,
    }
