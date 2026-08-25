from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtime_protocol.filesystem import canonical_path
from connector.runtimes.codex.sdk.binary import CodexRuntimeBinaryMode
from connector.runtimes.custom_models import custom_models_schema
from connector.runtimes.model_gateway import model_gateway_schema

PROTECTED_ENV_PREFIXES = ("AGENT_CONNECTOR_", "AGENT_SERVER_")
PROTECTED_ENV_NAMES = {
    "AGENT_CONNECTOR_ID",
    "AGENT_CONNECTOR_TOKEN",
    "AGENT_CONNECTOR_CONFIG",
    "AGENT_CONNECTOR_DATA_DIR",
    "AGENT_CONNECTOR_STATE_FILE",
    "AGENT_SERVER_URL",
    "CODEX_HOME",
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
            "useSystemCodex": {
                "type": "boolean",
                "title": "Use System Codex",
                "description": (
                    "Use the Codex executable found in the user's login shell PATH. "
                    "If it is unavailable, fall back to the bundled Codex executable. "
                    "Turn this off to always use the bundled Codex executable."
                ),
                "metadata": {
                    "i18n": {
                        "labelKey": (
                            "dashboard.device.runtimeConfigFields.useSystemCodex.label"
                        ),
                        "descriptionKey": (
                            "dashboard.device.runtimeConfigFields."
                            "useSystemCodex.description"
                        ),
                    }
                },
                "default": True,
            },
            "codexExecutablePath": {
                "type": "string",
                "title": "Codex executable path",
                "description": (
                    "Optional path to a Codex executable. When set, this executable "
                    "is always used and the Use System Codex setting is ignored. "
                    "Leave this empty to use the automatic binary selection."
                ),
                "metadata": {
                    "i18n": {
                        "labelKey": (
                            "dashboard.device.runtimeConfigFields."
                            "codexExecutablePath.label"
                        ),
                        "descriptionKey": (
                            "dashboard.device.runtimeConfigFields."
                            "codexExecutablePath.description"
                        ),
                    }
                },
            },
            "codexHome": {
                "type": "string",
                "title": "Codex Home",
                "description": (
                    "Directory used by this Codex instance for configuration, "
                    "credentials, and session history. Two running instances "
                    "cannot use the same directory."
                ),
            },
            "modelGateway": model_gateway_schema(),
            "customModels": custom_models_schema(),
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
        "attachments": True,
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


def runtime_binary_mode_for_system_preference(
    use_system_codex: bool,
) -> CodexRuntimeBinaryMode:
    return "prefer_system" if use_system_codex else "sdk_bundled"


def normalize_system_codex_preference(
    use_system_codex: Any,
) -> bool:
    if isinstance(use_system_codex, bool):
        return use_system_codex
    if use_system_codex is None:
        return True
    raise RuntimeInvalidRequestError("useSystemCodex must be a boolean")


def normalize_codex_executable_path(raw: Any) -> str | None:
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise RuntimeInvalidRequestError("codexExecutablePath must be a string")
    path = raw.strip()
    if not path:
        return None
    return os.path.expandvars(str(Path(path).expanduser()))


def validate_codex_executable_path(path: str | None) -> None:
    if path is None:
        return
    candidate = Path(path)
    if not candidate.is_file() or not os.access(candidate, os.X_OK):
        raise RuntimeInvalidRequestError(
            "codexExecutablePath must point to an executable file"
        )


def normalize_codex_home(raw: Any) -> str | None:
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise RuntimeInvalidRequestError("codexHome must be a string")
    value = raw.strip()
    if not value:
        return None
    if "\x00" in value or "\r" in value or "\n" in value:
        raise RuntimeInvalidRequestError("codexHome contains unsupported characters")
    expanded = os.path.expandvars(str(Path(value).expanduser()))
    return canonical_path(expanded)


def effective_codex_home(configured_home: str | None) -> str:
    if configured_home is not None:
        return configured_home
    environment_home = normalize_codex_home(os.environ.get("CODEX_HOME"))
    if environment_home is not None:
        return environment_home
    return canonical_path(Path.home() / ".codex")


def validate_codex_home(path: str) -> None:
    candidate = Path(path)
    if candidate.exists() and not candidate.is_dir():
        raise RuntimeInvalidRequestError(
            "codexHome must point to a directory or a path that can be created"
        )
