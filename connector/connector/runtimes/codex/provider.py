from __future__ import annotations

import importlib.metadata
import os
import sys
from collections.abc import Callable, Mapping
from typing import Any

from jsonschema import Draft202012Validator

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInvalidRequestError,
    RuntimeInventoryItem,
    RuntimeProvider,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.sdk_client import sdk_client_from_config

SdkChecker = Callable[[], dict[str, Any]]
SdkClientFactory = Callable[[RuntimeConfig], Any]

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
        sdk_client_factory: SdkClientFactory | None = None,
    ) -> None:
        self._sdk_checker = sdk_checker or _check_codex_sdk
        self._sdk_client_factory = sdk_client_factory or sdk_client_from_config
        self._discovered_sdk: dict[str, Any] | None = None

    async def discover(self) -> RuntimeInventoryItem:
        sdk = self._sdk_checker()
        self._discovered_sdk = sdk
        available = bool(sdk.get("available"))
        reason = None
        if not available:
            reason = "Codex SDK is unavailable"
        return RuntimeInventoryItem(
            runtime=self.runtime,
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            available=available,
            configured=available,
            capabilities=_codex_capabilities(),
            reason=reason,
            config_schema=await self.get_config_schema(),
            metadata={
                "sdk": sdk,
                "platform": sys.platform,
            },
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        schema = _codex_config_schema()
        return RuntimeConfigSchema(
            runtime=self.runtime,
            revision=1,
            schema=schema,
            ui_schema={
                "order": ["environment"],
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

        sdk = self._discovered_sdk or self._sdk_checker()
        if not sdk.get("available"):
            raise RuntimeInvalidRequestError("Codex SDK is not available")
        _merge_environment(raw_values.get("environment"))

        normalized_values: dict[str, Any] = {
            "environment": dict(raw_values.get("environment") or {}),
        }

        return RuntimeConfig(
            runtime=self.runtime,
            revision=1,
            values=normalized_values,
            schema=schema,
            ui_schema=(await self.get_config_schema()).ui_schema,
            metadata={
                "sdk": sdk,
                "platform": sys.platform,
            },
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        sdk = config.metadata.get("sdk") if isinstance(config.metadata, dict) else None
        if isinstance(sdk, dict) and not sdk.get("available", True):
            raise RuntimeInvalidRequestError("Codex SDK is not available")
        client = self._sdk_client_factory(config)
        return CodexRuntime(config=config, host=host, client=client)


def _codex_config_schema() -> dict[str, Any]:
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


def _codex_capabilities() -> dict[str, bool]:
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
        "ipc": False,
    }


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
            raise RuntimeInvalidRequestError(
                "environment contains an invalid variable name"
            )
        if key in _PROTECTED_ENV_NAMES or key.startswith(_PROTECTED_ENV_PREFIXES):
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
