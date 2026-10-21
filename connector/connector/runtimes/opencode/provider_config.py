from __future__ import annotations

from typing import Any

from connector.runtime_protocol import RuntimeInvalidRequestError

DEFAULT_SERVER_URL = "http://127.0.0.1:4096"
DEFAULT_REQUEST_TIMEOUT_S = 60.0
DEFAULT_STREAM_TIMEOUT_S = 300.0
DEFAULT_AUTO_START = True


def opencode_config_schema() -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "serverUrl": {
                "type": "string",
                "minLength": 1,
                "pattern": "^https?://",
                "title": "OpenCode serve URL",
                "description": "Base URL of a local `opencode serve` instance (REST + SSE).",
                "default": DEFAULT_SERVER_URL,
            },
            "apiKey": {
                "type": "string",
                "title": "Server password",
                "description": (
                    "Password for the serve instance's HTTP Basic auth. Required "
                    "by opencode 2.x, which protects every /api route. Only "
                    "needed for a serve the connector did not start; an "
                    "auto-started serve inherits OPENCODE_SERVER_PASSWORD from "
                    "the environment, or gets a generated password."
                ),
            },
            "apiUser": {
                "type": "string",
                "title": "Basic auth username",
                "description": "Username paired with the server password (default: opencode).",
                "default": "opencode",
            },
            "requestTimeoutSeconds": {
                "type": "number",
                "minimum": 1,
                "maximum": 600,
                "default": DEFAULT_REQUEST_TIMEOUT_S,
                "title": "Request timeout (s)",
            },
            "autoStart": {
                "type": "boolean",
                "default": DEFAULT_AUTO_START,
                "title": "Auto-start local serve",
                "description": (
                    "Start a local `opencode serve` child process when the "
                    "configured serverUrl (loopback only) is unreachable."
                ),
            },
        },
        "additionalProperties": False,
    }


def default_config_values() -> dict[str, Any]:
    return {
        "serverUrl": DEFAULT_SERVER_URL,
        "requestTimeoutSeconds": DEFAULT_REQUEST_TIMEOUT_S,
        "autoStart": DEFAULT_AUTO_START,
    }


def normalized_config_values(raw: dict[str, Any]) -> dict[str, Any]:
    values = {**default_config_values(), **raw}
    url = values.get("serverUrl")
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        raise RuntimeInvalidRequestError("serverUrl must be an http(s) URL")
    values["serverUrl"] = url.rstrip("/")
    timeout = values.get("requestTimeoutSeconds")
    if not isinstance(timeout, (int, float)) or isinstance(timeout, bool) or not 1 <= timeout <= 600:
        raise RuntimeInvalidRequestError("requestTimeoutSeconds must be a number between 1 and 600")
    values["requestTimeoutSeconds"] = float(timeout)
    key = values.get("apiKey")
    if key is not None and not isinstance(key, str):
        raise RuntimeInvalidRequestError("apiKey must be a string")
    if not key:
        values.pop("apiKey", None)
    user = values.get("apiUser")
    if user is not None and not isinstance(user, str):
        raise RuntimeInvalidRequestError("apiUser must be a string")
    if not user:
        values.pop("apiUser", None)
    auto = values.get("autoStart", DEFAULT_AUTO_START)
    if isinstance(auto, str):
        auto = auto.strip().lower() in ("1", "true", "yes", "on")
    values["autoStart"] = bool(auto)
    return values


def opencode_capabilities() -> dict[str, bool]:
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
        "attachments": True,
        "ipc": True,
    }
