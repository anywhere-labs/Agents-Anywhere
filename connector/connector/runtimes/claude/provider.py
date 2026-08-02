from __future__ import annotations

import importlib
import importlib.metadata
import os
import shutil
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from connector.launch import LaunchTarget, launch_target
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInvalidRequestError,
    RuntimeInventoryItem,
    RuntimeProvider,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude.runtime import ClaudeRuntime

SdkLoader = Callable[[], Any]

_PROTECTED_ENV_PREFIXES = ("AGENT_CONNECTOR_", "AGENT_SERVER_")
_PROTECTED_ENV_NAMES = {
    "AGENT_CONNECTOR_ID",
    "AGENT_CONNECTOR_TOKEN",
    "AGENT_CONNECTOR_CONFIG",
    "AGENT_CONNECTOR_DATA_DIR",
    "AGENT_CONNECTOR_STATE_FILE",
    "AGENT_SERVER_URL",
}


class ClaudeProvider(RuntimeProvider):
    @property
    def runtime(self) -> str:
        return "claude"

    @property
    def runtime_type(self) -> str:
        return "claude"

    @property
    def display_name(self) -> str:
        return "Claude"

    def __init__(
        self,
        sdk_loader: SdkLoader | None = None,
        command_checker: Callable[[LaunchTarget, Mapping[str, str]], dict[str, Any]] | None = None,
    ) -> None:
        self._sdk_loader = sdk_loader or _load_claude_sdk
        self._command_checker = command_checker or _check_claude_target
        self._discovered_sdk: dict[str, Any] | None = None
        self._discovered_target: LaunchTarget | None = None

    async def discover(self) -> RuntimeInventoryItem:
        sdk = _check_sdk(self._sdk_loader)
        target = _discover_claude_target(self._command_checker, {})
        self._discovered_sdk = sdk
        self._discovered_target = target
        available = bool(sdk.get("available"))
        reason = None if available else "claude-agent-sdk is not installed"
        return RuntimeInventoryItem(
            runtime=self.runtime,
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            available=available,
            configured=available,
            capabilities=_claude_capabilities(),
            reason=reason,
            config_schema=await self.get_config_schema(),
            metadata={
                "sdk": sdk,
                "cli": _target_metadata(target),
                "platform": sys.platform,
            },
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        schema = _claude_config_schema(self._discovered_target)
        return RuntimeConfigSchema(
            runtime=self.runtime,
            revision=1,
            schema=schema,
            ui_schema={
                "order": ["executablePath", "environment"],
                "executablePath": {"component": "path"},
                "environment": {"component": "keyValue"},
            },
            defaults={
                "environment": {},
            },
        )

    async def validate_config(
        self,
        values: Mapping[str, Any],
    ) -> RuntimeConfig:
        raw_values = dict(values)
        schema_obj = await self.get_config_schema()
        errors = sorted(
            Draft202012Validator(schema_obj.schema).iter_errors(raw_values),
            key=lambda error: list(error.absolute_path),
        )
        if errors:
            path = "/" + "/".join(str(part) for part in errors[0].absolute_path)
            raise RuntimeInvalidRequestError(
                f"claude config is invalid at {path or '/'}: {errors[0].message}"
            )
        environment = _merge_environment(raw_values.get("environment"))
        sdk = self._discovered_sdk or _check_sdk(self._sdk_loader)
        if not sdk.get("available"):
            raise RuntimeInvalidRequestError("claude-agent-sdk is not available")
        target = _resolve_target(
            raw_values=raw_values,
            environment=environment,
            discovered_target=self._discovered_target,
            command_checker=self._command_checker,
        )
        normalized_values: dict[str, Any] = {
            "environment": dict(raw_values.get("environment") or {}),
        }
        if target is not None:
            normalized_values["executablePath"] = target.path
        return RuntimeConfig(
            runtime=self.runtime,
            revision=1,
            values=normalized_values,
            schema=schema_obj.schema,
            ui_schema=schema_obj.ui_schema,
            metadata={
                "sdk": sdk,
                "cli": _target_metadata(target),
                "platform": sys.platform,
            },
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        return ClaudeRuntime(config=config, host=host, sdk_loader=self._sdk_loader)


def _claude_config_schema(target: LaunchTarget | None) -> dict[str, Any]:
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


def _claude_capabilities() -> dict[str, bool]:
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


def _load_claude_sdk() -> Any:
    return importlib.import_module("claude_agent_sdk")


def _check_sdk(loader: SdkLoader) -> dict[str, Any]:
    try:
        module = loader()
    except ModuleNotFoundError as exc:
        return {
            "available": False,
            "package": "claude-agent-sdk",
            "reason": str(exc) or "package not installed",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "available": False,
            "package": "claude-agent-sdk",
            "reason": str(exc) or exc.__class__.__name__,
        }
    version = getattr(module, "__version__", None)
    if not isinstance(version, str):
        try:
            version = importlib.metadata.version("claude-agent-sdk")
        except importlib.metadata.PackageNotFoundError:
            version = None
    return {
        "available": True,
        "package": "claude-agent-sdk",
        **({"version": version} if isinstance(version, str) and version else {}),
    }


def _discover_claude_target(
    command_checker: Callable[[LaunchTarget, Mapping[str, str]], dict[str, Any]],
    environment: Mapping[str, str],
) -> LaunchTarget | None:
    for target in _claude_candidate_targets():
        result = command_checker(target, environment)
        if result.get("status") == "ok":
            return target
    return None


def _resolve_target(
    raw_values: Mapping[str, Any],
    environment: Mapping[str, str],
    discovered_target: LaunchTarget | None,
    command_checker: Callable[[LaunchTarget, Mapping[str, str]], dict[str, Any]],
) -> LaunchTarget | None:
    raw_path = raw_values.get("executablePath")
    if isinstance(raw_path, str) and raw_path:
        target = launch_target("configured", os.path.expandvars(os.path.expanduser(raw_path)))
        result = command_checker(target, environment)
        if result.get("status") != "ok":
            raise RuntimeInvalidRequestError(
                f"Claude executable validation failed: {result.get('reason') or result.get('status')}"
            )
        return target
    return discovered_target


def _claude_candidate_targets() -> tuple[LaunchTarget, ...]:
    names = ("claude.cmd", "claude.exe") if sys.platform == "win32" else ("claude",)
    targets: list[LaunchTarget] = []
    configured = os.environ.get("CLAUDE_BIN")
    if configured:
        targets.append(launch_target("env", configured))
    for name in names:
        resolved = shutil.which(name)
        if resolved:
            targets.append(launch_target("path", resolved))
    home = Path.home()
    for candidate in (
        home / ".claude" / "local" / "claude",
        home / ".npm-global" / "bin" / "claude",
    ):
        targets.append(launch_target("common", str(candidate)))
    return tuple(dict.fromkeys(targets))


def _check_claude_target(
    target: LaunchTarget,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    _ = environment
    path = os.path.expanduser(os.path.expandvars(target.path))
    if not Path(path).exists() and shutil.which(path) is None:
        return {
            "status": "missing",
            "source": target.source,
            "path": target.path,
            "reason": "file not found",
        }
    return {
        "status": "ok",
        "source": target.source,
        "path": target.path,
    }


def _merge_environment(raw: Any) -> dict[str, str]:
    if raw is None:
        return {}
    if not isinstance(raw, Mapping):
        raise RuntimeInvalidRequestError("environment must be an object")
    environment: dict[str, str] = {}
    for key, value in raw.items():
        if not isinstance(key, str) or not key:
            raise RuntimeInvalidRequestError("environment keys must be non-empty strings")
        if key in _PROTECTED_ENV_NAMES or any(key.startswith(prefix) for prefix in _PROTECTED_ENV_PREFIXES):
            raise RuntimeInvalidRequestError(f"environment variable {key} is managed by the connector")
        if value is None:
            continue
        if not isinstance(value, str):
            raise RuntimeInvalidRequestError(f"environment variable {key} must be a string or null")
        environment[key] = value
    return environment


def _target_metadata(target: LaunchTarget | None) -> dict[str, Any] | None:
    if target is None:
        return None
    return {"source": target.source, "path": target.path}
