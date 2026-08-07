from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

import pytest

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeHostClient,
    RuntimeIdentity,
    RuntimeInvalidRequestError,
    RuntimeInventoryItem,
    RuntimeSupervisor,
    RuntimeUnavailableError,
)


class FakeHost(RuntimeHostClient):
    @property
    def connector_id(self) -> str:
        return "conn_test"


class FakeRuntime(AgentRuntime):
    def __init__(self, runtime: str = "fake", fail_start: bool = False) -> None:
        self._runtime = runtime
        self.fail_start = fail_start
        self.started = False
        self.stopped = False

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(runtime=self._runtime, runtime_version="test")

    async def start(self) -> None:
        if self.fail_start:
            raise RuntimeError("boom")
        self.started = True

    async def stop(self) -> None:
        self.stopped = True


class FakeProvider:
    runtime = "fake"
    runtime_type = "fake"
    display_name = "Fake Runtime"

    def __init__(self) -> None:
        self.discoveries = 0
        self.validated: list[dict[str, Any]] = []
        self.created: list[RuntimeConfig] = []
        self.stopped: list[AgentRuntime] = []
        self.fail_discover = False
        self.fail_validate = False
        self.fail_start = False
        self.config_runtime = "fake"
        self.config_revision = 1
        self.normalize_modes: dict[str, str] = {}

    async def discover(self) -> RuntimeInventoryItem:
        self.discoveries += 1
        if self.fail_discover:
            raise RuntimeError("missing")
        return RuntimeInventoryItem(
            runtime=self.runtime,
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            available=True,
            configured=True,
            config_schema=RuntimeConfigSchema(
                runtime=self.runtime,
                revision=1,
                schema={"type": "object"},
            ),
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        return RuntimeConfigSchema(
            runtime=self.runtime,
            revision=1,
            schema={"type": "object"},
        )

    async def validate_config(self, values: Mapping[str, Any]) -> RuntimeConfig:
        self.validated.append(dict(values))
        if self.fail_validate:
            raise RuntimeInvalidRequestError("invalid config")
        normalized = dict(values)
        mode = normalized.get("mode")
        if isinstance(mode, str) and mode in self.normalize_modes:
            normalized["mode"] = self.normalize_modes[mode]
        return RuntimeConfig(
            runtime=self.config_runtime,
            revision=self.config_revision,
            values=normalized,
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        assert host.connector_id == "conn_test"
        self.created.append(config)
        return FakeRuntime(runtime=config.runtime, fail_start=self.fail_start)

    async def stop_runtime(self, runtime: AgentRuntime) -> None:
        self.stopped.append(runtime)
        await runtime.stop()


def test_runtime_protocol_supervisor_discovers_providers() -> None:
    asyncio.run(_test_runtime_protocol_supervisor_discovers_providers())


async def _test_runtime_protocol_supervisor_discovers_providers() -> None:
    provider = FakeProvider()
    statuses: list[tuple[str, str, Mapping[str, Any] | None]] = []
    supervisor = RuntimeSupervisor(
        providers=(provider,),
        host=FakeHost(),
        status_sink=lambda runtime, status, error: _append(
            statuses, (runtime, status, error)
        ),
    )

    items = await supervisor.discover()

    assert items[0].runtime == "fake"
    assert items[0].available is True
    assert provider.discoveries == 1
    assert [status for _runtime, status, _error in statuses] == [
        "discovering",
        "available",
    ]


def test_runtime_protocol_supervisor_maps_discovery_failure_to_unavailable() -> None:
    asyncio.run(
        _test_runtime_protocol_supervisor_maps_discovery_failure_to_unavailable()
    )


async def _test_runtime_protocol_supervisor_maps_discovery_failure_to_unavailable() -> (
    None
):
    provider = FakeProvider()
    provider.fail_discover = True
    statuses: list[str] = []
    supervisor = RuntimeSupervisor(
        providers=(provider,),
        host=FakeHost(),
        status_sink=lambda _runtime, status, _error: _append(statuses, status),
    )

    items = await supervisor.discover()

    assert items[0].available is False
    assert items[0].reason == "missing"
    assert statuses == ["discovering", "unavailable"]


def test_runtime_protocol_supervisor_starts_and_reuses_same_config() -> None:
    asyncio.run(_test_runtime_protocol_supervisor_starts_and_reuses_same_config())


async def _test_runtime_protocol_supervisor_starts_and_reuses_same_config() -> None:
    provider = FakeProvider()
    statuses: list[str] = []
    supervisor = RuntimeSupervisor(
        providers=(provider,),
        host=FakeHost(),
        status_sink=lambda _runtime, status, _error: _append(statuses, status),
    )

    first = await supervisor.start("fake", {"mode": "auto"})
    second = await supervisor.start("fake", {"mode": "auto"})

    assert second is first
    assert first.started is True
    assert provider.validated == [{"mode": "auto"}]
    assert len(provider.created) == 1
    assert supervisor.resolve_runtime("fake") is first
    assert statuses == ["validating", "starting", "running"]


def test_runtime_protocol_supervisor_restarts_when_config_changes() -> None:
    asyncio.run(_test_runtime_protocol_supervisor_restarts_when_config_changes())


async def _test_runtime_protocol_supervisor_restarts_when_config_changes() -> None:
    provider = FakeProvider()
    statuses: list[str] = []
    supervisor = RuntimeSupervisor(
        providers=(provider,),
        host=FakeHost(),
        status_sink=lambda _runtime, status, _error: _append(statuses, status),
    )

    first = await supervisor.start("fake", {"mode": "auto"})
    second = await supervisor.start("fake", {"mode": "sdk"})

    assert second is not first
    assert first.stopped is True
    assert provider.stopped == [first]
    assert [config.values for config in provider.created] == [
        {"mode": "auto"},
        {"mode": "sdk"},
    ]
    assert statuses == [
        "validating",
        "starting",
        "running",
        "validating",
        "stopping",
        "stopped",
        "starting",
        "running",
    ]


def test_runtime_protocol_supervisor_validate_config_does_not_mark_running_runtime_stopped() -> (
    None
):
    asyncio.run(
        _test_runtime_protocol_supervisor_validate_config_does_not_mark_running_runtime_stopped()
    )


async def _test_runtime_protocol_supervisor_validate_config_does_not_mark_running_runtime_stopped() -> (
    None
):
    provider = FakeProvider()
    statuses: list[str] = []
    supervisor = RuntimeSupervisor(
        providers=(provider,),
        host=FakeHost(),
        status_sink=lambda _runtime, status, _error: _append(statuses, status),
    )

    runtime = await supervisor.start("fake", {"mode": "auto"})
    config = await supervisor.validate_config("fake", {"mode": "sdk"})

    assert config.values == {"mode": "sdk"}
    assert supervisor.resolve_runtime("fake") is runtime
    assert runtime.stopped is False
    assert supervisor.entry("fake").config is not None
    assert supervisor.entry("fake").config.values == {"mode": "auto"}
    assert statuses == [
        "validating",
        "starting",
        "running",
        "validating",
        "running",
    ]


def test_runtime_protocol_supervisor_validate_config_failure_keeps_running_runtime() -> (
    None
):
    asyncio.run(
        _test_runtime_protocol_supervisor_validate_config_failure_keeps_running_runtime()
    )


async def _test_runtime_protocol_supervisor_validate_config_failure_keeps_running_runtime() -> (
    None
):
    provider = FakeProvider()
    statuses: list[tuple[str, Mapping[str, Any] | None]] = []
    supervisor = RuntimeSupervisor(
        providers=(provider,),
        host=FakeHost(),
        status_sink=lambda _runtime, status, error: _append(statuses, (status, error)),
    )

    runtime = await supervisor.start("fake", {"mode": "auto"})
    provider.fail_validate = True
    with pytest.raises(RuntimeInvalidRequestError, match="invalid config"):
        await supervisor.validate_config("fake", {"mode": "broken"})

    assert supervisor.resolve_runtime("fake") is runtime
    assert runtime.stopped is False
    assert provider.stopped == []
    assert [status for status, _error in statuses] == [
        "validating",
        "starting",
        "running",
        "validating",
        "running",
    ]
    assert statuses[-1][1] is not None
    assert statuses[-1][1]["message"] == "invalid config"


def test_runtime_protocol_supervisor_reuses_equivalent_normalized_config() -> None:
    asyncio.run(_test_runtime_protocol_supervisor_reuses_equivalent_normalized_config())


async def _test_runtime_protocol_supervisor_reuses_equivalent_normalized_config() -> (
    None
):
    provider = FakeProvider()
    provider.normalize_modes = {"auto": "app-server"}
    statuses: list[str] = []
    supervisor = RuntimeSupervisor(
        providers=(provider,),
        host=FakeHost(),
        status_sink=lambda _runtime, status, _error: _append(statuses, status),
    )

    first = await supervisor.start("fake", {"mode": "auto"})
    second = await supervisor.start("fake", {"mode": "app-server"})

    assert second is first
    assert first.stopped is False
    assert provider.validated == [{"mode": "auto"}, {"mode": "app-server"}]
    assert len(provider.created) == 1
    assert statuses == [
        "validating",
        "starting",
        "running",
        "validating",
        "running",
    ]


def test_runtime_protocol_supervisor_keeps_running_runtime_after_invalid_restart_config() -> (
    None
):
    asyncio.run(
        _test_runtime_protocol_supervisor_keeps_running_runtime_after_invalid_restart_config()
    )


async def _test_runtime_protocol_supervisor_keeps_running_runtime_after_invalid_restart_config() -> (
    None
):
    provider = FakeProvider()
    statuses: list[tuple[str, Mapping[str, Any] | None]] = []
    supervisor = RuntimeSupervisor(
        providers=(provider,),
        host=FakeHost(),
        status_sink=lambda _runtime, status, error: _append(statuses, (status, error)),
    )

    runtime = await supervisor.start("fake", {"mode": "auto"})
    provider.fail_validate = True
    with pytest.raises(RuntimeInvalidRequestError, match="invalid config"):
        await supervisor.start("fake", {"mode": "broken"})

    assert supervisor.resolve_runtime("fake") is runtime
    assert runtime.stopped is False
    assert provider.stopped == []
    assert [status for status, _error in statuses] == [
        "validating",
        "starting",
        "running",
        "validating",
        "running",
    ]
    assert statuses[-1][1] is not None
    assert statuses[-1][1]["message"] == "invalid config"


def test_runtime_protocol_supervisor_stops_runtime() -> None:
    asyncio.run(_test_runtime_protocol_supervisor_stops_runtime())


async def _test_runtime_protocol_supervisor_stops_runtime() -> None:
    provider = FakeProvider()
    supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())

    runtime = await supervisor.start("fake", {})
    await supervisor.stop("fake")

    assert runtime.stopped is True
    with pytest.raises(RuntimeUnavailableError):
        supervisor.resolve_runtime("fake")


def test_runtime_protocol_supervisor_rejects_unknown_runtime() -> None:
    supervisor = RuntimeSupervisor(providers=(FakeProvider(),), host=FakeHost())

    with pytest.raises(RuntimeInvalidRequestError):
        supervisor.resolve_runtime("missing")


def test_runtime_protocol_supervisor_rejects_wrong_config_runtime() -> None:
    asyncio.run(_test_runtime_protocol_supervisor_rejects_wrong_config_runtime())


async def _test_runtime_protocol_supervisor_rejects_wrong_config_runtime() -> None:
    provider = FakeProvider()
    provider.config_runtime = "other"
    supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())

    with pytest.raises(RuntimeInvalidRequestError):
        await supervisor.start("fake", {})


def test_runtime_protocol_supervisor_cleans_up_after_start_failure() -> None:
    asyncio.run(_test_runtime_protocol_supervisor_cleans_up_after_start_failure())


async def _test_runtime_protocol_supervisor_cleans_up_after_start_failure() -> None:
    provider = FakeProvider()
    provider.fail_start = True
    supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())

    with pytest.raises(RuntimeError, match="boom"):
        await supervisor.start("fake", {})

    assert len(provider.stopped) == 1
    assert provider.stopped[0].stopped is True
    with pytest.raises(RuntimeUnavailableError):
        supervisor.resolve_runtime("fake")


async def _append(target: list[Any], value: Any) -> None:
    target.append(value)
