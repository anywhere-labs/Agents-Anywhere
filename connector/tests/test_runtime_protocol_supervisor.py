from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

import pytest

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeConflictError,
    RuntimeHostClient,
    RuntimeIdentity,
    RuntimeInstance,
    RuntimeInstancePolicy,
    RuntimeInstanceSpec,
    RuntimeInvalidRequestError,
    RuntimeProvider,
    RuntimeResourceClaim,
    RuntimeSupervisor,
    RuntimeTypeDescriptor,
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


class FakeProvider(RuntimeProvider):
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
        self.fail_stop = False
        self.config_runtime = "fake"
        self.config_revision = 1
        self.normalize_modes: dict[str, str] = {}
        self.claim_by_mode: dict[str, str] = {}
        self.policy: RuntimeInstancePolicy = "multiple"
        self.block_validation_mode: str | None = None
        self.validation_started: asyncio.Event | None = None
        self.validation_release: asyncio.Event | None = None
        self.block_stop = False
        self.stop_started: asyncio.Event | None = None
        self.stop_release: asyncio.Event | None = None

    @property
    def instance_policy(self) -> RuntimeInstancePolicy:
        return self.policy

    @property
    def max_instances(self) -> int | None:
        return 1 if self.policy == "single" else None

    async def discover(self) -> RuntimeTypeDescriptor:
        self.discoveries += 1
        if self.fail_discover:
            raise RuntimeError("missing")
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            available=True,
            instance_policy=self.instance_policy,
            max_instances=self.max_instances,
            config_schema=RuntimeConfigSchema(
                runtime=self.runtime,
                revision=1,
                schema={"type": "object"},
            ),
            metadata={"configured": True},
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
        if (
            self.block_validation_mode is not None
            and mode == self.block_validation_mode
        ):
            assert self.validation_started is not None
            assert self.validation_release is not None
            self.validation_started.set()
            await self.validation_release.wait()
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
        if self.block_stop:
            assert self.stop_started is not None
            assert self.stop_release is not None
            self.stop_started.set()
            await self.stop_release.wait()
        if self.fail_stop:
            raise RuntimeError("stop boom")
        await runtime.stop()

    def resource_claims(
        self,
        config: RuntimeConfig,
    ) -> tuple[RuntimeResourceClaim, ...]:
        mode = config.values.get("mode")
        key = self.claim_by_mode.get(mode) if isinstance(mode, str) else None
        if key is None:
            return ()
        return (
            RuntimeResourceClaim(kind="fake_source", key=key, label=f"source {key}"),
        )


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

    assert items[0].runtime_type == "fake"
    assert items[0].available is True
    assert provider.discoveries == 1
    assert statuses == []


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
    assert statuses == []


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
    assert isinstance(first, RuntimeInstance)
    assert first.native_runtime.started is True
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
    assert isinstance(first, RuntimeInstance)
    assert first.native_runtime.stopped is True
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
    assert isinstance(runtime, RuntimeInstance)
    assert runtime.native_runtime.stopped is False
    assert supervisor.entry("fake").config is not None
    assert supervisor.entry("fake").config.values == {"mode": "auto"}
    assert statuses == [
        "validating",
        "starting",
        "running",
        "validating",
        "running",
    ]


def test_runtime_protocol_supervisor_applies_revision_override() -> None:
    asyncio.run(_test_runtime_protocol_supervisor_applies_revision_override())


async def _test_runtime_protocol_supervisor_applies_revision_override() -> None:
    provider = FakeProvider()
    supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())

    runtime = await supervisor.start("fake", {"mode": "auto"}, revision=42)
    validated = await supervisor.validate_config("fake", {"mode": "sdk"}, revision=43)

    assert isinstance(runtime, RuntimeInstance)
    assert runtime.native_runtime.started is True
    assert provider.created[0].revision == 42
    assert supervisor.entry("fake").config is not None
    assert supervisor.entry("fake").config.revision == 42
    assert validated.revision == 43


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
    assert isinstance(runtime, RuntimeInstance)
    assert runtime.native_runtime.stopped is False
    assert provider.stopped == []
    assert [status for status, _error in statuses] == [
        "validating",
        "starting",
        "running",
        "validating",
        "running",
    ]
    assert statuses[-1][1] is None


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
    assert isinstance(first, RuntimeInstance)
    assert first.native_runtime.stopped is False
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
    assert isinstance(runtime, RuntimeInstance)
    assert runtime.native_runtime.stopped is False
    assert provider.stopped == []
    assert [status for status, _error in statuses] == [
        "validating",
        "starting",
        "running",
        "validating",
        "running",
    ]
    assert statuses[-1][1] is None


def test_runtime_protocol_supervisor_stops_runtime() -> None:
    asyncio.run(_test_runtime_protocol_supervisor_stops_runtime())


async def _test_runtime_protocol_supervisor_stops_runtime() -> None:
    provider = FakeProvider()
    supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())

    runtime = await supervisor.start("fake", {})
    await supervisor.stop("fake")

    assert isinstance(runtime, RuntimeInstance)
    assert runtime.native_runtime.stopped is True
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


def test_runtime_protocol_supervisor_runs_multiple_named_instances() -> None:
    async def run() -> None:
        provider = FakeProvider()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        first_spec = RuntimeInstanceSpec("rti_first", "fake", "First")
        second_spec = RuntimeInstanceSpec("rti_second", "fake", "Second")

        first = await supervisor.start(first_spec, {"mode": "first"})
        second = await supervisor.start(second_spec, {"mode": "second"})

        assert first is not second
        assert first.identity.runtime == "fake"
        assert first.identity.runtime_id == "rti_first"
        assert second.identity.runtime == "fake"
        assert second.identity.runtime_id == "rti_second"
        assert set(supervisor.runtimes) == {"rti_first", "rti_second"}

    asyncio.run(run())


def test_runtime_protocol_supervisor_rejects_same_resource_claim() -> None:
    async def run() -> None:
        provider = FakeProvider()
        provider.claim_by_mode = {"first": "shared", "second": "shared"}
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        first_spec = RuntimeInstanceSpec("rti_first", "fake", "First")
        second_spec = RuntimeInstanceSpec("rti_second", "fake", "Second")

        first = await supervisor.start(first_spec, {"mode": "first"})
        with pytest.raises(RuntimeConflictError, match="First"):
            await supervisor.start(second_spec, {"mode": "second"})

        assert supervisor.resolve_runtime("rti_first") is first
        assert isinstance(first, RuntimeInstance)
        assert first.native_runtime.stopped is False

    asyncio.run(run())


def test_runtime_protocol_supervisor_keeps_healthy_runtime_on_claim_failure() -> None:
    async def run() -> None:
        provider = FakeProvider()
        provider.claim_by_mode = {"one": "source-1", "two": "source-2"}
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        first_spec = RuntimeInstanceSpec("rti_first", "fake", "First")
        second_spec = RuntimeInstanceSpec("rti_second", "fake", "Second")
        first = await supervisor.start(first_spec, {"mode": "one"})
        await supervisor.start(second_spec, {"mode": "two"})

        with pytest.raises(RuntimeConflictError, match="Second"):
            await supervisor.start(first_spec, {"mode": "two"})

        assert supervisor.resolve_runtime("rti_first") is first
        assert isinstance(first, RuntimeInstance)
        assert first.native_runtime.stopped is False

    asyncio.run(run())


def test_runtime_protocol_supervisor_releases_claim_after_failed_start() -> None:
    async def run() -> None:
        provider = FakeProvider()
        provider.claim_by_mode = {"shared": "source"}
        provider.fail_start = True
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())

        with pytest.raises(RuntimeError, match="boom"):
            await supervisor.start(
                RuntimeInstanceSpec("rti_failed", "fake", "Failed"),
                {"mode": "shared"},
            )

        provider.fail_start = False
        running = await supervisor.start(
            RuntimeInstanceSpec("rti_running", "fake", "Running"),
            {"mode": "shared"},
        )
        assert running.identity.runtime_id == "rti_running"

    asyncio.run(run())


def test_runtime_protocol_supervisor_retains_claim_when_start_cleanup_fails() -> None:
    async def run() -> None:
        provider = FakeProvider()
        provider.claim_by_mode = {"shared": "source"}
        provider.fail_start = True
        provider.fail_stop = True
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        failed_spec = RuntimeInstanceSpec("rti_failed", "fake", "Failed")
        waiting_spec = RuntimeInstanceSpec("rti_waiting", "fake", "Waiting")

        with pytest.raises(RuntimeError, match="boom"):
            await supervisor.start(failed_spec, {"mode": "shared"})

        failed_entry = supervisor.entry("rti_failed")
        assert failed_entry.runtime is not None
        assert failed_entry.resource_claims == (
            RuntimeResourceClaim(
                kind="fake_source",
                key="source",
                label="source source",
            ),
        )
        assert failed_entry.error is not None
        assert failed_entry.error["message"] == "stop boom"
        with pytest.raises(RuntimeUnavailableError, match="not running"):
            supervisor.resolve_runtime("rti_failed")

        retained_runtime = failed_entry.runtime
        retained_claims = failed_entry.resource_claims
        cleanup_error = failed_entry.error
        await supervisor.validate_config(failed_spec, {"mode": "shared"})
        validated_entry = supervisor.entry("rti_failed")
        assert validated_entry.status == "error"
        assert validated_entry.runtime is retained_runtime
        assert validated_entry.resource_claims == retained_claims
        assert validated_entry.error == cleanup_error

        provider.fail_validate = True
        with pytest.raises(RuntimeInvalidRequestError, match="invalid config"):
            await supervisor.validate_config(failed_spec, {"mode": "shared"})
        invalid_entry = supervisor.entry("rti_failed")
        assert invalid_entry.status == "error"
        assert invalid_entry.runtime is retained_runtime
        assert invalid_entry.resource_claims == retained_claims
        provider.fail_validate = False

        cleanup_attempts = len(provider.stopped)
        with pytest.raises(RuntimeError, match="stop boom"):
            await supervisor.start(failed_spec, {"mode": "shared"})
        assert len(provider.stopped) == cleanup_attempts + 1
        assert supervisor.entry("rti_failed").status == "error"
        with pytest.raises(RuntimeUnavailableError, match="not running"):
            supervisor.resolve_runtime("rti_failed")

        with pytest.raises(RuntimeConflictError, match="Failed"):
            await supervisor.start(waiting_spec, {"mode": "shared"})

        provider.fail_start = False
        provider.fail_stop = False
        await supervisor.stop("rti_failed")
        running = await supervisor.start(waiting_spec, {"mode": "shared"})
        assert running.identity.runtime_id == "rti_waiting"

    asyncio.run(run())


def test_runtime_protocol_supervisor_retains_claim_when_normal_stop_fails() -> None:
    async def run() -> None:
        provider = FakeProvider()
        provider.claim_by_mode = {"shared": "source"}
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        first_spec = RuntimeInstanceSpec("rti_first", "fake", "First")
        second_spec = RuntimeInstanceSpec("rti_second", "fake", "Second")
        await supervisor.start(first_spec, {"mode": "shared"})

        provider.fail_stop = True
        with pytest.raises(RuntimeError, match="stop boom"):
            await supervisor.stop("rti_first")

        failed_entry = supervisor.entry("rti_first")
        assert failed_entry.status == "error"
        assert failed_entry.runtime is not None
        assert failed_entry.resource_claims
        with pytest.raises(RuntimeUnavailableError, match="not running"):
            supervisor.resolve_runtime("rti_first")
        with pytest.raises(RuntimeConflictError, match="First"):
            await supervisor.start(second_spec, {"mode": "shared"})

        provider.fail_stop = False
        await supervisor.stop("rti_first")
        running = await supervisor.start(second_spec, {"mode": "shared"})
        assert running.identity.runtime_id == "rti_second"

    asyncio.run(run())


def test_runtime_protocol_supervisor_rejects_routing_while_stopping() -> None:
    async def run() -> None:
        provider = FakeProvider()
        provider.block_stop = True
        provider.stop_started = asyncio.Event()
        provider.stop_release = asyncio.Event()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        await supervisor.start("fake", {})

        stopping = asyncio.create_task(supervisor.stop("fake"))
        await provider.stop_started.wait()

        assert supervisor.entry("fake").status == "stopping"
        with pytest.raises(RuntimeUnavailableError, match="not running"):
            supervisor.resolve_runtime("fake")

        provider.stop_release.set()
        await stopping

    asyncio.run(run())


def test_runtime_protocol_supervisor_keeps_running_claim_during_validation() -> None:
    async def run() -> None:
        provider = FakeProvider()
        provider.claim_by_mode = {
            "current": "source-a",
            "candidate": "source-b",
            "conflict": "source-a",
        }
        provider.block_validation_mode = "candidate"
        provider.validation_started = asyncio.Event()
        provider.validation_release = asyncio.Event()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        first_spec = RuntimeInstanceSpec("rti_first", "fake", "First")
        await supervisor.start(first_spec, {"mode": "current"})

        validation = asyncio.create_task(
            supervisor.validate_config(first_spec, {"mode": "candidate"})
        )
        await provider.validation_started.wait()

        with pytest.raises(RuntimeConflictError, match="already used"):
            await supervisor.start(
                RuntimeInstanceSpec("rti_second", "fake", "Second"),
                {"mode": "conflict"},
            )

        provider.validation_release.set()
        await validation
        assert supervisor.resolve_runtime("rti_first").identity.runtime_id == (
            "rti_first"
        )

    asyncio.run(run())


def test_runtime_protocol_supervisor_rename_does_not_restart() -> None:
    async def run() -> None:
        provider = FakeProvider()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        original = await supervisor.start(
            RuntimeInstanceSpec("rti_named", "fake", "Original"),
            {"mode": "same"},
            revision=1,
        )
        renamed = await supervisor.start(
            RuntimeInstanceSpec("rti_named", "fake", "Renamed"),
            {"mode": "same"},
            revision=2,
        )

        assert isinstance(original, RuntimeInstance)
        assert isinstance(renamed, RuntimeInstance)
        assert renamed.native_runtime is original.native_runtime
        assert renamed.identity.display_name == "Renamed"
        assert renamed.native_runtime.stopped is False
        assert len(provider.created) == 1
        config = supervisor.entry("rti_named").config
        assert config is not None
        assert config.revision == 2

    asyncio.run(run())


def test_runtime_protocol_supervisor_enforces_single_policy() -> None:
    async def run() -> None:
        provider = FakeProvider()
        provider.policy = "single"
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        await supervisor.start(
            RuntimeInstanceSpec("rti_first", "fake", "First"),
            {},
        )

        with pytest.raises(RuntimeConflictError, match="at most 1"):
            await supervisor.start(
                RuntimeInstanceSpec("rti_second", "fake", "Second"),
                {},
            )

    asyncio.run(run())


async def _append(target: list[Any], value: Any) -> None:
    target.append(value)
