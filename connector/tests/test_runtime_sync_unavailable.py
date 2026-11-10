from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from connector.logging import logger
from connector.runtime_protocol import RuntimeInstanceSpec, RuntimeSupervisor
from connector.server.runtime_rpc import RuntimeRpcHandler
from connector.server.runtime_sync import RuntimeSyncRunner
from tests.test_runtime_protocol_supervisor import FakeHost, FakeProvider, FakeRuntime


class EventRuntime(FakeRuntime):
    def __init__(self, runtime: str, fail_start: bool = False, fail_resync: bool = False) -> None:
        super().__init__(runtime=runtime, fail_start=fail_start)
        self.fail_resync = fail_resync
        self.resynchronized = 0

    @property
    def sync_mode(self) -> str:
        return "events"

    async def resynchronize(self, session_id=None, external_session_id=None) -> None:
        self.resynchronized += 1
        if self.fail_resync:
            raise RuntimeError("resync boom")


class EventProvider(FakeProvider):
    def __init__(self) -> None:
        super().__init__()
        self.fail_resync = False

    async def create_runtime(self, config, host):
        await super().create_runtime(config, host)
        return EventRuntime(config.runtime, fail_start=self.fail_start, fail_resync=self.fail_resync)


class Fixture:
    def __init__(self) -> None:
        self.provider = EventProvider()
        self.host = FakeHost()
        self.supervisor = RuntimeSupervisor((self.provider,), self.host)
        self.rpc = RuntimeRpcHandler(self.supervisor, self.host)
        self.runner = RuntimeSyncRunner(None, self.supervisor, self.host, dict, AsyncMock())

    async def start(self, runtime_id: str, values=None):
        return await self.supervisor.start(spec(runtime_id), values or {})

    def resynchronized(self, runtime_id: str) -> int:
        return self.supervisor.entry(runtime_id).runtime.native_runtime.resynchronized


def spec(runtime_id: str) -> RuntimeInstanceSpec:
    return RuntimeInstanceSpec(runtime_id=runtime_id, runtime_type="fake", name=runtime_id)


async def stopped_through_rpc(f: Fixture, runtime_id: str) -> None:
    started = await f.rpc.dispatch(
        "runtime.start",
        {"runtime": "fake", "runtimeId": runtime_id, "name": runtime_id, "config": {}, "configRevision": 1},
    )
    assert started["status"] == "running"
    # Deleting an instance in Web makes the Server send exactly this RPC.
    stopped = await f.rpc.dispatch("runtime.stop", {"runtime": "fake", "runtimeId": runtime_id})
    assert stopped["status"] == "stopped"


async def registered_never_started(f: Fixture, runtime_id: str) -> None:
    await f.supervisor.ensure_instance(spec(runtime_id))


async def stop_failed(f: Fixture, runtime_id: str) -> None:
    await f.start(runtime_id)
    f.provider.fail_stop = True
    with pytest.raises(RuntimeError, match="stop boom"):
        await f.supervisor.stop(runtime_id)
    f.provider.fail_stop = False


async def start_failed(f: Fixture, runtime_id: str) -> None:
    f.provider.fail_start = True
    with pytest.raises(RuntimeError, match="boom"):
        await f.start(runtime_id)
    f.provider.fail_start = False


async def provider_reported_error(f: Fixture, runtime_id: str) -> None:
    await f.start(runtime_id)
    await f.provider.hosts[-1].runtime_health_update(
        "error", {"code": "runtime_unavailable", "message": "bridge gone"}
    )


# (scenario, expected supervisor status, whether the runtime is expected to be reported)
UNAVAILABLE_CASES = [
    (stopped_through_rpc, "stopped", False),
    (registered_never_started, "stopped", False),
    (stop_failed, "error", True),
    (start_failed, "error", True),
    (provider_reported_error, "error", True),
]
CASE_IDS = [case[0].__name__ for case in UNAVAILABLE_CASES]


class LogCapture:
    def __enter__(self):
        self.records = []
        self._handler = logger.add(lambda message: self.records.append(message.record), level="DEBUG")
        return self

    def __exit__(self, *exc):
        logger.remove(self._handler)

    def about(self, runtime_id: str):
        return [record for record in self.records if f"runtime={runtime_id}" in record["message"]
                or f"existing {runtime_id} " in record["message"]]


@pytest.mark.parametrize(("scenario", "status", "reported"), UNAVAILABLE_CASES, ids=CASE_IDS)
def test_reconnect_recovery_logs_unavailable_instances_by_lifecycle_state(scenario, status, reported):
    async def exercise():
        f = Fixture()
        await scenario(f, "rti_target")
        await f.start("rti_live")
        assert f.supervisor.entry("rti_target").status == status
        with LogCapture() as logs:
            await f.runner.reconnect_event_runtimes()

        assert f.resynchronized("rti_live") == 1
        assert logs.about("rti_live") == []
        target = logs.about("rti_target")
        if not reported:
            assert target == []
            return
        assert len(target) == 1
        assert target[0]["level"].name == "INFO"
        assert target[0]["exception"] is None
        assert target[0]["message"] == (
            "runtime event recovery skipped runtime=rti_target reason="
            f"runtime instance 'rti_target' is not running (status='{status}')"
        )

    asyncio.run(exercise())


@pytest.mark.parametrize(("scenario", "status", "reported"), UNAVAILABLE_CASES, ids=CASE_IDS)
def test_existing_session_sync_reports_only_unavailable_configured_instances(scenario, status, reported):
    async def exercise():
        f = Fixture()
        await scenario(f, "rti_target")
        assert f.supervisor.entry("rti_target").status == status
        with LogCapture() as logs:
            for _ in range(3):
                await f.runner.sync_existing_once()

        messages = [record["message"] for record in logs.about("rti_target")]
        assert all(record["level"].name == "INFO" for record in logs.records)
        expected = "existing session sync runtime unavailable runtime=rti_target"
        assert messages == ([expected] * 3 if reported else [])

    asyncio.run(exercise())


def test_reconnect_reports_an_instance_that_is_still_validating():
    async def exercise():
        f = Fixture()
        f.provider.block_validation_mode = "slow"
        f.provider.validation_started = asyncio.Event()
        f.provider.validation_release = asyncio.Event()
        pending = asyncio.create_task(f.start("rti_booting", {"mode": "slow"}))
        await f.provider.validation_started.wait()
        try:
            with LogCapture() as logs:
                await f.runner.reconnect_event_runtimes()
        finally:
            f.provider.validation_release.set()
            await pending

        assert [record["message"] for record in logs.records] == [
            (
                "runtime event recovery skipped runtime=rti_booting reason="
                "runtime instance 'rti_booting' is not running (status='validating')"
            )
        ]

    asyncio.run(exercise())


def test_restarted_instance_is_resynchronized_again_after_being_stopped():
    async def exercise():
        f = Fixture()
        await stopped_through_rpc(f, "rti_target")
        await f.start("rti_target")
        with LogCapture() as logs:
            await f.runner.reconnect_event_runtimes()

        assert f.resynchronized("rti_target") == 1
        assert logs.records == []

    asyncio.run(exercise())


def test_unexpected_recovery_failure_still_logs_a_traceback_and_does_not_stop_later_instances():
    async def exercise():
        f = Fixture()
        await stopped_through_rpc(f, "rti_stopped")
        f.provider.fail_resync = True
        await f.start("rti_broken")
        f.provider.fail_resync = False
        await f.start("rti_live")
        with LogCapture() as logs:
            await f.runner.reconnect_event_runtimes()

        assert f.resynchronized("rti_broken") == 1
        assert f.resynchronized("rti_live") == 1
        assert [(record["level"].name, record["message"]) for record in logs.records] == [
            ("ERROR", "runtime event recovery deferred runtime=rti_broken")
        ]
        assert logs.records[0]["exception"].type is RuntimeError

    asyncio.run(exercise())
