from __future__ import annotations

import asyncio
from collections import Counter
from types import SimpleNamespace

import pytest
from meshcall import MeshCallError

from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeUnavailableError,
)
from connector.server.mesh_services import (
    ConnectorControlExecutor,
    Payload,
    _DomainService,
    bind_control_services,
)


class HeldDispatch:
    def __init__(self):
        self.entered = asyncio.Queue()
        self.release = {lane: asyncio.Event() for lane in ("regular", "critical")}
        self.active, self.peaks, self.calls, self.finished, self.cancelled = (Counter() for _ in range(5))

    async def __call__(self, method, params):
        marker = params["marker"]
        lane = "critical" if method in {"interaction.respond", "session.notices"} else "regular"
        self.calls[marker] += 1
        self.active[lane] += 1
        self.peaks[lane] = max(self.peaks[lane], self.active[lane])
        self.entered.put_nowait(marker)
        try:
            await self.release[lane].wait()
            self.finished[marker] += 1
            return {"marker": marker}
        except asyncio.CancelledError:
            self.cancelled[marker] += 1
            raise
        finally:
            self.active[lane] -= 1

    async def started(self, count):
        return [await asyncio.wait_for(self.entered.get(), 2) for _ in range(count)]

    async def cleanup(self, executor, tasks):
        for event in self.release.values():
            event.set()
        await executor.close_session()
        await asyncio.gather(*tasks, return_exceptions=True)


def test_executor_queues_regular_work_and_keeps_two_critical_slots_independent():
    async def exercise():
        dispatch = HeldDispatch()
        executor = ConnectorControlExecutor(dispatch)
        executor.open_session(dispatch, "base")
        regular = [asyncio.create_task(executor.execute(
            "session.interrupt" if index % 2 else "shell.exec", {"marker": f"regular-{index}"},
            "base", str(index), "connection")) for index in range(12)]
        critical = [asyncio.create_task(executor.execute(
            "session.notices" if index % 2 else "interaction.respond", {"marker": f"critical-{index}"},
            "base", str(index), "connection")) for index in range(4)]
        try:
            await dispatch.started(10)
            await asyncio.sleep(0)
            assert dispatch.active == {"regular": 8, "critical": 2}
            assert sum(dispatch.calls.values()) == 10
            assert all(not task.done() for task in [*regular, *critical])
            dispatch.release["critical"].set()
            await asyncio.wait_for(asyncio.gather(*critical), 2)
            assert all(not task.done() for task in regular)
            dispatch.release["regular"].set()
            replies = await asyncio.wait_for(asyncio.gather(*regular), 2)
            assert len({reply["marker"] for reply in replies}) == 12
            assert len(dispatch.finished) == 16 and set(dispatch.finished.values()) == {1}
            assert dispatch.peaks == {"regular": 8, "critical": 2}
        finally:
            await dispatch.cleanup(executor, [*regular, *critical])

    asyncio.run(exercise())


@pytest.mark.parametrize("cancel_running", [False, True], ids=["queued", "running"])
def test_cancellation_reclaims_capacity_without_executing_cancelled_queue_entries(cancel_running):
    async def exercise():
        dispatch = HeldDispatch()
        executor = ConnectorControlExecutor(dispatch)
        executor.open_session(dispatch, "base")
        tasks = [asyncio.create_task(executor.execute(
            "shell.exec", {"marker": str(index)}, "base", str(index), "connection")) for index in range(8)]
        try:
            assert set(await dispatch.started(8)) == {str(index) for index in range(8)}
            queued = asyncio.create_task(executor.execute("shell.exec", {"marker": "queued"}, "base", "q", "connection"))
            tasks.append(queued)
            await asyncio.sleep(0)
            victim = tasks[0] if cancel_running else queued
            victim.cancel()
            with pytest.raises(asyncio.CancelledError):
                await victim
            if cancel_running:
                assert await dispatch.started(1) == ["queued"]
                assert dispatch.cancelled == {"0": 1}
            else:
                assert dispatch.calls["queued"] == 0
            dispatch.release["regular"].set()
            await asyncio.gather(*tasks, return_exceptions=True)
            assert await executor.execute("shell.exec", {"marker": "after"}, "base", "after", "connection") == {"marker": "after"}
            assert dispatch.peaks["regular"] == 8 and not executor._tasks
        finally:
            await dispatch.cleanup(executor, tasks)

    asyncio.run(exercise())


def test_base_connection_close_cancels_running_and_queued_work_before_reopening():
    async def exercise():
        dispatch = HeldDispatch()
        executor = ConnectorControlExecutor(dispatch)
        executor.open_session(dispatch, "old-base")
        tasks = [asyncio.create_task(executor.execute(
            "shell.exec", {"marker": str(index)}, "old-base", str(index), "old-connection")) for index in range(10)]
        tasks += [asyncio.create_task(executor.execute(
            "interaction.respond", {"marker": f"approval-{index}"}, "old-base", str(index), "old-connection")) for index in range(3)]
        try:
            await dispatch.started(10)
            await asyncio.sleep(0)
            await executor.close_session()
            assert all(task.cancelled() for task in tasks)
            assert sum(dispatch.cancelled.values()) == 10
            assert not dispatch.finished and not executor._tasks
            assert not dispatch.calls["8"] and not dispatch.calls["approval-2"]
            executor.open_session(dispatch, "new-base")
            with pytest.raises(MeshCallError) as stale:
                await executor.execute("shell.exec", {"marker": "stale"}, "old-base", "stale", "old-connection")
            assert stale.value.details == {"source": "connector_executor", "deliveryState": "not_dispatched"}
            assert not dispatch.calls["stale"]
            dispatch.release["regular"].set()
            assert await executor.execute("shell.exec", {"marker": "fresh"}, "new-base", "fresh", "new-connection") == {"marker": "fresh"}
        finally:
            await dispatch.cleanup(executor, tasks)

    asyncio.run(exercise())


def test_overlapping_service_registrations_share_executor_capacity():
    async def exercise():
        dispatch = HeldDispatch()
        executor = ConnectorControlExecutor(dispatch)
        executor.open_session(dispatch, "base")
        domains = ("RuntimeControl", "Sessions", "Workspaces", "Files", "Shell", "Terminals")
        bindings = [bind_control_services({domain: f"probe.link{link}.{domain}" for domain in domains}, dispatch,
                                         asyncio.get_running_loop(), executor=executor) for link in range(2)]
        tasks = [asyncio.create_task(bindings[index % 2][0]._call(
            "shell.exec", Payload(marker=str(index)), SimpleNamespace(call_id=str(index), metadata={}))) for index in range(12)]
        try:
            await dispatch.started(8)
            await asyncio.sleep(0)
            assert dispatch.active["regular"] == 8 and len(dispatch.calls) == 8
            dispatch.release["regular"].set()
            assert len(await asyncio.wait_for(asyncio.gather(*tasks), 2)) == 12
            assert dispatch.peaks["regular"] == 8 and set(dispatch.finished.values()) == {1}
        finally:
            await dispatch.cleanup(executor, tasks)

    asyncio.run(exercise())


def test_cancelling_rpc_waiter_does_not_cancel_admitted_execution():
    async def exercise():
        dispatch = HeldDispatch()
        executor = ConnectorControlExecutor(dispatch)
        executor.open_session(dispatch, "base")
        service = _DomainService(executor, asyncio.get_running_loop(), "base")
        caller = asyncio.create_task(service._call("shell.exec", Payload(marker="mutation"),
                                                 SimpleNamespace(call_id="mesh", metadata={})))
        try:
            assert await dispatch.started(1) == ["mutation"]
            caller.cancel()
            with pytest.raises(asyncio.CancelledError):
                await caller
            assert executor._tasks and not dispatch.cancelled and not dispatch.finished
            dispatch.release["regular"].set()
            await asyncio.wait_for(asyncio.gather(*tuple(executor._tasks)), 2)
            assert dispatch.finished == dispatch.calls == {"mutation": 1}
        finally:
            await dispatch.cleanup(executor, [caller])

    asyncio.run(exercise())


@pytest.mark.parametrize("result", [{"ok": False, "code": "denied"}, {"accepted": False, "reason": "busy"}])
def test_adapter_preserves_business_rejections(result):
    async def exercise():
        async def dispatch(*_args):
            return result
        executor = ConnectorControlExecutor(dispatch)
        executor.open_session(dispatch, "base")
        service = _DomainService(executor, asyncio.get_running_loop(), "base")
        try:
            response = await service._call("session.send_message", Payload(), SimpleNamespace(call_id="mesh", metadata={}))
            assert response.model_dump() == result
        finally:
            await executor.close_session()
    asyncio.run(exercise())


@pytest.mark.parametrize("error,code,retryable,details", [
    (RuntimeInvalidRequestError("invalid"), "runtime_invalid_request", False, {}),
    (RuntimeUnavailableError("offline"), "runtime_unavailable", True, {}),
    (MeshCallError("unavailable", "domain refused", retryable=True,
                   details={"source": "router", "reason": "no_instances"}),
     "unavailable", True, {"reason": "no_instances"}),
    (ValueError("bad value"), "ValueError", False, {"errorType": "ValueError"}),
])
def test_adapter_marks_domain_errors_so_server_cannot_replay_them(error, code, retryable, details):
    async def exercise():
        async def dispatch(*_args):
            raise error
        executor = ConnectorControlExecutor(dispatch)
        executor.open_session(dispatch, "base")
        service = _DomainService(executor, asyncio.get_running_loop(), "base")
        try:
            with pytest.raises(MeshCallError) as caught:
                await service._call("session.send_message", Payload(), SimpleNamespace(call_id="mesh", metadata={}))
            assert caught.value.code == code and caught.value.retryable is retryable
            assert caught.value.details == {**details, "source": "connector_domain"}
            assert caught.value.message == str(error)
        finally:
            await executor.close_session()
    asyncio.run(exercise())
