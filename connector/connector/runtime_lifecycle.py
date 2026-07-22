from __future__ import annotations

import asyncio
import copy
import importlib
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from jsonschema import Draft202012Validator

from connector.adapter import Adapter
from connector.runtime_discovery import (
    check_claude_target,
    check_codex_target,
    discover_claude_capability,
    discover_codex_capability,
)
from connector.claude.history_adapter import ClaudeHistoryAdapter
from connector.claude.sdk_adapter import ClaudeSdkAdapter
from connector.codex.adapter import CodexAdapter
from connector.codex.rpc import JsonRpcStdioClient
from connector.launch import LaunchTarget, launch_target
from connector.sync_state import SyncStateStore


RuntimeStatusSink = Callable[[str, str, dict[str, Any] | None], Awaitable[None]]
RuntimeChangedSink = Callable[[str, Adapter | None], Awaitable[None]]
NotificationSink = Callable[[str, dict[str, Any]], Awaitable[None]]
AttachmentDownloader = Callable[[str, str], Awaitable[tuple[bytes, str, str]]]

_PROTECTED_ENV_PREFIXES = ("AGENT_CONNECTOR_", "AGENT_SERVER_")
_PROTECTED_ENV_NAMES = {
    "AGENT_CONNECTOR_ID",
    "AGENT_CONNECTOR_TOKEN",
    "AGENT_CONNECTOR_CONFIG",
    "AGENT_CONNECTOR_STATE_DB",
    "AGENT_SERVER_URL",
}


class RuntimeLifecycleError(RuntimeError):
    code = "runtime_lifecycle_error"


class RuntimeNotFoundError(RuntimeLifecycleError):
    code = "runtime_not_found"


class RuntimeInactiveError(RuntimeLifecycleError):
    code = "runtime_inactive"


class RuntimeConfigError(RuntimeLifecycleError):
    code = "invalid_config"


@dataclass(frozen=True, slots=True)
class RuntimeBindings:
    notification_sink: NotificationSink
    attachment_downloader: AttachmentDownloader
    sync_state_store: SyncStateStore | None


@dataclass(frozen=True, slots=True)
class EffectiveRuntimeConfig:
    target: LaunchTarget
    environment: dict[str, str]


class RuntimeProvider(Protocol):
    runtime_id: str
    runtime_type: str
    display_name: str

    async def discover(self, *, status: str) -> dict[str, Any]: ...

    def unavailable_inventory(self, *, status: str, error: BaseException) -> dict[str, Any]: ...

    async def validate_config(self, config: dict[str, Any]) -> EffectiveRuntimeConfig: ...

    async def create_adapter(self, effective: EffectiveRuntimeConfig) -> Adapter: ...

    async def stop_adapter(self, adapter: Adapter) -> None: ...

    def capability_specs(self) -> list[tuple[str, dict[str, Any]]]: ...


class ExecutableRuntimeProvider:
    runtime_id = ""
    runtime_type = ""
    display_name = ""

    def __init__(self, bindings: RuntimeBindings) -> None:
        self.bindings = bindings
        self._discovered_target: LaunchTarget | None = None

    async def discover(self, *, status: str) -> dict[str, Any]:
        report, target = await self._discover_target()
        self._discovered_target = target
        return {
            "runtimeId": self.runtime_id,
            "runtimeType": self.runtime_type,
            "displayName": self.display_name,
            "discovery": self._normalize_discovery(report, target),
            "schema": self._config_schema(target),
            "uiSchema": self._ui_schema(),
            "status": status,
        }

    def unavailable_inventory(self, *, status: str, error: BaseException) -> dict[str, Any]:
        return {
            "runtimeId": self.runtime_id,
            "runtimeType": self.runtime_type,
            "displayName": self.display_name,
            "discovery": {
                "available": False,
                "error": {
                    "code": "discovery_failed",
                    "message": str(error) or error.__class__.__name__,
                },
            },
            "schema": self._config_schema(None),
            "uiSchema": self._ui_schema(),
            "status": status,
        }

    async def validate_config(self, config: dict[str, Any]) -> EffectiveRuntimeConfig:
        if not isinstance(config, dict):
            raise RuntimeConfigError("runtime config must be an object")
        schema = self._config_schema(self._discovered_target)
        errors = sorted(
            Draft202012Validator(schema).iter_errors(config),
            key=lambda error: list(error.absolute_path),
        )
        if errors:
            path = "/" + "/".join(str(part) for part in errors[0].absolute_path)
            raise RuntimeConfigError(f"runtime config is invalid at {path or '/'}: {errors[0].message}")

        raw_path = config.get("executablePath")
        if isinstance(raw_path, str) and raw_path:
            target = launch_target("configured", os.path.expandvars(os.path.expanduser(raw_path)))
        elif self._discovered_target is not None:
            target = self._discovered_target
        else:
            raise RuntimeConfigError("executablePath is required because no runtime executable was discovered")

        environment = _merge_environment(config.get("environment"))
        check = await self._check_target(target, environment)
        if check.get("status") != "ok":
            stage = check.get("stage") if isinstance(check.get("stage"), str) else "executable"
            raise RuntimeConfigError(f"runtime {stage} validation failed")
        return EffectiveRuntimeConfig(target=target, environment=environment)

    async def stop_adapter(self, adapter: Adapter) -> None:
        stop = getattr(adapter, "stop", None)
        if callable(stop):
            await stop()

    def _config_schema(self, target: LaunchTarget | None) -> dict[str, Any]:
        executable: dict[str, Any] = {
            "type": "string",
            "minLength": 1,
            "title": "Executable path",
            "description": f"Path to the {self.display_name} executable.",
        }
        if target is not None:
            executable["default"] = target.path
        schema: dict[str, Any] = {
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
        if target is None:
            schema["required"] = ["executablePath"]
        return schema

    @staticmethod
    def _ui_schema() -> dict[str, Any]:
        return {
            "order": ["executablePath", "environment"],
            "executablePath": {"component": "path"},
            "environment": {"component": "keyValue"},
        }

    @staticmethod
    def _normalize_discovery(
        report: dict[str, Any],
        target: LaunchTarget | None,
    ) -> dict[str, Any]:
        result: dict[str, Any] = {
            "available": target is not None,
            "checked": report.get("checked") if isinstance(report.get("checked"), list) else [],
        }
        for key in ("selected", "error", "historyCheck"):
            value = report.get(key)
            if isinstance(value, dict):
                result[key] = value
        return result

    async def _discover_target(self) -> tuple[dict[str, Any], LaunchTarget | None]:
        raise NotImplementedError

    async def _check_target(
        self,
        target: LaunchTarget,
        environment: dict[str, str],
    ) -> dict[str, Any]:
        raise NotImplementedError


class CodexRuntimeProvider(ExecutableRuntimeProvider):
    runtime_id = "codex"
    runtime_type = "codex"
    display_name = "Codex"

    async def _discover_target(self) -> tuple[dict[str, Any], LaunchTarget | None]:
        return await discover_codex_capability()

    async def _check_target(
        self,
        target: LaunchTarget,
        environment: dict[str, str],
    ) -> dict[str, Any]:
        return await check_codex_target(target, environment=environment)

    async def create_adapter(self, effective: EffectiveRuntimeConfig) -> Adapter:
        adapter = CodexAdapter(
            rpc=JsonRpcStdioClient(
                command=effective.target.command(["app-server", "--listen", "stdio://"]),
                environment=effective.environment,
            ),
            notification_sink=self.bindings.notification_sink,
            attachment_downloader=self.bindings.attachment_downloader,
            sync_state_store=self.bindings.sync_state_store,
        )
        try:
            await adapter.start()
        except Exception:
            await adapter.stop()
            raise
        return adapter

    def capability_specs(self) -> list[tuple[str, dict[str, Any]]]:
        return [
            ("session.interrupt", {}),
            ("session.steer", {}),
            (
                "session.interaction.approval",
                {
                    "supports_allow_once": True,
                    "supports_allow_session": True,
                    "supports_persistent_rules": False,
                    "supports_input_schema": True,
                },
            ),
            ("runtime.config", {}),
            ("catalog.model", {}),
            ("catalog.permission", {}),
            ("catalog.effort", {}),
        ]


class ClaudeRuntimeProvider(ExecutableRuntimeProvider):
    runtime_id = "claude"
    runtime_type = "claude"
    display_name = "Claude Code"

    async def _discover_target(self) -> tuple[dict[str, Any], LaunchTarget | None]:
        return await discover_claude_capability()

    async def _check_target(
        self,
        target: LaunchTarget,
        environment: dict[str, str],
    ) -> dict[str, Any]:
        return await check_claude_target(target, environment=environment)

    async def create_adapter(self, effective: EffectiveRuntimeConfig) -> Adapter:
        try:
            sdk = importlib.import_module("claude_agent_sdk")
        except ModuleNotFoundError as exc:
            raise RuntimeLifecycleError("claude-agent-sdk is not installed") from exc
        return ClaudeSdkAdapter(
            notification_sink=self.bindings.notification_sink,
            sdk_module=sdk,
            history_adapter=ClaudeHistoryAdapter(
                sdk_module=sdk,
                sync_state_store=self.bindings.sync_state_store,
            ),
            attachment_downloader=self.bindings.attachment_downloader,
            claude_target=effective.target,
            environment=effective.environment,
        )

    def capability_specs(self) -> list[tuple[str, dict[str, Any]]]:
        return [
            ("session.interrupt", {}),
            ("session.interaction.approval", {}),
            ("runtime.config", {}),
            ("catalog.model", {}),
            ("catalog.permission", {}),
        ]


class RuntimeSupervisor:
    def __init__(
        self,
        providers: list[RuntimeProvider],
        *,
        status_sink: RuntimeStatusSink,
        changed_sink: RuntimeChangedSink,
        running_adapters: dict[str, Adapter] | None = None,
    ) -> None:
        self.providers = {provider.runtime_id: provider for provider in providers}
        self.adapters: dict[str, Adapter] = dict(running_adapters or {})
        self._statuses: dict[str, str] = {
            runtime_id: "running" if runtime_id in self.adapters else "stopped"
            for runtime_id in self.providers
        }
        self._configs: dict[str, dict[str, Any]] = {}
        self._locks = {runtime_id: asyncio.Lock() for runtime_id in self.providers}
        self._status_sink = status_sink
        self._changed_sink = changed_sink

    async def discover(self) -> dict[str, Any]:
        inventories = await asyncio.gather(
            *(
                provider.discover(status=self._statuses.get(runtime_id, "stopped"))
                for runtime_id, provider in self.providers.items()
            ),
            return_exceptions=True,
        )
        runtimes: list[dict[str, Any]] = []
        for (runtime_id, provider), inventory in zip(self.providers.items(), inventories, strict=True):
            if isinstance(inventory, BaseException):
                runtimes.append(
                    provider.unavailable_inventory(
                        status=self._statuses.get(runtime_id, "stopped"),
                        error=inventory,
                    )
                )
            else:
                runtimes.append(inventory)
        return {"runtimes": runtimes}

    async def validate_config(self, runtime_id: str, config: dict[str, Any]) -> None:
        provider = self._provider(runtime_id)
        await provider.validate_config(config)

    async def start(self, runtime_id: str, config: dict[str, Any]) -> dict[str, Any]:
        provider = self._provider(runtime_id)
        async with self._locks[runtime_id]:
            if runtime_id in self.adapters and self._configs.get(runtime_id) == config:
                return {"runtimeId": runtime_id, "status": "running"}
            if runtime_id in self.adapters:
                await self._stop_locked(runtime_id, provider)

            await self._set_status(runtime_id, "starting")
            try:
                effective = await provider.validate_config(config)
                adapter = await provider.create_adapter(effective)
            except Exception as exc:
                await self._set_status(
                    runtime_id,
                    "error",
                    {"code": getattr(exc, "code", None) or exc.__class__.__name__, "message": str(exc)},
                )
                raise
            self.adapters[runtime_id] = adapter
            self._configs[runtime_id] = copy.deepcopy(config)
            await self._set_status(runtime_id, "running")
            await self._changed_sink(runtime_id, adapter)
            return {"runtimeId": runtime_id, "status": "running"}

    async def stop(self, runtime_id: str) -> dict[str, Any]:
        provider = self._provider(runtime_id)
        async with self._locks[runtime_id]:
            await self._stop_locked(runtime_id, provider)
            return {"runtimeId": runtime_id, "status": "stopped"}

    def resolve_adapter(self, runtime_id: str) -> Adapter:
        self._provider(runtime_id)
        adapter = self.adapters.get(runtime_id)
        if adapter is None:
            raise RuntimeInactiveError(f"runtime {runtime_id!r} is not active")
        return adapter

    def active_capabilities(self, *, revision: int) -> dict[str, Any]:
        capabilities: list[dict[str, Any]] = []
        for runtime_id in self.adapters:
            provider = self.providers.get(runtime_id)
            if provider is None:
                continue
            for capability_id, parameters in provider.capability_specs():
                capabilities.append(
                    {
                        "capabilityId": capability_id,
                        "version": "1",
                        "scope": "runtime",
                        "runtime": runtime_id,
                        "supported": True,
                        "available": True,
                        "allowed": True,
                        "parameters": parameters,
                    }
                )
        return {"revision": revision, "capabilities": capabilities}

    async def _stop_locked(self, runtime_id: str, provider: RuntimeProvider) -> None:
        adapter = self.adapters.get(runtime_id)
        if adapter is None:
            self._configs.pop(runtime_id, None)
            await self._set_status(runtime_id, "stopped")
            return
        await self._set_status(runtime_id, "stopping")
        try:
            await provider.stop_adapter(adapter)
        except Exception as exc:
            await self._set_status(
                runtime_id,
                "error",
                {"code": getattr(exc, "code", None) or exc.__class__.__name__, "message": str(exc)},
            )
            raise
        self.adapters.pop(runtime_id, None)
        self._configs.pop(runtime_id, None)
        await self._set_status(runtime_id, "stopped")
        await self._changed_sink(runtime_id, None)

    async def _set_status(
        self,
        runtime_id: str,
        status: str,
        error: dict[str, Any] | None = None,
    ) -> None:
        self._statuses[runtime_id] = status
        await self._status_sink(runtime_id, status, error)

    def _provider(self, runtime_id: str) -> RuntimeProvider:
        provider = self.providers.get(runtime_id)
        if provider is None:
            raise RuntimeNotFoundError(f"unknown runtime {runtime_id!r}")
        return provider


def default_runtime_providers(bindings: RuntimeBindings) -> list[RuntimeProvider]:
    return [CodexRuntimeProvider(bindings), ClaudeRuntimeProvider(bindings)]


def _merge_environment(raw: Any) -> dict[str, str]:
    if raw is None:
        overrides: dict[str, Any] = {}
    elif isinstance(raw, dict):
        overrides = raw
    else:
        raise RuntimeConfigError("environment must be an object")

    environment = dict(os.environ)
    for key, value in overrides.items():
        if not isinstance(key, str) or not key or "=" in key or "\x00" in key:
            raise RuntimeConfigError("environment contains an invalid variable name")
        if key in _PROTECTED_ENV_NAMES or key.startswith(_PROTECTED_ENV_PREFIXES):
            raise RuntimeConfigError(f"environment variable {key!r} is managed by the connector")
        if value is None:
            environment.pop(key, None)
            continue
        if not isinstance(value, str) or "\x00" in value:
            raise RuntimeConfigError(f"environment variable {key!r} must be a string or null")
        environment[key] = value
    return environment
