from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent_server.core.runtime_config import RuntimeConfigSchema
from agent_server.services.runtime_config import RuntimeConfigService


@dataclass(frozen=True)
class DeviceAgentSettingsResult:
    settings: dict[str, Any]
    schema: RuntimeConfigSchema


class DeviceAgentSettingsService:
    def __init__(
        self,
        runtime_config: RuntimeConfigService,
    ) -> None:
        self._runtime_config = runtime_config

    async def get_settings(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str,
    ) -> DeviceAgentSettingsResult:
        settings = await self._runtime_config.get_device_agent_settings(
            connector_id,
            runtime,
            user_id=user_id,
        )
        schema = await self._runtime_config.get_runtime_config_schema(runtime)
        return DeviceAgentSettingsResult(
            settings=settings,
            schema=schema,
        )

    async def patch_settings(
        self,
        connector_id: str,
        runtime: str,
        patch: dict[str, Any],
        *,
        user_id: str,
    ) -> DeviceAgentSettingsResult:
        settings = await self._runtime_config.patch_device_agent_settings(
            connector_id,
            runtime,
            patch,
            user_id=user_id,
        )
        schema = await self._runtime_config.get_runtime_config_schema(runtime)
        return DeviceAgentSettingsResult(
            settings=settings,
            schema=schema,
        )
