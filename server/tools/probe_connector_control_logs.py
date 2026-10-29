"""Exercise control diagnostics with synthetic peers, no Router or business DB.

Run from server with PYTHONPATH=.:../connector:
python -m tools.probe_connector_control_logs --output ../.local-dev/control-logs
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from agent_server.api import connector_mesh as proxy_api
from agent_server.infra.connector_control_log import (
    _FIELDS,
    completion_log_level,
    control_log,
)
from agent_server.infra.connector_mesh_contract import CONTROL_METHODS
from agent_server.infra.connector_mesh_control import MeshConnectorControlTransport
from agent_server.infra.connector_mesh_routes import MeshRoute
from agent_server.infra.connector_rpc import (
    ConnectorRpcManager,
    ConnectorTransportTimeout,
    connector_request_timeout,
)
from connector.logging import CONTROL_LOG_FIELDS, install_rpc_log_sink
from connector.mesh.logs import LogHub
from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.server.control_log import (
    completion_log_level as connector_completion_log_level,
)
from connector.server.mesh_services import (
    ConnectorControlExecutor,
    Payload,
    _DomainService,
)
from loguru import logger

CANARY = "private-payload-must-not-appear"
ROUTE = MeshRoute(
    "probe-connector",
    "probe-connection",
    "probe-link",
    "probe-router",
    "probe-worker",
    1,
    "probe-owner",
)


async def wait_for(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(0)


def verify_server_log_defaults(passed):
    code = """
import contextlib
import io
import json
import sys
from loguru import logger
from agent_server.infra.logging import configure_server_logging
if sys.argv[1] == "custom":
    logger.add(sys.stderr, level="DEBUG")
records = []
logger.add(lambda message: records.append(message.record["level"].name), level="DEBUG")
with io.StringIO() as temporary, contextlib.redirect_stderr(temporary):
    configure_server_logging()
configure_server_logging()
logger.debug("server-debug-marker")
logger.info("server-info-marker")
print(json.dumps(records))
"""
    for mode in ("default", "debug", "custom"):
        env = dict(os.environ)
        env.pop("LOGURU_LEVEL", None)
        env.pop("LOGURU_AUTOINIT", None)
        if mode == "debug":
            env["LOGURU_LEVEL"] = "DEBUG"
        elif mode == "custom":
            env["LOGURU_AUTOINIT"] = "false"
        child = subprocess.run(
            [sys.executable, "-c", code, mode],
            env=env,
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        )
        assert json.loads(child.stdout) == ["DEBUG", "INFO"]
        assert child.stderr.count("server-info-marker") == 1
        assert child.stderr.count("server-debug-marker") == (
            0 if mode == "default" else 1
        )
    passed(
        "Fresh Server processes default to INFO; DEBUG opt-in, explicit sinks and repeated configuration remain intact"
    )


async def verify_call_log_levels(records, passed):
    for policy in (completion_log_level, connector_completion_log_level):
        assert policy("returned", 99.999, {}) == "DEBUG"
        assert policy("returned", 100, {}) == "INFO"
        assert policy("returned", 0, {"businessOutcome": "rejected"}) == "INFO"
        assert policy("returned", 0, {"callerDetached": True}) == "INFO"
        assert policy("timeout", 0, {}) == "WARNING"
        assert policy("failed", 0, {"errorStack": "safe location"}) == "ERROR"
    passed(
        "Both completion policies preserve the exact 100ms boundary, refusal, detachment and failure visibility"
    )

    for mode in ("mesh", "fallback", "legacy"):
        for behavior in ("fast", "slow", "refused"):
            await verify_call_log_case(mode, behavior, records)
            passed(
                f"{mode} {behavior} calls keep one execution, correlation and the intended default log volume"
            )


async def verify_call_log_case(mode, behavior, records):
    manager = ConnectorRpcManager()
    count = 0

    async def dispatch(_method, _params):
        nonlocal count
        count += 1
        if behavior == "slow":
            await asyncio.sleep(0.12)
        return {
            "ok": behavior != "refused",
            "accepted": behavior != "refused",
            "body": CANARY,
        }

    executor = ConnectorControlExecutor(dispatch, connector_id=ROUTE.connector_id)

    class ReplySocket:
        async def send_json(self, message):
            result = await executor.execute(
                message["method"],
                message["params"],
                connection.connection_id,
                message["metadata"]["aa-control-call-id"],
                connection.connection_id,
            )
            manager.resolve_response(
                ROUTE.connector_id,
                {"id": message["id"], "ok": True, "result": result},
                connection=connection,
            )

        async def close(self, **_kwargs):
            pass

    connection = await manager.register(
        ROUTE.connector_id,
        ReplySocket(),
        mesh_capable=mode != "legacy",
        control_fallback_capable=mode != "legacy",
    )

    async def authorized():
        return True

    connection.authorize_control = authorized
    executor.open_session(dispatch, connection.connection_id)
    route = replace(
        ROUTE, connection_id=connection.connection_id, worker_id=manager.instance_id
    )

    async def get_route(_connector_id):
        return None if mode == "fallback" else route

    mesh = SimpleNamespace(
        router_id=route.router_id, routes=SimpleNamespace(get=get_route)
    )
    adapter = MeshConnectorControlTransport(mesh, manager)

    async def call(_route, method, params, _timeout, call_id):
        return await executor.execute(
            method, params, connection.connection_id, call_id, connection.connection_id
        )

    adapter._call_local = call
    manager.bind_request_transport(adapter)
    prefix = f"volume-{mode}-{behavior}-"
    requests = 10 if behavior == "fast" else 1
    try:
        for index in range(requests):
            async with connector_request_timeout(2, call_id=f"{prefix}{index}"):
                result = await manager.request(
                    ROUTE.connector_id, "terminal.write", {"data": CANARY}
                )
                assert result["ok"] is (behavior != "refused")
        rows = [row for row in records if str(row.get("callId", "")).startswith(prefix)]
        assert count == requests
        if behavior == "fast":
            assert rows and all(row["level"] == "DEBUG" for row in rows), rows
        else:
            terminal = [
                row
                for row in rows
                if row["event"].endswith(".finished") and row["outcome"] == "returned"
            ]
            assert len(terminal) >= 2 and all(
                row["level"] == "INFO" for row in terminal
            ), terminal
            if behavior == "refused":
                assert all(row["businessOutcome"] == "rejected" for row in terminal)
    finally:
        await executor.close_session()
        await manager.close()


async def run_probe() -> tuple[list[dict], list[dict]]:
    records: list[dict] = []
    results: list[dict] = []

    def capture(message):
        control = message.record["extra"].get("control")
        if control:
            records.append({**control, "level": message.record["level"].name})

    def passed(scenario):
        results.append({"scenario": scenario, "passed": True})

    def events(event, call=None):
        return [
            row
            for row in records
            if row["event"] == event and (call is None or row.get("callId") == call)
        ]

    logger.remove()
    sink = logger.add(capture, level="DEBUG")
    try:
        verify_server_log_defaults(passed)
        await verify_call_log_levels(records, passed)

        async def current(*_args):
            return True

        async def get_route(*_args):
            return ROUTE

        mesh = SimpleNamespace(
            router_id=ROUTE.router_id, routes=SimpleNamespace(get=get_route)
        )
        rpc = SimpleNamespace(
            instance_id="probe-source-worker", is_connection_id_current=current
        )
        adapter = MeshConnectorControlTransport(mesh, rpc)

        async def timeout(*_args):
            raise ConnectorTransportTimeout(
                CANARY, details={"deliveryState": "outcome_unknown"}
            )

        adapter._call_local = timeout
        try:
            await adapter._request_on_connection(
                ROUTE.connector_id, ROUTE.connection_id, "shell.exec", {}, timeout=1
            )
        except ConnectorTransportTimeout:
            pass
        row = events("request.finished")[-1]
        assert row["outcome"] == "timeout" and row["deliveryState"] == "outcome_unknown"
        assert row["callId"] == events("request.started")[-1]["callId"]
        passed(
            "Server timeout has one correlated terminal record and delivery uncertainty"
        )

        async def refused(*_args):
            return {"ok": False, "accepted": False, "code": "busy", "body": CANARY}

        adapter._call_local = refused
        result = await adapter._request_on_connection(
            ROUTE.connector_id, ROUTE.connection_id, "shell.exec", {}, timeout=1
        )
        assert result["ok"] is False
        assert events("request.finished")[-1]["businessOutcome"] == "rejected"
        passed("Business refusal is classified without changing the returned result")

        lookup_started = asyncio.Event()

        async def blocked_lookup(*_args):
            lookup_started.set()
            await asyncio.Event().wait()

        mesh.routes.get = blocked_lookup
        task = asyncio.create_task(
            adapter._request_on_connection(
                ROUTE.connector_id, ROUTE.connection_id, "shell.exec", {}, timeout=10
            )
        )
        await lookup_started.wait()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        row = events("request.finished")[-1]
        assert (
            row["outcome"] == "cancelled" and row["deliveryState"] == "not_dispatched"
        )
        passed("Cancellation while locating a route is recorded as not dispatched")

        async def domain_error(*_args):
            raise RuntimeInvalidRequestError(CANARY)

        executor = ConnectorControlExecutor(
            domain_error, connector_id=ROUTE.connector_id
        )
        executor.open_session(domain_error, "private-connection-token")
        try:
            await executor.execute(
                "shell.exec",
                {"sessionId": "s-probe", "body": CANARY},
                executor.generation,
                "domain-call",
                ROUTE.connection_id,
            )
        except RuntimeInvalidRequestError:
            pass
        assert (
            events("execution.finished", "domain-call")[0]["errorCode"]
            == "runtime_invalid_request"
        )
        passed(
            "Domain failure records its code and identifiers without its private message"
        )

        entered, release = asyncio.Event(), asyncio.Event()

        async def late_failure(*_args):
            entered.set()
            await release.wait()
            raise ValueError(CANARY)

        executor.open_session(late_failure, "private-connection-token")
        service = _DomainService(
            executor, asyncio.get_running_loop(), executor.generation
        )
        ctx = SimpleNamespace(
            metadata={
                "aa-control-call-id": "late-call",
                "aa-connection-id": ROUTE.connection_id,
            },
            call_id="sdk-late-call",
        )
        task = asyncio.create_task(
            service._call("shell.exec", Payload(body=CANARY), ctx)
        )
        await entered.wait()
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        release.set()
        await wait_for(lambda: not executor._tasks)
        (row,) = events("execution.finished", "late-call")
        assert (
            row["callerDetached"]
            and row["errorType"] == "ValueError"
            and row.get("errorStack")
        )
        assert row["meshCallId"] == "sdk-late-call"
        passed(
            "Late execution failure survives caller detachment with safe stack locations"
        )

        release = asyncio.Event()

        async def held(*_args):
            await release.wait()
            return {"ok": True}

        executor.open_session(held, "private-connection-token")
        jobs = [
            asyncio.create_task(
                executor.execute(
                    "shell.exec",
                    {},
                    executor.generation,
                    f"queue-{index}",
                    ROUTE.connection_id,
                )
            )
            for index in range(9)
        ]
        await wait_for(
            lambda: (
                executor._active["regular"] == 8 and executor._queued["regular"] == 1
            )
        )
        assert events("execution.queued", "queue-8")[0]["queueDepth"] == 1
        release.set()
        await asyncio.gather(*jobs)
        (row,) = events("execution.finished", "queue-8")
        assert row["queueWaitMs"] >= 0 and row["runMs"] >= 0
        assert executor._queued == executor._active == {"regular": 0, "critical": 0}
        passed(
            "Queue depth, lane and separate waiting/execution times retain 8-slot scheduling"
        )

        release = asyncio.Event()
        executor.open_session(held, "private-connection-token")
        jobs = [
            asyncio.create_task(
                executor.execute(
                    "shell.exec",
                    {},
                    executor.generation,
                    f"cancel-{index}",
                    ROUTE.connection_id,
                )
            )
            for index in range(9)
        ]
        await wait_for(lambda: executor._queued["regular"] == 1)
        await executor.close_session()
        await asyncio.gather(*jobs, return_exceptions=True)
        assert all(
            events("execution.finished", f"cancel-{index}")[0]["reason"]
            == "base_connection_closed"
            for index in range(9)
        )
        assert executor._queued == executor._active == {"regular": 0, "critical": 0}
        passed(
            "Base-connection cancellation records running and queued work without leaking capacity"
        )

        async def proxy_fault(*_args):
            raise ConnectionError(CANARY)

        async def noop(*_args, **_kwargs):
            return None

        async def grant(*_args):
            return {
                "connectorId": ROUTE.connector_id,
                "connectionId": ROUTE.connection_id,
                "linkId": ROUTE.link_id,
                "generation": 1,
                "fingerprint": "probe-fingerprint",
                "expiresAt": time.time() + 60,
            }

        async def authorize(*_args):
            return SimpleNamespace(token=CANARY, token_id=CANARY)

        class Upstream:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            def __aiter__(self):
                return self

            async def __anext__(self):
                await asyncio.Future()

        state = SimpleNamespace(
            rpc=rpc,
            store=SimpleNamespace(),
            connector_mesh=SimpleNamespace(
                credentials=SimpleNamespace(
                    healthy=True,
                    get=lambda _identity: asyncio.sleep(0, result="probe-fingerprint"),
                ),
                grant=grant,
                route_for=lambda _grant: ROUTE,
                authorize_router=authorize,
                router_url="ws://127.0.0.1/probe",
                registered=proxy_fault,
                routes=SimpleNamespace(remove=noop),
                connection=lambda: SimpleNamespace(
                    auth=SimpleNamespace(revoke_token=noop)
                ),
            ),
        )
        ws = SimpleNamespace(
            app=SimpleNamespace(state=state),
            headers={"authorization": "Bearer " + CANARY},
            accept=noop,
            receive=lambda: asyncio.Future(),
            close=noop,
        )
        with patch.object(proxy_api.websockets, "connect", return_value=Upstream()):
            await proxy_api.mesh_proxy(ws)
        assert events("proxy.task_failed")[-1]["phase"] == "mesh.watchdog"
        assert events("proxy.closed")[-1]["reason"] == "mesh.watchdog_failed"
        passed(
            "Proxy child-task faults are observed, identified and included in link closure"
        )

        assert _FIELDS == CONTROL_LOG_FIELDS
        with tempfile.TemporaryDirectory(prefix="aa-control-logs-") as directory:
            hub = LogHub(Path(directory))
            persistent = install_rpc_log_sink(hub.notify)
            try:
                control_log(
                    "persistence.probe",
                    callId="persist-call",
                    connectorId=ROUTE.connector_id,
                    connectionId=ROUTE.connection_id,
                    queueWaitMs=2.5,
                    token=CANARY,
                    params={"body": CANARY},
                )
                await persistent.close()
                page = hub.read()
                details = json.loads(page.items[-1].details)
                assert details["control"]["callId"] == "persist-call"
                assert details["control"]["queueWaitMs"] == 2.5
                assert (
                    "token" not in details["control"]
                    and "params" not in details["control"]
                )
            finally:
                await persistent.close()
                hub.close()
        passed(
            "Structured control identifiers/timings survive real log persistence without payload fields"
        )

        with tempfile.TemporaryDirectory(prefix="aa-log-format-") as directory:
            paths = []
            for colored in (False, True):
                path = Path(directory) / f"colored-{colored}.log"
                paths.append(path)
                file_sink = logger.add(
                    path, format="probe - <level>{message}</level>", colorize=colored
                )
                try:
                    control_log("parser.probe", callId=f"parser-{colored}")
                finally:
                    logger.remove(file_sink)
            assert "\x1b[" in paths[1].read_text()
            assert {row["callId"] for row in read_control_records(paths)} == {
                "parser-False",
                "parser-True",
            }
        passed(
            "Real Loguru file records parse identically with and without forced ANSI colors"
        )

        def broken_sink(_message):
            raise OSError(CANARY)

        broken = logger.add(broken_sink, catch=False)
        try:
            mesh.routes.get = get_route
            adapter._call_local = refused
            assert (
                await adapter._request_on_connection(
                    ROUTE.connector_id, ROUTE.connection_id, "shell.exec", {}, timeout=1
                )
            )["ok"] is False
        finally:
            logger.remove(broken)
        passed("Diagnostic sink failures do not change a business result")
        assert CANARY not in json.dumps(
            records
        ) and "private-connection-token" not in json.dumps(records)
        for event in events("request.started"):
            assert len(events("request.finished", event["callId"])) == 1
        passed(
            "Every started Server call settles once; no payloads, tokens or private exception messages leak"
        )
        return results, records
    finally:
        logger.remove(sink)


def read_control_records(paths: list[Path]) -> list[dict]:
    records = []
    for path in paths:
        for line in path.read_text(errors="replace").splitlines():
            # GitHub runners can force Loguru colors even when redirected to a
            # file. Formatting codes may sit between the separator and marker.
            line = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", line)
            if " - connector.control " not in line:
                continue
            row, _ = json.JSONDecoder().raw_decode(
                line.split(" - connector.control ", 1)[1]
            )
            records.append(row)
    return records


def verify_transport_logs(
    directory: Path, connector_log: Path
) -> tuple[list[dict], list[dict]]:
    """Check real cross-instance correlation after the existing transport probe."""
    records = read_control_records([connector_log, *directory.glob("*.log")])
    assert records, "no control records parsed; check captured log paths and format"
    by_call = defaultdict(list)
    by_route = defaultdict(set)
    for row in records:
        if row.get("callId"):
            by_call[row["callId"]].append(row)
        if row.get("routeRequestId"):
            by_route[row["routeRequestId"]].add(row["event"])
        if row["event"] == "execution.started":
            assert row["activeCount"] <= (2 if row["lane"] == "critical" else 8)
    chain = {
        "request.started",
        "request.finished",
        "redis.request.sent",
        "redis.request.finished",
        "redis.target.received",
        "redis.target.finished",
        "execution.started",
        "execution.finished",
    }
    methods = set()
    for rows in by_call.values():
        if not chain <= {row["event"] for row in rows}:
            continue  # A forcibly killed worker cannot emit a terminal event.
        started = next(row for row in rows if row["event"] == "request.started")
        for row in rows:
            if row["event"] == "execution.finished":
                assert row["connectionId"] == started["connectionId"]
                assert row["connectorId"] == started["connectorId"]
                assert row.get("meshCallId")
        methods.add(started["method"])
    expected = set(CONTROL_METHODS) - {"workspace.refresh"}
    assert expected <= methods, expected - methods
    pairs = [
        names
        for names in by_route.values()
        if {
            "redis.request.sent",
            "redis.target.received",
            "redis.request.finished",
            "redis.target.finished",
        }
        <= names
    ]
    assert len(pairs) >= len(expected)
    finished = [row for row in records if row["event"] == "execution.finished"]
    assert any(
        row.get("callerDetached") and row["outcome"] == "returned" for row in finished
    )
    assert any(row.get("businessOutcome") == "rejected" for row in finished)
    return [
        {
            "scenario": "real cross-instance calls have correlated Server/Redis/SDK/Connector phases for every implemented method",
            "passed": True,
        },
        {
            "scenario": "Redis round trips, late returns, business refusals and 8+2 limits remain visible",
            "passed": True,
        },
    ], records


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--transport-output",
        type=Path,
        help="Existing distributed transport probe directory",
    )
    parser.add_argument(
        "--connector-log", type=Path, help="That probe's captured stdout/stderr"
    )
    args = parser.parse_args()
    if bool(args.transport_output) != bool(args.connector_log):
        parser.error("--transport-output and --connector-log must be provided together")
    if args.transport_output:
        results, records = verify_transport_logs(
            args.transport_output, args.connector_log
        )
    else:
        results, records = asyncio.run(run_probe())
    if args.output:
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
        (args.output / "events.json").write_text(json.dumps(records, indent=2) + "\n")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
