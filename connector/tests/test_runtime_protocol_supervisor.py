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
    RuntimeInstanceSpec,
    RuntimeInvalidRequestError,
    RuntimeProvider,
    RuntimeResourceClaim,
    RuntimeResourceConflictError,
    RuntimeSupervisor,
    RuntimeTypeDescriptor,
    RuntimeUnavailableError,
)


class FakeHost(RuntimeHostClient):
    @property
    def connector_id(self) -> str:
        return "conn_test"


class FakeRuntime(AgentRuntime):
    def __init__(self, fail_start: bool = False) -> None:
        self.fail_start = fail_start
        self.started = False
        self.stopped = False

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime_id="fake-native",
            runtime_type="fake",
            name="Fake native",
            runtime_version="test",
        )

    async def start(self) -> None:
        if self.fail_start:
            raise RuntimeError("boom")
        self.started = True

    async def stop(self) -> None:
        self.stopped = True


class FakeProvider(RuntimeProvider):
    runtime_type = "fake"
    display_name = "Fake Runtime"
    description = "Fake runtime type"
    recommended = True
    recommendation_rank = 10

    def __init__(self) -> None:
        self.discoveries = 0
        self.validated: list[dict[str, Any]] = []
        self.created: list[tuple[RuntimeInstanceSpec, RuntimeConfig, str | None]] = []
        self.stopped: list[AgentRuntime] = []
        self.fail_discover = False
        self.fail_validate = False
        self.fail_start = False
        self.config_runtime_type = "fake"
        self.config_revision = 1
        self.normalize_modes: dict[str, str] = {}

    async def discover(self) -> RuntimeTypeDescriptor:
        self.discoveries += 1
        if self.fail_discover:
            raise RuntimeError("missing")
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            description=self.description,
            available=True,
            recommended=self.recommended,
            recommendation_rank=self.recommendation_rank,
            config_schema=await self.get_config_schema(),
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        return RuntimeConfigSchema(
            runtime_type=self.runtime_type,
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
            runtime_type=self.config_runtime_type,
            revision=self.config_revision,
            values=normalized,
        )

    async def create_runtime(
        self,
        instance: RuntimeInstanceSpec,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        self.created.append((instance, config, host.runtime_id))
        return FakeRuntime(fail_start=self.fail_start)

    def resource_claims(
        self,
        config: RuntimeConfig,
    ) -> tuple[RuntimeResourceClaim, ...]:
        resource = config.values.get("resource")
        if not isinstance(resource, str) or not resource:
            return ()
        return (
            RuntimeResourceClaim(
                kind="fake_resource",
                key=resource,
                label=f"Fake resource {resource!r}",
            ),
        )

    async def stop_runtime(self, runtime: AgentRuntime) -> None:
        self.stopped.append(runtime)
        await runtime.stop()


INSTANCE_ONE = RuntimeInstanceSpec(
    runtime_id="runtime_one",
    runtime_type="fake",
    name="Fake One",
)
INSTANCE_TWO = RuntimeInstanceSpec(
    runtime_id="runtime_two",
    runtime_type="fake",
    name="Fake Two",
)


def test_runtime_supervisor_discovers_runtime_types_without_creating_instances() -> (
    None
):
    async def exercise() -> None:
        provider = FakeProvider()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())

        items = await supervisor.discover()

        assert items[0].runtime_type == "fake"
        assert items[0].recommended is True
        assert provider.discoveries == 1
        assert supervisor.runtimes == ()
        assert supervisor.runtime_types == ("fake",)

    asyncio.run(exercise())


def test_runtime_supervisor_maps_discovery_failure_to_unavailable_type() -> None:
    async def exercise() -> None:
        provider = FakeProvider()
        provider.fail_discover = True
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())

        items = await supervisor.discover()

        assert items[0].runtime_type == "fake"
        assert items[0].available is False
        assert items[0].reason == "missing"

    asyncio.run(exercise())


def test_runtime_supervisor_runs_multiple_instances_of_one_type() -> None:
    async def exercise() -> None:
        provider = FakeProvider()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())

        first = await supervisor.start(INSTANCE_ONE, {"mode": "one"})
        second = await supervisor.start(INSTANCE_TWO, {"mode": "two"})

        assert first is supervisor.resolve_runtime(INSTANCE_ONE.runtime_id)
        assert second is supervisor.resolve_runtime(INSTANCE_TWO.runtime_id)
        assert first is not second
        assert first.identity.runtime_id == INSTANCE_ONE.runtime_id
        assert first.identity.runtime_type == "fake"
        assert first.identity.name == INSTANCE_ONE.name
        assert second.identity.runtime_id == INSTANCE_TWO.runtime_id
        assert [created[2] for created in provider.created] == [
            INSTANCE_ONE.runtime_id,
            INSTANCE_TWO.runtime_id,
        ]

    asyncio.run(exercise())


def test_runtime_supervisor_reuses_identical_requested_config() -> None:
    async def exercise() -> None:
        provider = FakeProvider()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())

        first = await supervisor.start(INSTANCE_ONE, {"mode": "auto"})
        second = await supervisor.start(INSTANCE_ONE, {"mode": "auto"})

        assert second is first
        assert provider.validated == [{"mode": "auto"}]
        assert len(provider.created) == 1

    asyncio.run(exercise())


def test_runtime_supervisor_updates_instance_name_without_restart() -> None:
    async def exercise() -> None:
        provider = FakeProvider()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        first = await supervisor.start(INSTANCE_ONE, {"mode": "auto"})
        renamed = RuntimeInstanceSpec(
            runtime_id=INSTANCE_ONE.runtime_id,
            runtime_type=INSTANCE_ONE.runtime_type,
            name="Renamed Fake",
        )

        second = await supervisor.start(renamed, {"mode": "auto"})

        assert second is not first
        assert second.runtime is first.runtime  # type: ignore[attr-defined]
        assert second.identity.name == "Renamed Fake"
        assert len(provider.created) == 1

    asyncio.run(exercise())


def test_runtime_supervisor_restarts_only_changed_instance() -> None:
    async def exercise() -> None:
        provider = FakeProvider()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        first = await supervisor.start(INSTANCE_ONE, {"mode": "auto"})
        other = await supervisor.start(INSTANCE_TWO, {"mode": "other"})

        restarted = await supervisor.start(INSTANCE_ONE, {"mode": "sdk"})

        assert restarted is not first
        assert first.runtime.stopped is True  # type: ignore[attr-defined]
        assert supervisor.resolve_runtime(INSTANCE_TWO.runtime_id) is other
        assert other.runtime.stopped is False  # type: ignore[attr-defined]

    asyncio.run(exercise())


def test_runtime_supervisor_validation_does_not_replace_running_config() -> None:
    async def exercise() -> None:
        provider = FakeProvider()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        runtime = await supervisor.start(INSTANCE_ONE, {"mode": "auto"})

        validated = await supervisor.validate_config(
            INSTANCE_ONE,
            {"mode": "sdk"},
            revision=43,
        )

        assert validated.revision == 43
        assert validated.values == {"mode": "sdk"}
        assert supervisor.resolve_runtime(INSTANCE_ONE.runtime_id) is runtime
        entry = supervisor.entry(INSTANCE_ONE.runtime_id)
        assert entry.config is not None
        assert entry.config.values == {"mode": "auto"}

    asyncio.run(exercise())


def test_runtime_supervisor_invalid_restart_keeps_running_instance() -> None:
    async def exercise() -> None:
        provider = FakeProvider()
        statuses: list[tuple[str, str, Mapping[str, Any] | None]] = []
        supervisor = RuntimeSupervisor(
            providers=(provider,),
            host=FakeHost(),
            status_sink=lambda runtime_id, status, error: append_status(
                statuses,
                runtime_id,
                status,
                error,
            ),
        )
        runtime = await supervisor.start(INSTANCE_ONE, {"mode": "auto"})
        provider.fail_validate = True

        with pytest.raises(RuntimeInvalidRequestError, match="invalid config"):
            await supervisor.start(INSTANCE_ONE, {"mode": "broken"})

        assert supervisor.resolve_runtime(INSTANCE_ONE.runtime_id) is runtime
        assert runtime.runtime.stopped is False  # type: ignore[attr-defined]
        assert statuses[-1][0] == INSTANCE_ONE.runtime_id
        assert statuses[-1][1] == "running"
        assert statuses[-1][2] == {
            "code": "runtime_invalid_request",
            "message": "invalid config",
            "retryable": False,
        }

    asyncio.run(exercise())


def test_runtime_supervisor_rejects_conflicting_resource_claim() -> None:
    async def exercise() -> None:
        provider = FakeProvider()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        await supervisor.start(INSTANCE_ONE, {"resource": "/shared/home"})

        with pytest.raises(
            RuntimeResourceConflictError,
            match="Fake One.*runtime_one",
        ):
            await supervisor.start(INSTANCE_TWO, {"resource": "/shared/home"})

        conflict = supervisor.entry(INSTANCE_TWO.runtime_id)
        assert conflict.status == "error"
        assert conflict.error is not None
        assert conflict.error["code"] == "runtime_resource_conflict"
        assert len(provider.created) == 1

    asyncio.run(exercise())


def test_runtime_supervisor_releases_resource_after_stop() -> None:
    async def exercise() -> None:
        provider = FakeProvider()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        await supervisor.start(INSTANCE_ONE, {"resource": "/shared/home"})
        await supervisor.stop(INSTANCE_ONE.runtime_id)

        second = await supervisor.start(INSTANCE_TWO, {"resource": "/shared/home"})

        assert second.identity.runtime_id == INSTANCE_TWO.runtime_id

    asyncio.run(exercise())


def test_runtime_supervisor_releases_resource_after_failed_start() -> None:
    async def exercise() -> None:
        provider = FakeProvider()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())
        provider.fail_start = True

        with pytest.raises(RuntimeError, match="boom"):
            await supervisor.start(INSTANCE_ONE, {"resource": "/shared/home"})

        failed = supervisor.entry(INSTANCE_ONE.runtime_id)
        assert failed.status == "error"
        assert failed.error is not None
        assert failed.error["message"] == "boom"
        assert failed.resource_claims == ()
        provider.fail_start = False
        second = await supervisor.start(INSTANCE_TWO, {"resource": "/shared/home"})
        assert second.identity.runtime_id == INSTANCE_TWO.runtime_id

    asyncio.run(exercise())


def test_runtime_supervisor_rejects_provider_config_for_wrong_type() -> None:
    async def exercise() -> None:
        provider = FakeProvider()
        provider.config_runtime_type = "other"
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())

        with pytest.raises(RuntimeInvalidRequestError, match="returned config"):
            await supervisor.start(INSTANCE_ONE, {})

    asyncio.run(exercise())


def test_runtime_supervisor_rejects_unknown_instance() -> None:
    supervisor = RuntimeSupervisor(providers=(FakeProvider(),), host=FakeHost())

    with pytest.raises(RuntimeInvalidRequestError, match="unknown runtime instance"):
        supervisor.resolve_runtime("missing")
    with pytest.raises(RuntimeUnavailableError):
        asyncio.run(_start_then_stop(supervisor))


async def _start_then_stop(supervisor: RuntimeSupervisor) -> None:
    await supervisor.start(INSTANCE_ONE, {})
    await supervisor.stop(INSTANCE_ONE.runtime_id)
    supervisor.resolve_runtime(INSTANCE_ONE.runtime_id)


async def append_status(
    target: list[tuple[str, str, Mapping[str, Any] | None]],
    runtime_id: str,
    status: str,
    error: Mapping[str, Any] | None,
) -> None:
    target.append((runtime_id, status, error))
