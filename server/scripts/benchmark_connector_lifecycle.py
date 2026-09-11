"""Headless measurements of unchanged scans and a deleted-connector backlog.

Uses a private SQLite database, or an explicitly supplied empty local PostgreSQL
test database, and production service/pump code. Does not start app listeners or
contact native runtimes. PostgreSQL replay retains the production connection pool.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import tempfile
import time
import traceback
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[2]
for key in tuple(os.environ):
    if key.startswith(("AGENT_SERVER_", "AGENT_CONNECTOR_")):
        os.environ.pop(key)
sys.path[:0] = [str(REPO / "server"), str(REPO / "server/tests")]

from agent_server.api.connector_ingress import _ConnectorNotificationPump
from agent_server.api.connectors import delete_connector
from agent_server.app import create_app
from agent_server.infra.db import metadata
from agent_server.infra.db import sessions as sessions_t
from agent_server.infra.db.migrations import upgrade_database
from agent_server.services.connector_ingest import ConnectorIngestService
from agent_server.services.connector_notifications import ConnectorNotificationService
from agent_server.services.connector_realtime import ConnectorRealtimeService
from agent_server.services.effective_capabilities import (
    publish_connector_session_capabilities,
)
from loguru import logger
from sqlalchemy import event, insert, select, text, update
from test_backend_mvp import create_connector_and_session, make_client

logger.remove()


class Counters:
    def __init__(self, store):
        self.sql = Counter()
        self.views = 0
        event.listen(store.engine.sync_engine, "before_cursor_execute", self.statement)
        original = store._session_from_row

        async def view(row):
            self.views += 1
            return await original(row)

        store._session_from_row = view

    def statement(self, _conn, _cursor, statement, _parameters, _context, _many):
        self.sql[statement.split(None, 1)[0].upper()] += 1

    def reset(self):
        self.sql.clear()
        self.views = 0

    def snapshot(self):
        return {
            "sql": dict(self.sql),
            "total_sql": sum(self.sql.values()),
            "session_views": self.views,
        }


class Socket:
    def __init__(self):
        self.closed = []

    async def close(self, **kwargs):
        self.closed.append(kwargs)


async def postgres_plans(store, rows, connector_id, runtime_id, scan):
    """Explain actual emitted statements with 10,000 synthetic session rows."""
    captured = []

    def capture(_conn, _cursor, statement, parameters, _context, many):
        if statement.startswith(("SELECT", "UPDATE")):
            captured.append((statement, parameters[0] if many else parameters))

    event.listen(store.engine.sync_engine, "before_cursor_execute", capture)
    try:
        await store.refresh_unchanged_session_source(
            rows[0]["id"],
            connector_id=connector_id,
            runtime="codex",
            runtime_id=runtime_id,
            availability="available",
            reason="codex.thread/list active",
            observed_at="2026-09-11T00:00:00Z",
            observation_origin="inventory",
        )
        await scan(False)
    finally:
        event.remove(store.engine.sync_engine, "before_cursor_execute", capture)
    plans = []
    async with store.engine.connect() as conn:
        transaction = await conn.begin()
        try:
            for offset in range(len(rows), 10_000, 500):
                await conn.execute(
                    insert(sessions_t),
                    [
                        {
                            **rows[0],
                            "id": f"plan_session_{i}",
                            "external_session_id": f"plan_thread_{i}",
                        }
                        for i in range(offset, min(offset + 500, 10_000))
                    ],
                )
            await conn.execute(text("ANALYZE sessions"))
            for name, (statement, parameters) in zip(
                (
                    "unchanged_source",
                    "inventory_begin",
                    "inventory_read",
                    "inventory_refresh",
                ),
                captured,
                strict=True,
            ):
                explained = await conn.exec_driver_sql(
                    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + statement, parameters
                )
                plans.append(
                    {"path": name, "sql": statement, "plan": explained.scalar_one()}
                )
        finally:
            await transaction.rollback()
    return {"session_rows": 10_000, "plans": plans}


async def audit(app, connector_id, session_id, *, postgres=False):
    state, count = app.state, 200
    store = state.store
    async with store.engine.begin() as conn:
        original = dict(
            (
                await conn.execute(
                    select(sessions_t).where(sessions_t.c.id == session_id)
                )
            )
            .mappings()
            .one()
        )
        seeded = {
            **original,
            "origin": "connector_import",
            "takeover": 0,
            "source_state": "available",
            "source_state_at": "2026-09-10T00:00:00Z",
            "source_state_reason": "codex.thread/list active",
            "source_observation_origin": "inventory",
        }
        await conn.execute(
            update(sessions_t).where(sessions_t.c.id == session_id).values(**seeded)
        )
        others = [
            {
                **seeded,
                "id": f"source_audit_{i}",
                "external_session_id": f"audit_thread_{i}",
            }
            for i in range(1, count)
        ]
        await conn.execute(insert(sessions_t), others)
    rows = [seeded, *others]
    runtime_id = seeded["runtime_id"]
    stats = Counters(store)
    realtime = ConnectorRealtimeService(
        state.shell_tasks, state.terminal_broker, state.terminal_stream_hub
    )
    service = ConnectorIngestService(
        store,
        ConnectorNotificationService(store, realtime, state.timeline_write_buffer),
        state.timeline_broker,
        state.device_runtime_service,
        state.rpc,
        state.session_runtime_state_cache,
    )
    observation = "2026-09-11T00:00:00Z"

    def source(row):
        return {
            "sessionId": row["id"],
            "externalSessionId": row["external_session_id"],
            "runtime": "codex",
            "runtimeId": runtime_id,
            "availability": "available",
            "reason": "codex.thread/list active",
            "observationOrigin": "inventory",
            "observedAt": observation,
        }

    async def scan(individual):
        token = "audit-inventory-token-000001"
        base = {"runtime": "codex", "runtimeId": runtime_id, "scanToken": token}
        await service.handle_notification_message(
            connector_id=connector_id, method="session.inventory.begin", params=base
        )
        if individual:
            for row in rows:
                await service.handle_notification_message(
                    connector_id=connector_id,
                    method="session.source.updated",
                    params=source(row),
                )
        entries = [
            {
                "sessionId": row["id"],
                "externalSessionId": row["external_session_id"],
                "sourceState": {
                    "availability": "available",
                    "reason": "codex.thread/list active",
                    "observedAt": observation,
                },
            }
            for row in rows
        ]
        await service.handle_notification_message(
            connector_id=connector_id,
            method="session.inventory.complete",
            params={**base, "sessions": entries, "complete": True},
        )

    async def sample(work):
        stats.reset()
        wall, loop_cpu, process_cpu = (
            time.perf_counter(),
            time.thread_time(),
            time.process_time(),
        )
        await work()
        return {
            **stats.snapshot(),
            "wall_ms": round((time.perf_counter() - wall) * 1000, 3),
            "loop_cpu_ms": round((time.thread_time() - loop_cpu) * 1000, 3),
            "process_cpu_ms": round((time.process_time() - process_cpu) * 1000, 3),
        }

    async def summaries():
        async with store.engine.connect() as conn:
            return [
                dict(row)
                for row in (
                    await conn.execute(select(sessions_t).order_by(sessions_t.c.id))
                ).mappings()
            ]

    results = {
        "scope": f"local {'PostgreSQL' if postgres else 'SQLite'}, real services, synthetic 200 unchanged imported sessions; no app listeners",
        "scan_sessions": count,
        "samples": {},
    }
    original_fast_path = store.refresh_unchanged_session_source

    async def use_fenced_path(*_args, **_kwargs):
        return False

    for label, mode, fast in (
        ("fenced_source_replay", True, False),
        ("current_scan", True, True),
        ("inventory_only_replay", False, True),
    ):
        store.refresh_unchanged_session_source = (
            original_fast_path if fast else use_fenced_path
        )
        await scan(mode)
        samples = [await sample(lambda mode=mode: scan(mode)) for _ in range(3)]
        results["samples"][label] = {
            **samples[-1],
            **{
                key: round(statistics.median(row[key] for row in samples), 3)
                for key in ("wall_ms", "loop_cpu_ms", "process_cpu_ms")
            },
            "repeats": 3,
        }
        if label == "fenced_source_replay":
            expected = await summaries()
        else:
            assert await summaries() == expected, (
                "unchanged scan replay must retain identical persisted session rows"
            )
    results["identical_scan_rows"] = True

    # Count remaining per-session operations in the current capability batch.
    capability_counts = Counter()
    for name in (
        "get_protocol_capabilities",
        "get_protocol_capabilities_stamp",
        "get_session_seq",
    ):
        original_method = getattr(store, name)

        async def tracked(*args, _original=original_method, _name=name, **kwargs):
            capability_counts[_name] += 1
            return await _original(*args, **kwargs)

        setattr(store, name, tracked)

    class Presence:
        async def is_online(self, _connector):
            capability_counts["is_online"] += 1
            return True

    class Publisher:
        async def publish(self, _session, _payload):
            capability_counts["publish"] += 1

    results["capability_batch"] = await sample(
        lambda: publish_connector_session_capabilities(
            store, Presence(), Publisher(), connector_id
        )
    )
    results["capability_batch"]["calls"] = dict(capability_counts)

    if postgres:
        results["postgres_plans"] = await postgres_plans(
            store, rows, connector_id, runtime_id, scan
        )

    # Normal close still applies the received observations with an active parent.
    normal = _ConnectorNotificationPump(connector_id, service)
    normal.start()
    for row in rows[:20]:
        normal.enqueue_message(
            {"method": "session.source.updated", "params": source(row)}
        )
    results["normal_close"] = await sample(normal.close)
    results["normal_close"]["pending_after_close"] = normal._pending

    # Hold the first four notifications after admission, delete through the actual
    # endpoint function, then resume its queued work as WS-finally close() does.
    gate, occupied = asyncio.Event(), asyncio.Event()
    entered = 0

    class BlockedService:
        async def handle_notification_message(self, **kwargs):
            nonlocal entered
            entered += 1
            if entered == 4:
                occupied.set()
            await gate.wait()
            await service.handle_notification_message(**kwargs)

    socket = Socket()
    connection = await state.rpc.register(connector_id, socket)
    pump = _ConnectorNotificationPump(
        connector_id, BlockedService(), connection_id=connection.connection_id
    )
    connection.abort_notifications = pump.abort
    pump.start()
    messages = 500
    for index in range(messages):
        pump.enqueue_message(
            {"method": "session.source.updated", "params": source(rows[index % count])}
        )
    await asyncio.wait_for(occupied.wait(), 5)
    connector = await store.get_connector(connector_id)
    errors, log_bytes, first_error = 0, 0, None

    def capture(message):
        nonlocal errors, log_bytes, first_error
        exception = message.record["exception"]
        if exception is not None:
            errors += 1
            log_bytes += len(str(message).encode())
            if first_error is None:
                first_error = {
                    "error_type": exception.type.__name__,
                    "missing_key_is_connector": exception.value.args == (connector_id,),
                    "context_type": type(exception.value.__context__).__name__,
                    "context_is_session": exception.value.__context__.args[0]
                    in {row["id"] for row in rows},
                    "frames": [
                        frame.name
                        for frame in traceback.extract_tb(exception.traceback)
                    ],
                }

    logger.add(
        capture,
        level="ERROR",
        format="{message}",
        backtrace=True,
        diagnose=True,
        colorize=False,
    )

    async def delete_and_stop():
        await delete_connector(
            connector_id,
            user_id=connector.userId,
            store=store,
            manager=state.rpc,
            broker=state.timeline_broker,
            terminals=state.terminal_broker,
            timeline_buffer=state.timeline_write_buffer,
            runtime_state_cache=state.session_runtime_state_cache,
        )
        assert socket.closed and not await state.rpc.is_online(connector_id)

    results["delete_and_cancel"] = await sample(delete_and_stop)

    async def drain():
        gate.set()
        await asyncio.wait_for(pump.close(), 30)

    results["deleted_backlog"] = await sample(drain)
    results["deleted_backlog"].update(
        {
            "queued": messages,
            "handlers_entered": entered,
            "tracebacks": errors,
            "formatted_traceback_bytes": log_bytes,
            "pending_after_close": pump._pending,
            "socket_close": socket.closed,
            "first_error": first_error,
        }
    )
    logger.remove()
    async with store.engine.connect() as conn:
        assert (
            await conn.execute(
                select(sessions_t.c.id).where(sessions_t.c.connector_id == connector_id)
            )
        ).first() is None
    results["deleted_backlog"]["sessions_remain_deleted"] = True
    await store.close()
    return results


async def prepare_postgres(source_store, url):
    """Copy only the synthetic seed into a verified empty disposable database."""
    os.environ["AGENT_SERVER_DB_URL"] = url
    app = create_app(migrate_database=False)
    store = app.state.store
    copied_tables = {
        "users",
        "connectors",
        "connector_runtime_types",
        "device_runtimes",
        "connector_protocol_capabilities",
        "connector_runtime_catalogs",
        "projects",
        "sessions",
    }
    async with source_store.engine.connect() as source, store.engine.begin() as target:
        for table in metadata.sorted_tables:
            if table.name not in copied_tables:
                continue
            if (await target.execute(select(table).limit(1))).first() is not None:
                raise ValueError(
                    "PostgreSQL benchmark requires empty application tables"
                )
            rows = [
                dict(row) for row in (await source.execute(select(table))).mappings()
            ]
            if rows:
                await target.execute(insert(table), rows)
    await source_store.close()
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--postgres-url", help="Empty local test database named aa_session_* only"
    )
    args = parser.parse_args()
    if args.postgres_url:
        parsed = urlsplit(args.postgres_url)
        if (
            parsed.scheme != "postgresql+asyncpg"
            or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or not parsed.path.startswith("/aa_session_")
            or parsed.query
            or parsed.fragment
        ):
            parser.error(
                "--postgres-url must be a loopback postgresql+asyncpg URL with database aa_session_*"
            )
    with tempfile.TemporaryDirectory(prefix="aa-source-queue-audit-") as directory:
        client = make_client(Path(directory))
        connector_id, _, session_id, _ = create_connector_and_session(client)
        if args.postgres_url:
            upgrade_database(db_url=args.postgres_url)

            async def run_postgres():
                app = await prepare_postgres(client.app.state.store, args.postgres_url)
                return await audit(app, connector_id, session_id, postgres=True)

            result = asyncio.run(run_postgres())
        else:
            result = asyncio.run(audit(client.app, connector_id, session_id))
    if args.output is not None:
        args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
