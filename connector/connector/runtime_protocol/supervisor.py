from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import replace
from typing import Any

from connector.logging import logger
from connector.runtime_protocol.errors import (
    RuntimeConflictError,
    RuntimeInvalidRequestError,
    RuntimeUnavailableError,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.instance_binding import (
    RuntimeInstance,
    RuntimeInstanceHost,
)
from connector.runtime_protocol.instance_models import (
    MAX_CONFIG_REVISION,
    RuntimeInstancePolicy,
    RuntimeInstanceSpec,
    RuntimeResourceClaim,
    RuntimeSourceKey,
    RuntimeTypeDescriptor,
    legacy_runtime_scope,
)
from connector.runtime_protocol.models import RuntimeConfig, RuntimeInventoryItem
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
    """Own provider types and dynamically configured runtime instances."""

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
        self._entries_guard = asyncio.Lock()
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

    def entry_or_none(self, runtime_id: str) -> RuntimeSupervisorEntry | None:
        return self._entries.get(runtime_id)

    async def discover(self) -> tuple[RuntimeTypeDescriptor, ...]:
        discovered = await asyncio.gather(
            *(
                self.discover_runtime_type(runtime_type)
                for runtime_type in self._providers
            )
        )
        return tuple(discovered)

    async def discover_legacy(self) -> tuple[RuntimeInventoryItem, ...]:
        return tuple(
            descriptor_to_legacy_inventory(descriptor)
            for descriptor in await self.discover()
        )

    async def discover_runtime_type(
        self,
        runtime_type: str,
    ) -> RuntimeTypeDescriptor:
        provider = self.provider(runtime_type)
        try:
            discovered = await provider.discover()
            descriptor = _coerce_descriptor(provider, discovered)
            if descriptor.runtime_type != provider.runtime_type:
                raise RuntimeInvalidRequestError(
                    f"provider {provider.runtime_type!r} returned descriptor for "
                    f"{descriptor.runtime_type!r}"
                )
            return descriptor
        except Exception as exc:  # noqa: BLE001
            error = error_payload(exc)
            return RuntimeTypeDescriptor(
                runtime_type=provider.runtime_type,
                display_name=provider.display_name,
                description=getattr(provider, "description", None),
                implementation_type=getattr(provider, "implementation_type", None),
                available=False,
                recommended=bool(getattr(provider, "recommended", False)),
                recommendation_rank=getattr(provider, "recommendation_rank", None),
                reason=error["message"],
                instance_policy=_provider_instance_policy(provider),
                max_instances=_provider_max_instances(provider),
                metadata={"configured": False, "error": error},
            )

    async def ensure_legacy_instance(
        self,
        runtime_type: str,
    ) -> RuntimeSupervisorEntry:
        scope = legacy_runtime_scope(runtime_type)
        provider = self.provider(scope.runtime_type)
        return await self.ensure_instance(
            RuntimeInstanceSpec(
                runtime_id=scope.runtime_id,
                runtime_type=scope.runtime_type,
                name=provider.display_name,
            )
        )

    async def ensure_instance(
        self,
        instance: RuntimeInstanceSpec,
    ) -> RuntimeSupervisorEntry:
        provider = self.provider(instance.runtime_type)
        async with self._entries_guard:
            existing = self._entries.get(instance.runtime_id)
            if existing is not None:
                if existing.runtime_type != instance.runtime_type:
                    raise RuntimeInvalidRequestError(
                        f"runtime instance {instance.runtime_id!r} is already bound "
                        f"to type {existing.runtime_type!r}"
                    )
                if existing.instance != instance:
                    runtime = existing.runtime
                    if isinstance(runtime, RuntimeInstance):
                        runtime = replace(runtime, instance=instance)
                    self._entries[instance.runtime_id] = replace(
                        existing,
                        instance=instance,
                        runtime=runtime,
                    )
                return self._entries[instance.runtime_id]

            current_count = sum(
                entry.runtime_type == instance.runtime_type
                for entry in self._entries.values()
            )
            maximum = _provider_max_instances(provider)
            if maximum is not None and current_count >= maximum:
                raise RuntimeConflictError(
                    f"runtime type {instance.runtime_type!r} allows at most "
                    f"{maximum} configured instance(s)"
                )
            entry = RuntimeSupervisorEntry(instance=instance, provider=provider)
            self._entries[instance.runtime_id] = entry
            self._locks[instance.runtime_id] = asyncio.Lock()
            return entry

    async def validate_config(
        self,
        instance: RuntimeInstanceSpec | str,
        values: Mapping[str, Any],
        revision: int | None = None,
    ) -> RuntimeConfig:
        resolved = await self._resolve_instance(instance)
        lock = self._locks[resolved.runtime_id]
        async with lock:
            entry = self._entry(resolved.runtime_id)
            await self._set_entry(resolved.runtime_id, status="validating", error=None)
            try:
                config = await entry.provider.validate_config(values)
                config = config_with_revision(config, revision)
                validate_provider_config_type(entry.provider, config)
                claims = _provider_resource_claims(entry.provider, config)
                async with self._resource_lock:
                    self.ensure_resources_available(resolved, claims)
            except Exception as exc:
                current = self._entry(resolved.runtime_id)
                running = current.runtime is not None
                await self._set_entry(
                    resolved.runtime_id,
                    status="running" if running else "error",
                    error=None if running else error_payload(exc),
                )
                raise

            current = self._entry(resolved.runtime_id)
            if current.runtime is not None:
                await self._set_entry(
                    resolved.runtime_id,
                    status="running",
                    error=None,
                )
            else:
                await self._set_entry(
                    resolved.runtime_id,
                    status="stopped",
                    config=config,
                    error=None,
                )
            return config

    async def start(
        self,
        instance: RuntimeInstanceSpec | str,
        values: Mapping[str, Any],
        revision: int | None = None,
    ) -> AgentRuntime:
        resolved = await self._resolve_instance(instance)
        lock = self._locks[resolved.runtime_id]
        async with lock, self._resource_lock:
            return await self._start_locked(resolved, values, revision)

    async def _start_locked(
        self,
        instance: RuntimeInstanceSpec,
        values: Mapping[str, Any],
        revision: int | None,
    ) -> AgentRuntime:
        entry = self._entry(instance.runtime_id)
        requested_values = dict(values)
        if (
            entry.runtime is not None
            and dict(entry.requested_values or {}) == requested_values
        ):
            config = (
                config_with_revision(entry.config, revision)
                if entry.config is not None
                else None
            )
            await self._set_entry(
                instance.runtime_id,
                config=config,
                status="running" if entry.status != "running" else None,
                error=None,
            )
            current_runtime = self._entry(instance.runtime_id).runtime
            assert current_runtime is not None
            return current_runtime

        await self._set_entry(instance.runtime_id, status="validating", error=None)
        try:
            config = await entry.provider.validate_config(requested_values)
            config = config_with_revision(config, revision)
            validate_provider_config_type(entry.provider, config)
            claims = _provider_resource_claims(entry.provider, config)
            self.ensure_resources_available(instance, claims)
        except Exception as exc:
            current = self._entry(instance.runtime_id)
            running = current.runtime is not None
            await self._set_entry(
                instance.runtime_id,
                status="running" if running else "error",
                error=None if running else error_payload(exc),
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
            current_runtime = self._entry(instance.runtime_id).runtime
            assert current_runtime is not None
            return current_runtime

        if entry.runtime is not None:
            await self._stop_locked(instance.runtime_id)

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
                source_key=_provider_source_key(entry.provider, config),
            )
            native_runtime = await entry.provider.create_runtime(config, scoped_host)
            bound_runtime = RuntimeInstance(
                instance=instance,
                native_runtime=native_runtime,
            )
            await bound_runtime.start()
        except Exception as exc:
            cleanup_error = await self._stop_runtime_after_failed_start(
                entry.provider,
                native_runtime,
            )
            retained_runtime = bound_runtime or native_runtime
            cleanup_failed = cleanup_error is not None and retained_runtime is not None
            await self._set_entry(
                instance.runtime_id,
                runtime=retained_runtime if cleanup_failed else None,
                requested_values=requested_values if cleanup_failed else None,
                resource_claims=claims if cleanup_failed else (),
                status="error",
                config=config,
                error=error_payload(cleanup_error or exc),
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
        lock = self._locks[runtime_id]
        async with lock, self._resource_lock:
            await self._stop_locked(runtime_id)

    def resolve_runtime(
        self,
        runtime_id: str,
        runtime_type: str | None = None,
    ) -> AgentRuntime:
        entry = self._entry(runtime_id)
        if runtime_type is not None and entry.runtime_type != runtime_type:
            raise RuntimeInvalidRequestError(
                f"runtime instance {runtime_id!r} belongs to type "
                f"{entry.runtime_type!r}, not {runtime_type!r}"
            )
        if entry.runtime is None:
            raise RuntimeUnavailableError(
                f"runtime instance {runtime_id!r} is not running"
            )
        return entry.runtime

    def ensure_resources_available(
        self,
        instance: RuntimeInstanceSpec,
        requested_claims: tuple[RuntimeResourceClaim, ...],
    ) -> None:
        for claim in requested_claims:
            for runtime_id, entry in self._entries.items():
                if runtime_id == instance.runtime_id:
                    continue
                if entry.status != "starting" and entry.runtime is None:
                    continue
                conflicting = next(
                    (
                        current
                        for current in entry.resource_claims
                        if current.kind == claim.kind
                        and current.key == claim.key
                        and current.mode == "exclusive"
                        and claim.mode == "exclusive"
                    ),
                    None,
                )
                if conflicting is not None:
                    raise RuntimeConflictError(
                        f"{claim.label} is already used by runtime instance "
                        f"{entry.name!r} ({entry.runtime_id})"
                    )

    async def _resolve_instance(
        self,
        instance: RuntimeInstanceSpec | str,
    ) -> RuntimeInstanceSpec:
        if isinstance(instance, str):
            return (await self.ensure_legacy_instance(instance)).instance
        await self.ensure_instance(instance)
        return instance

    async def _stop_locked(self, runtime_id: str) -> None:
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
    async def _stop_runtime_after_failed_start(
        provider: RuntimeProvider,
        runtime: AgentRuntime | None,
    ) -> Exception | None:
        if runtime is None:
            return None
        try:
            await provider.stop_runtime(runtime)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "runtime cleanup after failed start failed runtime_type={} error_type={}",
                provider.runtime_type,
                exc.__class__.__name__,
            )
            return exc
        return None


def provider_registry(
    providers: tuple[RuntimeProvider, ...],
) -> dict[str, RuntimeProvider]:
    registry: dict[str, RuntimeProvider] = {}
    for provider in providers:
        legacy_runtime_scope(provider.runtime_type)
        if provider.runtime != provider.runtime_type:
            raise ValueError(
                f"provider runtime {provider.runtime!r} must equal runtime_type "
                f"{provider.runtime_type!r}"
            )
        if provider.runtime_type in registry:
            raise ValueError(f"duplicate runtime type {provider.runtime_type!r}")
        registry[provider.runtime_type] = provider
    return registry


def validate_provider_config_type(
    provider: RuntimeProvider,
    config: RuntimeConfig,
) -> None:
    _validate_revision(config.revision, "provider config revision")
    if config.runtime == provider.runtime_type:
        return
    raise RuntimeInvalidRequestError(
        f"provider {provider.runtime_type!r} returned config for {config.runtime!r}"
    )


def config_with_revision(
    config: RuntimeConfig,
    revision: int | None,
) -> RuntimeConfig:
    _validate_revision(config.revision, "provider config revision")
    if revision is None or revision == config.revision:
        return config
    _validate_revision(revision, "configRevision")
    return replace(config, revision=revision)


def descriptor_to_legacy_inventory(
    descriptor: RuntimeTypeDescriptor,
) -> RuntimeInventoryItem:
    metadata = dict(descriptor.metadata)
    configured = metadata.pop("configured", None)
    return RuntimeInventoryItem(
        runtime=descriptor.runtime_type,
        runtime_type=descriptor.implementation_type or descriptor.runtime_type,
        display_name=descriptor.display_name,
        available=descriptor.available,
        configured=(
            configured if isinstance(configured, bool) else descriptor.available
        ),
        capabilities=descriptor.capabilities,
        reason=descriptor.reason,
        config_schema=descriptor.config_schema,
        metadata=metadata,
    )


def _coerce_descriptor(
    provider: RuntimeProvider,
    discovered: RuntimeTypeDescriptor | RuntimeInventoryItem,
) -> RuntimeTypeDescriptor:
    if isinstance(discovered, RuntimeTypeDescriptor):
        return discovered
    if not isinstance(discovered, RuntimeInventoryItem):
        raise TypeError("provider discover() must return RuntimeTypeDescriptor")
    return RuntimeTypeDescriptor(
        runtime_type=provider.runtime_type,
        display_name=discovered.display_name,
        description=getattr(provider, "description", None),
        implementation_type=getattr(provider, "implementation_type", None),
        available=discovered.available,
        recommended=bool(getattr(provider, "recommended", False)),
        recommendation_rank=getattr(provider, "recommendation_rank", None),
        capabilities=discovered.capabilities,
        reason=discovered.reason,
        config_schema=discovered.config_schema,
        instance_policy=_provider_instance_policy(provider),
        max_instances=_provider_max_instances(provider),
        metadata={**dict(discovered.metadata), "configured": discovered.configured},
    )


def _validated_claims(
    claims: tuple[RuntimeResourceClaim, ...],
) -> tuple[RuntimeResourceClaim, ...]:
    if not isinstance(claims, tuple) or not all(
        isinstance(claim, RuntimeResourceClaim) for claim in claims
    ):
        raise TypeError("resource_claims() must return RuntimeResourceClaim tuple")
    identities: set[tuple[str, str]] = set()
    for claim in claims:
        identity = (claim.kind, claim.key)
        if identity in identities:
            raise RuntimeInvalidRequestError(
                f"provider returned duplicate resource claim {identity!r}"
            )
        identities.add(identity)
    return claims


def _provider_instance_policy(provider: RuntimeProvider) -> RuntimeInstancePolicy:
    policy = getattr(provider, "instance_policy", "single")
    return "multiple" if policy == "multiple" else "single"


def _provider_max_instances(provider: RuntimeProvider) -> int | None:
    maximum = getattr(provider, "max_instances", None)
    if maximum is None and _provider_instance_policy(provider) == "single":
        return 1
    return maximum


def _provider_resource_claims(
    provider: RuntimeProvider,
    config: RuntimeConfig,
) -> tuple[RuntimeResourceClaim, ...]:
    return _validated_claims(provider.resource_claims(config))


def _provider_source_key(
    provider: RuntimeProvider,
    config: RuntimeConfig,
) -> RuntimeSourceKey | None:
    source_key = provider.session_source_key(config)
    if source_key is not None and not isinstance(source_key, RuntimeSourceKey):
        raise TypeError("session_source_key() must return RuntimeSourceKey or None")
    return source_key


def _validate_revision(value: int, field_name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int):
        raise RuntimeInvalidRequestError(f"{field_name} must be an integer")
    if not 0 <= value <= MAX_CONFIG_REVISION:
        raise RuntimeInvalidRequestError(
            f"{field_name} must be between 0 and {MAX_CONFIG_REVISION}"
        )
