"""Measure retained notification payloads behind a blocked ingest handler.

Uses the real pump with a fake handler: no database, Redis, or network access.
Run in a fresh process for comparable RSS baselines:

    PYTHONPATH=. .venv/bin/python scripts/bench_notification_memory.py --trim

``--trim`` calls malloc_trim in THIS benchmark process only. The default stream
replaces the same item; ``--distinct-items`` demonstrates legitimate backlog
that cannot be removed by replacement coalescing.
"""

from __future__ import annotations

import argparse
import asyncio
import gc
import json
import tracemalloc

from loguru import logger

from agent_server.api.connector_ingress import _ConnectorNotificationPump
from agent_server.infra.malloc_trim import load_malloc_trim, resident_bytes


class BlockingIngest:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.handled: list[int] = []

    async def handle_notification_message(self, **kwargs: object) -> None:
        params = kwargs["params"]
        self.handled.append(params["item"]["sequence"])
        self.started.set()
        await self.release.wait()


def report(phase: str, pump: _ConnectorNotificationPump) -> None:
    gc.collect()
    current, peak = tracemalloc.get_traced_memory()
    rss = resident_bytes()
    print(json.dumps({
        "phase": phase,
        "pending": pump._pending,
        "coalesced": pump.coalesced,
        "rss_mib": round(rss / 2**20, 2) if rss is not None else None,
        "python_live_mib": round(current / 2**20, 2),
        "python_peak_mib": round(peak / 2**20, 2),
    }), flush=True)


async def run(args: argparse.Namespace) -> None:
    ingest = BlockingIngest()
    pump = _ConnectorNotificationPump("memory-benchmark", ingest)
    tracemalloc.start()
    pump.start()

    def enqueue(sequence: int) -> None:
        pump.enqueue_message({
            "method": "timeline.itemUpsert",
            "params": {
                "sessionId": "session",
                "runtimeId": "codex",
                "item": {
                    "id": f"item-{sequence}" if args.distinct_items else "item",
                    "sequence": sequence,
                    "content": {"text": str(sequence) + "x" * args.payload_bytes},
                },
            },
        })

    try:
        enqueue(0)
        await asyncio.wait_for(ingest.started.wait(), timeout=5)
        report("blocked", pump)
        for sequence in range(1, args.messages + 1):
            enqueue(sequence)
            if args.yield_every and sequence % args.yield_every == 0:
                await asyncio.sleep(0)
        report("queued", pump)
        ingest.release.set()
        await asyncio.wait_for(pump.flush(), timeout=30)
        report("drained", pump)
        if args.trim:
            trim = load_malloc_trim()
            if trim is not None:
                trim()
                report("trimmed", pump)
            else:
                print("malloc_trim unavailable", flush=True)
        print(json.dumps({"handled_count": len(ingest.handled),
                          "first": ingest.handled[0], "last": ingest.handled[-1]}))
    finally:
        await pump.abort()
        tracemalloc.stop()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--messages", type=int, default=2000)
    parser.add_argument("--payload-bytes", type=int, default=64 * 1024)
    parser.add_argument("--yield-every", type=int, default=1,
                        help="yield to the dispatcher every N messages; 0 tests a burst")
    parser.add_argument("--distinct-items", action="store_true")
    parser.add_argument("--trim", action="store_true")
    args = parser.parse_args()
    if args.messages < 1 or args.payload_bytes < 1 or args.yield_every < 0:
        parser.error("messages/payload-bytes must be positive; yield-every must be >= 0")
    logger.remove()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
