from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
import os
from typing import Any

from loguru import logger
from pydantic import ValidationError

from agent_server.core.device_runtime import (
    MAX_JAVASCRIPT_SAFE_INTEGER,
    DeviceRuntimeView,
    RuntimeConfigValidationError,
    RuntimeDiscoveryResponse,
    RuntimeTypeView,
    validate_config,
)
from agent_server.infra.connector_rpc import (
    ConnectorConnection,
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.repository_ports import DeviceRuntimeRepository
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache
from agent_server.services.timeline_write_buffer import TimelineWriteBuffer



def _runtime_rpc_timeout_seconds() -> float:
    """Runtime RPCs can be slow on a large corpus; tests shorten this to fail fast."""
    try:
        return float(os.environ.get("AGENT_SERVER_RUNTIME_RPC_TIMEOUT_SECONDS", "90"))
    except ValueError:
        return 90.0



class DeviceRuntimeError(RuntimeError):
    status_code = 500
    code = "device_runtime_error"

    def __init__(self, message: str, *, detail: Any | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = (
            detail if detail is not None else {"code": self.code, "message": message}
        )


class DeviceRuntimeNotFoundError(DeviceRuntimeError):
    status_code = 404
    code = "runtime_not_found"


class DeviceRuntimeConflictError(DeviceRuntimeError):
    status_code = 409
    code = "runtime_conflict"


class DeviceRuntimeInvalidConfigError(DeviceRuntimeError):
    status_code = 422
    code = "invalid_runtime_config"


class DeviceRuntimeUpstreamError(DeviceRuntimeError):
    status_code = 502
    code = "runtime_upstream_error"


class DeviceRuntimeOfflineError(DeviceRuntimeError):
    status_code = 503
    code = "connector_offline"


class DeviceRuntimeNotConfiguredError(DeviceRuntimeError):
    """The instance exists but has no saved configuration yet."""

    status_code = 409
    code = "runtime_not_configured"


class DeviceRuntimeNotStartedError(DeviceRuntimeError):
    """The instance is configured but the user has not started it."""

    status_code = 409
    code = "runtime_not_started"


NAMED_INSTANCE_REQUIRED_FIELDS_KEY = "requiredForNamedInstance"


def _config_schema_for_instance(
    schema: dict[str, Any],
    ui_schema: dict[str, Any],
    *,
    named: bool,
) -> dict[str, Any]:
    if not named:
        return schema
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return schema
    configured_fields = ui_schema.get(NAMED_INSTANCE_REQUIRED_FIELDS_KEY)
    if not isinstance(configured_fields, list):
        configured_fields = []
    required_for_instance = [
        field
        for field in configured_fields
        if isinstance(field, str) and field in properties
    ]
    if not required_for_instance:
        return schema
    existing_required = schema.get("required")
    required = list(existing_required) if isinstance(existing_required, list) else []
    return {
        **schema,
        "required": list(dict.fromkeys([*required, *required_for_instance])),
    }


class DeviceRuntimeService:
    def __init__(
        self,
        store: DeviceRuntimeRepository,
        manager: ConnectorRpcManager,
        timeline_broker: TimelineBroker | None = None,
        coordinator: RedisCoordinator | None = None,
        runtime_state_cache: SessionRuntimeStateCache | None = None,
        timeline_write_buffer: TimelineWriteBuffer | None = None,
        terminal_broker: TerminalBroker | None = None,
    ) -> None:
        self._store = store
        self._manager = manager
        self._timeline_broker = timeline_broker
        self._coordinator = coordinator
        self._runtime_state_cache = runtime_state_cache
        self._timeline_write_buffer = timeline_write_buffer
        self._terminal_broker = terminal_broker
        self._locks: dict[tuple[str, str], asyncio.Lock] = {}
        self._locks_guard = asyncio.Lock()

    async def list_runtimes(
        self, connector_id: str, *, user_id: str
    ) -> list[DeviceRuntimeView]:
        try:
            rows = await self._store.list_device_runtimes(connector_id, user_id=user_id)
        except KeyError as exc:
            raise DeviceRuntimeNotFoundError("connector not found") from exc
        return [DeviceRuntimeView.model_validate(row) for row in rows]

    async def get_runtime(
        self,
        connector_id: str,
        runtime_id: str,
        *,
        user_id: str,
    ) -> DeviceRuntimeView:
        return await self._get_owned(connector_id, runtime_id, user_id=user_id)

    async def list_runtime_types(
        self,
        connector_id: str,
        *,
        user_id: str,
    ) -> list[RuntimeTypeView]:
        try:
            rows = await self._store.list_connector_runtime_types(
                connector_id,
                user_id=user_id,
            )
        except KeyError as exc:
            raise DeviceRuntimeNotFoundError("connector not found") from exc
        return [RuntimeTypeView.model_validate(row) for row in rows]

    async def ingest_runtime_types(
        self,
        connector_id: str,
        response: RuntimeDiscoveryResponse,
        *,
        publish: bool = True,
    ) -> list[RuntimeTypeView]:
        rows = await self._store.replace_connector_runtime_types(
            connector_id,
            response.runtimeTypes,
        )
        if publish:
            await self._publish(connector_id, "runtime.types")
        return [RuntimeTypeView.model_validate(row) for row in rows]

    async def discover_connection(
        self,
        connector_id: str,
        connection: ConnectorConnection,
    ) -> str:
        return await self._discover(
            connector_id,
            connection=connection,
        )

    async def publish_discovery(self, connector_id: str, reason: str) -> None:
        await self._publish(connector_id, reason)

    async def discover(
        self, connector_id: str, *, user_id: str
    ) -> list[DeviceRuntimeView]:
        await self.list_runtimes(connector_id, user_id=user_id)
        reason = await self._discover(connector_id)
        await self.publish_discovery(connector_id, reason)
        await self.reconcile_active(connector_id)
        return await self.list_runtimes(connector_id, user_id=user_id)

    async def discover_runtime_types(
        self,
        connector_id: str,
        *,
        user_id: str,
    ) -> list[RuntimeTypeView]:
        await self.list_runtime_types(connector_id, user_id=user_id)
        reason = await self._discover(connector_id)
        await self.publish_discovery(connector_id, reason)
        await self.reconcile_active(connector_id)
        return await self.list_runtime_types(connector_id, user_id=user_id)

    async def _discover(
        self,
        connector_id: str,
        *,
        connection: ConnectorConnection | None = None,
    ) -> str:
        result, connection_id = await self._request_discovery(
            connector_id,
            connection=connection,
        )
        async with self._runtime_lock(connector_id, "@instances"):
            if not await self._manager.is_connection_id_current(
                connector_id,
                connection_id,
            ):
                raise DeviceRuntimeOfflineError("connector connection was replaced")
            return await self._ingest_discovery(connector_id, result)

    async def _request_discovery(
        self,
        connector_id: str,
        *,
        connection: ConnectorConnection | None = None,
    ) -> tuple[Any, str]:
        if connection is None and not await self._manager.is_online(connector_id):
            raise DeviceRuntimeOfflineError("connector is offline")
        try:
            params: dict[str, Any] = {}
            if connection is None:
                return await self._manager.request_bound(
                    connector_id,
                    "runtime.discover",
                    params,
                    timeout=_runtime_rpc_timeout_seconds(),
                )
            else:
                result = await self._manager.request_on_connection(
                    connection,
                    "runtime.discover",
                    params,
                    timeout=_runtime_rpc_timeout_seconds(),
                )
                return result, connection.connection_id
        except ConnectorOfflineError as exc:
            raise DeviceRuntimeOfflineError(str(exc)) from exc
        except ConnectorRpcError as exc:
            raise DeviceRuntimeUpstreamError(
                exc.message,
                detail={"code": exc.code, "message": exc.message},
            ) from exc

    async def _ingest_discovery(
        self,
        connector_id: str,
        result: Any,
    ) -> str:
        if not isinstance(result, dict):
            raise DeviceRuntimeUpstreamError(
                "connector returned an invalid runtime discovery response"
            )
        try:
            response = RuntimeDiscoveryResponse.model_validate(result)
            await self.ingest_runtime_types(connector_id, response, publish=False)
            return "runtime.types"
        except (ValidationError, ValueError) as exc:
            raise DeviceRuntimeUpstreamError(
                "connector returned an invalid runtime discovery response",
                detail={"code": "invalid_runtime_discovery", "message": str(exc)},
            ) from exc

    async def create_runtime(
        self,
        connector_id: str,
        *,
        runtime_type: str,
        name: str,
        config: dict[str, Any],
        active: bool,
        user_id: str,
    ) -> DeviceRuntimeView:
        async with self._runtime_lock(connector_id, "@instances"):
            try:
                runtime_type_row = RuntimeTypeView.model_validate(
                    await self._store.get_connector_runtime_type(
                        connector_id,
                        runtime_type,
                        user_id=user_id,
                    )
                )
            except KeyError as exc:
                raise DeviceRuntimeNotFoundError("runtime type not found") from exc
            if not runtime_type_row.present:
                raise DeviceRuntimeConflictError(
                    "runtime type is not currently present on the connector"
                )
            if runtime_type_row.schema_ is None:
                raise DeviceRuntimeConflictError("runtime config schema is unavailable")
            self._validate(
                config,
                _config_schema_for_instance(
                    runtime_type_row.schema_,
                    runtime_type_row.uiSchema,
                    named=True,
                ),
            )
            if not await self._manager.is_online(connector_id):
                raise DeviceRuntimeOfflineError("connector is offline")

            try:
                runtime = DeviceRuntimeView.model_validate(
                    await self._store.create_device_runtime(
                        connector_id,
                        runtime_type=runtime_type,
                        name=name,
                        config=config,
                        active=active,
                    )
                )
            except KeyError as exc:
                raise DeviceRuntimeNotFoundError("runtime type not found") from exc
            except ValueError as exc:
                raise DeviceRuntimeConflictError(str(exc)) from exc

            try:
                await self._request_validate(runtime, config)
            except DeviceRuntimeError as exc:
                error = (
                    exc.detail
                    if isinstance(exc.detail, dict)
                    else {"code": exc.code, "message": exc.message}
                )
                await self._store.set_device_runtime_status(
                    connector_id,
                    runtime.runtimeId,
                    "error",
                    error=error,
                )
                raise
            if active:
                runtime = await self._start_locked(runtime)
            await self._publish(connector_id, "runtime.created")
            return runtime

    async def rename_runtime(
        self,
        connector_id: str,
        runtime_id: str,
        name: str,
        *,
        user_id: str,
    ) -> DeviceRuntimeView:
        async with self._runtime_lock(connector_id, runtime_id):
            await self._get_owned(
                connector_id,
                runtime_id,
                user_id=user_id,
            )
            try:
                renamed = DeviceRuntimeView.model_validate(
                    await self._store.rename_device_runtime(
                        connector_id,
                        runtime_id,
                        name,
                    )
                )
            except ValueError as exc:
                raise DeviceRuntimeConflictError(str(exc)) from exc
            await self._publish(connector_id, "runtime.renamed")
            return renamed

    async def put_config(
        self,
        connector_id: str,
        runtime_id: str,
        config: dict[str, Any],
        *,
        user_id: str,
    ) -> DeviceRuntimeView:
        async with self._runtime_lock(connector_id, runtime_id):
            runtime = await self._get_owned(connector_id, runtime_id, user_id=user_id)
            schema = _config_schema_for_instance(
                self._schema(runtime),
                runtime.uiSchema,
                named=runtime.runtimeId != runtime.runtimeType,
            )
            self._validate(config, schema)
            if not await self._manager.is_online(connector_id):
                raise DeviceRuntimeOfflineError("connector is offline")
            try:
                await self._request_validate(runtime, config)
            except DeviceRuntimeError as exc:
                error = (
                    exc.detail
                    if isinstance(exc.detail, dict)
                    else {"code": exc.code, "message": exc.message}
                )
                await self._store.set_device_runtime_status(
                    connector_id,
                    runtime_id,
                    "error",
                    error=error,
                )
                raise
            runtime = DeviceRuntimeView.model_validate(
                await self._store.set_device_runtime_config(
                    connector_id, runtime_id, config
                )
            )
            if runtime.active:
                runtime = await self._restart_locked(runtime)
            elif runtime.status != "stopped":
                # A successful configuration without activation settles on the
                # configured-but-not-started state instead of leaving a stale
                # status such as error behind.
                runtime = DeviceRuntimeView.model_validate(
                    await self._store.set_device_runtime_status(
                        connector_id,
                        runtime_id,
                        "stopped",
                    )
                )
            await self._publish(connector_id, "runtime.config")
            return runtime

    async def set_active(
        self,
        connector_id: str,
        runtime_id: str,
        active: bool,
        *,
        user_id: str,
    ) -> DeviceRuntimeView:
        async with self._runtime_lock(connector_id, runtime_id):
            runtime = await self._get_owned(connector_id, runtime_id, user_id=user_id)
            if active:
                if not runtime.configured or runtime.config is None:
                    raise DeviceRuntimeNotConfiguredError(
                        "runtime must be configured before activation"
                    )
                if not await self._manager.is_online(connector_id):
                    raise DeviceRuntimeOfflineError("connector is offline")
                # Activation is the explicit start signal, so the connector
                # performs the live availability check for the runtime type.
                await self._store.set_device_runtime_active(
                    connector_id, runtime_id, True
                )
                runtime = await self._start_locked(runtime)
            else:
                await self._store.set_device_runtime_active(
                    connector_id, runtime_id, False
                )
                runtime = await self._stop_locked(runtime, allow_offline=True)
            await self._publish(connector_id, "runtime.active")
            return runtime

    async def ensure_active_running(
        self,
        connector_id: str,
        runtime_id: str,
        *,
        user_id: str | None,
    ) -> DeviceRuntimeView:
        async with self._runtime_lock(connector_id, runtime_id):
            runtime = await self._get_owned(connector_id, runtime_id, user_id=user_id)
            if not runtime.active:
                raise DeviceRuntimeNotStartedError("runtime is not started")
            if not runtime.configured or runtime.config is None:
                raise DeviceRuntimeNotConfiguredError(
                    "runtime must be configured before use"
                )
            if not await self._manager.is_online(connector_id):
                raise DeviceRuntimeOfflineError("connector is offline")

            current = DeviceRuntimeView.model_validate(
                await self._store.get_device_runtime(connector_id, runtime_id)
            )
            if current.status == "running":
                return current
            started = await self._start_locked(current)
            await self._publish(connector_id, "runtime.ensure_running")
            return started

    async def ensure_session_routable(
        self,
        connector_id: str,
        *,
        runtime_type: str,
        runtime_id: str,
        user_id: str | None,
        ensure_running: bool,
    ) -> DeviceRuntimeView | None:
        if runtime_id == runtime_type:
            return None
        runtime = await self._get_owned(
            connector_id,
            runtime_id,
            user_id=user_id,
        )
        if runtime.runtimeType != runtime_type:
            raise DeviceRuntimeConflictError("runtime instance type mismatch")
        if ensure_running:
            return await self.ensure_active_running(
                connector_id,
                runtime_id,
                user_id=user_id,
            )
        return runtime

    async def delete_config(
        self,
        connector_id: str,
        runtime_id: str,
        *,
        user_id: str,
    ) -> DeviceRuntimeView:
        async with self._runtime_lock(connector_id, runtime_id):
            runtime = await self._get_owned(connector_id, runtime_id, user_id=user_id)
            if runtime.active or runtime.status in {
                "starting",
                "running",
                "stopping",
                "error",
                "unknown",
            }:
                if not await self._manager.is_online(connector_id):
                    raise DeviceRuntimeOfflineError(
                        "connector must be online before deleting a running runtime"
                    )
                await self._store.set_device_runtime_active(
                    connector_id, runtime_id, False
                )
                runtime = await self._stop_locked(runtime, allow_offline=False)
            session_ids = await self._store.clear_device_runtime_config(
                connector_id, runtime_id
            )
            for session_id in session_ids:
                if self._terminal_broker is not None:
                    for terminal in await self._terminal_broker.get_for_session(
                        session_id
                    ):
                        await self._terminal_broker.remove(terminal.id)
                if self._timeline_write_buffer is not None:
                    await self._timeline_write_buffer.discard_session(session_id)
                if self._runtime_state_cache is not None:
                    await self._runtime_state_cache.discard(session_id)
            runtime = await self._get_owned(connector_id, runtime_id, user_id=user_id)
            await self._publish(connector_id, "runtime.config_deleted")
            return runtime

    async def apply_status(
        self,
        connector_id: str,
        runtime_id: str,
        status: str,
        *,
        error: dict[str, Any] | None = None,
        expected_connection_id: str | None = None,
    ) -> DeviceRuntimeView | None:
        if status not in {
            "stopped",
            "discovering",
            "available",
            "unavailable",
            "validating",
            "starting",
            "running",
            "stopping",
            "error",
            "unknown",
        }:
            raise ValueError(f"unsupported runtime status: {status}")
        async with self._runtime_lock(connector_id, runtime_id):
            if (
                expected_connection_id is not None
                and not await self._manager.is_connection_id_current(
                    connector_id,
                    expected_connection_id,
                )
            ):
                return None
            try:
                current = DeviceRuntimeView.model_validate(
                    await self._store.get_device_runtime(connector_id, runtime_id)
                )
                if current.active and status in {
                    "discovering",
                    "available",
                    "unavailable",
                }:
                    return current
                runtime = DeviceRuntimeView.model_validate(
                    await self._store.set_device_runtime_status(
                        connector_id,
                        runtime_id,
                        status,
                        error=error,
                    )
                )
            except KeyError as exc:
                raise DeviceRuntimeNotFoundError("runtime not found") from exc
        await self._publish(connector_id, "runtime.status")
        return runtime

    async def reconcile_active(
        self,
        connector_id: str,
        *,
        expected_connection_id: str | None = None,
        connection: ConnectorConnection | None = None,
    ) -> None:
        if connection is not None:
            if connection.connector_id != connector_id:
                raise ValueError("runtime reconciliation connector mismatch")
            if (
                expected_connection_id is not None
                and expected_connection_id != connection.connection_id
            ):
                raise ValueError("runtime reconciliation connection mismatch")
            expected_connection_id = connection.connection_id
        if (
            expected_connection_id is not None
            and not await self._manager.is_connection_id_current(
                connector_id,
                expected_connection_id,
            )
        ):
            return
        try:
            rows = await self._store.list_device_runtimes(connector_id)
        except KeyError:
            return
        for row in rows:
            runtime = DeviceRuntimeView.model_validate(row)
            if not runtime.present:
                continue
            async with self._runtime_lock(connector_id, runtime.runtimeId):
                if (
                    expected_connection_id is not None
                    and not await self._manager.is_connection_id_current(
                        connector_id,
                        expected_connection_id,
                    )
                ):
                    return
                current = DeviceRuntimeView.model_validate(
                    await self._store.get_device_runtime(
                        connector_id, runtime.runtimeId
                    )
                )
                if not current.present:
                    continue
                if not current.active:
                    if current.status in {"starting", "running", "stopping", "unknown"}:
                        try:
                            await self._stop_locked(
                                current,
                                allow_offline=True,
                                connection=connection,
                            )
                        except DeviceRuntimeError:
                            pass
                    continue
                if current.config is None:
                    continue
                try:
                    await self._start_locked(current, connection=connection)
                except DeviceRuntimeError as exc:
                    logger.warning(
                        "active runtime reconciliation failed "
                        "connector_id={} runtime_id={} error_code={} error={}",
                        connector_id,
                        current.runtimeId,
                        exc.code,
                        exc.message,
                    )
                    continue
        await self._publish(connector_id, "runtime.reconciled")

    async def _start_locked(
        self,
        runtime: DeviceRuntimeView,
        *,
        connection: ConnectorConnection | None = None,
    ) -> DeviceRuntimeView:
        assert runtime.config is not None
        await self._store.set_device_runtime_status(
            runtime.connectorId, runtime.runtimeId, "starting"
        )
        params = {
            "runtime": runtime.runtimeType,
            "runtimeId": runtime.runtimeId,
            "name": runtime.name,
            "config": runtime.config,
            "configRevision": _config_revision(runtime),
        }
        try:
            if connection is None:
                result = await self._manager.request(
                    runtime.connectorId,
                    "runtime.start",
                    params,
                    timeout=_runtime_rpc_timeout_seconds(),
                )
            else:
                result = await self._manager.request_on_connection(
                    connection,
                    "runtime.start",
                    params,
                    timeout=_runtime_rpc_timeout_seconds(),
                )
        except ConnectorOfflineError as exc:
            await self._store.set_device_runtime_status(
                runtime.connectorId,
                runtime.runtimeId,
                "unknown",
                error={"code": "connector_offline", "message": str(exc)},
            )
            raise DeviceRuntimeOfflineError(str(exc)) from exc
        except ConnectorRpcError as exc:
            row = await self._store.set_device_runtime_status(
                runtime.connectorId,
                runtime.runtimeId,
                "error",
                error={"code": exc.code, "message": exc.message},
            )
            raise DeviceRuntimeUpstreamError(exc.message, detail=row["error"]) from exc
        # A local service may be waiting for its Bridge while the switch stays on.
        # Older connectors omit status on successful starts.
        status = result.get("status", "running")
        if status not in {"starting", "running", "error"}:
            status = "running"
        error = result.get("error")
        return DeviceRuntimeView.model_validate(
            await self._store.set_device_runtime_status(
                runtime.connectorId,
                runtime.runtimeId,
                status,
                error=error if isinstance(error, dict) else None,
            )
        )

    async def _stop_locked(
        self,
        runtime: DeviceRuntimeView,
        *,
        allow_offline: bool,
        connection: ConnectorConnection | None = None,
    ) -> DeviceRuntimeView:
        if runtime.status == "stopped":
            await self._settle_runtime_sessions(runtime)
            return DeviceRuntimeView.model_validate(
                await self._store.set_device_runtime_status(
                    runtime.connectorId,
                    runtime.runtimeId,
                    "stopped",
                )
            )
        if connection is None:
            online = await self._manager.is_online(runtime.connectorId)
        else:
            online = await self._manager.is_connection_id_current(
                runtime.connectorId,
                connection.connection_id,
            )
        if not online:
            if not allow_offline:
                raise DeviceRuntimeOfflineError("connector is offline")
            if connection is not None:
                raise DeviceRuntimeOfflineError("connector connection was replaced")
            return DeviceRuntimeView.model_validate(
                await self._store.set_device_runtime_status(
                    runtime.connectorId,
                    runtime.runtimeId,
                    "unknown",
                )
            )
        await self._store.set_device_runtime_status(
            runtime.connectorId, runtime.runtimeId, "stopping"
        )
        params = {
            "runtime": runtime.runtimeType,
            "runtimeId": runtime.runtimeId,
        }
        try:
            if connection is None:
                await self._manager.request(
                    runtime.connectorId,
                    "runtime.stop",
                    params,
                    timeout=_runtime_rpc_timeout_seconds(),
                )
            else:
                await self._manager.request_on_connection(
                    connection,
                    "runtime.stop",
                    params,
                    timeout=_runtime_rpc_timeout_seconds(),
                )
        except ConnectorOfflineError as exc:
            await self._store.set_device_runtime_status(
                runtime.connectorId, runtime.runtimeId, "unknown"
            )
            raise DeviceRuntimeOfflineError(str(exc)) from exc
        except ConnectorRpcError as exc:
            await self._store.set_device_runtime_status(
                runtime.connectorId,
                runtime.runtimeId,
                "error",
                error={"code": exc.code, "message": exc.message},
            )
            raise DeviceRuntimeUpstreamError(
                exc.message,
                detail={"code": exc.code, "message": exc.message},
            ) from exc
        await self._settle_runtime_sessions(runtime)
        return DeviceRuntimeView.model_validate(
            await self._store.set_device_runtime_status(
                runtime.connectorId,
                runtime.runtimeId,
                "stopped",
            )
        )

    async def _restart_locked(self, runtime: DeviceRuntimeView) -> DeviceRuntimeView:
        if runtime.status in {"starting", "running", "stopping", "unknown"}:
            runtime = await self._stop_locked(runtime, allow_offline=False)
        return await self._start_locked(runtime)

    async def _settle_runtime_sessions(self, runtime: DeviceRuntimeView) -> None:
        sessions = await self._store.list_running_sessions_for_connector_agent(
            connector_id=runtime.connectorId,
            runtime_id=runtime.runtimeId,
        )
        for session in sessions:
            async with self._store.session_revision_fence(session.id):
                await self._store.clear_active_run(session.id)
                if self._runtime_state_cache is not None:
                    await self._runtime_state_cache.discard(session.id)
                await self._store.set_session_status(session.id, "idle")
                if self._timeline_broker is not None:
                    await self._timeline_broker.publish(
                        session.id,
                        {
                            "sessionId": session.id,
                            "nextSeq": await self._store.get_session_seq(session.id),
                            "refetch": True,
                        },
                    )

    async def _request_validate(
        self,
        runtime: DeviceRuntimeView,
        config: dict[str, Any],
    ) -> None:
        params = {
            "runtime": runtime.runtimeType,
            "runtimeId": runtime.runtimeId,
            "name": runtime.name,
            "config": config,
            "configRevision": _config_revision(runtime),
        }
        try:
            await self._manager.request(
                runtime.connectorId,
                "runtime.validateConfig",
                params,
                timeout=_runtime_rpc_timeout_seconds(),
            )
        except ConnectorOfflineError as exc:
            raise DeviceRuntimeOfflineError(str(exc)) from exc
        except ConnectorRpcError as exc:
            status_code = (
                422 if exc.code in {"invalid_config", "runtime_config_invalid"} else 502
            )
            error_cls = (
                DeviceRuntimeInvalidConfigError
                if status_code == 422
                else DeviceRuntimeUpstreamError
            )
            raise error_cls(
                exc.message,
                detail={"code": exc.code, "message": exc.message},
            ) from exc

    async def _get_owned(
        self,
        connector_id: str,
        runtime_id: str,
        *,
        user_id: str | None,
    ) -> DeviceRuntimeView:
        try:
            row = await self._store.get_device_runtime(
                connector_id,
                runtime_id,
                user_id=user_id,
            )
        except KeyError as exc:
            raise DeviceRuntimeNotFoundError("runtime not found") from exc
        return DeviceRuntimeView.model_validate(row)

    @staticmethod
    def _schema(runtime: DeviceRuntimeView) -> dict[str, Any]:
        if runtime.schema_ is None:
            raise DeviceRuntimeConflictError("runtime config schema is unavailable")
        return runtime.schema_

    @staticmethod
    def _validate(config: dict[str, Any], schema: dict[str, Any]) -> None:
        try:
            validate_config(config, schema)
        except RuntimeConfigValidationError as exc:
            raise DeviceRuntimeInvalidConfigError(
                "runtime config validation failed",
                detail={
                    "code": "invalid_runtime_config",
                    "message": "runtime config validation failed",
                    "issues": [issue.model_dump() for issue in exc.issues],
                },
            ) from exc

    async def _lock(self, connector_id: str, runtime_id: str) -> asyncio.Lock:
        key = (connector_id, runtime_id)
        async with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[key] = lock
            return lock

    @asynccontextmanager
    async def _runtime_lock(
        self,
        connector_id: str,
        runtime_id: str,
    ) -> AsyncIterator[None]:
        if self._coordinator is not None:
            async with self._coordinator.lock(f"runtime:{connector_id}:{runtime_id}"):
                yield
            return
        lock = await self._lock(connector_id, runtime_id)
        async with lock:
            yield

    async def _publish(self, connector_id: str, reason: str) -> None:
        if self._timeline_broker is None:
            return
        await publish_dashboard_changed(
            self._store,
            self._timeline_broker,
            connector_id=connector_id,
            reason=reason,
        )


def _config_revision(runtime: DeviceRuntimeView) -> int:
    value = runtime.updatedAt
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return 1
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return min(
        MAX_JAVASCRIPT_SAFE_INTEGER,
        max(1, int(parsed.timestamp() * 1000)),
    )
