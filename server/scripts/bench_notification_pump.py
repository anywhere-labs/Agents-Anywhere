"""Measure whether connector notifications still queue up behind each other.

The connector notification pump processes one message at a time per connector
connection. This script feeds it a synthetic stream and reports how the
completion latency of each message grows with its position in the queue, which
is the signature of serial accumulation.

    PYTHONPATH=. .venv/bin/python scripts/bench_notification_pump.py

It uses a fake ingest service, so it measures the pump's scheduling only, not
the handler cost. Multiply by your real handler time to size the backlog.
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import time
from typing import Any

from agent_server.api.connector_ingress import _ConnectorNotificationPump

DEFAULT_HANDLER_MS = 20.0
DEFAULT_MESSAGES = 100
DEFAULT_SESSIONS = 10


class _FakeIngest:
    def __init__(self, handler_seconds: float) -> None:
        self._handler_seconds = handler_seconds
        self.completed_at: dict[int, float] = {}
        self.max_in_flight = 0
        self._in_flight = 0

    async def handle_notification_message(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        connection_id: str | None = None,
    ) -> None:
        self._in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self._in_flight)
        try:
            await asyncio.sleep(self._handler_seconds)
            self.completed_at[int(params["seq"])] = time.perf_counter()
        finally:
            self._in_flight -= 1


async def run(args: argparse.Namespace) -> None:
    ingest = _FakeIngest(args.handler_ms / 1000.0)
    pump = _ConnectorNotificationPump("conn_bench", ingest)
    pump.start()
    try:
        started = time.perf_counter()
        for seq in range(args.messages):
            pump.enqueue_message(
                {
                    "method": "timeline.itemUpsert",
                    "params": {
                        "seq": seq,
                        "sessionId": f"sess_{seq % args.sessions}",
                        "item": {
                            "id": "item_hot" if args.same_item else f"item_{seq}"
                        },
                    },
                }
            )
        await asyncio.wait_for(pump.flush(), timeout=600)
        elapsed = time.perf_counter() - started
    finally:
        await pump.close()

    latencies = sorted(
        ingest.completed_at[seq] - started for seq in sorted(ingest.completed_at)
    )
    if not latencies:
        print("no messages completed")
        return
    ideal = args.handler_ms / 1000.0 * args.messages / max(1, args.sessions)
    print(
        f"messages={args.messages} sessions={args.sessions} "
        f"handler={args.handler_ms:.1f}ms"
    )
    print(
        f"  wall={elapsed * 1000:.1f}ms "
        f"p50_latency={statistics.median(latencies) * 1000:.1f}ms "
        f"p99_latency={latencies[int(len(latencies) * 0.99)] * 1000:.1f}ms "
        f"max_latency={latencies[-1] * 1000:.1f}ms"
    )
    print(
        f"  first={latencies[0] * 1000:.1f}ms last={latencies[-1] * 1000:.1f}ms "
        f"accumulation={latencies[-1] / max(latencies[0], 1e-9):.1f}x "
        f"max_in_flight={ingest.max_in_flight}"
    )
    print(
        f"  serial_estimate={args.handler_ms * args.messages:.0f}ms "
        f"ideal_with_{args.sessions}_sessions={ideal * 1000:.0f}ms "
        f"coalesced={getattr(pump, 'coalesced', 0)}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--messages", type=int, default=DEFAULT_MESSAGES)
    parser.add_argument("--sessions", type=int, default=DEFAULT_SESSIONS)
    parser.add_argument("--handler-ms", type=float, default=DEFAULT_HANDLER_MS)
    parser.add_argument(
        "--same-item",
        action="store_true",
        help="every message replaces the same timeline item, so only the newest survives",
    )
    args = parser.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
