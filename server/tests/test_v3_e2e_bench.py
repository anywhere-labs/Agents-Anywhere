"""v3 latency baselines end to end (S5, plain-mode half of E-7): opt-in, skipped unless ``AA_E2E_BENCH=1``.

Same environment as ``test_v3_e2e.py`` (``v3_e2e_harness``): the real Server, a real MeshCall Router and the real
TS Connector with the fake ACP Agent, all on this machine (loopback, no network model). Measured through the client
API only:

- first screen: ``GET /api/v2/sessions/{id}/snapshot`` of sessions with 100, 1000 and 5000 timeline items
  (``#bulk``: the fake Agent reports that many tool calls in one turn), P50/P95 and response size;
- Timeline paging: the latest page and older pages (``mode=history``, 100 items per page);
- send to first live event: ``POST runtime/messages`` until the first event and until the reply arrive on the
  session WebSocket;
- terminal round trip: input on the terminal stream until its output comes back.

No thresholds: the numbers are a baseline. The report goes to ``AA_E2E_BENCH_REPORT`` (a directory, default
``server/.test-results``) as ``v3-e2e-bench.json`` and ``v3-e2e-bench.md``.

    AA_E2E_BENCH=1 [AA_E2E_BENCH_SIZES=100,1000,5000] [AA_E2E_BENCH_ITERATIONS=30] \\
    MESHCALL_ROUTER_BINARY=/path/to/meshcall-router uv run pytest tests/test_v3_e2e_bench.py -s
"""

from __future__ import annotations

import base64
import contextlib
import json
import math
import os
import platform
import subprocess
import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from v3_e2e_harness import (
    E2E,
    REPO,
    STARTUP_TIMEOUT,
    SessionSocket,
    create_project,
    e2e_environment,
    enable_fake_agent,
    new_session,
    node_binary,
    send_message,
    skip_reason,
    wait_for,
    wait_session,
    wait_text,
)

pytestmark = [
    pytest.mark.skipif(skip_reason() is not None, reason=skip_reason() or ""),
    pytest.mark.skipif(os.environ.get("AA_E2E_BENCH") != "1", reason="benchmark: set AA_E2E_BENCH=1"),
]

SIZES = [int(size) for size in os.environ.get("AA_E2E_BENCH_SIZES", "100,1000,5000").split(",") if size.strip()]
ITERATIONS = int(os.environ.get("AA_E2E_BENCH_ITERATIONS", "30"))
PAGE = 100
HISTORY_PAGES = 20


def _ms(seconds: float) -> float:
    return round(seconds * 1000, 2)


def _percentile(sorted_values: list[float], p: float) -> float:
    rank = min(len(sorted_values) - 1, max(0, math.ceil(p / 100 * len(sorted_values)) - 1))
    return sorted_values[rank]


def _summary(values: list[float]) -> dict[str, Any]:
    ordered = sorted(values)
    if not ordered:
        return {"n": 0}
    return {
        "n": len(ordered),
        "p50": _ms(_percentile(ordered, 50)),
        "p95": _ms(_percentile(ordered, 95)),
        "min": _ms(ordered[0]),
        "max": _ms(ordered[-1]),
    }


def _timed(call: Any) -> tuple[float, Any]:
    started = time.perf_counter()
    result = call()
    return time.perf_counter() - started, result


@pytest.fixture(scope="module")
def bench(request: pytest.FixtureRequest) -> Iterator[E2E]:
    with e2e_environment(request) as env:
        env.wait_status("online", STARTUP_TIMEOUT)
        enable_fake_agent(env)
        create_project(env)
        yield env


def _seeded_session(env: E2E, size: int) -> tuple[str, float]:
    """A session with ``size`` timeline items: the user message, ``size - 2`` tool calls and the reply."""
    marker = f"seeded {size} {uuid.uuid4().hex[:6]}"
    started = time.perf_counter()
    session_id = new_session(env, f"#bulk {max(0, size - 2)} {marker}")
    wait_text(env, session_id, f"echo: #bulk {max(0, size - 2)} {marker}", timeout=600)
    wait_session(env, session_id, "idle", timeout=120)
    return session_id, time.perf_counter() - started


def _count_items(env: E2E, session_id: str) -> int:
    latest = env.api.get(f"/sessions/{session_id}/timeline", params={"mode": "latest", "limit": 500})
    total = len(latest["items"])
    page = latest
    while page.get("hasMore") and page["items"]:
        oldest = min(int(item["orderSeq"]) for item in page["items"])
        page = env.api.get(f"/sessions/{session_id}/timeline",
                           params={"mode": "history", "beforeOrderSeq": oldest, "limit": 500})
        total += len(page["items"])
    return total


def _first_screen(env: E2E, session_id: str) -> dict[str, Any]:
    path = f"/sessions/{session_id}/snapshot"
    env.api.call("GET", path)  # warm-up
    timings: list[float] = []
    sizes: list[int] = []
    for _ in range(ITERATIONS):
        elapsed, response = _timed(lambda: env.api.call("GET", path))
        timings.append(elapsed)
        sizes.append(len(response.content))
    body = env.api.get(path)
    return {
        **_summary(timings),
        "bytes": max(sizes),
        "timelineItems": len((body.get("timeline") or {}).get("items") or body.get("items") or []),
    }


def _paging(env: E2E, session_id: str) -> dict[str, Any]:
    latest: list[float] = []
    older: list[float] = []
    for _ in range(ITERATIONS):
        elapsed, page = _timed(lambda: env.api.get(f"/sessions/{session_id}/timeline",
                                                   params={"mode": "latest", "limit": PAGE}))
        latest.append(elapsed)
    for _ in range(max(1, ITERATIONS // 10)):
        page = env.api.get(f"/sessions/{session_id}/timeline", params={"mode": "latest", "limit": PAGE})
        for _ in range(HISTORY_PAGES):
            if not page.get("hasMore") or not page["items"]:
                break
            oldest = min(int(item["orderSeq"]) for item in page["items"])
            elapsed, page = _timed(lambda oldest=oldest: env.api.get(
                f"/sessions/{session_id}/timeline",
                params={"mode": "history", "beforeOrderSeq": oldest, "limit": PAGE}))
            older.append(elapsed)
    return {"latestPage": _summary(latest), "olderPage": _summary(older), "pageSize": PAGE}


def _streaming(env: E2E, session_id: str) -> dict[str, Any]:
    socket = SessionSocket(env.api, session_id)
    accepted: list[float] = []
    first_event: list[float] = []
    reply: list[float] = []
    try:
        wait_for(lambda: "session.subscribed" in socket.types(), 10, 0.01, "subscribed")
        for index in range(ITERATIONS):
            text = f"bench ping {index} {uuid.uuid4().hex[:6]}"
            before = len(socket.seen())
            started = time.perf_counter()
            send_message(env, session_id, text)
            accepted.append(time.perf_counter() - started)
            wait_for(lambda before=before: len(socket.seen()) > before, 30, 0.002, "the first live event")
            first_event.append(time.perf_counter() - started)
            wait_for(lambda text=text, before=before: any(f"echo: {text}" in json.dumps(e) for e in socket.seen()[before:]),
                     30, 0.002, "the reply event")
            reply.append(time.perf_counter() - started)
            wait_session(env, session_id, "idle", timeout=30)
    finally:
        socket.close()
    return {"accepted": _summary(accepted), "firstEvent": _summary(first_event), "replyEvent": _summary(reply)}


def _terminal(env: E2E) -> dict[str, Any]:
    from websockets.sync.client import connect

    api = env.api
    root = str(env.device.workspace)
    created = api.post(f"{env.dev}/terminals-v2", {"cols": 120, "rows": 40, "label": "bench"}, params={"root": root})
    terminal_id = created["result"]["terminalId"]
    url = api.ws_url(f"/api/v2/connectors/{env.connector_id}/terminals-v2/{terminal_id}/stream"
                     f"?token={api.token}&fromSeq=0")
    stream: list[float] = []
    http: list[float] = []
    buffer = ""
    try:
        with connect(url, open_timeout=10, max_size=None) as socket:

            def until(marker: str, started: float) -> float:
                nonlocal buffer
                while marker not in buffer:
                    remaining = 30 - (time.perf_counter() - started)
                    assert remaining > 0, f"terminal output {marker!r} not seen"
                    frame = json.loads(socket.recv(timeout=remaining))
                    if frame.get("type") in {"replay", "output"} and frame.get("data"):
                        buffer += base64.b64decode(frame["data"]).decode("utf-8", "replace")
                return time.perf_counter() - started

            # Shell expansion makes the output differ from the echoed input.
            started = time.perf_counter()
            socket.send(json.dumps({"type": "input", "data": base64.b64encode(b"echo warm-$((0+1))\n").decode()}))
            until("warm-1", started)
            for index in range(ITERATIONS):
                started = time.perf_counter()
                command = f"echo rt{index}-$((40+2))\n".encode()
                socket.send(json.dumps({"type": "input", "data": base64.b64encode(command).decode()}))
                stream.append(until(f"rt{index}-42", started))
                started = time.perf_counter()
                command = f"echo http{index}-$((40+2))\n".encode()
                api.post(f"{env.dev}/terminals-v2/{terminal_id}/write",
                         {"dataBase64": base64.b64encode(command).decode()})
                http.append(until(f"http{index}-42", started))
    finally:
        with contextlib.suppress(Exception):
            api.delete(f"{env.dev}/terminals-v2/{terminal_id}")
    return {"streamInput": _summary(stream), "httpWrite": _summary(http)}


def _environment() -> dict[str, Any]:
    def run(*command: str) -> str:
        with contextlib.suppress(Exception):
            return subprocess.run(command, check=False, capture_output=True, text=True, timeout=10, cwd=REPO).stdout.strip()
        return ""

    return {
        "at": datetime.now(UTC).isoformat(),
        "commit": run("git", "rev-parse", "--short", "HEAD"),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpus": os.cpu_count(),
        "python": platform.python_version(),
        "node": run(node_binary() or "node", "--version"),
        "iterations": ITERATIONS,
        "topology": "loopback: client, Server (1 uvicorn worker, no Redis), Router and device on one machine",
    }


def _markdown(report: dict[str, Any]) -> str:
    def row(name: str, s: dict[str, Any], extra: str = "") -> str:
        return f"| {name} | {s.get('n', 0)} | {s.get('p50', '-')} | {s.get('p95', '-')} | {s.get('max', '-')} | {extra} |"

    env = report["environment"]
    lines = [
        "# v3 end-to-end latency baseline (plain mode)",
        "",
        f"{env['at']} · commit {env['commit']} · {env['platform']} · {env['cpus']} CPUs · Node {env['node']}",
        "",
        f"Topology: {env['topology']}. Milliseconds.",
        "",
        "| Measurement | n | P50 | P95 | max | notes |",
        "| --- | ---: | ---: | ---: | ---: | --- |",
    ]
    for size in report["sizes"]:
        lines.append(row(f"first screen, {size['items']} items", size["firstScreen"],
                         f"{size['firstScreen']['bytes']} bytes, {size['firstScreen']['timelineItems']} items in"
                         f" the snapshot; seeding took {size['seedSeconds']} s"))
        lines.append(row(f"Timeline latest page, {size['items']} items", size["paging"]["latestPage"],
                         f"{PAGE} per page"))
        lines.append(row(f"Timeline older page, {size['items']} items", size["paging"]["olderPage"],
                         f"{PAGE} per page, up to {HISTORY_PAGES} pages back"))
    stream = report["streaming"]
    lines.append(row("send: POST accepted", stream["accepted"]))
    lines.append(row("send: first live event", stream["firstEvent"], "session WebSocket"))
    lines.append(row("send: reply event", stream["replyEvent"], "fake Agent replies at once"))
    terminal = report["terminal"]
    lines.append(row("terminal: stream input to output", terminal["streamInput"]))
    lines.append(row("terminal: HTTP write to output", terminal["httpWrite"]))
    return "\n".join(lines) + "\n"


def test_v3_latency_baseline(bench: E2E) -> None:
    report: dict[str, Any] = {"environment": _environment(), "sizes": []}
    smallest: str | None = None
    for size in SIZES:
        session_id, seeded = _seeded_session(bench, size)
        smallest = smallest or session_id
        items = _count_items(bench, session_id)
        report["sizes"].append({
            "requested": size,
            "items": items,
            "seedSeconds": round(seeded, 1),
            "firstScreen": _first_screen(bench, session_id),
            "paging": _paging(bench, session_id),
        })
    assert smallest is not None
    report["streaming"] = _streaming(bench, smallest)
    report["terminal"] = _terminal(bench)

    directory = Path(os.environ.get("AA_E2E_BENCH_REPORT") or REPO / "server/.test-results")
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "v3-e2e-bench.json").write_text(json.dumps(report, indent=2))
    markdown = _markdown(report)
    (directory / "v3-e2e-bench.md").write_text(markdown)
    print(f"\n{markdown}\nreport: {directory / 'v3-e2e-bench.json'}")
