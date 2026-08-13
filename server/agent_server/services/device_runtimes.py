from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from agent_server.core.device_runtime import (
    DeviceRuntimeView,
    RuntimeConfigValidationError,
    RuntimeTypeCatalog,
    RuntimeTypeView,
    validate_config,
    validate_config_schema,
)
from agent_server.infra.connector_rpc import (
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

    async def list_runtime_types(
        self, connector_id: str, *, user_id: str
    ) -> list[RuntimeTypeView]:
        try:
            rows = await self._store.list_connector_runtime_types(
                connector_id, user_id=user_id
            )
        except KeyError as exc:
            raise DeviceRuntimeNotFoundError("connector not found") from exc
        return [RuntimeTypeView.model_validate(row) for row in rows]

    async def ingest_runtime_types(
        self,
        connector_id: str,
        raw: dict[str, Any],
    ) -> list[RuntimeTypeView]:
        catalog = RuntimeTypeCatalog.model_validate(raw)
        for runtime_type in catalog.runtimeTypes:
            if runtime_type.schema_ is not None:
                validate_config_schema(runtime_type.schema_)
        rows = await self._store.replace_connector_runtime_types(
            connector_id, catalog.runtimeTypes
        )
        await self._publish(connector_id, "runtime.types")
        return [RuntimeTypeView.model_validate(row) for row in rows]

    async def discover(
        self, connector_id: str, *, user_id: str
    ) -> list[RuntimeTypeView]:
        await self.list_runtime_types(connector_id, user_id=user_id)
        if not await self._manager.is_online(connector_id):
            raise DeviceRuntimeOfflineError("connector is offline")
        try:
            result = await self._manager.request(
                connector_id, "runtime.discover", {}, timeout=90
            )
        except ConnectorOfflineError as exc:
            raise DeviceRuntimeOfflineError(str(exc)) from exc
        except ConnectorRpcError as exc:
            raise DeviceRuntimeUpstreamError(
                exc.message,
                detail={"code": exc.code, "message": exc.message},
            ) from exc
        if not isinstance(result, dict):
            raise DeviceRuntimeUpstreamError(
                "connector returned an invalid runtime type catalog"
            )
        await self.ingest_runtime_types(connector_id, result)
        await self.reconcile_active(connector_id)
        return await self.list_runtime_types(connector_id, user_id=user_id)

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
        try:
            runtime_type_row = RuntimeTypeView.model_validate(
                await self._store.get_connector_runtime_type(
                    connector_id, runtime_type, user_id=user_id
                )
            )
        except KeyError as exc:
            raise DeviceRuntimeNotFoundError("runtime type not found") from exc
        if not runtime_type_row.available:
            raise DeviceRuntimeConflictError("runtime type is not available")
        if runtime_type_row.schema_ is None:
            raise DeviceRuntimeConflictError("runtime config schema is unavailable")
        self._validate(config, runtime_type_row.schema_)
        if not await self._manager.is_online(connector_id):
            raise DeviceRuntimeOfflineError("connector is offline")

        runtime_id = f"rti_{secrets.token_urlsafe(12)}"
        async with self._runtime_lock(connector_id, runtime_id):
            try:
                runtime = DeviceRuntimeView.model_validate(
                    await self._store.create_device_runtime(
                        connector_id,
                        runtime_id=runtime_id,
                        runtime_type=runtime_type,
                        name=name,
                        config=config,
                        active=active,
                    )
                )
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
                    runtime_id,
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
            current = await self._get_owned(
                connector_id, runtime_id, user_id=user_id
            )
            try:
                renamed = DeviceRuntimeView.model_validate(
                    await self._store.rename_device_runtime(
                        connector_id, runtime_id, name
                    )
                )
            except ValueError as exc:
                raise DeviceRuntimeConflictError(str(exc)) from exc
            if current.status == "running" and renamed.config is not None:
                renamed = await self._start_locked(renamed)
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
                runtime = await self._start_locked(runtime)
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
                    raise DeviceRuntimeConflictError(
                        "runtime must be configured before activation"
                    )
                if not runtime.available:
                    raise DeviceRuntimeConflictError(
                        "runtime type is not currently available on the connector"
                    )
                if not await self._manager.is_online(connector_id):
                    raise DeviceRuntimeOfflineError("connector is offline")
                self._validate(runtime.config, self._schema(runtime))
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
        user_id: str,
    ) -> DeviceRuntimeView:
        async with self._runtime_lock(connector_id, runtime_id):
            runtime = await self._get_owned(connector_id, runtime_id, user_id=user_id)
            if not runtime.active:
                raise DeviceRuntimeConflictError("runtime is not active")
            if not runtime.configured or runtime.config is None:
                raise DeviceRuntimeConflictError(
                    "runtime must be configured before use"
                )
            if not runtime.available:
                raise DeviceRuntimeConflictError(
                    "runtime type is not currently available on the connector"
                )
            if not await self._manager.is_online(connector_id):
                raise DeviceRuntimeOfflineError("connector is offline")

            current = DeviceRuntimeView.model_validate(
                await self._store.get_device_runtime(connector_id, runtime_id)
            )
            if current.status == "running":
                return current
            self._validate(current.config, self._schema(current))
            started = await self._start_locked(current)
            await self._publish(connector_id, "runtime.ensure_running")
            return started

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
            if not runtime.available:
                continue
            async with self._runtime_lock(connector_id, runtime.runtimeId):
                current = DeviceRuntimeView.model_validate(
                    await self._store.get_device_runtime(
                        connector_id, runtime.runtimeId
                    )
                )
                if not current.available:
                    continue
                if not current.active:
                    continue
                if current.config is None:
                    continue
                try:
                    self._validate(current.config, self._schema(current))
                    await self._start_locked(current)
                except DeviceRuntimeError:
                    continue
        await self._publish(connector_id, "runtime.reconciled")

    async def _start_locked(self, runtime: DeviceRuntimeView) -> DeviceRuntimeView:
        assert runtime.config is not None
        await self._store.set_device_runtime_status(
            runtime.connectorId, runtime.runtimeId, "starting"
        )
        try:
            await self._manager.request(
                runtime.connectorId,
                "runtime.start",
                {
                    "runtimeId": runtime.runtimeId,
                    "runtimeType": runtime.runtimeType,
                    "name": runtime.name,
                    "config": runtime.config,
                    "configRevision": _config_revision(runtime.config),
                },
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
        try:
            await self._manager.request(
                runtime.connectorId,
                "runtime.stop",
                {"runtimeId": runtime.runtimeId, "reason": "server_requested"},
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

    async def _settle_runtime_sessions(self, runtime: DeviceRuntimeView) -> None:
        sessions = await self._store.list_running_sessions_for_connector_agent(
            connector_id=runtime.connectorId,
            runtime=runtime.runtimeId,
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
        try:
            await self._manager.request(
                runtime.connectorId,
                "runtime.validateConfig",
                {
                    "runtimeId": runtime.runtimeId,
                    "runtimeType": runtime.runtimeType,
                    "name": runtime.name,
                    "config": config,
                    "configRevision": _config_revision(config),
                },
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

    async def _get_owned(
        self,
        connector_id: str,
        runtime_id: str,
        *,
        user_id: str,
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


def _config_revision(config: dict[str, Any]) -> int:
    encoded = json.dumps(
        config,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return max(1, int(hashlib.sha256(encoded).hexdigest()[:13], 16))
