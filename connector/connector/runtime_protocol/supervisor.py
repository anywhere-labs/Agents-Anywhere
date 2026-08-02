from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

from connector.logging import logger
from connector.runtime_protocol.errors import (
    RuntimeInvalidRequestError,
    RuntimeUnavailableError,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.models import RuntimeConfig, RuntimeInventoryItem
from connector.runtime_protocol.protocol import AgentRuntime
from connector.runtime_protocol.provider import RuntimeProvider

RuntimeLifecycleStatus = Literal[
    "stopped",
    "discovering",
    "available",
    "unavailable",
    "validating",
    "starting",
    "running",
    "stopping",
    "error",
]

RuntimeStatusSink = Callable[
    [str, RuntimeLifecycleStatus, Mapping[str, Any] | None],
    Awaitable[None],
]


class _Missing:
    pass


_MISSING = _Missing()


@dataclass(frozen=True, slots=True)
class RuntimeSupervisorEntry:
    provider: RuntimeProvider
    runtime: AgentRuntime | None = None
    config: RuntimeConfig | None = None
    requested_values: Mapping[str, Any] | None = None
    status: RuntimeLifecycleStatus = "stopped"
    error: Mapping[str, Any] | None = None


class RuntimeSupervisor:
    """Lifecycle supervisor for native AgentRuntime implementations."""

    def __init__(
        self,
        providers: tuple[RuntimeProvider, ...],
        host: RuntimeHostClient,
        status_sink: RuntimeStatusSink | None = None,
    ) -> None:
        self._entries = {
            provider.runtime: RuntimeSupervisorEntry(provider=provider)
            for provider in providers
        }
        self._host = host
        self._status_sink = status_sink
        self._locks = {runtime: asyncio.Lock() for runtime in self._entries}

    @property
    def runtimes(self) -> tuple[str, ...]:
        return tuple(self._entries)

    def entry(self, runtime: str) -> RuntimeSupervisorEntry:
        return self._entry(runtime)

    async def discover(self) -> tuple[RuntimeInventoryItem, ...]:
        discovered = await asyncio.gather(
            *(self.discover_runtime(runtime) for runtime in self._entries),
        )
        return tuple(discovered)

    async def discover_runtime(self, runtime: str) -> RuntimeInventoryItem:
        entry = self._entry(runtime)
        await self._set_entry(runtime, status="discovering", error=None)
        try:
            item = await entry.provider.discover()
        except Exception as exc:  # noqa: BLE001
            error = _error_payload(exc)
            await self._set_entry(runtime, status="unavailable", error=error)
            return RuntimeInventoryItem(
                runtime=entry.provider.runtime,
                runtime_type=entry.provider.runtime_type,
                display_name=entry.provider.display_name,
                available=False,
                configured=False,
                reason=error["message"],
                metadata={"error": error},
            )

        await self._set_entry(
            runtime,
            status="available" if item.available else "unavailable",
            error=None if item.available else {"message": item.reason or "unavailable"},
        )
        return item

    async def validate_config(
        self,
        runtime: str,
        values: Mapping[str, Any],
    ) -> RuntimeConfig:
        entry = self._entry(runtime)
        await self._set_entry(runtime, status="validating", error=None)
        try:
            config = await entry.provider.validate_config(values)
        except Exception as exc:
            await self._set_entry(runtime, status="error", error=_error_payload(exc))
            raise
        if config.runtime != runtime:
            exc = RuntimeInvalidRequestError(
                f"provider {runtime!r} returned config for {config.runtime!r}"
            )
            await self._set_entry(runtime, status="error", error=_error_payload(exc))
            raise exc
        await self._set_entry(runtime, status="stopped", config=config, error=None)
        return config

    async def start(
        self,
        runtime: str,
        values: Mapping[str, Any],
    ) -> AgentRuntime:
        self._entry(runtime)
        async with self._locks[runtime]:
            entry = self._entry(runtime)
            requested_values = dict(values)
            if (
                entry.runtime is not None
                and dict(entry.requested_values or {}) == requested_values
            ):
                return entry.runtime

            await self._set_entry(runtime, status="validating", error=None)
            try:
                config = await entry.provider.validate_config(requested_values)
            except Exception as exc:
                current = self._entry(runtime)
                await self._set_entry(
                    runtime,
                    status="running" if current.runtime is not None else "error",
                    error=_error_payload(exc),
                )
                raise
            if config.runtime != runtime:
                exc = RuntimeInvalidRequestError(
                    f"provider {runtime!r} returned config for {config.runtime!r}"
                )
                current = self._entry(runtime)
                await self._set_entry(
                    runtime,
                    status="running" if current.runtime is not None else "error",
                    config=config,
                    error=_error_payload(exc),
                )
                raise exc

            entry = self._entry(runtime)
            if entry.runtime is not None and _same_effective_config(
                entry.config, config
            ):
                await self._set_entry(
                    runtime,
                    config=config,
                    requested_values=requested_values,
                    status="running",
                    error=None,
                )
                return entry.runtime

            if entry.runtime is not None:
                await self._stop_locked(runtime)

            await self._set_entry(runtime, status="starting", config=config, error=None)
            runtime_instance: AgentRuntime | None = None
            try:
                runtime_instance = await entry.provider.create_runtime(
                    config, self._host
                )
                await runtime_instance.start()
            except Exception as exc:
                await self._stop_runtime_after_failed_start(
                    entry.provider, runtime_instance
                )
                await self._set_entry(
                    runtime, status="error", config=config, error=_error_payload(exc)
                )
                raise

            await self._set_entry(
                runtime,
                runtime=runtime_instance,
                config=config,
                requested_values=requested_values,
                status="running",
                error=None,
            )
            return runtime_instance

    async def stop(self, runtime: str) -> None:
        self._entry(runtime)
        async with self._locks[runtime]:
            await self._stop_locked(runtime)

    def resolve_runtime(self, runtime: str) -> AgentRuntime:
        entry = self._entry(runtime)
        if entry.runtime is None:
            raise RuntimeUnavailableError(f"runtime {runtime!r} is not running")
        return entry.runtime

    async def _stop_locked(self, runtime: str) -> None:
        entry = self._entry(runtime)
        if entry.runtime is None:
            await self._set_entry(
                runtime,
                status="stopped",
                runtime=None,
                requested_values=None,
                error=None,
            )
            return
        await self._set_entry(runtime, status="stopping", error=None)
        try:
            await entry.provider.stop_runtime(entry.runtime)
        except Exception as exc:
            await self._set_entry(runtime, status="error", error=_error_payload(exc))
            raise
        await self._set_entry(
            runtime,
            runtime=None,
            requested_values=None,
            status="stopped",
            error=None,
        )

    async def _set_entry(
        self,
        runtime_key: str,
        runtime: AgentRuntime | None | object = _MISSING,
        config: RuntimeConfig | None | object = _MISSING,
        requested_values: Mapping[str, Any] | None | object = _MISSING,
        status: RuntimeLifecycleStatus | None = None,
        error: Mapping[str, Any] | None | object = _MISSING,
    ) -> None:
        entry = self._entry(runtime_key)
        next_runtime = entry.runtime if runtime is _MISSING else runtime
        next_config = entry.config if config is _MISSING else config
        next_requested_values = (
            entry.requested_values if requested_values is _MISSING else requested_values
        )
        next_error = entry.error if error is _MISSING else error
        next_status = entry.status if status is None else status
        self._entries[runtime_key] = RuntimeSupervisorEntry(
            provider=entry.provider,
            runtime=next_runtime,  # type: ignore[arg-type]
            config=next_config,  # type: ignore[arg-type]
            requested_values=next_requested_values,  # type: ignore[arg-type]
            status=next_status,
            error=next_error,  # type: ignore[arg-type]
        )
        if status is not None and self._status_sink is not None:
            await self._status_sink(runtime_key, next_status, next_error)  # type: ignore[arg-type]

    def _entry(self, runtime: str) -> RuntimeSupervisorEntry:
        entry = self._entries.get(runtime)
        if entry is None:
            raise RuntimeInvalidRequestError(f"unknown runtime {runtime!r}")
        return entry

    @staticmethod
    async def _stop_runtime_after_failed_start(
        provider: RuntimeProvider,
        runtime: AgentRuntime | None,
    ) -> None:
        if runtime is not None:
            try:
                await provider.stop_runtime(runtime)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "runtime cleanup after failed start failed runtime={} error_type={}",
                    runtime.identity.runtime,
                    exc.__class__.__name__,
                )


def _error_payload(exc: BaseException) -> dict[str, Any]:
    return {
        "code": getattr(exc, "code", None) or exc.__class__.__name__,
        "message": str(exc) or exc.__class__.__name__,
        "retryable": bool(getattr(exc, "retryable", False)),
    }


def _same_effective_config(left: RuntimeConfig | None, right: RuntimeConfig) -> bool:
    if left is None:
        return False
    return (
        left.runtime == right.runtime
        and left.revision == right.revision
        and dict(left.values) == dict(right.values)
    )
