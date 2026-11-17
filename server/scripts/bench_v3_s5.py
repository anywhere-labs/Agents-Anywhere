"""S5: first-screen latency and MeshCall Router / worker capacity.

Two measurements, both against a real MeshCall Router (``9334405``):

``firstscreen``
    2.x baseline: ``GET /api/v2/sessions/{id}/snapshot`` on a session with N
    timeline items, served from PostgreSQL (the v2 read path). v3 read-through:
    the same items fetched from a fake device with ``Client/call`` (``GET /snapshot``) through
    the Router, with the device's home link simulated by a delay proxy
    (one-way latency + uplink bandwidth). The client's 4G leg is identical for
    both and is added as a model (RTT + bytes / downlink).

``capacity``
    One Server worker (one Mesh client connection) holds ``Link/attach`` and
    ``Link/outbox`` for N devices plus W ``Sessions/watch`` streams. Reports the
    Router's and the worker's RSS, heartbeat delivery and unary latency under
    load, and the token issue rate.

Usage (Server uv environment, Router binary from ``go build`` or a release)::

    MESHCALL_ROUTER_BINARY=/path/to/meshcall-router \
    AGENT_SERVER_TEST_DB_URL=postgresql+asyncpg://.../aa_test \
    .venv/bin/python -m scripts.bench_v3_s5 firstscreen
    .venv/bin/python -m scripts.bench_v3_s5 capacity --devices 1000 --watch 1000
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import random
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

SERVICES = tuple(
    f"aa.device.v1.{name}" for name in ("Link", "Sessions", "Store", "Runtime", "Commands", "Workspace", "Secure")
)
ROUTER_SERVICES = ("meshcall.router.v1.AuthService", "meshcall.router.v1.Registry")


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------


def router_binary() -> str:
    path = os.environ.get("MESHCALL_ROUTER_BINARY", "").strip()
    if not path or not Path(path).exists():
        raise SystemExit("set MESHCALL_ROUTER_BINARY to a meshcall-router binary (9334405)")
    return path


def password_hash(password: str) -> str:
    salt = secrets.token_bytes(16)
    key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 600_000)
    return f"pbkdf2-sha256$600000${salt.hex()}${key.hex()}"


def write_auth_file(directory: Path, password: str) -> Path:
    path = directory / "router-auth.json"
    path.write_text(
        json.dumps(
            {
                "users": [
                    {
                        "username": "aa-server",
                        "password_hash": password_hash(password),
                        "roles": ["client", "server"],
                        "register": list(SERVICES),
                        "call": [f"{name}/*" for name in (*SERVICES, *ROUTER_SERVICES)],
                    }
                ]
            }
        )
    )
    return path


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class RouterProcess:
    def __init__(self, *extra: str) -> None:
        self.password = secrets.token_urlsafe(16)
        self.port = free_port()
        self.dir = Path(tempfile.mkdtemp(prefix="aa-s5-router-"))
        self.args = [
            router_binary(),
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
            "--auth-file",
            str(write_auth_file(self.dir, self.password)),
            "--max-frame-size",
            str(4 * 1024 * 1024),
            *extra,
        ]
        self.proc: subprocess.Popen[bytes] | None = None

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    def start(self) -> None:
        self.proc = subprocess.Popen(self.args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            with contextlib.suppress(OSError), socket.create_connection(("127.0.0.1", self.port), 0.2):
                return
            time.sleep(0.05)
        raise SystemExit("Router did not start")

    def stop(self) -> None:
        if self.proc is not None:
            self.proc.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                self.proc.wait(5)


def rss_mib(pid: int) -> float:
    out = subprocess.run(
        ["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, check=False
    ).stdout.strip()
    return int(out or 0) / 1024


def cpu_seconds(pid: int) -> float:
    out = subprocess.run(
        ["ps", "-o", "time=", "-p", str(pid)], capture_output=True, text=True, check=False
    ).stdout.strip()
    if not out:
        return 0.0
    parts = out.replace("-", ":").split(":")
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60 + float(part)
    return seconds


def pct(values: list[float], q: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(q * (len(ordered) - 1))))
    return ordered[index]


def summary(values: list[float]) -> dict[str, float]:
    return {
        "n": len(values),
        "p50": round(pct(values, 0.5), 1),
        "p95": round(pct(values, 0.95), 1),
        "max": round(max(values), 1) if values else float("nan"),
    }


async def server_mesh(router: RouterProcess):
    from meshcall import Mesh, ReconnectPolicy, RetryPolicy, Router, RouterCredentials

    mesh = Mesh(
        Router(router.url),
        credentials=RouterCredentials.basic("aa-server", router.password),
        retry=RetryPolicy(enabled=False),
        reconnect=ReconnectPolicy(max_attempts=3),
        max_frame_size=4 * 1024 * 1024,
    )
    await mesh.connect()
    return mesh


async def issue_device_token(mesh: Any, device_id: str, ttl: int = 900) -> Any:
    from meshcall import RouterScope

    scopes = [RouterScope(service=name, register=True, instance_ids=[device_id]) for name in SERVICES if not name.endswith(".Secure")]
    return await mesh.auth.issue_token(scopes, ttl_seconds=ttl)


# ---------------------------------------------------------------------------
# Delay proxy: simulates a link with one-way latency and a bandwidth cap
# ---------------------------------------------------------------------------


class DelayProxy:
    def __init__(self, target_port: int, *, one_way_ms: float, up_mbps: float, down_mbps: float) -> None:
        self.target_port = target_port
        self.delay = one_way_ms / 1000
        # "up" is device -> Router (responses), "down" is Router -> device (requests).
        self.up_bps = up_mbps * 1_000_000 / 8
        self.down_bps = down_mbps * 1_000_000 / 8
        self.port = 0
        self.server: asyncio.base_events.Server | None = None

    async def start(self) -> None:
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        if self.server is not None:
            self.server.close()

    async def _pipe(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, bps: float) -> None:
        queue: asyncio.Queue[tuple[float, bytes] | None] = asyncio.Queue()
        busy_until = 0.0

        async def deliver() -> None:
            while (entry := await queue.get()) is not None:
                at, data = entry
                wait = at - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
                writer.write(data)
                with contextlib.suppress(ConnectionError):
                    await writer.drain()
            with contextlib.suppress(Exception):
                writer.close()

        task = asyncio.create_task(deliver())
        try:
            while data := await reader.read(65536):
                now = time.monotonic()
                busy_until = max(busy_until, now) + len(data) / bps
                queue.put_nowait((busy_until + self.delay, data))
        except ConnectionError:
            pass
        finally:
            queue.put_nowait(None)
            await task

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            up_reader, up_writer = await asyncio.open_connection("127.0.0.1", self.target_port)
        except OSError:
            writer.close()
            return
        await asyncio.gather(
            self._pipe(reader, up_writer, self.up_bps),
            self._pipe(up_reader, writer, self.down_bps),
            return_exceptions=True,
        )


# ---------------------------------------------------------------------------
# Realistic timeline items
# ---------------------------------------------------------------------------


def timeline_items(session_id: str, count: int, seed: int = 7) -> list[dict[str, Any]]:
    """A first screen of a coding session: user turns, answers, tool calls with output."""

    rng = random.Random(seed)
    # Real prose and code from this checkout, so compression ratios are realistic.
    repo = Path(__file__).resolve().parents[2]
    prose = "\n".join(p.read_text() for p in sorted((repo / "docs").glob("*.md"))[:20])
    code = "\n".join(p.read_text() for p in sorted((repo / "server" / "agent_server" / "services").glob("*.py"))[:20])

    def text(n: int, corpus: str = "") -> str:
        corpus = corpus or prose
        start = rng.randrange(0, max(1, len(corpus) - n))
        return corpus[start : start + n]

    items: list[dict[str, Any]] = []
    for order in range(1, count + 1):
        roll = order % 10
        base = {
            "id": f"tl_{order}",
            "sessionId": session_id,
            "turnId": f"turn_{order // 10}",
            "status": "done",
            "source": {
                "runtime": "codex",
                "sessionId": "thr_bench",
                "turnId": f"turn_{order // 10}",
                "itemId": f"item_{order}",
                "itemType": "agentMessage",
            },
            "orderSeq": order,
            "revision": 1,
            "contentHash": f"sha256:{order}",
        }
        if roll == 0:
            items.append(
                {**base, "type": "message", "role": "user", "content": {"text": text(300), "format": "markdown"}}
            )
        elif roll in (1, 5, 9):
            items.append(
                {**base, "type": "message", "role": "assistant", "content": {"text": text(1500), "format": "markdown"}}
            )
        else:
            items.append(
                {
                    **base,
                    "type": "message",
                    "role": "assistant",
                    "content": {"text": "```\n" + text(3000, code) + "\n```", "format": "markdown"},
                }
            )
    return items


# ---------------------------------------------------------------------------
# firstscreen
# ---------------------------------------------------------------------------


async def v2_snapshot_baseline(items_count: int, runs: int) -> dict[str, Any]:
    """Time ``GET /snapshot`` on the real v2 app (in-process ASGI, PostgreSQL)."""

    import httpx

    from scripts._bench_db import open_bench_store, resolve_bench_db_url

    url = resolve_bench_db_url(None)
    os.environ["AGENT_SERVER_DB_URL"] = url
    os.environ.setdefault("AGENT_SERVER_SECRET", "s5-bench-secret-" + "x" * 32)
    store = await open_bench_store(url)
    await store.close()

    from agent_server.app import create_app
    from agent_server.core.models import TimelineItemIn

    app = create_app()
    transport = httpx.ASGITransport(app=app)
    results: dict[str, Any] = {}
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=transport, base_url="http://bench") as client,
    ):
        from agent_server.core.auth import create_user_access_token

        user = await app.state.store.create_user(user_id="bench_user", password="bench-password")
        user_id = user.userId if hasattr(user, "userId") else user.id
        headers = {"Authorization": f"Bearer {create_user_access_token(user_id)}"}
        conn = await client.post("/api/v2/connectors", headers=headers, json={"name": "bench"})
        conn.raise_for_status()
        connector_id = conn.json()["connector"]["id"]
        project = await client.post(
            "/api/v2/projects",
            headers=headers,
            json={"connectorId": connector_id, "name": "bench", "workspacePath": "/repo"},
        )
        project.raise_for_status()
        store = app.state.store
        for count in (0, items_count):
            session = await store.create_session(
                connector_id=connector_id,
                project_id=project.json()["project"]["id"],
                user_id=user_id,
                runtime="codex",
                external_session_id=f"thr_{count}",
                title="bench",
                cwd="/repo",
            )
            for item in timeline_items(session.id, count):
                await store.upsert_timeline_item(session_id=session.id, item=TimelineItemIn.model_validate(item))
            samples: list[float] = []
            size = 0
            for _ in range(runs + 3):
                start = time.perf_counter()
                response = await client.get(f"/api/v2/sessions/{session.id}/snapshot", headers=headers)
                elapsed = (time.perf_counter() - start) * 1000
                response.raise_for_status()
                size = len(response.content)
                samples.append(elapsed)
            results[f"items_{count}"] = {"bytes": size, **summary(samples[3:])}
    return results


async def v3_read_through(items_count: int, runs: int, link: dict[str, float]) -> dict[str, Any]:
    from agent_server.core.device_meshcall import ClientCallItem, ClientCallRequest
    from scripts.v3_fake_device import FakeDevice

    router = RouterProcess()
    router.start()
    proxy = DelayProxy(router.port, **link)
    await proxy.start()
    mesh = await server_mesh(router)
    token = await issue_device_token(mesh, "dev_bench")
    device = FakeDevice("dev_bench", f"ws://127.0.0.1:{proxy.port}", token.token)
    try:
        await device.start()
        session = device.state.session("sess_bench")
        session.items = timeline_items("sess_bench", items_count)
        session.head_seq = items_count

        def snapshot(request: dict[str, Any]) -> tuple[int, dict[str, Any]]:
            items = session.items[-100:]
            return 200, {
                "timeline": {"items": items, "nextSeq": session.head_seq, "hasMore": len(session.items) > 100},
                "notices": [],
                "eventCursor": f"seq:{session.head_seq}",
            }

        device.state.client_handler = snapshot
        request = ClientCallRequest(
            route="session.snapshot",
            method="GET",
            path="/api/v2/sessions/sess_bench/snapshot",
            query={"limit": "100"},
            caller={"userId": "usr_bench"},
        )
        samples: list[float] = []
        size = 0
        for _ in range(runs + 3):
            start = time.perf_counter()
            stream = mesh.call_server_stream(
                "aa.device.v1.Client", "call", request, ClientCallItem, instance="dev_bench", timeout=10
            )
            items = [item.root async for item in stream]
            body = "".join(str(item.chunk) for item in items if item.kind == "chunk")
            samples.append((time.perf_counter() - start) * 1000)
            size = len(body)
        return {"bytes": size, "wireBytes": size, **summary(samples[3:])}
    finally:
        await device.stop()
        await mesh.close()
        await proxy.stop()
        router.stop()


def model_4g(server_ms: float, size: int, *, rtt_ms: float, down_mbps: float) -> float:
    return rtt_ms + server_ms + size * 8 / (down_mbps * 1000)


async def firstscreen(args: argparse.Namespace) -> dict[str, Any]:
    v2 = await v2_snapshot_baseline(args.items, args.runs)
    links = {
        "local": {"one_way_ms": 0, "up_mbps": 10_000, "down_mbps": 10_000},
        "home_broadband": {"one_way_ms": args.home_one_way_ms, "up_mbps": args.home_up_mbps, "down_mbps": 100},
        "home_slow": {"one_way_ms": args.home_one_way_ms * 2, "up_mbps": args.home_up_mbps / 4, "down_mbps": 50},
    }
    v3 = {name: await v3_read_through(args.items, args.runs, link) for name, link in links.items()}
    full = v2[f"items_{args.items}"]
    empty = v2["items_0"]
    # v3 keeps everything the v2 snapshot does except the timeline read; the device leg replaces it.
    meta_p50, meta_p95 = empty["p50"], empty["p95"]
    out: dict[str, Any] = {"v2_server": v2, "v3_device_leg": v3, "client_4g_model": {}}
    for name, leg in v3.items():
        out["client_4g_model"][name] = {
            "v2_p50": round(
                model_4g(full["p50"], full["bytes"], rtt_ms=args.rtt_4g_ms, down_mbps=args.down_4g_mbps), 1
            ),
            "v2_p95": round(
                model_4g(full["p95"], full["bytes"], rtt_ms=args.rtt_4g_ms, down_mbps=args.down_4g_mbps), 1
            ),
            "v3_p50": round(
                model_4g(meta_p50 + leg["p50"], full["bytes"], rtt_ms=args.rtt_4g_ms, down_mbps=args.down_4g_mbps), 1
            ),
            "v3_p95": round(
                model_4g(meta_p95 + leg["p95"], full["bytes"], rtt_ms=args.rtt_4g_ms, down_mbps=args.down_4g_mbps), 1
            ),
        }
    return out


# ---------------------------------------------------------------------------
# capacity
# ---------------------------------------------------------------------------


async def _device_worker(router_url: str, tokens: list[tuple[str, str]], heartbeat: float, ready_file: str) -> None:
    from scripts.v3_fake_device import FakeDevice

    devices: list[FakeDevice] = []
    for device_id, token in tokens:
        device = FakeDevice(device_id, router_url, token)
        device.state.heartbeat_interval = heartbeat
        await device.start()
        devices.append(device)
    Path(ready_file).write_text(str(len(devices)))
    await asyncio.Event().wait()


def device_worker_main() -> None:
    spec = json.loads(sys.stdin.read())
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(
            _device_worker(spec["router"], [tuple(t) for t in spec["tokens"]], spec["heartbeat"], spec["ready"])
        )


async def capacity(args: argparse.Namespace) -> dict[str, Any]:
    from agent_server.core.device_meshcall import (
        ChangesEvent,
        CommandStatusRequest,
        CommandStatusResponse,
        LinkAttachItem,
        LinkAttachRequest,
        OutboxItem,
        OutboxOpenRequest,
        SessionWatchRequest,
    )

    router = RouterProcess(
        "--max-tokens",
        str(max(4096, args.devices * 2)),
        "--max-calls-per-connection",
        "0",
        "--idle-timeout",
        "30s",
    )
    router.start()
    out: dict[str, Any] = {"devices": args.devices, "watch": args.watch, "heartbeat_s": args.heartbeat}
    out["router_rss_idle_mib"] = round(rss_mib(router.proc.pid), 1)
    mesh = await server_mesh(router)
    worker_rss_before = rss_mib(os.getpid())
    procs: list[subprocess.Popen[bytes]] = []
    try:
        ids = [f"dev_{i:05d}" for i in range(args.devices)]
        start = time.perf_counter()
        tokens = await asyncio.gather(*(issue_device_token(mesh, device_id) for device_id in ids))
        out["token_issue_per_s"] = round(len(ids) / (time.perf_counter() - start), 1)
        per_proc = max(1, -(-args.devices // args.device_procs))
        tmp = Path(tempfile.mkdtemp(prefix="aa-s5-dev-"))
        start = time.perf_counter()
        for index in range(0, args.devices, per_proc):
            ready = tmp / f"ready-{index}"
            proc = subprocess.Popen(  # noqa: ASYNC220 - a benchmark launching its device workers
                [sys.executable, "-m", "scripts.bench_v3_s5", "_device_worker"],
                stdin=subprocess.PIPE,
                cwd=Path(__file__).resolve().parents[1],
            )
            assert proc.stdin is not None
            proc.stdin.write(
                json.dumps(
                    {
                        "router": router.url,
                        "tokens": [
                            (ids[i], tokens[i].token) for i in range(index, min(index + per_proc, args.devices))
                        ],
                        "heartbeat": args.heartbeat,
                        "ready": str(ready),
                    }
                ).encode()
            )
            proc.stdin.close()
            procs.append((proc, ready))  # type: ignore[arg-type]
        while not all(ready.exists() for _, ready in procs):  # type: ignore[misc]
            if any(p.poll() is not None for p, _ in procs):  # type: ignore[misc]
                raise SystemExit("a device worker died")
            await asyncio.sleep(0.2)
        out["register_s"] = round(time.perf_counter() - start, 2)
        out["router_rss_registered_mib"] = round(rss_mib(router.proc.pid), 1)

        heartbeats = 0
        streams: list[Any] = []

        async def consume(stream: Any, counter: bool) -> None:
            nonlocal heartbeats
            with contextlib.suppress(Exception):
                async for _item in stream:
                    if counter:
                        heartbeats += 1

        start = time.perf_counter()
        tasks = []
        for device_id in ids:
            attach = mesh.call_server_stream(
                "aa.device.v1.Link", "attach", LinkAttachRequest(connectionId="c1"), LinkAttachItem, instance=device_id
            )
            outbox = mesh.call_server_stream(
                "aa.device.v1.Link", "outbox", OutboxOpenRequest(connectionId="c1"), OutboxItem, instance=device_id
            )
            streams += [attach, outbox]
            tasks += [asyncio.create_task(consume(attach, True)), asyncio.create_task(consume(outbox, False))]
        for index in range(args.watch):
            device_id = ids[index % len(ids)]
            watch = mesh.call_server_stream(
                "aa.device.v1.Sessions",
                "watch",
                SessionWatchRequest(sessionId=f"sess_{index}", afterSeq=0),
                ChangesEvent,
                instance=device_id,
            )
            streams.append(watch)
            tasks.append(asyncio.create_task(consume(watch, False)))
        # Every attach yields one heartbeat at once.
        while heartbeats < len(ids):
            await asyncio.sleep(0.05)
            if time.perf_counter() - start > 120:
                break
        out["open_streams"] = len(streams)
        out["open_all_streams_s"] = round(time.perf_counter() - start, 2)
        heartbeats = 0
        window_start = time.perf_counter()
        router_cpu0 = cpu_seconds(router.proc.pid)
        worker_cpu0 = time.process_time()
        await asyncio.sleep(args.window)
        elapsed = time.perf_counter() - window_start
        out["heartbeats_per_s"] = round(heartbeats / elapsed, 1)
        out["expected_heartbeats_per_s"] = round(len(ids) / args.heartbeat, 1)
        out["router_cpu_pct"] = round(100 * (cpu_seconds(router.proc.pid) - router_cpu0) / elapsed, 1)
        out["worker_cpu_pct"] = round(100 * (time.process_time() - worker_cpu0) / elapsed, 1)
        out["router_rss_streams_mib"] = round(rss_mib(router.proc.pid), 1)
        out["worker_rss_delta_mib"] = round(rss_mib(os.getpid()) - worker_rss_before, 1)

        latencies: list[float] = []

        async def read_one() -> None:
            device_id = random.choice(ids)
            t = time.perf_counter()
            await mesh.call_unary(
                "aa.device.v1.Commands",
                "status",
                CommandStatusRequest(commandId="cmd_bench"),
                CommandStatusResponse,
                instance=device_id,
                timeout=10,
            )
            latencies.append((time.perf_counter() - t) * 1000)

        for _ in range(args.unary_rounds):
            await asyncio.gather(*(read_one() for _ in range(args.unary_concurrency)))
        out["unary_under_load_ms"] = summary(latencies)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    finally:
        await mesh.close()
        for proc, _ in procs:  # type: ignore[misc]
            proc.terminate()
        for proc, _ in procs:  # type: ignore[misc]
            with contextlib.suppress(subprocess.TimeoutExpired):
                proc.wait(10)
        router.stop()
    return out


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "_device_worker":
        device_worker_main()
        return
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    fs = sub.add_parser("firstscreen")
    fs.add_argument("--items", type=int, default=100)
    fs.add_argument("--runs", type=int, default=40)
    fs.add_argument("--home-one-way-ms", type=float, default=15.0, help="device <-> Server one-way latency")
    fs.add_argument("--home-up-mbps", type=float, default=20.0, help="device uplink")
    fs.add_argument("--rtt-4g-ms", type=float, default=80.0)
    fs.add_argument("--down-4g-mbps", type=float, default=20.0)
    cap = sub.add_parser("capacity")
    cap.add_argument("--devices", type=int, default=500)
    cap.add_argument("--watch", type=int, default=500)
    cap.add_argument("--heartbeat", type=float, default=20.0)
    cap.add_argument("--window", type=float, default=20.0)
    cap.add_argument("--device-procs", type=int, default=4)
    cap.add_argument("--unary-rounds", type=int, default=20)
    cap.add_argument("--unary-concurrency", type=int, default=20)
    args = parser.parse_args()
    from loguru import logger

    logger.remove()
    logger.add(sys.stderr, level="ERROR")
    result = asyncio.run(firstscreen(args) if args.command == "firstscreen" else capacity(args))
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
