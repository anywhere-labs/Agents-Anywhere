from __future__ import annotations

import asyncio
import json
import os
import secrets as token_source
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
    RuntimeDiscoveryResponse,
    RuntimeTypeView,
    validate_config,
)
from agent_server.core.model_connection import (
    connection_digest,
    failed_report,
    stored_report,
)
from agent_server.core.secret_fields import (
    SecretOriginChangedError,
    merge_secrets,
    scrub,
    secret_paths,
    secret_values,
)
from agent_server.infra.connector_presence_registry import ConnectorPresenceRegistry
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.device_commands import DeviceCommandError
from agent_server.services.repository_ports import DeviceRuntimeRepository
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache

# v3 devices (contracts/device-meshcall/1.0): desired state goes out as ``Commands/*``, facts come back
# on ``Link/attach`` as ``runtime.status`` events (contracts/runtime-control/3.0).
RUNTIME_APPLY_COMMAND = "runtime.apply"
CHANNEL_SWITCH_COMMAND = "channel.switch"
# ``runtime.status`` whose ``status.event`` is this carries the device's Runtime type descriptors
# (Runtime Control 2.x ``RuntimeDiscoveryResponse``); ``runtimeId`` is ``*``.
DEVICE_RUNTIME_TYPES_EVENT = "runtime.types"
# The device's ``CommandAck.e.code`` values that mean "this configuration is not accepted".
_DEVICE_INVALID_CONFIG_CODES = frozenset(
    {"invalid_config", "runtime_config_invalid", "model_connection_unsupported", "model_gateway_unsupported"}
)
# A v3 change made while the device is offline is stored and reaches it in ``LinkWelcome.desired``.
WAITING_FOR_DEVICE_PHASE = {"code": "waiting_for_device", "message": "设备离线，上线后自动应用。"}
# Server ``ModelProtocol`` -> device ``ModelGatewayConfig.protocol``.
_DEVICE_GATEWAY_PROTOCOLS = {
    "anthropic": "anthropic",
    "openai_responses": "openai-responses",
    "openai_chat": "openai-chat",
}
_CAPABILITY_CACHE_SECONDS = 7 * 24 * 3600


def device_model_gateway(
    config: dict[str, Any] | None, capability: dict[str, Any] | None
) -> dict[str, Any] | None:
    """The device's ``modelGateway`` from the gateway the Server keeps in ``config[configField]``."""

    if not isinstance(config, dict) or not isinstance(capability, dict):
        return None
    gateway = config.get(str(capability.get("configField") or ""))
    if not isinstance(gateway, dict):
        return None
    base_url, api_key = gateway.get("baseUrl"), gateway.get("apiKey")
    if not isinstance(base_url, str) or not base_url or not isinstance(api_key, str) or not api_key:
        return None
    protocols = capability.get("protocols")
    protocol = gateway.get("protocol")
    if not isinstance(protocol, str) and isinstance(protocols, list) and protocols:
        protocol = protocols[0]
    device_protocol = _DEVICE_GATEWAY_PROTOCOLS.get(str(protocol))
    if device_protocol is None:
        return None
    return {"baseUrl": base_url, "authToken": api_key, "protocol": device_protocol}


def device_runtime_entry(runtime: DeviceRuntimeView, *, active: bool | None = None) -> dict[str, Any]:
    """One desired Runtime instance as a v3 device takes it.

    The payload of ``runtime.apply`` / ``channel.switch`` and the item of ``LinkWelcome.desired.runtimes``:
    ``{runtimeId, runtimeType, name, active, config, revision, modelGateway?}``. ``config`` holds only the
    instance's own settings; a model gateway the Server keeps in ``config[modelConnection.configField]``
    travels as ``modelGateway``. ``revision`` only grows, so a late command never undoes a newer one.
    """

    config = runtime.config
    gateway = device_model_gateway(config, runtime.modelConnection)
    if gateway is not None and isinstance(config, dict):
        field = str((runtime.modelConnection or {}).get("configField"))
        config = {key: value for key, value in config.items() if key != field}
    return {
        "runtimeId": runtime.runtimeId,
        "runtimeType": runtime.runtimeType,
        "name": runtime.name,
        "active": runtime.active if active is None else active,
        "config": config,
        "revision": _config_revision(runtime),
        **({"modelGateway": gateway} if gateway is not None else {}),
    }


def _runtime_rpc_timeout_seconds() -> float:
    """How long ``runtime.apply`` may take on a large corpus; tests shorten this to fail fast."""
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


class DeviceRuntimeOutcomeUnknownError(DeviceRuntimeError):
    """A v3 command opened and then failed: the device may have applied it. Never re-sent."""

    status_code = 504
    code = "command_outcome_unknown"


class DeviceRuntimeUpgradeRequiredError(DeviceRuntimeError):
    """A v2 Connector: its Runtime instances need Agents Anywhere upgraded on that device (D4)."""

    status_code = 409
    code = "device_upgrade_required"

    def __init__(self, message: str = "Upgrade Agents Anywhere on this device to manage its Runtimes.") -> None:
        super().__init__(message)


class DeviceRuntimeNotConfiguredError(DeviceRuntimeError):
    """The instance exists but has no saved configuration yet."""

    status_code = 409
    code = "runtime_not_configured"


class DeviceRuntimeNotStartedError(DeviceRuntimeError):
    """The instance is configured but the user has not started it."""

    status_code = 409
    code = "runtime_not_started"


class DeviceRuntimeStartingError(DeviceRuntimeError):
    """The instance is still starting (for example synchronizing sessions).

    Re-sending ``runtime.start`` would restart it and lose the progress, so
    callers get a retryable conflict instead.
    """

    status_code = 409
    code = "runtime_starting"


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
        manager: ConnectorPresenceRegistry,
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
        # What each device declared it supports (e.g. channelReconcileFence) in its ``runtime.types`` report.
        self._features: dict[str, frozenset[str]] = {}
        # The ``DeviceCommandService`` the app attaches.
        self.device_commands: Any | None = None
        # v3: runtime-level capability sets and the device process id last reported, when Redis is not shared.
        self._capabilities: dict[tuple[str, str], dict[str, Any]] = {}
        self._device_instances: dict[str, str] = {}

    # -- v3 devices (contracts/device-meshcall/1.0, runtime-control/3.0) ------------------------

    async def is_v3_device(self, connector_id: str) -> bool:
        """Whether the connector last linked as a v3 device (MeshCall) rather than over the v2 socket."""

        reader = getattr(self._store, "connector_link_contract", None)
        if reader is None:
            return False
        try:
            return bool(await reader(connector_id))
        except KeyError:
            return False

    async def _require_v3(self, connector_id: str) -> None:
        """Instance management of a v2 Connector answers ``device_upgrade_required`` (D4)."""

        if not await self.is_v3_device(connector_id):
            raise DeviceRuntimeUpgradeRequiredError()

    def _device_commands(self) -> Any:
        if self.device_commands is None:
            raise DeviceRuntimeOfflineError("the device link is not available on this server")
        return self.device_commands

    async def on_device_event(self, device_id: str, method: str, payload: dict[str, Any]) -> None:
        """``DeviceLinkService.event_listeners``: keep what a v3 device reports about its Runtimes.

        - ``status.event == "runtime.types"``: the device's Runtime type descriptors (replaces discovery);
        - ``status.instance``: an instance's ``{status, phase?, error?}`` after it applied desired state;
        - ``status.state`` ``ready``/``degraded``: the running instance's own health;
        - ``capabilities``: the instance's runtime-level capability set.
        """

        if method != "runtime.status" or not isinstance(payload, dict):
            return
        status = payload.get("status")
        runtime_id = payload.get("runtimeId")
        if not isinstance(status, dict):
            return
        if status.get("event") == DEVICE_RUNTIME_TYPES_EVENT:
            await self.ingest_device_runtime_types(device_id, status)
            return
        if not isinstance(runtime_id, str) or not runtime_id:
            return
        capabilities = payload.get("capabilities")
        if isinstance(capabilities, dict):
            await self._remember_capabilities(device_id, runtime_id, capabilities)
        instance = status.get("instance")
        if isinstance(instance, dict):
            await self._apply_device_instance(device_id, runtime_id, instance)
        elif status.get("state") in {"ready", "degraded"}:
            error = status.get("error") if status.get("state") == "degraded" else None
            await self._apply_device_instance(
                device_id, runtime_id, {"status": "running", "error": error if isinstance(error, dict) else None}
            )

    async def ingest_device_runtime_types(self, device_id: str, report: dict[str, Any]) -> bool:
        """Persist a v3 device's Runtime types (``{runtimeTypes, features}``); False when it is malformed."""

        try:
            response = RuntimeDiscoveryResponse.model_validate(
                {"runtimeTypes": report.get("runtimeTypes") or [], "features": report.get("features") or []}
            )
        except (ValidationError, ValueError) as exc:
            logger.warning("ignoring invalid runtime types from device device_id={} error={}", device_id, exc)
            return False
        try:
            async with self._runtime_lock(device_id, "@instances"):
                await self.ingest_runtime_types(device_id, response, publish=False)
                await self._remember_features(device_id, response.features)
        except KeyError:
            return False
        await self._publish(device_id, "runtime.types")
        return True

    async def _apply_device_instance(self, device_id: str, runtime_id: str, instance: dict[str, Any]) -> None:
        status = instance.get("status")
        if status not in {"running", "starting", "stopped", "error", "unknown"}:
            return
        try:
            current = DeviceRuntimeView.model_validate(await self._store.get_device_runtime(device_id, runtime_id))
        except KeyError:
            # A legacy instance the user never configured: the device runs it, the Server has no row.
            return
        if not current.active and status in {"running", "starting"}:
            # The device's default for a type the user did not start; the stored state stays "stopped".
            return
        error = instance.get("error")
        phase = instance.get("phase")
        if (
            current.status == status
            and current.error == (error if isinstance(error, dict) else None)
            and current.phase == _phase_payload(phase if isinstance(phase, dict) else None)
        ):
            return
        try:
            await self.apply_status(
                device_id,
                runtime_id,
                status,
                error=error if isinstance(error, dict) else None,
                phase=phase if isinstance(phase, dict) else None,
                model_connection=instance.get("modelConnection") if isinstance(instance.get("modelConnection"), dict) else None,
            )
        except DeviceRuntimeNotFoundError:
            return

    def _capabilities_key(self, connector_id: str, runtime_id: str) -> str:
        assert self._coordinator is not None
        return self._coordinator.key("runtime-capabilities", connector_id, runtime_id)

    async def _remember_capabilities(self, connector_id: str, runtime_id: str, capability_set: dict[str, Any]) -> None:
        if self._coordinator is not None and self._coordinator.distributed:
            await self._coordinator.client.set(
                self._capabilities_key(connector_id, runtime_id),
                json.dumps(capability_set, separators=(",", ":")),
                ex=_CAPABILITY_CACHE_SECONDS,
            )
            return
        self._capabilities[(connector_id, runtime_id)] = capability_set

    async def runtime_capabilities(self, connector_id: str, runtime_id: str) -> dict[str, Any]:
        """A v3 instance's runtime-level capability set as the device last reported it.

        ``runtime.capabilities`` is not a device-meshcall method: the device reports the set when it
        applies an instance and whenever it changes. Nothing reported yet is an empty set, so clients
        hide what they cannot confirm (for example workspace preparation) instead of failing.
        """

        stored: Any = None
        if self._coordinator is not None and self._coordinator.distributed:
            raw = await self._coordinator.client.get(self._capabilities_key(connector_id, runtime_id))
            try:
                stored = json.loads(raw) if raw else None
            except (TypeError, ValueError):
                stored = None
        else:
            stored = self._capabilities.get((connector_id, runtime_id))
        if not isinstance(stored, dict) or not isinstance(stored.get("capabilities"), list):
            return {"revision": 0, "capabilities": []}
        return stored

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
        owner = await self._store.channel_connector_owner(connector_id)
        if owner is not None:
            async with self._store.channel_transaction(owner):
                rows = await self._store.replace_connector_runtime_types(connector_id, response.runtimeTypes)
                await self._store.refresh_channel_targets(owner)
        else:
            rows = await self._store.replace_connector_runtime_types(connector_id, response.runtimeTypes)
        if publish:
            await self._publish(connector_id, "runtime.types")
        return [RuntimeTypeView.model_validate(row) for row in rows]

    async def discover(
        self, connector_id: str, *, user_id: str
    ) -> list[DeviceRuntimeView]:
        """A device reports its types on its own (``runtime.types``); there is nothing to ask."""

        runtimes = await self.list_runtimes(connector_id, user_id=user_id)
        await self._require_v3(connector_id)
        return runtimes

    async def discover_runtime_types(
        self,
        connector_id: str,
        *,
        user_id: str,
    ) -> list[RuntimeTypeView]:
        runtime_types = await self.list_runtime_types(connector_id, user_id=user_id)
        await self._require_v3(connector_id)
        return runtime_types

    async def create_runtime(
        self,
        connector_id: str,
        *,
        runtime_type: str,
        name: str,
        config: dict[str, Any],
        active: bool,
        user_id: str,
        runtime_id: str | None = None,
        managed_by: str | None = None,
        fence: dict[str, Any] | None = None,
    ) -> DeviceRuntimeView:
        await self._require_v3(connector_id)
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
            secrets = secret_values(
                config, secret_paths(runtime_type_row.schema_, runtime_type_row.uiSchema)
            )
            self._validate(
                config,
                _config_schema_for_instance(
                    runtime_type_row.schema_,
                    runtime_type_row.uiSchema,
                    named=True,
                ),
                secrets=secrets,
            )
            try:
                runtime = DeviceRuntimeView.model_validate(
                    await self._store.create_device_runtime(
                        connector_id,
                        runtime_type=runtime_type,
                        name=name,
                        config=config,
                        active=active,
                        **({"runtime_id": runtime_id, "managed_by": managed_by} if runtime_id is not None else {}),
                    )
                )
            except KeyError as exc:
                raise DeviceRuntimeNotFoundError("runtime type not found") from exc
            except ValueError as exc:
                raise DeviceRuntimeConflictError(str(exc)) from exc

            # The device validates again in ``runtime.apply`` and rejects what it cannot run (422).
            if active:
                runtime = await self._start_locked(runtime, fence=fence)
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
        await self._require_v3(connector_id)
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
            return await self._put_config_locked(runtime, config)

    async def is_connector_online(self, connector_id: str) -> bool:
        return await self._manager.is_online(connector_id)

    async def running_session_count(self, connector_id: str, runtime_id: str) -> int:
        sessions = await self._store.list_running_sessions_for_connector_agent(
            connector_id=connector_id,
            runtime_id=runtime_id,
        )
        return len(sessions)

    @asynccontextmanager
    async def locked_runtime(
        self,
        connector_id: str,
        runtime_id: str,
        *,
        user_id: str,
    ) -> AsyncIterator[LockedRuntime]:
        """Hold one runtime's lock for a sequence of changes.

        The lock is not re-entrant, so code holding it must change the runtime
        through the returned handle rather than the public methods.
        """
        async with self._runtime_lock(connector_id, runtime_id):
            runtime = await self._get_owned(connector_id, runtime_id, user_id=user_id)
            yield LockedRuntime(self, runtime)

    async def _put_config_locked(
        self,
        runtime: DeviceRuntimeView,
        config: dict[str, Any],
        *,
        restart: bool = True,
        fence: dict[str, Any] | None = None,
        started: dict[str, Any] | None = None,
    ) -> DeviceRuntimeView:
        connector_id, runtime_id = runtime.connectorId, runtime.runtimeId
        base_schema = self._schema(runtime)
        paths = secret_paths(base_schema, runtime.uiSchema)
        try:
            config = merge_secrets(config, runtime.config, paths)
        except SecretOriginChangedError as exc:
            raise DeviceRuntimeInvalidConfigError(
                str(exc),
                detail={
                    "code": "secret_required",
                    "message": str(exc),
                    "issues": [
                        {"path": "/" + exc.path.name.replace(".", "/"), "message": str(exc), "validator": "required"}
                    ],
                },
            ) from exc
        secrets = secret_values(config, paths)
        schema = _config_schema_for_instance(
            base_schema,
            runtime.uiSchema,
            named=runtime.runtimeId != runtime.runtimeType,
        )
        self._validate(config, schema, secrets=secrets)
        # The device validates again in ``runtime.apply``; offline, the change waits in desired state.
        await self._require_v3(connector_id)
        if fence and fence.get("targetGeneration") is not None:
            owner = await self._store.channel_connector_owner(connector_id)
            async with self._store.channel_transaction(owner):
                sync = await self._store.get_channel_sync(connector_id, fence["logicalRuntimeId"])
                if sync is None or sync["desired_generation"] != fence["targetGeneration"]:
                    raise DeviceRuntimeConflictError("channel target changed before configuration write",
                        detail={"code": "channel_target_superseded"})
                saved = await self._store.set_device_runtime_config(connector_id, runtime_id, config)
        else:
            saved = await self._store.set_device_runtime_config(connector_id, runtime_id, config)
        runtime = DeviceRuntimeView.model_validate(saved)
        if runtime.active and not restart:
            # Saved for the next start; the running instance keeps going.
            pass
        elif runtime.active:
            runtime = await self._restart_locked(runtime, fence=fence, started=started)
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
            await self._require_v3(connector_id)
            if active:
                if not runtime.configured or runtime.config is None:
                    raise DeviceRuntimeNotConfiguredError(
                        "runtime must be configured before activation"
                    )
                # Activation is the explicit start signal; offline, it waits in desired state.
                await self._store.set_device_runtime_active(
                    connector_id, runtime_id, True
                )
                runtime = await self._start_locked(runtime)
            else:
                await self._store.set_device_runtime_active(
                    connector_id, runtime_id, False
                )
                runtime = await self._stop_locked(runtime)
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
            await self._require_v3(connector_id)
            if not await self._manager.is_online(connector_id):
                raise DeviceRuntimeOfflineError("connector is offline")

            current = DeviceRuntimeView.model_validate(
                await self._store.get_device_runtime(connector_id, runtime_id)
            )
            if current.status == "running":
                return current
            if current.status == "starting" and current.phase is not None:
                # The device is mid-start (e.g. syncing sessions); another
                # runtime.apply would restart it and throw that work away.
                phase = current.phase
                message = phase.get("message")
                text = message if isinstance(message, str) and message else "runtime is starting"
                raise DeviceRuntimeStartingError(
                    text,
                    detail={
                        "code": DeviceRuntimeStartingError.code,
                        "message": text,
                        "retryable": True,
                        "phase": phase,
                    },
                )
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
        # The device drops an instance that is no longer in its desired state when it links again.
        await self._require_v3(connector_id)
        async with self._runtime_lock(connector_id, runtime_id):
            runtime = await self._get_owned(connector_id, runtime_id, user_id=user_id)
            if runtime.active or runtime.status in {
                "starting",
                "running",
                "stopping",
                "error",
                "unknown",
            }:
                await self._store.set_device_runtime_active(
                    connector_id, runtime_id, False
                )
                runtime = await self._stop_locked(runtime)
        # Acquire admission only after the stop command completes, then recheck under the normal lock order.
        async with self._store.connector_lifecycle(connector_id), self._runtime_lock(connector_id, runtime_id):
            runtime = await self._get_owned(connector_id, runtime_id, user_id=user_id)
            if runtime.active or runtime.status in {"starting", "running", "stopping", "unknown"}:
                raise DeviceRuntimeConflictError("runtime changed while deleting configuration; retry deletion")
            session_ids = await self._store.runtime_session_ids(connector_id, runtime_id)
            # A storage failure leaves the database and cache available for the same deletion retry.
            await self._store.delete_runtime_session_files(session_ids)
            for session_id in session_ids:
                if self._runtime_state_cache is not None:
                    await self._runtime_state_cache.discard(session_id)
            await self._store.clear_device_runtime_config(
                connector_id, runtime_id, cleanup_files=False, retire=True,
            )
            # The row is gone; report its final state so clients drop it.
            runtime = runtime.model_copy(update={
                "configured": False,
                "active": False,
                "available": False,
                "status": "stopped",
                "config": None,
                "error": None,
            })
            await self._publish(connector_id, "runtime.config_deleted")
            return runtime

    async def apply_status(
        self,
        connector_id: str,
        runtime_id: str,
        status: str,
        *,
        error: dict[str, Any] | None = None,
        phase: dict[str, Any] | None = None,
        expected_connection_id: str | None = None,
        model_connection: dict[str, Any] | None = None,
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
                await self._store_later_report(current, model_connection)
                runtime = DeviceRuntimeView.model_validate(
                    await self._store.set_device_runtime_status(
                        connector_id,
                        runtime_id,
                        status,
                        error=error,
                        phase=_phase_payload(phase),
                    )
                )
            except KeyError as exc:
                raise DeviceRuntimeNotFoundError("runtime not found") from exc
        await self._publish(connector_id, "runtime.status")
        return runtime

    async def _store_later_report(
        self, runtime: DeviceRuntimeView, reply: dict[str, Any] | None
    ) -> None:
        """Keep a report an adapter sent after starting, such as DSH once its
        Bridge connected.

        Only while the stored report belongs to the saved connection: that
        means the running instance was started with it, so a report from an
        instance still running an older connection cannot pass as applied.
        """
        if reply is None:
            return
        digest = connection_digest(runtime.config, runtime.modelConnection)
        stored = runtime.modelConnectionReport
        if digest is None or not isinstance(stored, dict) or stored.get("digest") != digest:
            return
        report = stored_report(reply, digest=digest)
        if report is not None and report != stored:
            await self._store.set_device_runtime_model_connection(
                runtime.connectorId, runtime.runtimeId, report
            )

    async def _start_locked(
        self,
        runtime: DeviceRuntimeView,
        *,
        fence: dict[str, Any] | None = None,
        started: dict[str, Any] | None = None,
    ) -> DeviceRuntimeView:
        assert runtime.config is not None
        return await self._apply_v3(runtime, active=True, fence=fence, started=started)

    async def _apply_v3(
        self,
        runtime: DeviceRuntimeView,
        *,
        active: bool,
        fence: dict[str, Any] | None,
        started: dict[str, Any] | None,
    ) -> DeviceRuntimeView:
        """Hand one instance's desired state to a v3 device and store what it reports.

        ``runtime.apply`` (``channel.switch`` when a model channel switch fences it) with
        ``device_runtime_entry``. The device answers ``{runtimeId, status, phase?, error?,
        modelConnection?, capabilities?, instanceId?}`` once the instance runs (or stopped) with it.

        - Offline: the change is already stored, so it reaches the device in ``LinkWelcome.desired``;
          the instance waits (``unknown`` + ``waiting_for_device``), or is ``stopped`` when stopping.
          A channel switch reports the offline device instead, as with v2.
        - Rejected: ``invalid_config`` and friends are 422; anything else is an upstream error. Either
          way the instance is in ``error``.
        - Outcome unknown: the instance is ``unknown``; never re-sent (the receipt converges).
        """

        connector_id, runtime_id = runtime.connectorId, runtime.runtimeId
        kind = CHANNEL_SWITCH_COMMAND if fence else RUNTIME_APPLY_COMMAND
        payload = {
            **device_runtime_entry(runtime, active=active),
            **(await self._fence_params(connector_id, fence)),
        }
        commands = self._device_commands()
        await self._store.set_device_runtime_status(connector_id, runtime_id, "starting" if active else "stopping")
        try:
            outcome = await commands.send(
                user_id=None,
                device_id=connector_id,
                kind=kind,
                command_id=f"{'cs' if fence else 'ra'}_{token_source.token_urlsafe(16)}",
                payload=payload,
                timeout=_runtime_rpc_timeout_seconds(),
            )
        except DeviceCommandError as exc:
            if exc.code == "connector_offline":
                if fence:
                    await self._store.set_device_runtime_status(connector_id, runtime_id, "unknown")
                    raise DeviceRuntimeOfflineError(exc.message) from exc
                if not active:
                    return DeviceRuntimeView.model_validate(
                        await self._store.set_device_runtime_status(connector_id, runtime_id, "stopped")
                    )
                return DeviceRuntimeView.model_validate(
                    await self._store.set_device_runtime_status(
                        connector_id, runtime_id, "unknown", phase=dict(WAITING_FOR_DEVICE_PHASE)
                    )
                )
            if exc.code == "command_outcome_unknown":
                await self._store.set_device_runtime_status(
                    connector_id, runtime_id, "unknown",
                    error={"code": exc.code, "message": exc.message},
                )
                raise DeviceRuntimeOutcomeUnknownError(exc.message) from exc
            # The device may quote the configuration it rejected; never store or return its secrets.
            message = scrub(
                exc.message or exc.code,
                secret_values(runtime.config or {}, secret_paths(runtime.schema_, runtime.uiSchema)),
            )
            error = {"code": exc.code, "message": message}
            if active:
                digest = connection_digest(runtime.config, runtime.modelConnection)
                if digest is not None:
                    await self._store.set_device_runtime_model_connection(
                        connector_id, runtime_id, failed_report(message, digest=digest)
                    )
            row = await self._store.set_device_runtime_status(connector_id, runtime_id, "error", error=error)
            if exc.code in _DEVICE_INVALID_CONFIG_CODES:
                raise DeviceRuntimeInvalidConfigError(message, detail=error) from exc
            if exc.code in {"runtime_conflict", "switch_revision_stale"}:
                raise DeviceRuntimeConflictError(message, detail=row["error"]) from exc
            raise DeviceRuntimeUpstreamError(message, detail=row["error"]) from exc
        result = outcome.result if isinstance(outcome.result, dict) else {}
        capabilities = result.get("capabilities")
        if isinstance(capabilities, dict):
            await self._remember_capabilities(connector_id, runtime_id, capabilities)
        instance_id = result.get("instanceId")
        if isinstance(instance_id, str) and instance_id:
            self._device_instances[connector_id] = instance_id
        if not active:
            return DeviceRuntimeView.model_validate(
                await self._store.set_device_runtime_status(connector_id, runtime_id, "stopped")
            )
        if started is not None:
            # What a channel switch verifies: the device ran exactly the configuration it was sent.
            started.update(result)
            digest = connection_digest(runtime.config, runtime.modelConnection)
            if digest is not None and "configDigest" not in result:
                started["configDigest"] = digest
        status = result.get("status", "running")
        if status not in {"starting", "running", "error"}:
            status = "running"
        error = result.get("error")
        phase = result.get("phase")
        report = stored_report(
            result.get("modelConnection"),
            digest=connection_digest(runtime.config, runtime.modelConnection),
        )
        await self._store.set_device_runtime_model_connection(connector_id, runtime_id, report)
        return DeviceRuntimeView.model_validate(
            await self._store.set_device_runtime_status(
                connector_id,
                runtime_id,
                status,
                error=error if isinstance(error, dict) else None,
                phase=_phase_payload(phase if isinstance(phase, dict) else None),
            )
        )

    async def _stop_locked(
        self,
        runtime: DeviceRuntimeView,
        *,
        fence: dict[str, Any] | None = None,
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
        return await self._apply_v3(runtime, active=False, fence=fence, started=None)

    async def _restart_locked(
        self,
        runtime: DeviceRuntimeView,
        *,
        fence: dict[str, Any] | None = None,
        started: dict[str, Any] | None = None,
    ) -> DeviceRuntimeView:
        # One command: the device replaces a running instance whose desired state changed.
        return await self._start_locked(runtime, fence=fence, started=started)

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

    async def _remember_features(self, connector_id: str, features: list[str]) -> None:
        self._features[connector_id] = frozenset(features)
        if self._coordinator is not None and self._coordinator.distributed:
            # The device's link is held by one worker; the others read it here.
            await self._coordinator.client.set(
                self._coordinator.key("connector-features", connector_id), ",".join(sorted(features)),
            )

    async def connector_supports(self, connector_id: str, feature: str) -> bool:
        """Whether the device declared ``feature`` in its last ``runtime.types`` report (never a v2 Connector)."""
        if not await self.is_v3_device(connector_id):
            return False
        if self._coordinator is not None and self._coordinator.distributed:
            stored = await self._coordinator.client.get(self._coordinator.key("connector-features", connector_id))
            return feature in (stored or "").split(",")
        return feature in self._features.get(connector_id, frozenset())

    async def _fence_params(self, connector_id: str, fence: dict[str, Any] | None) -> dict[str, Any]:
        # Devices refuse unknown fields, so only send what they declared.
        if not fence:
            return {}
        await self._store.assert_channel_execution()
        if not await self.connector_supports(connector_id, "channelReconcileFence"):
            raise DeviceRuntimeConflictError("connector upgrade required for channel reconciliation")
        return {key: fence[key] for key in ("operationId", "switchRevision") if fence.get(key) is not None}

    async def read_connector_config(self, connector_id: str, runtime_id: str, runtime_type: str) -> dict[str, Any] | None:
        """The configuration the device is running, or None if it cannot say.

        A device acknowledges ``runtime.apply`` only after it took the configuration, so the stored row is what it
        runs; offline (or a v2 Connector) it cannot say.
        """
        del runtime_type
        if not await self.is_v3_device(connector_id) or not await self._manager.is_online(connector_id):
            return None
        try:
            row = DeviceRuntimeView.model_validate(await self._store.get_device_runtime(connector_id, runtime_id))
        except KeyError:
            return None
        return {"running": row.status == "running", "values": row.config,
                "instanceId": self._device_instances.get(connector_id)}

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
    def _validate(
        config: dict[str, Any],
        schema: dict[str, Any],
        *,
        secrets: list[str] | None = None,
    ) -> None:
        try:
            validate_config(config, schema, secrets=secrets)
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


class LockedRuntime:
    """One runtime whose lock the caller holds (see ``locked_runtime``)."""

    def __init__(self, service: DeviceRuntimeService, runtime: DeviceRuntimeView) -> None:
        self._service = service
        self.runtime = runtime
        # The device's reply to the last start through this handle.
        self.last_start: dict[str, Any] = {}

    async def refresh(self) -> DeviceRuntimeView:
        """Re-read the row: status reports may have arrived since the last write."""
        self.runtime = DeviceRuntimeView.model_validate(
            await self._service._store.get_device_runtime(self.runtime.connectorId, self.runtime.runtimeId)
        )
        return self.runtime

    async def running_session_count(self) -> int:
        sessions = await self._service._store.list_running_sessions_for_connector_agent(
            connector_id=self.runtime.connectorId,
            runtime_id=self.runtime.runtimeId,
        )
        return len(sessions)

    async def put_config(
        self, config: dict[str, Any], *, restart: bool = True, fence: dict[str, Any] | None = None,
    ) -> DeviceRuntimeView:
        self.last_start = {}
        self.runtime = await self._service._put_config_locked(
            self.runtime, config, restart=restart, fence=fence, started=self.last_start,
        )
        return self.runtime

    async def restart(self, *, fence: dict[str, Any] | None = None) -> DeviceRuntimeView:
        """Start the saved configuration of an active runtime."""
        if self.runtime.active:
            self.runtime = await self._service._restart_locked(self.runtime, fence=fence)
        return self.runtime

    async def set_active(self, active: bool, *, fence: dict[str, Any] | None = None) -> DeviceRuntimeView:
        service, runtime = self._service, self.runtime
        if active:
            if not runtime.configured or runtime.config is None:
                raise DeviceRuntimeNotConfiguredError(
                    "runtime must be configured before activation"
                )
            if not await service._manager.is_online(runtime.connectorId):
                # Also for v3: a channel switch reports an offline device instead of deferring.
                raise DeviceRuntimeOfflineError("connector is offline")
            await service._store.set_device_runtime_active(
                runtime.connectorId, runtime.runtimeId, True
            )
            self.last_start = {}
            runtime = await service._start_locked(runtime, fence=fence, started=self.last_start)
        else:
            await service._store.set_device_runtime_active(
                runtime.connectorId, runtime.runtimeId, False
            )
            runtime = await service._stop_locked(runtime, fence=fence)
        await service._publish(runtime.connectorId, "runtime.active")
        self.runtime = runtime
        return runtime


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


def _phase_payload(phase: dict[str, Any] | None) -> dict[str, Any] | None:
    """Keep only well-formed phases: a stable code plus a human message."""

    if not isinstance(phase, dict):
        return None
    code = phase.get("code")
    message = phase.get("message")
    if not isinstance(code, str) or not code or not isinstance(message, str) or not message:
        return None
    return dict(phase)
