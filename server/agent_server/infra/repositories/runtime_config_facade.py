from __future__ import annotations

from agent_server.infra.repositories.store_support import *


class RuntimeConfigRepositoryMixin:
    async def seed_runtime_config_schemas(self) -> None:
        await self.runtime_config.seed_runtime_config_schemas()


    async def get_runtime_config_schema(self, runtime: str) -> RuntimeConfigSchema:
        return await self.runtime_config.get_runtime_config_schema(runtime)


    async def set_runtime_config_schema(
        self,
        runtime: str,
        schema_json: dict[str, Any],
    ) -> RuntimeConfigSchema:
        return await self.runtime_config.set_runtime_config_schema(runtime, schema_json)


    async def get_device_agent_settings(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        return await self.runtime_config.get_device_agent_settings(
            connector_id,
            runtime,
            user_id=user_id,
        )


    async def patch_device_agent_settings(
        self,
        connector_id: str,
        runtime: str,
        patch: dict[str, Any],
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        return await self.runtime_config.patch_device_agent_settings(
            connector_id,
            runtime,
            patch,
            user_id=user_id,
        )


    async def get_session_runtime_settings_override(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        return await self.runtime_config.get_session_runtime_settings_override(
            session_id,
            user_id=user_id,
        )


    async def patch_session_runtime_settings(
        self,
        session_id: str,
        patch: dict[str, Any],
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        return await self.runtime_config.patch_session_runtime_settings(
            session_id,
            patch,
            user_id=user_id,
        )


    async def get_effective_runtime_settings(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        return await self.runtime_config.get_effective_runtime_settings(
            session_id,
            user_id=user_id,
        )


    async def get_effective_settings_for_connector_agent(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str | None = None,
        cwd: str | None = None,
    ) -> dict[str, Any]:
        return await self.runtime_config.get_effective_settings_for_connector_agent(
            connector_id,
            runtime,
            user_id=user_id,
            cwd=cwd,
        )

