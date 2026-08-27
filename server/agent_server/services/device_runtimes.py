from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from loguru import logger
from pydantic import ValidationError

from agent_server.core.device_runtime import (
    MAX_JAVASCRIPT_SAFE_INTEGER,
    DeviceRuntimeView,
    RuntimeConfigValidationError,
    RuntimeDiscoverV2Response,
    RuntimeInventory,
    RuntimeTypeView,
    validate_config,
    validate_config_schema,
)
from agent_server.infra.connector_rpc import (
    ConnectorConnection,
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.repository_ports import DeviceRuntimeRepository
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache


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


class DeviceRuntimeInstancesUnsupportedError(DeviceRuntimeError):
    status_code = 409
    code = "runtime_instances_unsupported"


SUPPORTED_RUNTIME_CONTROL_VERSIONS = ["2.0", "1.0"]


class DeviceRuntimeService:
    def __init__(
        self,
        store: DeviceRuntimeRepository,
        manager: ConnectorRpcManager,
        timeline_broker: TimelineBroker | None = None,
        coordinator: RedisCoordinator | None = None,
        runtime_state_cache: SessionRuntimeStateCache | None = None,
    ) -> None:
        self._store = store
        self._manager = manager
        self._timeline_broker = timeline_broker
        self._coordinator = coordinator
        self._runtime_state_cache = runtime_state_cache
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
        response: RuntimeDiscoverV2Response,
    ) -> list[RuntimeTypeView]:
        rows = await self._store.replace_connector_runtime_types(
            connector_id,
            response.runtimeTypes,
        )
        await self._publish(connector_id, "runtime.types")
        return [RuntimeTypeView.model_validate(row) for row in rows]

    async def ingest_inventory(
        self,
        connector_id: str,
        raw: dict[str, Any],
        *,
        select_control_version: bool = True,
    ) -> list[DeviceRuntimeView]:
        inventory = RuntimeInventory.model_validate(raw)
        for runtime in inventory.runtimes:
            if runtime.schema_ is not None:
                validate_config_schema(runtime.schema_)
        rows = await self._store.replace_device_runtime_inventory(
            connector_id,
            inventory.runtimes,
            select_control_version=select_control_version,
        )
        await self._publish(connector_id, "runtime.inventory")
        return [DeviceRuntimeView.model_validate(row) for row in rows]

    async def prepare_connection(self, connector_id: str) -> None:
        async with self._runtime_lock(connector_id, "@instances"):
            await self._store.set_connector_runtime_control_version(
                connector_id,
                "1.0",
            )

    async def ingest_unsolicited_inventory(
        self,
        connector_id: str,
        raw: dict[str, Any],
    ) -> None:
        async with self._runtime_lock(connector_id, "@instances"):
            if await self._get_control_version(connector_id) == "2.0":
                logger.debug(
                    "ignored legacy runtime inventory after v2 negotiation "
                    "connector_id={}",
                    connector_id,
                )
                return
            await self.ingest_inventory(
                connector_id,
                raw,
                select_control_version=False,
            )

    async def negotiate_connection(
        self,
        connector_id: str,
        connection: ConnectorConnection,
    ) -> None:
        await self._discover(
            connector_id,
            connection=connection,
        )
        await self.ensure_default_runtimes(connector_id)
        await self.reconcile_active(connector_id)

    async def discover(
        self, connector_id: str, *, user_id: str
    ) -> list[DeviceRuntimeView]:
        await self.list_runtimes(connector_id, user_id=user_id)
        await self._discover(connector_id)
        await self.ensure_default_runtimes(connector_id)
        await self.reconcile_active(connector_id)
        return await self.list_runtimes(connector_id, user_id=user_id)

    async def discover_runtime_types(
        self,
        connector_id: str,
        *,
        user_id: str,
    ) -> list[RuntimeTypeView]:
        await self.list_runtime_types(connector_id, user_id=user_id)
        await self._discover(connector_id)
        await self.ensure_default_runtimes(connector_id)
        await self.reconcile_active(connector_id)
        return await self.list_runtime_types(connector_id, user_id=user_id)

    async def ensure_default_runtimes(self, connector_id: str) -> None:
        """Create one ready-to-start instance for each usable Agent type."""

        async with self._runtime_lock(connector_id, "@instances"):
            try:
                control_version = await self._get_control_version(connector_id)
                runtime_types = [
                    RuntimeTypeView.model_validate(row)
                    for row in await self._store.list_connector_runtime_types(
                        connector_id
                    )
                ]
                runtimes = [
                    DeviceRuntimeView.model_validate(row)
                    for row in await self._store.list_device_runtimes(connector_id)
                ]
            except KeyError:
                return

            changed = False
            for runtime_type in runtime_types:
                if (
                    not runtime_type.present
                    or not runtime_type.available
                    or runtime_type.schema_ is None
                ):
                    continue

                instances = [
                    runtime
                    for runtime in runtimes
                    if runtime.runtimeType == runtime_type.runtimeType
                ]
                if any(runtime.configured for runtime in instances):
                    continue

                defaults = dict(runtime_type.defaults)
                try:
                    self._validate(defaults, runtime_type.schema_)
                    reusable = min(
                        (runtime for runtime in instances if not runtime.configured),
                        key=lambda runtime: (
                            runtime.runtimeId != runtime.runtimeType,
                            runtime.createdAt,
                            runtime.runtimeId,
                        ),
                        default=None,
                    )
                    if reusable is not None:
                        configured = DeviceRuntimeView.model_validate(
                            await self._store.set_device_runtime_config(
                                connector_id,
                                reusable.runtimeId,
                                defaults,
                            )
                        )
                        configured = DeviceRuntimeView.model_validate(
                            await self._store.set_device_runtime_active(
                                connector_id,
                                configured.runtimeId,
                                True,
                            )
                        )
                    elif control_version == "2.0":
                        configured = DeviceRuntimeView.model_validate(
                            await self._store.create_device_runtime(
                                connector_id,
                                runtime_type=runtime_type.runtimeType,
                                name=_default_runtime_name(runtime_type, runtimes),
                                config=defaults,
                                active=True,
                            )
                        )
                    else:
                        continue
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "default runtime bootstrap failed connector_id={} "
                        "runtime_type={} error_type={} error={}",
                        connector_id,
                        runtime_type.runtimeType,
                        exc.__class__.__name__,
                        exc,
                    )
                    continue

                runtimes = [
                    runtime
                    for runtime in runtimes
                    if runtime.runtimeId != configured.runtimeId
                ]
                runtimes.append(configured)
                changed = True

            if changed:
                await self._publish(connector_id, "runtime.defaults")

    async def _discover(
        self,
        connector_id: str,
        *,
        connection: ConnectorConnection | None = None,
    ) -> None:
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
            await self._ingest_discovery(connector_id, result)

    async def _request_discovery(
        self,
        connector_id: str,
        *,
        connection: ConnectorConnection | None = None,
    ) -> tuple[Any, str]:
        if connection is None and not await self._manager.is_online(connector_id):
            raise DeviceRuntimeOfflineError("connector is offline")
        try:
            params = {
                "supportedControlVersions": SUPPORTED_RUNTIME_CONTROL_VERSIONS,
            }
            if connection is None:
                return await self._manager.request_bound(
                    connector_id,
                    "runtime.discover",
                    params,
                    timeout=90,
                )
            else:
                result = await self._manager.request_on_connection(
                    connection,
                    "runtime.discover",
                    params,
                    timeout=90,
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
    ) -> None:
        if not isinstance(result, dict):
            raise DeviceRuntimeUpstreamError(
                "connector returned an invalid runtime discovery response"
            )
        try:
            if result.get("selectedControlVersion") == "2.0":
                response = RuntimeDiscoverV2Response.model_validate(result)
                await self.ingest_runtime_types(connector_id, response)
                return
            if "selectedControlVersion" not in result and "runtimes" in result:
                await self.ingest_inventory(connector_id, result)
                return
        except (ValidationError, ValueError) as exc:
            raise DeviceRuntimeUpstreamError(
                "connector returned an invalid runtime discovery response",
                detail={
                    "code": "invalid_runtime_discovery",
                    "message": str(exc),
                },
            ) from exc
        raise DeviceRuntimeUpstreamError(
            "connector returned an unsupported runtime discovery response",
            detail={
                "code": "invalid_runtime_discovery",
                "message": "connector did not select Runtime Control 2.0 or return a legacy inventory",
            },
        )

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
            control_version = await self._get_control_version(
                connector_id,
                user_id=user_id,
            )
            if control_version != "2.0":
                raise DeviceRuntimeInstancesUnsupportedError(
                    "connector does not support named runtime instances"
                )
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
                raise DeviceRuntimeConflictError(
                    "runtime config schema is unavailable"
                )
            self._validate(config, runtime_type_row.schema_)
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
                if str(exc) == "runtime instances are unsupported":
                    raise DeviceRuntimeInstancesUnsupportedError(
                        "connector does not support named runtime instances"
                    ) from exc
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
            runtime = await self._get_owned(
                connector_id,
                runtime_id,
                user_id=user_id,
            )
            await self._ensure_lifecycle_supported(runtime)
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
            await self._ensure_lifecycle_supported(runtime)
            schema = self._schema(runtime)
            self._validate(config, schema)
            if not await self._manager.is_online(connector_id):
                raise DeviceRuntimeOfflineError("connector is offline")
            await self._request_validate(runtime, config)
            runtime = DeviceRuntimeView.model_validate(
                await self._store.set_device_runtime_config(
                    connector_id, runtime_id, config
                )
            )
            if runtime.active:
                runtime = await self._restart_locked(runtime)
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
            await self._ensure_lifecycle_supported(runtime)
            if active:
                if not runtime.configured or runtime.config is None:
                    raise DeviceRuntimeConflictError(
                        "runtime must be configured before activation"
                    )
                if not runtime.present:
                    raise DeviceRuntimeConflictError(
                        "runtime type is not currently present on the connector"
                    )
                if not await self._manager.is_online(connector_id):
                    raise DeviceRuntimeOfflineError("connector is offline")
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
            await self._ensure_lifecycle_supported(runtime)
            if not runtime.active:
                raise DeviceRuntimeConflictError("runtime is not active")
            if not runtime.configured or runtime.config is None:
                raise DeviceRuntimeConflictError(
                    "runtime must be configured before use"
                )
            if not runtime.present:
                raise DeviceRuntimeConflictError(
                    "runtime type is not currently present on the connector"
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
        control_version = await self._get_control_version(
            connector_id,
            user_id=user_id,
        )
        if control_version not in {"1.0", "2.0"}:
            raise DeviceRuntimeConflictError(
                f"unsupported runtime control version: {control_version}"
            )
        if runtime_id == runtime_type:
            # Legacy sessions predate persisted runtime rows and remain routable
            # through the type-equal compatibility identity.
            return None
        if control_version != "2.0":
            raise DeviceRuntimeInstancesUnsupportedError(
                "connector does not support named runtime instances"
            )
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
            await self._ensure_lifecycle_supported(runtime)
            if runtime.active or runtime.status in {
                "starting",
                "running",
                "stopping",
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
            runtime = DeviceRuntimeView.model_validate(
                await self._store.clear_device_runtime_config(connector_id, runtime_id)
            )
            await self._publish(connector_id, "runtime.config_deleted")
            return runtime

    async def apply_status(
        self,
        connector_id: str,
        runtime_id: str,
        status: str,
        *,
        error: dict[str, Any] | None = None,
    ) -> DeviceRuntimeView:
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

    async def reconcile_active(self, connector_id: str) -> None:
        try:
            rows = await self._store.list_device_runtimes(connector_id)
        except KeyError:
            return
        for row in rows:
            runtime = DeviceRuntimeView.model_validate(row)
            if not runtime.present:
                continue
            async with self._runtime_lock(connector_id, runtime.runtimeId):
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
                            await self._stop_locked(current, allow_offline=True)
                        except DeviceRuntimeError:
                            pass
                    continue
                if current.config is None:
                    continue
                try:
                    await self._start_locked(current)
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

    async def _start_locked(self, runtime: DeviceRuntimeView) -> DeviceRuntimeView:
        assert runtime.config is not None
        control_version = await self._ensure_lifecycle_supported(runtime)
        await self._store.set_device_runtime_status(
            runtime.connectorId, runtime.runtimeId, "starting"
        )
        params = (
            {
                "runtime": runtime.runtimeType,
                "runtimeId": runtime.runtimeId,
                "name": runtime.name,
                "config": runtime.config,
                "configRevision": _config_revision(runtime),
            }
            if control_version == "2.0"
            else {
                "runtimeId": runtime.runtimeId,
                "config": runtime.config,
                "configRevision": _config_revision(runtime),
            }
        )
        try:
            await self._manager.request(
                runtime.connectorId,
                "runtime.start",
                params,
                timeout=90,
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
        return DeviceRuntimeView.model_validate(
            await self._store.set_device_runtime_status(
                runtime.connectorId,
                runtime.runtimeId,
                "running",
            )
        )

    async def _stop_locked(
        self,
        runtime: DeviceRuntimeView,
        *,
        allow_offline: bool,
    ) -> DeviceRuntimeView:
        control_version = await self._ensure_lifecycle_supported(runtime)
        if runtime.status == "stopped":
            await self._settle_runtime_sessions(runtime)
            return DeviceRuntimeView.model_validate(
                await self._store.set_device_runtime_status(
                    runtime.connectorId,
                    runtime.runtimeId,
                    "stopped",
                )
            )
        if not await self._manager.is_online(runtime.connectorId):
            if not allow_offline:
                raise DeviceRuntimeOfflineError("connector is offline")
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
        params = (
            {
                "runtime": runtime.runtimeType,
                "runtimeId": runtime.runtimeId,
            }
            if control_version == "2.0"
            else {"runtimeId": runtime.runtimeId, "reason": "server_requested"}
        )
        try:
            await self._manager.request(
                runtime.connectorId,
                "runtime.stop",
                params,
                timeout=90,
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
        control_version = await self._ensure_lifecycle_supported(runtime)
        params = (
            {
                "runtime": runtime.runtimeType,
                "runtimeId": runtime.runtimeId,
                "name": runtime.name,
                "config": config,
                "configRevision": _config_revision(runtime),
            }
            if control_version == "2.0"
            else {"runtimeId": runtime.runtimeId, "config": config}
        )
        try:
            await self._manager.request(
                runtime.connectorId,
                "runtime.validateConfig",
                params,
                timeout=90,
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

    async def _get_control_version(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> str:
        try:
            return await self._store.get_connector_runtime_control_version(
                connector_id,
                user_id=user_id,
            )
        except KeyError as exc:
            raise DeviceRuntimeNotFoundError("connector not found") from exc

    async def _ensure_lifecycle_supported(
        self,
        runtime: DeviceRuntimeView,
    ) -> str:
        control_version = await self._get_control_version(runtime.connectorId)
        if control_version == "1.0" and runtime.runtimeId != runtime.runtimeType:
            raise DeviceRuntimeInstancesUnsupportedError(
                "connector does not support named runtime instances"
            )
        if control_version not in {"1.0", "2.0"}:
            raise DeviceRuntimeConflictError(
                f"unsupported runtime control version: {control_version}"
            )
        return control_version

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


def _default_runtime_name(
    runtime_type: RuntimeTypeView,
    runtimes: list[DeviceRuntimeView],
) -> str:
    existing = {runtime.name.strip().casefold() for runtime in runtimes}
    if runtime_type.displayName.strip().casefold() not in existing:
        return runtime_type.displayName
    suffix = 2
    while f"{runtime_type.displayName} {suffix}".casefold() in existing:
        suffix += 1
    return f"{runtime_type.displayName} {suffix}"
