from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtime_protocol.filesystem import canonical_path

DEFAULT_STARTUP_TIMEOUT_MS = 30_000
DEFAULT_REQUEST_TIMEOUT_MS = 60_000
DEFAULT_MAX_RESTART_ATTEMPTS = 3
DEFAULT_RESTART_BACKOFF_MS = 1_000

# rev3 ruling 2: partial session discovery rides this capability row's
# metadata (``discoveryState`` in {"complete","partial"}), never the boolean
# supported/available/allowed channel that AA gates on.
CAPABILITY_SESSION_DISCOVERY = "session.discovery"


def opencode_config_schema() -> dict[str, Any]:
    positive_timeout = {"type": "integer", "minimum": 100, "maximum": 600_000}
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "stateDir": {
                "type": "string",
                "minLength": 1,
                "title": "OpenCode state directory",
                "description": "OpenCode's XDG state home; the registration is read at `<stateDir>/opencode/service.json`. Defaults to `$XDG_STATE_HOME` (or `~/.local/state`). Pointing this at the directory that holds `service.json` directly is also accepted.",
            },
            "servicePid": {
                "type": "integer",
                "minimum": 1,
                "title": "OpenCode service PID",
                "description": "Optional pin: refuse to attach unless the registered service reports this pid. One runtime instance binds each (servicePid, location) pair.",
            },
            "location": {
                "type": "string",
                "minLength": 1,
                "title": "OpenCode location",
                "description": "Absolute project location served by this instance; scopes the session inventory.",
            },
            "startupTimeoutMs": {**positive_timeout, "default": DEFAULT_STARTUP_TIMEOUT_MS},
            "requestTimeoutMs": {**positive_timeout, "default": DEFAULT_REQUEST_TIMEOUT_MS},
            "maxRestartAttempts": {
                "type": "integer",
                "minimum": 0,
                "maximum": 10,
                "default": DEFAULT_MAX_RESTART_ATTEMPTS,
                "description": "Attach attempts before the runtime stops retrying.",
            },
            "restartBackoffMs": {**positive_timeout, "default": DEFAULT_RESTART_BACKOFF_MS},
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
    state_dir = values.get("stateDir")
    if state_dir is not None:
        if (
            not isinstance(state_dir, str)
            or not Path(state_dir).expanduser().is_absolute()
        ):
            raise RuntimeInvalidRequestError("stateDir must be an absolute path")
        values["stateDir"] = canonical_path(state_dir)
    pid = values.get("servicePid")
    if pid is not None and (
        not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0
    ):
        raise RuntimeInvalidRequestError("servicePid must be a positive integer")
    location = values.get("location")
    if location is not None:
        if not isinstance(location, str) or not location:
            raise RuntimeInvalidRequestError("location must be a non-empty string")
        if not Path(location).expanduser().is_absolute():
            raise RuntimeInvalidRequestError("location must be an absolute path")
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


def registry_dir(values: dict[str, Any]) -> Path:
    """Directory holding OpenCode's `service.json`, without creating it.

    ``stateDir`` is the **XDG state home**, because that is what OpenCode itself
    resolves: the file lives at ``<state home>/opencode/service.json``. Both
    branches therefore append ``opencode``; a caller that treats a configured
    ``stateDir`` as the final directory finds nothing and reports "no service".

    Follows the ``connector/paths.py`` convention so a self-hosted data directory
    override keeps working: an explicit ``stateDir`` wins, otherwise
    ``$XDG_STATE_HOME`` (or ``~/.local/state``).
    """

    configured = values.get("stateDir")
    if isinstance(configured, str) and configured:
        return Path(canonical_path(Path(configured) / "opencode"))
    override = os.environ.get("XDG_STATE_HOME")
    base = Path(override).expanduser() if override else Path.home() / ".local" / "state"
    return Path(canonical_path(base / "opencode"))


def state_home(values: dict[str, Any]) -> Path | None:
    """The state home ``registry_dir`` was derived from, or None for the default."""

    configured = values.get("stateDir")
    return Path(configured) if isinstance(configured, str) and configured else None


def service_reader(values: dict[str, Any]):
    """A zero-argument registration reader pointed at this config's state home.

    Discovery, configuration probing and the attached runtime must all read the
    same file; passing ``stateDir`` in only one of them made a custom directory
    invisible to `provider.discover()` while the runtime could still attach.
    """

    from connector.runtimes.opencode.serve.service import read_service

    home = state_home(values)
    return (lambda: read_service(home)) if home is not None else read_service


def opencode_capabilities(reported: dict[str, Any] | None = None) -> dict[str, bool]:
    enabled = {
        row.get("capabilityId")
        for row in (reported or {}).get("capabilities", [])
        if isinstance(row, dict)
        and row.get("supported")
        and row.get("available")
        and row.get("allowed")
    }
    return {
        "modelCatalog": "catalog.model" in enabled,
        "permissionCatalog": "catalog.permission" in enabled,
        # Derived from the Hub capability, never hardcoded: if the Hub cannot
        # run discovery the descriptor must not claim support (m3).
        "sessionDiscovery": CAPABILITY_SESSION_DISCOVERY in enabled,
        "sessionSnapshot": True,
        "sessionState": True,
        "sessionNotices": True,
        "createAndStartSession": "session.send_message" in enabled,
        "startTurn": "session.send_message" in enabled,
        "steerTurn": "session.steer" in enabled,
        "interruptTurn": "session.interrupt" in enabled,
        "commands": "session.commands" in enabled,
        "interactions": "session.interaction.approval" in enabled,
        "attachments": "runtime.attachment" in enabled,
        "ipc": True,
    }
