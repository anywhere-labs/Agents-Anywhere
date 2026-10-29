"""Fault probes for request budgets and bounded diagnostic delivery; no business DB.

Run with PYTHONPATH=.:../connector from server. Peers are synthetic; the journal
probe uses a real temporary log directory. No product process is started.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import tempfile
import threading
import time
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace

from connector.logging import install_rpc_log_sink
from connector.mesh.logs import LogHub
from connector.server.mesh_services import (
    ConnectorControlExecutor,
    Payload,
    _DomainService,
)
from loguru import logger
from meshcall import UnavailableError

from agent_server.infra.connector_mesh_control import MeshConnectorControlTransport
from agent_server.infra.connector_mesh_routes import MeshRoute
from agent_server.infra.connector_rpc import (
    ConnectorNotDispatchedError,
    ConnectorRpcManager,
    ConnectorTransportTimeout,
)
from agent_server.infra.redis_coordinator import RedisCoordinator

ROUTE = MeshRoute("probe", "connection", "link", "router", "worker", 1, "owner")


async def ready(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(0.001)


async def run_probe() -> list[dict]:
    results = []
    logger.remove()

    async def yes(*_args):
        return True

    async def route(*_args):
        return ROUTE

    async def blocked(*_args, **_kwargs):
        await asyncio.Event().wait()

    def adapter():
        mesh = SimpleNamespace(router_id=ROUTE.router_id, routes=SimpleNamespace(get=route))
        rpc = SimpleNamespace(instance_id="worker", current_connection_id=yes, is_connection_id_current=yes)
        return MeshConnectorControlTransport(mesh, rpc)

    async def expires(name, action, delivery="not_dispatched", timeout=0.02):
        started = time.monotonic()
        async with asyncio.timeout(1):
            try:
                await action(timeout)
            except ConnectorTransportTimeout as exc:
                assert exc.details["deliveryState"] == delivery, exc.details
            else:
                raise AssertionError(f"{name}: request unexpectedly returned")
        elapsed = (time.monotonic() - started) * 1000
        assert elapsed < 300, elapsed
        results.append({"scenario": name, "passed": True, "elapsedMs": round(elapsed, 2)})

    transport = adapter()
    transport.rpc.current_connection_id = blocked
    await expires("initial connection lookup is bounded", lambda t: transport.request_bound("probe", "shell.exec", {}, timeout=t))
    transport = adapter()
    transport.rpc.is_connection_id_current = blocked
    await expires("presence validation is bounded", lambda t: transport._request_on_connection("probe", "connection", "shell.exec", {}, timeout=t))
    transport = adapter()
    transport.mesh.routes.get = blocked
    await expires("Mesh route lookup is bounded", lambda t: transport._request_on_connection("probe", "connection", "shell.exec", {}, timeout=t))

    manager = ConnectorRpcManager(RedisCoordinator(client=SimpleNamespace(get=blocked)))
    manager.bind_request_transport(adapter())
    await expires("capability discovery before Mesh selection is bounded", lambda t: manager.request("probe", "shell.exec", {}, timeout=t))

    transport = adapter()
    checks = 0

    async def postcheck(*_args):
        nonlocal checks
        checks += 1
        if checks > 1:
            await blocked()
        return True

    async def returned(*_args):
        return Payload(ok=True)

    transport.rpc.is_connection_id_current = postcheck
    transport.mesh.connection = lambda: SimpleNamespace(connect=yes, call_unary=lambda *_a, **_k: returned())
    await expires("identity validation after a response stays within budget", lambda t: transport._request_on_connection("probe", "connection", "shell.exec", {}, timeout=t), "outcome_unknown")

    transport = adapter()

    async def no_instance(*_args, **_kwargs):
        raise UnavailableError("not registered", details={"source": "router", "reason": "no_instances"})

    transport.mesh.connection = lambda: SimpleNamespace(connect=yes, call_unary=no_instance)
    try:
        await transport._request_on_connection("probe", "connection", "shell.exec", {}, timeout=1)
    except ConnectorNotDispatchedError as error:
        assert error.details["reason"] == "no_instances"
    else:
        raise AssertionError("Router rejection was not preserved")
    results.append({"scenario": "Router rejection returns immediately without polling or retrying Mesh", "passed": True})

    transport = adapter()
    transport.mesh.routes.get = blocked
    payload = {"meshRoute": asdict(ROUTE), "connectorId": "probe", "connectionId": "connection",
               "method": "shell.exec", "params": {}, "controlCallId": "original-call"}
    await expires("target worker validates its route within the relay budget", lambda t: transport.request_routed({**payload, "timeout": t}))
    await expires("expired relay is rejected before execution", lambda t: transport.request_routed({**payload, "timeout": t, "deadlineAt": time.time() - 1}))

    coordinator = RedisCoordinator(client=SimpleNamespace(publish=blocked))
    manager = ConnectorRpcManager(coordinator)
    await expires("Redis publish is bounded with uncertain delivery", lambda t: manager.route_mesh_request("target", "connection", {"method": "shell.exec"}, timeout=t), "outcome_unknown")
    assert not manager._routed_pending

    local = ConnectorRpcManager()
    ws = SimpleNamespace(send_json=blocked)
    connection = await local.register("probe", ws)
    await local.mark_ready(connection)
    await connection.send_lock.acquire()
    try:
        await expires("legacy send-lock wait is bounded before dispatch", lambda t: local.request("probe", "shell.exec", {}, timeout=t))
    finally:
        connection.send_lock.release()
    await expires("legacy WebSocket send is bounded with uncertain delivery", lambda t: local.request("probe", "shell.exec", {}, timeout=t), "outcome_unknown")
    assert not connection.pending

    transport = adapter()
    manager = ConnectorRpcManager()
    manager.bind_request_transport(transport)
    budgets = []

    connection = await manager.register("probe", SimpleNamespace(), mesh_capable=True, control_fallback_capable=True)
    connection.connection_id = ROUTE.connection_id
    await manager.mark_ready(connection)
    original_bound = manager._bound_lease

    async def delayed_lease(*args, **kwargs):
        await asyncio.sleep(0.05)
        return await original_bound(*args, **kwargs)

    async def delayed_route(*_args):
        await asyncio.sleep(0.025)
        return ROUTE

    async def budget_unary(*_args, **kwargs):
        budgets.append(kwargs["timeout"])
        await blocked()

    manager._bound_lease = delayed_lease
    transport.mesh.routes.get = delayed_route
    transport.mesh.connection = lambda: SimpleNamespace(connect=yes, call_unary=budget_unary)
    await expires("lookup phases consume one budget without restarting it", lambda t: manager.request("probe", "shell.exec", {}, timeout=t), "outcome_unknown", timeout=0.15)
    assert len(budgets) == 1 and 0 < budgets[0] < 0.09, budgets

    transport = adapter()
    release = asyncio.Event()
    calls = []

    async def slow_dispatch(*_args):
        calls.append("started")
        await release.wait()
        calls.append("finished")
        return {"ok": True}

    executor = ConnectorControlExecutor(slow_dispatch)
    executor.open_session(slow_dispatch, "generation")
    service = _DomainService(executor, asyncio.get_running_loop(), executor.generation)

    async def unary(*_args, **kwargs):
        ctx = SimpleNamespace(call_id="mesh-call", metadata=kwargs["metadata"])
        return await service._call("shell.exec", Payload(), ctx)

    transport.mesh.connection = lambda: SimpleNamespace(connect=yes, call_unary=unary)
    try:
        await expires("caller deadline leaves admitted Connector execution alive", lambda t: transport._request_on_connection("probe", "connection", "shell.exec", {}, timeout=t), "outcome_unknown")
        assert calls == ["started"] and executor._tasks
        release.set()
        await ready(lambda: not executor._tasks)
        assert calls == ["started", "finished"]
    finally:
        release.set()
        await executor.close_session()

    transport = adapter()
    transport.mesh.routes.get = blocked
    task = asyncio.create_task(transport._request_on_connection("probe", "connection", "shell.exec", {}, timeout=10))
    await asyncio.sleep(0)
    task.cancel()
    assert isinstance((await asyncio.gather(task, return_exceptions=True))[0], asyncio.CancelledError)
    results.append({"scenario": "explicit caller cancellation remains cancellation", "passed": True})

    with tempfile.TemporaryDirectory(prefix="aa-log-queue-") as directory:
        hub = LogHub(Path(directory))
        held, unlock = threading.Event(), threading.Event()

        def hold_journal():
            with hub.store._transaction():
                held.set()
                unlock.wait(2)

        holder = threading.Thread(target=hold_journal)
        holder.start()
        await ready(held.is_set)
        sink = install_rpc_log_sink(hub.notify, batch_notifier=hub.notify_batch)
        try:
            started = time.monotonic()
            logger.info("diagnostic while journal is locked")
            await asyncio.sleep(0.01)
            elapsed = (time.monotonic() - started) * 1000
            assert elapsed < 200 and not unlock.is_set(), elapsed
        finally:
            unlock.set()
            holder.join()
            await sink.close()
        assert hub.read().items[-1].message == "diagnostic while journal is locked"
        hub.close()
        results.append({"scenario": "real journal lock does not block the event loop; queued log persists", "passed": True, "timerMs": round(elapsed, 2)})

    entered, unlock, stopped = threading.Event(), threading.Event(), threading.Event()
    batches = []

    def batch_notify(records):
        entered.set()
        unlock.wait(2)
        batches.append(records)

    sink = install_rpc_log_sink(lambda *_: None, batch_notifier=batch_notify, capacity=2, byte_capacity=2000,
                                batch_size=2, close_timeout=0.02, on_stopped=stopped.set)
    try:
        logger.info("first")
        await ready(entered.is_set)
        for _ in range(8):
            logger.info("overflow")
        stats = sink.statistics
        assert stats["pending"] == 2 and stats["dropped"] == 6 and stats["pendingBytes"] <= 2000, stats
        started = time.monotonic()
        assert await sink.close() is False
        elapsed = (time.monotonic() - started) * 1000
        assert elapsed < 200 and not stopped.is_set(), elapsed
        assert sink.statistics["pending"] == 0 and sink.statistics["dropped"] == 8
    finally:
        unlock.set()
        await ready(stopped.is_set)
    results.append({"scenario": "queue overflow is counted; shutdown is bounded; store closes after in-flight write", "passed": True, "closeMs": round(elapsed, 2)})

    output = []
    healthy = False

    def flaky(_method, payload):
        if not healthy:
            raise OSError("probe backend unavailable")
        output.append(payload)

    sink = install_rpc_log_sink(flaky, byte_capacity=1024)
    try:
        logger.info("failed write")
        await ready(lambda: sink.statistics["failed"] == 1)
        logger.info("x" * 1500)
        assert sink.statistics["dropped"] == 1
        healthy = True
        logger.info("recovered")
        await ready(lambda: any(row["message"] == "Diagnostic log records lost" for row in output))
    finally:
        await sink.close()
    summary = next(json.loads(row["details"])["logSink"] for row in output if row["message"] == "Diagnostic log records lost")
    assert summary["dropped"] == summary["failed"] == 1
    results.append({"scenario": "byte limit and sink failures are reported after backend recovery", "passed": True})

    started, stopped = asyncio.Event(), threading.Event()

    async def hung_notifier(*_args):
        started.set()
        await blocked()

    sink = install_rpc_log_sink(hung_notifier, close_timeout=0.02, on_stopped=stopped.set)
    logger.info("async notifier stalls")
    await started.wait()
    assert await sink.close() is False
    await ready(stopped.is_set)
    results.append({"scenario": "stalled coroutine notifier is cancelled at the flush deadline", "passed": True})

    with tempfile.TemporaryDirectory(prefix="aa-log-batch-") as directory:
        hub = LogHub(Path(directory))
        entered, release = threading.Event(), threading.Event()
        batch_sizes = []

        def batch_writer(records):
            entered.set()
            release.wait(2)
            batch_sizes.append(len(records))
            hub.notify_batch(records)

        sink = install_rpc_log_sink(hub.notify, batch_notifier=batch_writer)
        try:
            logger.info("batch-0")
            await ready(entered.is_set)
            for index in range(1, 33):
                logger.info("batch-{}", index)
        finally:
            release.set()
            await sink.close()
        assert [row.message for row in hub.read().items] == [f"batch-{index}" for index in range(33)]
        assert len(batch_sizes) < 33 and max(batch_sizes) <= 64, batch_sizes
        hub.close()
    results.append({"scenario": "batched journal writes preserve order and persist every accepted record", "passed": True, "batchSizes": batch_sizes})
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    results = asyncio.run(run_probe())
    if args.output:
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / "results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
