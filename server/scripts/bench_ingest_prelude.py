"""Measure the per-notification session prelude against a local store.

The streaming ingest path resolves a connector notification to a session before
it touches the timeline buffer. This script compares the merged single-connection
lookup with the legacy three-call sequence so a future change cannot silently
reintroduce the extra pooled round trips.

    PYTHONPATH=. .venv/bin/python scripts/bench_ingest_prelude.py
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import time
from pathlib import Path
from tempfile import mkdtemp

from agent_server.core.models import TimelineItemIn
from agent_server.infra.db.migrations import upgrade_database
from agent_server.infra.repositories.facade import Store
from agent_server.services.connector_notifications import (
    _resolve_timeline_session_id,
    _session_disabled,
    timeline_runtime_identity_from_params,
)

DEFAULT_ITERATIONS = 300


def build_item() -> TimelineItemIn:
    return TimelineItemIn.model_validate(
        {
            "id": "item_hot",
            "sessionId": "sess_placeholder",
            "type": "message",
            "status": "done",
            "role": "assistant",
            "content": {"text": "x" * 2000, "format": "markdown"},
            "source": {
                "runtime": "codex",
                "sessionId": "thread_hot",
                "itemId": "runtime-item_hot",
                "itemType": "agentMessage",
            },
            "orderSeq": 1,
            "revision": 1,
            "contentHash": "sha256:1",
        }
    )


def _report(name: str, samples: list[float]) -> None:
    ordered = sorted(samples)
    print(
        f"{name}: p50={statistics.median(ordered):.3f}ms "
        f"p90={ordered[int(len(ordered) * 0.9)]:.3f}ms "
        f"mean={statistics.fmean(ordered):.3f}ms"
    )


async def run(args: argparse.Namespace) -> None:
    db_path = Path(mkdtemp(prefix="aa-prelude-")) / "prelude.sqlite3"
    upgrade_database(sqlite_path=db_path)
    store = Store(db_path)
    await store.create_user(user_id="user_1", password="bench-password")
    connector, _, _ = await store.create_connector(name="bench", user_id="user_1")
    project = await store.create_project(
        user_id="user_1",
        connector_id=connector.id,
        name="Bench",
        workspace_path="/repo",
    )
    session = await store.create_session(
        connector_id=connector.id,
        project_id=project.id,
        user_id="user_1",
        runtime="codex",
        external_session_id="thread_hot",
        title="Bench",
        cwd="/repo",
    )
    item = build_item()
    params = {"sessionId": session.id, "item": item.model_dump(mode="json")}

    legacy: list[float] = []
    merged: list[float] = []
    try:
        for _ in range(args.iterations):
            started = time.perf_counter()
            runtime, runtime_id = await timeline_runtime_identity_from_params(
                store, params
            )
            resolved = await _resolve_timeline_session_id(
                store,
                connector.id,
                session.id,
                [item],
                runtime=runtime,
                runtime_id=runtime_id,
            )
            await _session_disabled(store, resolved)
            legacy.append((time.perf_counter() - started) * 1000.0)

            started = time.perf_counter()
            await store.resolve_connector_session_binding(
                connector_id=connector.id,
                session_id=session.id,
                external_session_id=item.source.sessionId,
                runtime=None,
                runtime_id=None,
                source_runtime=item.source.runtime,
                source_runtime_id=None,
            )
            merged.append((time.perf_counter() - started) * 1000.0)
    finally:
        await store.close()

    print(f"iterations={args.iterations}")
    _report("legacy 3 calls", legacy)
    _report("merged  1 call ", merged)
    speedup = statistics.median(legacy) / statistics.median(merged)
    print(f"prelude speedup: {speedup:.2f}x")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=DEFAULT_ITERATIONS)
    args = parser.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
