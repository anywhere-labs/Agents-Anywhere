"""Repeatable micro-benchmark for the streaming timeline hot path.

Measures only the CPU-bound per-delta work, so it needs no database and no
Redis and can run anywhere:

    .venv/bin/python scripts/bench_timeline_hotpath.py --payload-bytes 200000

Use it before and after a hot-path change to check that payload handling did
not regress. The numbers are per-operation milliseconds on one event loop
thread; they do not include network round trips.
"""

from __future__ import annotations

import argparse
import json
import timeit
from typing import Any

from agent_server.core.models import TimelineItem, TimelineItemIn
from agent_server.core.timeline import timeline_item_from_runtime_input

DEFAULT_PAYLOAD_BYTES = 200_000
DEFAULT_REPEAT = 5
DEFAULT_NUMBER = 20


def build_raw_item(payload_bytes: int) -> dict[str, Any]:
    """Build an ingress payload whose content is roughly ``payload_bytes`` big."""

    text = "x" * max(1, payload_bytes)
    return {
        "id": "item_hot",
        "sessionId": "sess_hot",
        "type": "message",
        "status": "done",
        "role": "assistant",
        "content": {"text": text, "format": "markdown"},
        "source": {
            "runtime": "codex",
            "sessionId": "thread_hot",
            "itemId": "runtime-item_hot",
            "itemType": "agentMessage",
        },
        "orderSeq": 1,
        "revision": 1,
        "contentHash": "sha256:hot",
    }


def _best_ms(statement: str, globals_map: dict[str, Any], *, repeat: int, number: int) -> float:
    timings = timeit.repeat(statement, globals=globals_map, repeat=repeat, number=number)
    return min(timings) / number * 1000.0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload-bytes", type=int, default=DEFAULT_PAYLOAD_BYTES)
    parser.add_argument("--repeat", type=int, default=DEFAULT_REPEAT)
    parser.add_argument("--number", type=int, default=DEFAULT_NUMBER)
    args = parser.parse_args()

    raw = build_raw_item(args.payload_bytes)
    item = TimelineItemIn.model_validate(raw)
    normalized = timeline_item_from_runtime_input(
        item,
        updated_seq=7,
        now="2026-09-09T00:00:00Z",
        existing=None,
        order_seq=1,
        revision=1,
    )
    raw_json = json.dumps(normalized.model_dump(mode="json"), separators=(",", ":"))
    payload_size = len(raw_json)

    scope = {
        "raw": raw,
        "item": item,
        "normalized": normalized,
        "raw_json": raw_json,
        "TimelineItemIn": TimelineItemIn,
        "TimelineItem": TimelineItem,
        "timeline_item_from_runtime_input": timeline_item_from_runtime_input,
        "json": json,
    }

    measurements = [
        ("ingress validate (TimelineItemIn)", "TimelineItemIn.model_validate(raw)"),
        (
            "normalize (from_runtime_input)",
            (
                "timeline_item_from_runtime_input(item, updated_seq=7,"
                " now='2026-09-09T00:00:00Z', existing=None, order_seq=1,"
                " revision=1)"
            ),
        ),
        (
            "normalize (legacy model_dump path)",
            (
                "TimelineItem.model_validate({**item.model_dump(),"
                " 'updatedSeq': 7, 'orderSeq': 1, 'revision': 1,"
                " 'createdAt': '2026-09-09T00:00:00Z',"
                " 'updatedAt': '2026-09-09T00:00:00Z'})"
            ),
        ),
        (
            "stage serialize (dump + sorted json)",
            (
                "json.dumps(normalized.model_dump(mode='json'), ensure_ascii=False,"
                " sort_keys=True, separators=(',', ':'))"
            ),
        ),
        ("publish dump (model_dump json)", "normalized.model_dump(mode='json')"),
        ("pending parse (validate_json)", "TimelineItem.model_validate_json(raw_json)"),
    ]

    print(f"payload_bytes={payload_size} repeat={args.repeat} number={args.number}")
    print(f"{'operation':<38} {'ms/op':>8}  {'ops/s':>9}")
    total = 0.0
    for label, statement in measurements:
        per_op = _best_ms(statement, scope, repeat=args.repeat, number=args.number)
        total += per_op
        print(f"{label:<38} {per_op:>8.3f}  {1000.0 / per_op:>9.0f}")
    print(f"{'TOTAL (per delta, CPU only)':<38} {total:>8.3f}  {1000.0 / total:>9.0f}")


if __name__ == "__main__":
    main()
