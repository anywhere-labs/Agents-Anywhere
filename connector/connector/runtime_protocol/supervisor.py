from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import replace
from typing import Any

from connector.logging import logger
from connector.runtime_protocol.errors import (
    RuntimeInvalidRequestError,
    RuntimeResourceConflictError,
    RuntimeUnavailableError,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.instance_binding import (
    RuntimeInstance,
    RuntimeInstanceHost,
)
from connector.runtime_protocol.models import (
    RuntimeConfig,
    RuntimeInstanceSpec,
    RuntimeResourceClaim,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.protocol import AgentRuntime
from connector.runtime_protocol.provider import RuntimeProvider
from connector.runtime_protocol.supervisor_models import (
    MISSING,
    RuntimeLifecycleStatus,
    RuntimeStatusSink,
    RuntimeSupervisorEntry,
    error_payload,
    same_effective_config,
)


class RuntimeSupervisor:
    """Own runtime type providers and dynamically created runtime instances."""

    def __init__(
        self,
        providers: tuple[RuntimeProvider, ...],
        host: RuntimeHostClient,
        status_sink: RuntimeStatusSink | None = None,
    ) -> None:
        self._providers = provider_registry(providers)
        self._entries: dict[str, RuntimeSupervisorEntry] = {}
        self._host = host
        self._status_sink = status_sink
        self._locks: dict[str, asyncio.Lock] = {}
        self._locks_guard = asyncio.Lock()
        self._resource_lock = asyncio.Lock()

    @property
    def runtimes(self) -> tuple[str, ...]:
        return tuple(self._entries)

    @property
    def runtime_types(self) -> tuple[str, ...]:
        return tuple(self._providers)

    def provider(self, runtime_type: str) -> RuntimeProvider:
        provider = self._providers.get(runtime_type)
        if provider is None:
            raise RuntimeInvalidRequestError(f"unknown runtime type {runtime_type!r}")
        return provider

    def entry(self, runtime_id: str) -> RuntimeSupervisorEntry:
        return self._entry(runtime_id)

    async def discover(self) -> tuple[RuntimeTypeDescriptor, ...]:
        discovered = await asyncio.gather(
            *(
                self.discover_runtime_type(runtime_type)
                for runtime_type in self._providers
            ),
        )
        return tuple(discovered)

    async def discover_runtime_type(
        self,
        runtime_type: str,
    ) -> RuntimeTypeDescriptor:
        provider = self.provider(runtime_type)
        try:
            return await provider.discover()
        except Exception as exc:  # noqa: BLE001
            error = error_payload(exc)
            return RuntimeTypeDescriptor(
                runtime_type=provider.runtime_type,
                display_name=provider.display_name,
                description=provider.description,
                available=False,
                recommended=provider.recommended,
                recommendation_rank=provider.recommendation_rank,
                reason=error["message"],
                metadata={"error": error},
            )

    async def validate_config(
        self,
        instance: RuntimeInstanceSpec,
        values: Mapping[str, Any],
        revision: int | None = None,
    ) -> RuntimeConfig:
        entry = await self.ensure_instance(instance)
        await self._set_entry(instance.runtime_id, status="validating", error=None)
        try:
            config = await entry.provider.validate_config(values)
            config = config_with_revision(config, revision)
            validate_provider_config_type(entry.provider, config)
        except Exception as exc:
            current = self._entry(instance.runtime_id)
            await self._set_entry(
                instance.runtime_id,
                status="running" if current.runtime is not None else "error",
                error=error_payload(exc),
            )
            raise

        current = self._entry(instance.runtime_id)
        if current.runtime is not None:
            await self._set_entry(
                instance.runtime_id,
                status="running",
                error=None,
            )
        else:
            await self._set_entry(
                instance.runtime_id,
                status="stopped",
                config=config,
                error=None,
            )
        return config

    async def start(
        self,
        instance: RuntimeInstanceSpec,
        values: Mapping[str, Any],
        revision: int | None = None,
    ) -> AgentRuntime:
        await self.ensure_instance(instance)
        instance_lock = await self.instance_lock(instance.runtime_id)
        async with instance_lock, self._resource_lock:
            return await self.start_instance_locked(
                instance,
                values,
                revision,
            )

    async def start_instance_locked(
        self,
        instance: RuntimeInstanceSpec,
        values: Mapping[str, Any],
        revision: int | None,
    ) -> AgentRuntime:
        """Validate and start one instance while holding its resource transaction."""

        entry = self._entry(instance.runtime_id)
        requested_values = dict(values)
        if (
            entry.runtime is not None
            and dict(entry.requested_values or {}) == requested_values
        ):
            return entry.runtime

        await self._set_entry(instance.runtime_id, status="validating", error=None)
        try:
            config = await entry.provider.validate_config(requested_values)
            config = config_with_revision(config, revision)
            validate_provider_config_type(entry.provider, config)
            claims = entry.provider.resource_claims(config)
            self.ensure_resources_available(instance, claims)
        except Exception as exc:
            current = self._entry(instance.runtime_id)
            await self._set_entry(
                instance.runtime_id,
                status="running" if current.runtime is not None else "error",
                error=error_payload(exc),
            )
            raise

        entry = self._entry(instance.runtime_id)
        if entry.runtime is not None and same_effective_config(entry.config, config):
            await self._set_entry(
                instance.runtime_id,
                config=config,
                requested_values=requested_values,
                resource_claims=claims,
                status="running",
                error=None,
            )
            return entry.runtime

        if entry.runtime is not None:
            await self.stop_instance_locked(instance.runtime_id)

        await self._set_entry(
            instance.runtime_id,
            status="starting",
            config=config,
            resource_claims=claims,
            error=None,
        )
        native_runtime: AgentRuntime | None = None
        bound_runtime: RuntimeInstance | None = None
        try:
            scoped_host = RuntimeInstanceHost(
                base=self._host,
                instance=instance,
                session_source_key=entry.provider.session_source_key(config),
            )
            native_runtime = await entry.provider.create_runtime(
                instance,
                config,
                scoped_host,
            )
            bound_runtime = RuntimeInstance(instance=instance, runtime=native_runtime)
            await bound_runtime.start()
        except Exception as exc:
            await self.stop_runtime_after_failed_start(entry.provider, native_runtime)
            await self._set_entry(
                instance.runtime_id,
                runtime=None,
                resource_claims=(),
                status="error",
                config=config,
                error=error_payload(exc),
            )
            raise

        await self._set_entry(
            instance.runtime_id,
            runtime=bound_runtime,
            config=config,
            requested_values=requested_values,
            resource_claims=claims,
            status="running",
            error=None,
        )
        return bound_runtime

    async def stop(self, runtime_id: str) -> None:
        self._entry(runtime_id)
        instance_lock = await self.instance_lock(runtime_id)
        async with instance_lock, self._resource_lock:
            await self.stop_instance_locked(runtime_id)

    def resolve_runtime(self, runtime_id: str) -> AgentRuntime:
        entry = self._entry(runtime_id)
        if entry.runtime is None:
            raise RuntimeUnavailableError(
                f"runtime instance {runtime_id!r} is not running"
            )
        return entry.runtime

    async def ensure_instance(
        self,
        instance: RuntimeInstanceSpec,
    ) -> RuntimeSupervisorEntry:
        provider = self.provider(instance.runtime_type)
        existing = self._entries.get(instance.runtime_id)
        if existing is not None:
            if existing.instance.runtime_type != instance.runtime_type:
                raise RuntimeInvalidRequestError(
                    f"runtime instance {instance.runtime_id!r} is already bound to "
                    f"type {existing.instance.runtime_type!r}"
                )
            if existing.instance.name != instance.name:
                runtime = existing.runtime
                if isinstance(runtime, RuntimeInstance):
                    runtime = replace(runtime, instance=instance)
                self._entries[instance.runtime_id] = replace(
                    existing,
                    instance=instance,
                    runtime=runtime,
                )
            return self._entries[instance.runtime_id]

        self._entries[instance.runtime_id] = RuntimeSupervisorEntry(
            instance=instance,
            provider=provider,
        )
        async with self._locks_guard:
            self._locks.setdefault(instance.runtime_id, asyncio.Lock())
        return self._entries[instance.runtime_id]

    def ensure_resources_available(
        self,
        instance: RuntimeInstanceSpec,
        requested_claims: tuple[RuntimeResourceClaim, ...],
    ) -> None:
        for claim in requested_claims:
            for runtime_id, entry in self._entries.items():
                if runtime_id == instance.runtime_id:
                    continue
                if entry.status not in {"starting", "running"}:
                    continue
                conflicting = next(
                    (
                        current
                        for current in entry.resource_claims
                        if current.kind == claim.kind and current.key == claim.key
                    ),
                    None,
                )
                if conflicting is None:
                    continue
                raise RuntimeResourceConflictError(
                    f"{claim.label} is already used by runtime instance "
                    f"{entry.instance.name!r} ({entry.instance.runtime_id})"
                )

    async def stop_instance_locked(self, runtime_id: str) -> None:
        entry = self._entry(runtime_id)
        if entry.runtime is None:
            await self._set_entry(
                runtime_id,
                status="stopped",
                runtime=None,
                requested_values=None,
                resource_claims=(),
                error=None,
            )
            return
        await self._set_entry(runtime_id, status="stopping", error=None)
        try:
            await entry.provider.stop_runtime(entry.runtime)
        except Exception as exc:
            await self._set_entry(runtime_id, status="error", error=error_payload(exc))
            raise
        await self._set_entry(
            runtime_id,
            runtime=None,
            requested_values=None,
            resource_claims=(),
            status="stopped",
            error=None,
        )

    async def instance_lock(self, runtime_id: str) -> asyncio.Lock:
        async with self._locks_guard:
            lock = self._locks.get(runtime_id)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[runtime_id] = lock
            return lock

    async def _set_entry(
        self,
        runtime_id: str,
        runtime: AgentRuntime | None | object = MISSING,
        config: RuntimeConfig | None | object = MISSING,
        requested_values: Mapping[str, Any] | None | object = MISSING,
        resource_claims: tuple[RuntimeResourceClaim, ...] | object = MISSING,
        status: RuntimeLifecycleStatus | None = None,
        error: Mapping[str, Any] | None | object = MISSING,
    ) -> None:
        entry = self._entry(runtime_id)
        next_status = entry.status if status is None else status
        self._entries[runtime_id] = RuntimeSupervisorEntry(
            instance=entry.instance,
            provider=entry.provider,
            runtime=entry.runtime if runtime is MISSING else runtime,  # type: ignore[arg-type]
            config=entry.config if config is MISSING else config,  # type: ignore[arg-type]
            requested_values=(
                entry.requested_values
                if requested_values is MISSING
                else requested_values
            ),  # type: ignore[arg-type]
            resource_claims=(
                entry.resource_claims if resource_claims is MISSING else resource_claims
            ),  # type: ignore[arg-type]
            status=next_status,
            error=entry.error if error is MISSING else error,  # type: ignore[arg-type]
        )
        if status is not None and self._status_sink is not None:
            await self._status_sink(
                runtime_id,
                next_status,
                self._entries[runtime_id].error,
            )

    def _entry(self, runtime_id: str) -> RuntimeSupervisorEntry:
        entry = self._entries.get(runtime_id)
        if entry is None:
            raise RuntimeInvalidRequestError(f"unknown runtime instance {runtime_id!r}")
        return entry

    @staticmethod
    async def stop_runtime_after_failed_start(
        provider: RuntimeProvider,
        runtime: AgentRuntime | None,
    ) -> None:
        if runtime is None:
            return
        try:
            await provider.stop_runtime(runtime)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "runtime cleanup after failed start failed runtime_type={} error_type={}",
                provider.runtime_type,
                exc.__class__.__name__,
            )


def provider_registry(
    providers: tuple[RuntimeProvider, ...],
) -> dict[str, RuntimeProvider]:
    registry: dict[str, RuntimeProvider] = {}
    for provider in providers:
        if provider.runtime_type in registry:
            raise ValueError(f"duplicate runtime type {provider.runtime_type!r}")
        registry[provider.runtime_type] = provider
    return registry


def validate_provider_config_type(
    provider: RuntimeProvider,
    config: RuntimeConfig,
) -> None:
    if config.runtime_type == provider.runtime_type:
        return
    raise RuntimeInvalidRequestError(
        f"provider {provider.runtime_type!r} returned config for "
        f"{config.runtime_type!r}"
    )


def config_with_revision(
    config: RuntimeConfig,
    revision: int | None,
) -> RuntimeConfig:
    if revision is None or revision == config.revision:
        return config
    return replace(config, revision=revision)
