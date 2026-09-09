"""Measure the per-delta ``accept()`` hot path against a real Redis.

Unlike ``bench_timeline_hotpath.py`` (CPU only), this script exercises the full
distributed accept path: session fence, revision lease, pending projection and
live publish, with a real Redis round trip for every command.

    docker run -d --rm --name aa-bench-redis -p 56379:6379 redis:8-alpine
    PYTHONPATH=. .venv/bin/python scripts/bench_accept_hotpath.py --deltas 200

It also reports how many Redis commands one accepted delta issues, which is the
metric the fence-script change targets. The script only passes constructor
arguments the installed ``TimelineWriteBuffer`` actually supports, so the same
file runs on a pre-optimization checkout for a before/after comparison.
"""

from __future__ import annotations

import argparse
import asyncio
import inspect
import statistics
import time
from pathlib import Path
from tempfile import mkdtemp
from typing import Any

from agent_server.core.models import TimelineItemIn
from agent_server.infra.db.migrations import upgrade_database
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.timeline_write_buffer import TimelineWriteBuffer

DEFAULT_REDIS_URL = "redis://127.0.0.1:56379/0"


def build_item(session_id: str, revision: int, payload_bytes: int) -> TimelineItemIn:
    return TimelineItemIn.model_validate(
        {
            "id": "item_hot",
            "sessionId": session_id,
            "type": "message",
            "status": "done",
            "role": "assistant",
            "content": {"text": "x" * max(1, payload_bytes), "format": "markdown"},
            "source": {
                "runtime": "codex",
                "sessionId": "thread_hot",
                "itemId": "runtime-item_hot",
                "itemType": "agentMessage",
            },
            "orderSeq": 1,
            "revision": revision,
            "contentHash": f"sha256:{revision}",
        }
    )


async def command_counts(client: Any) -> dict[str, int]:
    info = await client.info("commandstats")
    counts: dict[str, int] = {}
    if not isinstance(info, dict):
        return counts
    for key, value in info.items():
        if key.startswith("cmdstat_") and isinstance(value, dict):
            counts[key[len("cmdstat_") :]] = int(value.get("calls", 0))
    return counts


async def run(args: argparse.Namespace) -> None:
    workdir = Path(mkdtemp(prefix="aa-bench-"))
    db_path = workdir / "bench.sqlite3"
    upgrade_database(sqlite_path=db_path)
    store = Store(db_path)
    coordinator = RedisCoordinator(
        args.redis_url,
        prefix=args.prefix,
        client=None,
    )
    await coordinator.client.flushdb()

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

    broker = TimelineBroker(coordinator)
    buffer_kwargs: dict[str, Any] = {}
    supported = inspect.signature(TimelineWriteBuffer.__init__).parameters
    if "single_instance" in supported:
        buffer_kwargs["single_instance"] = args.single_instance
    buffer = TimelineWriteBuffer(
        store,
        broker,
        coordinator,
        flush_interval_seconds=3600,
        **buffer_kwargs,
    )

    try:
        # Warm the lane so the measurement covers steady-state deltas.
        await buffer.accept(
            session_id=session.id,
            item=build_item(session.id, 1, args.payload_bytes),
            mark_read_on_change=True,
        )
        before = await command_counts(coordinator.client)
        durations: list[float] = []
        started = time.perf_counter()
        for revision in range(2, args.deltas + 2):
            item = build_item(session.id, revision, args.payload_bytes)
            begin = time.perf_counter()
            await buffer.accept(
                session_id=session.id,
                item=item,
                mark_read_on_change=True,
            )
            durations.append((time.perf_counter() - begin) * 1000.0)
        total_seconds = time.perf_counter() - started
        after = await command_counts(coordinator.client)
    finally:
        await buffer.close()
        await store.close()
        await coordinator.close()

    commands = {
        name: after.get(name, 0) - before.get(name, 0)
        for name in sorted(set(before) | set(after))
        if after.get(name, 0) - before.get(name, 0) > 0
    }
    per_delta_commands = sum(commands.values()) / max(1, args.deltas)
    ordered = sorted(durations)
    p50 = statistics.median(ordered)
    p90 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.9))]
    print(
        f"deltas={args.deltas} payload_bytes={args.payload_bytes} "
        f"single_instance={args.single_instance}"
    )
    print(
        f"  mean={statistics.fmean(durations):.3f}ms p50={p50:.3f}ms "
        f"p90={p90:.3f}ms max={ordered[-1]:.3f}ms "
        f"throughput={args.deltas / total_seconds:.0f} delta/s"
    )
    print(f"  redis_commands_per_delta={per_delta_commands:.1f}")
    print(
        "  redis_commands="
        + " ".join(f"{name}:{count}" for name, count in commands.items())
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--redis-url", default=DEFAULT_REDIS_URL)
    parser.add_argument("--prefix", default="aa-bench")
    parser.add_argument("--deltas", type=int, default=200)
    parser.add_argument("--payload-bytes", type=int, default=2000)
    parser.add_argument("--single-instance", action="store_true")
    args = parser.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
