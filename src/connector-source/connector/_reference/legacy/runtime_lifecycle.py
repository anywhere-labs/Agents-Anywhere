from __future__ import annotations

import asyncio
import copy
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from connector._reference.legacy.adapter import Adapter
from connector.server.sync_state import SyncStateStore

RuntimeStatusSink = Callable[[str, str, dict[str, Any] | None], Awaitable[None]]
RuntimeChangedSink = Callable[[str, Adapter | None], Awaitable[None]]
NotificationSink = Callable[[str, dict[str, Any]], Awaitable[None]]
AttachmentDownloader = Callable[[str, str], Awaitable[tuple[bytes, str, str]]]


class RuntimeLifecycleError(RuntimeError):
    code = "runtime_lifecycle_error"


class RuntimeNotFoundError(RuntimeLifecycleError):
    code = "runtime_not_found"


class RuntimeInactiveError(RuntimeLifecycleError):
    code = "runtime_inactive"


class RuntimeConfigError(RuntimeLifecycleError):
    code = "invalid_config"


@dataclass(frozen=True, slots=True)
class RuntimeBindings:
    notification_sink: NotificationSink
    attachment_downloader: AttachmentDownloader
    sync_state_store: SyncStateStore | None


@dataclass(frozen=True, slots=True)
class EffectiveRuntimeConfig:
    values: dict[str, Any]


class RuntimeProvider(Protocol):
    """Transitional provider interface for the active adapter-based supervisor.

    New runtime integrations must implement connector.runtime_protocol.RuntimeProvider.
    This protocol remains only so the current server dispatch can be narrowed
    incrementally without importing the reference Codex/Claude implementations.
    """

    runtime_id: str
    runtime_type: str
    display_name: str

    async def discover(self, status: str) -> dict[str, Any]: ...

    def unavailable_inventory(self, status: str, error: BaseException) -> dict[str, Any]: ...

    async def validate_config(self, config: dict[str, Any]) -> EffectiveRuntimeConfig: ...

    async def create_adapter(self, effective: EffectiveRuntimeConfig) -> Adapter: ...

    async def stop_adapter(self, adapter: Adapter) -> None: ...

    def capability_specs(self) -> list[tuple[str, dict[str, Any]]]: ...


class RuntimeSupervisor:
    def __init__(
        self,
        providers: list[RuntimeProvider],
        *,
        status_sink: RuntimeStatusSink,
        changed_sink: RuntimeChangedSink,
        running_adapters: dict[str, Adapter] | None = None,
    ) -> None:
        self.providers = {provider.runtime_id: provider for provider in providers}
        self.adapters: dict[str, Adapter] = dict(running_adapters or {})
        self._statuses: dict[str, str] = {
            runtime_id: "running" if runtime_id in self.adapters else "stopped"
            for runtime_id in self.providers
        }
        for runtime_id in self.adapters:
            self._statuses.setdefault(runtime_id, "running")
        self._configs: dict[str, dict[str, Any]] = {}
        self._locks = {runtime_id: asyncio.Lock() for runtime_id in self.providers}
        self._status_sink = status_sink
        self._changed_sink = changed_sink

    async def discover(self) -> dict[str, Any]:
        inventories = await asyncio.gather(
            *(
                provider.discover(status=self._statuses.get(runtime_id, "stopped"))
                for runtime_id, provider in self.providers.items()
            ),
            return_exceptions=True,
        )
        runtimes: list[dict[str, Any]] = []
        for (runtime_id, provider), inventory in zip(
            self.providers.items(),
            inventories,
            strict=True,
        ):
            if isinstance(inventory, BaseException):
                runtimes.append(
                    provider.unavailable_inventory(
                        status=self._statuses.get(runtime_id, "stopped"),
                        error=inventory,
                    )
                )
            else:
                runtimes.append(inventory)
        return {"runtimes": runtimes}

    async def validate_config(self, runtime_id: str, config: dict[str, Any]) -> None:
        provider = self._provider(runtime_id)
        await provider.validate_config(config)

    async def start(self, runtime_id: str, config: dict[str, Any]) -> dict[str, Any]:
        provider = self._provider(runtime_id)
        async with self._locks[runtime_id]:
            if runtime_id in self.adapters and self._configs.get(runtime_id) == config:
                return {"runtimeId": runtime_id, "status": "running"}
            if runtime_id in self.adapters:
                await self._stop_locked(runtime_id, provider)

            await self._set_status(runtime_id, "starting")
            try:
                effective = await provider.validate_config(config)
                adapter = await provider.create_adapter(effective)
            except Exception as exc:
                await self._set_status(
                    runtime_id,
                    "error",
                    {
                        "code": getattr(exc, "code", None) or exc.__class__.__name__,
                        "message": str(exc),
                    },
                )
                raise
            self.adapters[runtime_id] = adapter
            self._configs[runtime_id] = copy.deepcopy(config)
            await self._set_status(runtime_id, "running")
            await self._changed_sink(runtime_id, adapter)
            return {"runtimeId": runtime_id, "status": "running"}

    async def stop(self, runtime_id: str) -> dict[str, Any]:
        provider = self._provider(runtime_id)
        async with self._locks[runtime_id]:
            await self._stop_locked(runtime_id, provider)
            return {"runtimeId": runtime_id, "status": "stopped"}

    def resolve_adapter(self, runtime_id: str) -> Adapter:
        adapter = self.adapters.get(runtime_id)
        if adapter is None:
            raise RuntimeInactiveError(f"runtime {runtime_id!r} is not active")
        return adapter

    def active_capabilities(self, *, revision: int) -> dict[str, Any]:
        capabilities: list[dict[str, Any]] = []
        for runtime_id in self.adapters:
            provider = self.providers.get(runtime_id)
            if provider is None:
                continue
            for capability_id, parameters in provider.capability_specs():
                capabilities.append(
                    {
                        "capabilityId": capability_id,
                        "version": "1",
                        "scope": "runtime",
                        "runtime": runtime_id,
                        "supported": True,
                        "available": True,
                        "allowed": True,
                        "parameters": parameters,
                    }
                )
        return {"revision": revision, "capabilities": capabilities}

    async def _stop_locked(self, runtime_id: str, provider: RuntimeProvider) -> None:
        adapter = self.adapters.get(runtime_id)
        if adapter is None:
            self._configs.pop(runtime_id, None)
            await self._set_status(runtime_id, "stopped")
            return
        await self._set_status(runtime_id, "stopping")
        try:
            await provider.stop_adapter(adapter)
        except Exception as exc:
            await self._set_status(
                runtime_id,
                "error",
                {
                    "code": getattr(exc, "code", None) or exc.__class__.__name__,
                    "message": str(exc),
                },
            )
            raise
        self.adapters.pop(runtime_id, None)
        self._configs.pop(runtime_id, None)
        await self._set_status(runtime_id, "stopped")
        await self._changed_sink(runtime_id, None)

    async def _set_status(
        self,
        runtime_id: str,
        status: str,
        error: dict[str, Any] | None = None,
    ) -> None:
        self._statuses[runtime_id] = status
        await self._status_sink(runtime_id, status, error)

    def _provider(self, runtime_id: str) -> RuntimeProvider:
        provider = self.providers.get(runtime_id)
        if provider is None:
            raise RuntimeNotFoundError(f"unknown runtime {runtime_id!r}")
        return provider


def default_runtime_providers(bindings: RuntimeBindings) -> list[RuntimeProvider]:
    _ = bindings
    return []
