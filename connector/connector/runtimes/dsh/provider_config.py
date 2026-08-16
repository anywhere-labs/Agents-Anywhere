from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtimes.codex.sdk.binary import read_login_shell_path

DEFAULT_PROFILE = "aa"
DEFAULT_STARTUP_TIMEOUT_MS = 30_000
DEFAULT_REQUEST_TIMEOUT_MS = 60_000
DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000
DEFAULT_KILL_GRACE_MS = 5_000
DEFAULT_MAX_RESTART_ATTEMPTS = 3
DEFAULT_RESTART_BACKOFF_MS = 1_000

PROTECTED_ENV_NAMES = {
    "AGENT_CONNECTOR_ID",
    "AGENT_CONNECTOR_TOKEN",
    "AGENT_CONNECTOR_CONFIG",
    "AGENT_CONNECTOR_DATA_DIR",
    "AGENT_CONNECTOR_STATE_FILE",
    "AGENT_SERVER_URL",
    "DSH_HOME",
}
PROTECTED_ENV_PREFIXES = ("AGENT_CONNECTOR_", "AGENT_SERVER_")


def dsh_config_schema() -> dict[str, Any]:
    positive_timeout = {"type": "integer", "minimum": 100, "maximum": 600_000}
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "executablePath": {
                "type": "string",
                "minLength": 1,
                "title": "DSH executable path",
                "description": "Optional absolute path to the dsh executable.",
            },
            "profile": {
                "type": "string",
                "minLength": 1,
                "pattern": r"^[^/\\]+$",
                "default": DEFAULT_PROFILE,
                "title": "DSH profile",
            },
            "dshHome": {
                "type": "string",
                "minLength": 1,
                "title": "DSH home",
                "description": "Optional absolute DSH_HOME used only by the bridge child process.",
            },
            "environment": {
                "type": "object",
                "propertyNames": {"pattern": "^[^=\\u0000]+$"},
                "additionalProperties": {"type": "string"},
                "default": {},
                "title": "Environment overrides",
            },
            "startupTimeoutMs": {**positive_timeout, "default": DEFAULT_STARTUP_TIMEOUT_MS},
            "requestTimeoutMs": {**positive_timeout, "default": DEFAULT_REQUEST_TIMEOUT_MS},
            "shutdownTimeoutMs": {**positive_timeout, "default": DEFAULT_SHUTDOWN_TIMEOUT_MS},
            "killGraceMs": {**positive_timeout, "default": DEFAULT_KILL_GRACE_MS},
            "maxRestartAttempts": {
                "type": "integer",
                "minimum": 0,
                "maximum": 10,
                "default": DEFAULT_MAX_RESTART_ATTEMPTS,
            },
            "restartBackoffMs": {**positive_timeout, "default": DEFAULT_RESTART_BACKOFF_MS},
        },
        "additionalProperties": False,
    }


def default_config_values() -> dict[str, Any]:
    return {
        "profile": DEFAULT_PROFILE,
        "environment": {},
        "startupTimeoutMs": DEFAULT_STARTUP_TIMEOUT_MS,
        "requestTimeoutMs": DEFAULT_REQUEST_TIMEOUT_MS,
        "shutdownTimeoutMs": DEFAULT_SHUTDOWN_TIMEOUT_MS,
        "killGraceMs": DEFAULT_KILL_GRACE_MS,
        "maxRestartAttempts": DEFAULT_MAX_RESTART_ATTEMPTS,
        "restartBackoffMs": DEFAULT_RESTART_BACKOFF_MS,
    }


def normalized_config_values(raw: dict[str, Any]) -> dict[str, Any]:
    values = {**default_config_values(), **raw}
    profile = values.get("profile")
    if not isinstance(profile, str) or not profile or "/" in profile or "\\" in profile:
        raise RuntimeInvalidRequestError("dsh profile must be a non-empty name without path separators")
    dsh_home = values.get("dshHome")
    if dsh_home is not None:
        if not isinstance(dsh_home, str) or not Path(dsh_home).expanduser().is_absolute():
            raise RuntimeInvalidRequestError("dshHome must be an absolute path")
        values["dshHome"] = str(Path(dsh_home).expanduser())
    executable = values.get("executablePath")
    if executable is not None:
        if not isinstance(executable, str) or not Path(executable).expanduser().is_absolute():
            raise RuntimeInvalidRequestError("executablePath must be an absolute path")
        values["executablePath"] = str(Path(executable).expanduser())
    environment = values.get("environment")
    if not isinstance(environment, dict):
        raise RuntimeInvalidRequestError("environment must be an object")
    for key, value in environment.items():
        if not isinstance(key, str) or not key or "=" in key or "\x00" in key:
            raise RuntimeInvalidRequestError("environment contains an invalid variable name")
        if key in PROTECTED_ENV_NAMES or key.startswith(PROTECTED_ENV_PREFIXES):
            raise RuntimeInvalidRequestError(f"environment variable {key!r} is managed by the connector")
        if not isinstance(value, str) or "\x00" in value:
            raise RuntimeInvalidRequestError(f"environment variable {key!r} must be a string")
    for key in (
        "startupTimeoutMs",
        "requestTimeoutMs",
        "shutdownTimeoutMs",
        "killGraceMs",
        "restartBackoffMs",
    ):
        value = values.get(key)
        if not isinstance(value, int) or isinstance(value, bool) or not 100 <= value <= 600_000:
            raise RuntimeInvalidRequestError(f"{key} must be an integer between 100 and 600000")
    attempts = values.get("maxRestartAttempts")
    if not isinstance(attempts, int) or isinstance(attempts, bool) or not 0 <= attempts <= 10:
        raise RuntimeInvalidRequestError("maxRestartAttempts must be an integer between 0 and 10")
    return values


def child_environment(values: dict[str, Any]) -> dict[str, str]:
    environment = dict(os.environ)
    shell_path = read_login_shell_path()
    if shell_path.path is not None:
        environment["PATH"] = shell_path.path
    environment.update(values.get("environment") or {})
    dsh_home = values.get("dshHome")
    if isinstance(dsh_home, str):
        environment["DSH_HOME"] = dsh_home
    return environment


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
