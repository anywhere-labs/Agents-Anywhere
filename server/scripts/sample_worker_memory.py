"""Read Linux /proc smaps for specified host PIDs and emit JSONL to stdout.

No dependencies, application imports, signals, ptrace, environment reads, or
process-memory reads. Output includes aggregate mapping metadata only, without
file paths or command lines. PIDs are pinned by start time; exit/reuse stops the
sampler instead of silently continuing with another worker.

    python3 sample_worker_memory.py 1234 1235 --interval 600 --samples 36 > sample.jsonl
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

HEADER = re.compile(r"^[0-9a-f]+-[0-9a-f]+\s+\S+\s+\S+\s+\S+\s+(\d+)(?:\s+(.*))?$")
FIELDS = ("Size", "Rss", "Pss", "Private_Clean", "Private_Dirty", "Anonymous", "Swap")


def summarize_smaps(value: str) -> dict[str, dict[str, int]]:
    """Sizes are KiB. Mapping-size buckets do not identify allocator arenas."""
    groups: dict[str, dict[str, int]] = defaultdict(
        lambda: {"mappings": 0, **{field: 0 for field in FIELDS}}
    )
    path = ""
    inode = 0
    mapping: dict[str, int] = {}

    def finish() -> None:
        if not mapping:
            return
        if path == "[heap]":
            group = "heap"
        elif path.startswith("[stack"):
            group = "stack"
        elif inode or path.startswith("/"):
            group = "file"
        elif not path or path.startswith(("[anon:", "[anon_shmem:")):
            size = mapping.get("Size", 0)
            group = {1024: "anonymous_1mib_mapping", 65536: "anonymous_64mib_mapping"}.get(
                size, "anonymous_other"
            )
        else:
            group = "special"
        for key in (group, "total"):
            row = groups[key]
            row["mappings"] += 1
            for field in FIELDS:
                row[field] += mapping.get(field, 0)

    for line in value.splitlines():
        match = HEADER.match(line)
        if match:
            finish()
            inode = int(match.group(1))
            path = match.group(2) or ""
            mapping = {}
        else:
            field, _, raw = line.partition(":")
            if field in FIELDS:
                mapping[field] = int(raw.split()[0])
    finish()
    return dict(groups)


def start_ticks(proc: Path) -> int:
    # comm (field 2) can contain spaces and ')'; field 22 is starttime.
    fields = (proc / "stat").read_text().rsplit(")", 1)[1].split()
    return int(fields[19])


def sample(pid: int, expected_start: int) -> dict[str, object]:
    proc = Path("/proc") / str(pid)
    if start_ticks(proc) != expected_start:
        raise RuntimeError(f"PID {pid} was reused; start a new observation")
    started = time.monotonic()
    groups = summarize_smaps((proc / "smaps").read_text())
    if start_ticks(proc) != expected_start:
        raise RuntimeError(f"PID {pid} changed during smaps read")
    return {
        "pid": pid,
        "start_ticks": expected_start,
        "sampled_at": datetime.now(UTC).isoformat(),
        "read_ms": round((time.monotonic() - started) * 1000, 2),
        "groups_kib": groups,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pids", type=int, nargs="+")
    parser.add_argument("--interval", type=float, default=600)
    parser.add_argument("--samples", type=int, default=36)
    args = parser.parse_args()
    if min(args.pids) < 1 or args.samples < 1 or not math.isfinite(args.interval) or args.interval <= 0:
        parser.error("PIDs, samples, and finite interval must be positive")
    try:
        identities = {pid: start_ticks(Path("/proc") / str(pid)) for pid in args.pids}
        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        deadline = time.monotonic()
        for index in range(args.samples):
            if index:
                time.sleep(max(0, deadline - time.monotonic()))
            for pid, identity in identities.items():
                print(json.dumps({"boot_id": boot_id, **sample(pid, identity)}), flush=True)
            deadline += args.interval
    except (OSError, ValueError, RuntimeError, IndexError) as exc:
        print(f"Sampling stopped: {exc}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
