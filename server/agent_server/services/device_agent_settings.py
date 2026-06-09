from __future__ import annotations

from typing import Any

from loguru import logger

from agent_server.core.runtime_config import RuntimeConfigSchema
from agent_server.services.runtime_config import RuntimeConfigService
from agent_server.services.session_run import SessionRunError, SessionRunService
from agent_server.infra.repositories.facade import Store


class DeviceAgentSettingsService:
    def __init__(
        self,
        store: Store,
        runtime_config: RuntimeConfigService,
        session_run: SessionRunService,
    ) -> None:
        self._store = store
        self._runtime_config = runtime_config
        self._session_run = session_run

    async def get_settings(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str,
    ) -> tuple[dict[str, Any], RuntimeConfigSchema]:
        settings = await self._runtime_config.get_device_agent_settings(
            connector_id,
            runtime,
            user_id=user_id,
        )
        schema = await self._runtime_config.get_runtime_config_schema(runtime)
        return settings, schema

    async def patch_settings(
        self,
        connector_id: str,
        runtime: str,
        patch: dict[str, Any],
        *,
        user_id: str,
    ) -> tuple[dict[str, Any], RuntimeConfigSchema]:
        current = await self._runtime_config.get_device_agent_settings(
            connector_id,
            runtime,
            user_id=user_id,
        )
        if self._claude_run_mode_changed(runtime, current, patch):
            await self._interrupt_running_sessions(connector_id, runtime, user_id=user_id)

        settings = await self._runtime_config.patch_device_agent_settings(
            connector_id,
            runtime,
            patch,
            user_id=user_id,
        )
        schema = await self._runtime_config.get_runtime_config_schema(runtime)
        return settings, schema

    @staticmethod
    def _claude_run_mode_changed(
        runtime: str,
        current: dict[str, Any],
        patch: dict[str, Any],
    ) -> bool:
        next_run_mode = patch.get("runMode")
        return (
            runtime == "claude"
            and isinstance(next_run_mode, str)
            and next_run_mode != current.get("runMode")
        )

    async def _interrupt_running_sessions(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str,
    ) -> None:
        sessions = await self._store.list_running_sessions_for_connector_agent(
            connector_id=connector_id,
            runtime=runtime,
            user_id=user_id,
        )
        for session in sessions:
            try:
                await self._session_run.interrupt_session_internal(
                    session.id,
                    user_id=user_id,
                )
            except SessionRunError as exc:
                logger.warning(
                    "failed to interrupt session before runMode change connector_id={} session_id={} detail={}",
                    connector_id,
                    session.id,
                    exc.detail,
                )
