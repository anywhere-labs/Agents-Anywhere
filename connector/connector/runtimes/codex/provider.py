from __future__ import annotations

import asyncio
import importlib.metadata
import os
import shutil
import sys
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import Any, Literal

from jsonschema import Draft202012Validator

from connector.launch import LaunchTarget, launch_target, path_exists_for_launch
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInvalidRequestError,
    RuntimeInventoryItem,
    RuntimeProvider,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.runtime import (
    CodexRuntime,
    EmptyCodexClient,
    app_server_client_from_config,
)

SdkMode = Literal["auto", "sdk", "app-server"]
CommandChecker = Callable[[LaunchTarget, Mapping[str, str]], Awaitable[dict[str, Any]]]
SdkChecker = Callable[[], dict[str, Any]]

_COMMAND_CHECK_TIMEOUT_S = 8.0
_PROTECTED_ENV_PREFIXES = ("AGENT_CONNECTOR_", "AGENT_SERVER_")
_PROTECTED_ENV_NAMES = {
    "AGENT_CONNECTOR_ID",
    "AGENT_CONNECTOR_TOKEN",
    "AGENT_CONNECTOR_CONFIG",
    "AGENT_CONNECTOR_DATA_DIR",
    "AGENT_CONNECTOR_STATE_FILE",
    "AGENT_SERVER_URL",
}


class CodexProvider(RuntimeProvider):
    @property
    def runtime(self) -> str:
        return "codex"

    @property
    def runtime_type(self) -> str:
        return "codex"

    @property
    def display_name(self) -> str:
        return "Codex"

    def __init__(
        self,
        sdk_checker: SdkChecker | None = None,
        command_checker: CommandChecker | None = None,
    ) -> None:
        self._sdk_checker = sdk_checker or _check_codex_sdk
        self._command_checker = command_checker or _check_codex_target
        self._discovered_target: LaunchTarget | None = None
        self._discovered_sdk: dict[str, Any] | None = None

    async def discover(self) -> RuntimeInventoryItem:
        sdk = self._sdk_checker()
        report, target = await self._discover_app_server_target()
        self._discovered_sdk = sdk
        self._discovered_target = target
        available = bool(sdk.get("available")) or target is not None
        reason = None
        if not available:
            reason = "Codex SDK and Codex app-server executable are unavailable"
        return RuntimeInventoryItem(
            runtime=self.runtime,
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            available=available,
            configured=available,
            reason=reason,
            config_schema=await self.get_config_schema(),
            metadata={
                "sdk": sdk,
                "appServer": report,
                "platform": sys.platform,
            },
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        schema = _codex_config_schema(self._discovered_target)
        return RuntimeConfigSchema(
            runtime=self.runtime,
            revision=1,
            schema=schema,
            ui_schema={
                "order": ["sdkMode", "executablePath", "ipcEnabled", "environment"],
                "sdkMode": {"component": "select"},
                "executablePath": {"component": "path"},
                "ipcEnabled": {"component": "switch"},
                "environment": {"component": "keyValue"},
            },
            defaults={
                "sdkMode": "auto",
                "ipcEnabled": True,
                "environment": {},
            },
        )

    async def validate_config(
        self,
        values: Mapping[str, Any],
    ) -> RuntimeConfig:
        raw_values = dict(values)
        schema = (await self.get_config_schema()).schema
        errors = sorted(
            Draft202012Validator(schema).iter_errors(raw_values),
            key=lambda error: list(error.absolute_path),
        )
        if errors:
            path = "/" + "/".join(str(part) for part in errors[0].absolute_path)
            raise RuntimeInvalidRequestError(
                f"codex config is invalid at {path or '/'}: {errors[0].message}"
            )

        requested_mode = _sdk_mode(raw_values.get("sdkMode", "auto"))
        environment = _merge_environment(raw_values.get("environment"))
        sdk = self._discovered_sdk or self._sdk_checker()
        target = await self._resolve_target(raw_values, environment)

        effective_mode: SdkMode
        if requested_mode == "sdk":
            if not sdk.get("available"):
                raise RuntimeInvalidRequestError("Codex SDK is not available")
            effective_mode = "sdk"
        elif requested_mode == "app-server":
            if target is None:
                raise RuntimeInvalidRequestError("Codex app-server executable is not available")
            effective_mode = "app-server"
        elif sdk.get("available"):
            effective_mode = "sdk"
        elif target is not None:
            effective_mode = "app-server"
        else:
            raise RuntimeInvalidRequestError("Codex SDK and Codex app-server executable are unavailable")

        normalized_values: dict[str, Any] = {
            "sdkMode": effective_mode,
            "requestedSdkMode": requested_mode,
            "ipcEnabled": bool(raw_values.get("ipcEnabled", True)),
            "environment": dict(raw_values.get("environment") or {}),
        }
        if target is not None:
            normalized_values["executablePath"] = target.path

        return RuntimeConfig(
            runtime=self.runtime,
            revision=1,
            values=normalized_values,
            schema=schema,
            ui_schema=(await self.get_config_schema()).ui_schema,
            metadata={
                "sdk": sdk,
                "launchTarget": _target_metadata(target),
                "platform": sys.platform,
            },
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        _ = host
        mode = config.values.get("sdkMode")
        client = app_server_client_from_config(config) if mode == "app-server" else EmptyCodexClient()
        return CodexRuntime(config=config, host=host, client=client)

    async def _discover_app_server_target(self) -> tuple[dict[str, Any], LaunchTarget | None]:
        checked: list[dict[str, Any]] = []
        for target in _codex_candidate_targets():
            result = await self._command_checker(target, {})
            checked.append(result)
            if result.get("status") == "ok":
                return (
                    {
                        "available": True,
                        "selected": _target_metadata(target),
                        "checked": checked,
                    },
                    target,
                )
        return (
            {
                "available": False,
                "checked": checked,
            },
            None,
        )

    async def _resolve_target(
        self,
        raw_values: Mapping[str, Any],
        environment: Mapping[str, str],
    ) -> LaunchTarget | None:
        raw_path = raw_values.get("executablePath")
        if isinstance(raw_path, str) and raw_path:
            target = launch_target("configured", os.path.expandvars(os.path.expanduser(raw_path)))
            result = await self._command_checker(target, environment)
            if result.get("status") != "ok":
                raise RuntimeInvalidRequestError(
                    f"Codex executable validation failed: {result.get('reason') or result.get('status')}"
                )
            return target
        if self._discovered_target is not None:
            return self._discovered_target
        report, target = await self._discover_app_server_target()
        self._discovered_target = target
        if target is None:
            self._discovered_sdk = self._discovered_sdk or self._sdk_checker()
        _ = report
        return target


def _codex_config_schema(target: LaunchTarget | None) -> dict[str, Any]:
    executable: dict[str, Any] = {
        "type": "string",
        "minLength": 1,
        "title": "Codex executable path",
        "description": "Path to a Codex CLI executable that supports app-server.",
    }
    if target is not None:
        executable["default"] = target.path
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "sdkMode": {
                "type": "string",
                "title": "Codex runtime mode",
                "enum": ["auto", "sdk", "app-server"],
                "default": "auto",
            },
            "executablePath": executable,
            "ipcEnabled": {
                "type": "boolean",
                "title": "Codex IPC (Beta)",
                "description": (
                    "Synchronize Codex App and IDE extension sessions through the local IPC socket. "
                    "Tested on macOS only; Windows and Linux have not yet been tested. "
                    "May cause synchronization issues or runtime instability."
                ),
                "default": True,
            },
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


def _codex_candidate_targets() -> tuple[LaunchTarget, ...]:
    if sys.platform == "win32":
        home = Path.home()
        appdata = os.environ.get("APPDATA", str(home / "AppData" / "Roaming"))
        candidates = [
            ("custom", os.environ.get("CODEX_BIN", "")),
            *[
                ("nvm", str(Path("C:/nvm4w/nodejs") / name))
                for name in ("codex.cmd", "codex.ps1", "codex.exe")
            ],
            ("cli", shutil.which("codex") or ""),
            *[
                ("npm", str(Path(appdata) / "npm" / name))
                for name in ("codex.cmd", "codex.ps1", "codex.exe")
            ],
            *[
                ("npm", str(home / ".npm-global" / "bin" / name))
                for name in ("codex.cmd", "codex.ps1", "codex.exe")
            ],
            *[
                ("cli", str(home / ".local" / "bin" / name))
                for name in ("codex.exe", "codex.cmd", "codex.ps1")
            ],
            *[
                ("scoop", str(home / "scoop" / "shims" / name))
                for name in ("codex.exe", "codex.cmd", "codex.ps1")
            ],
        ]
    else:
        candidates = [
            ("custom", os.environ.get("CODEX_BIN", "")),
            ("app", "/Applications/Codex.app/Contents/Resources/codex"),
            (
                "app",
                str(Path.home() / "Applications" / "Codex.app" / "Contents" / "Resources" / "codex"),
            ),
            ("cli", shutil.which("codex") or ""),
            ("cli", "/opt/homebrew/bin/codex"),
            ("cli", "/usr/local/bin/codex"),
        ]

    seen: set[str] = set()
    targets: list[LaunchTarget] = []
    for source, raw_path in candidates:
        if not raw_path:
            continue
        path = os.path.expandvars(os.path.expanduser(raw_path))
        if path in seen:
            continue
        seen.add(path)
        targets.append(launch_target(source, path))
    return tuple(targets)


async def _check_codex_target(
    target: LaunchTarget,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    base = _target_metadata(target)
    path = target.path
    if not Path(path).is_file():
        return {**base, "status": "missing", "reason": "file not found"}
    if not path_exists_for_launch(path):
        return {**base, "status": "failed", "reason": "not executable"}

    try:
        proc = await asyncio.create_subprocess_exec(
            *target.command(["--version"]),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(environment),
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(),
            timeout=_COMMAND_CHECK_TIMEOUT_S,
        )
    except Exception as exc:  # noqa: BLE001
        return {**base, "status": "failed", "reason": str(exc) or exc.__class__.__name__}
    out = stdout.decode(errors="replace").strip()
    err = stderr.decode(errors="replace").strip()
    if proc.returncode != 0:
        return {
            **base,
            "status": "failed",
            "reason": f"exit {proc.returncode}",
            "stdout": out[:500],
            "stderr": err[:500],
        }
    return {**base, "status": "ok", "version": out[:500]}


def _check_codex_sdk() -> dict[str, Any]:
    try:
        version = importlib.metadata.version("openai-codex")
    except importlib.metadata.PackageNotFoundError:
        return {
            "available": False,
            "package": "openai-codex",
            "reason": "package not installed",
        }
    return {
        "available": True,
        "package": "openai-codex",
        "version": version,
    }


def _merge_environment(raw: Any) -> dict[str, str]:
    if raw is None:
        overrides: dict[str, Any] = {}
    elif isinstance(raw, dict):
        overrides = raw
    else:
        raise RuntimeInvalidRequestError("environment must be an object")

    environment = dict(os.environ)
    for key, value in overrides.items():
        if not isinstance(key, str) or not key or "=" in key or "\x00" in key:
            raise RuntimeInvalidRequestError("environment contains an invalid variable name")
        if key in _PROTECTED_ENV_NAMES or key.startswith(_PROTECTED_ENV_PREFIXES):
            raise RuntimeInvalidRequestError(f"environment variable {key!r} is managed by the connector")
        if value is None:
            environment.pop(key, None)
            continue
        if not isinstance(value, str) or "\x00" in value:
            raise RuntimeInvalidRequestError(f"environment variable {key!r} must be a string or null")
        environment[key] = value
    return environment


def _sdk_mode(value: Any) -> SdkMode:
    if value in {"auto", "sdk", "app-server"}:
        return value
    raise RuntimeInvalidRequestError("sdkMode must be auto, sdk, or app-server")


def _target_metadata(target: LaunchTarget | None) -> dict[str, Any] | None:
    if target is None:
        return None
    return {
        "source": target.source,
        "path": target.path,
        "launcher": target.launcher,
    }
