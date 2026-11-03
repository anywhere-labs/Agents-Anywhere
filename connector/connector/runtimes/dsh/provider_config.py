from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from connector.core import runtime_owner
from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtime_protocol.filesystem import canonical_path
from connector.runtime_protocol.model_connection import (
    ModelConnectionCapability,
    ModelConnectionUnsupportedError,
)
from connector.runtimes.custom_models import custom_models_schema, normalize_custom_models
from connector.runtimes.model_gateway import model_gateway_from_config, model_gateway_schema

DEFAULT_STARTUP_TIMEOUT_MS = 30_000
DEFAULT_REQUEST_TIMEOUT_MS = 60_000
DEFAULT_MAX_RESTART_ATTEMPTS = 3
DEFAULT_RESTART_BACKOFF_MS = 1_000
MODEL_PROTOCOLS = ("openai_chat", "anthropic", "openai_responses")

# The plugin writes the connection into DSH's own provider settings, which
# every DSH session reads on its next request.
MODEL_CONNECTION = ModelConnectionCapability(
    maturity="experimental",
    protocols=MODEL_PROTOCOLS,
    scope="native_global",
    apply="immediate",
    catalog_auto=False,
    catalog_manual=True,
    catalog_required=True,
)


def dsh_config_schema() -> dict[str, Any]:
    positive_timeout = {"type": "integer", "minimum": 100, "maximum": 600_000}
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "defaultAgentPreset": {
                "type": "string", "minLength": 1, "maxLength": 256,
                "title": "新会话默认模式",
                "description": "仅用于以后创建的会话，已有会话保持原模式。",
            },
            "dshHome": {
                "type": "string",
                "minLength": 1,
                "title": "DSH home",
                "description": "Optional absolute DSH_HOME of the DSH host; it identifies its sessions. The bridge endpoint is always read from ~/.agents-anywhere/dsh-bridge.",
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
                "description": "Fast reconnect attempts before polling the local Bridge every 5 seconds.",
            },
            "restartBackoffMs": {
                **positive_timeout,
                "default": DEFAULT_RESTART_BACKOFF_MS,
            },
            "modelGateway": model_gateway_schema(MODEL_PROTOCOLS),
            "customModels": custom_models_schema(),
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
    if "defaultAgentPreset" in values and (
        not isinstance(values["defaultAgentPreset"], str)
        or not 1 <= len(values["defaultAgentPreset"]) <= 256
    ):
        raise RuntimeInvalidRequestError("defaultAgentPreset must be a non-empty mode ID")
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
    gateway = model_gateway_from_config(values.get("modelGateway"), protocols=MODEL_PROTOCOLS)
    if gateway is None:
        values.pop("modelGateway", None)
    else:
        values["modelGateway"] = gateway.to_config_values()
    if "customModels" in values:
        values["customModels"] = normalize_custom_models(values["customModels"])
    if gateway is not None and not values.get("customModels"):
        # DSH only serves a declared gateway route with its models listed.
        raise ModelConnectionUnsupportedError("DSH needs at least one model for a model gateway")
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
    path = (
        Path(configured)
        if isinstance(configured, str)
        else Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh")
    )
    return Path(canonical_path(path))


def bridge_directory() -> Path:
    """Fixed per-user rendezvous shared with the plugin; DSH_HOME does not move it."""
    return Path(canonical_path(runtime_owner.system_home() / ".agents-anywhere" / "dsh-bridge"))


def endpoint_path() -> Path:
    """Where this Connector publishes its Router for the plugin (the 2.0 rendezvous)."""
    return bridge_directory() / "connector.json"


def legacy_endpoint_path(values: dict[str, Any]) -> Path:
    """Endpoint location of 1.x plugins under DSH_HOME, kept only as the session identity."""
    return Path(
        canonical_path(
            dsh_home(values) / "agents-anywhere" / "bridge" / "endpoint.json"
        )
    )


def dsh_capabilities(reported: dict[str, Any] | None = None) -> dict[str, bool]:
    enabled = {
        row.get("capabilityId") for row in (reported or {}).get("capabilities", [])
        if isinstance(row, dict) and row.get("supported") and row.get("available") and row.get("allowed")
    }
    return {
        "modelCatalog": "catalog.model" in enabled,
        "permissionCatalog": "catalog.permission" in enabled,
        "sessionDiscovery": True,
        "sessionSnapshot": True,
        "sessionState": True,
        "sessionNotices": False,
        "createAndStartSession": "session.send_message" in enabled,
        "startTurn": "session.send_message" in enabled,
        "steerTurn": False,
        "interruptTurn": "session.interrupt" in enabled,
        "commands": "session.commands" in enabled,
        "interactions": False,
        "attachments": "runtime.attachment" in enabled,
        "ipc": True,
    }
