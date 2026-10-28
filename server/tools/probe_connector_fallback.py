"""Real Mesh/WS fallback probes with isolated auth and Runtime handler fixtures.

Files, shell, PTY and terminal relay use actual Connector implementations.
Runtime methods use controlled handlers; this is not model/provider acceptance.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import hashlib
import json
import os
import secrets
import sys
from pathlib import Path

import httpx
from connector.local.ops import create_local_ops
from connector.server.local_rpc import LocalRpcHandler
from connector.server.terminal_relay import TerminalRelayRunner
from redis.asyncio import Redis

from tools.probe_connector_mesh import CONTROL_METHODS, free_port, until
from tools.probe_connector_mesh_renewal import RenewalConnector


class FunctionalConnector(RenewalConnector):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.ops = create_local_ops()
        self.relay_tasks = []

        async def no_upload(_params):
            raise AssertionError("uploads are outside this probe")

        async def relay(params):
            task = asyncio.create_task(TerminalRelayRunner(self.url, self.ops).run(params["terminalId"], self.token, attach=True))
            self.relay_tasks.append(task)
            return {"terminalId": params["terminalId"], "started": True}

        self.local = LocalRpcHandler(self.ops, no_upload, relay, asyncio.create_task)

    async def _dispatch(self, method, params):
        if params.get("realLocal"):
            result = await self.local.dispatch(method, params)
            self.finished[params["marker"]] += 1
            return result
        return await super()._dispatch(method, params)

    async def close_local(self):
        for task in self.relay_tasks:
            task.cancel()
        await asyncio.gather(*self.relay_tasks, return_exceptions=True)
        for identity in list(self.ops.terminal._terminals):
            await self.ops.terminal_close({"terminalId": identity})


async def probe(args):
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    workspace = output / "business"
    workspace.mkdir(exist_ok=True)
    gate = output / "mesh-gate"
    gate.write_text("bootstrap503")
    prefix = "aa-fallback-" + secrets.token_hex(8)
    os.environ["PROBE_CONNECTOR"] = "probe-" + secrets.token_hex(8)
    env = dict(os.environ, PROBE_PREFIX=prefix, PROBE_REDIS=args.redis_url,
               PROBE_TOKEN=secrets.token_urlsafe(24), PROBE_MESH_GATE_FILE=str(gate))
    redis = Redis.from_url(args.redis_url, decode_responses=True) if args.redis_url else None
    processes, logs, requests, results = [], [], [], []
    connector, connector_task = None, None
    ports = [free_port() for _ in range(5 if redis is not None else 2)]
    urls = [f"http://127.0.0.1:{port}" for port in ports]
    if redis is None:
        urls = [urls[0]] * 4 + [urls[1]]
    env["PROBE_URLS"] = json.dumps(urls[:4])
    script = Path(__file__).with_name("probe_connector_mesh.py")

    def passed(scenario, **metrics):
        results.append({"scenario": scenario, "passed": True, **metrics})

    def pending(coroutine):
        task = asyncio.create_task(coroutine)
        requests.append(task)
        return task

    try:
        for index, port in enumerate(ports):
            log = (output / f"process-{index}.log").open("w")
            logs.append(log)
            processes.append(await asyncio.create_subprocess_exec(
                sys.executable, str(script), "--serve", "--port", str(port),
                *(["--front"] if index == len(ports) - 1 else ["--workers", "2"] if redis and index in {0, 2} else []),
                env=env, stdout=log, stderr=asyncio.subprocess.STDOUT))
        async with httpx.AsyncClient(timeout=20, trust_env=False, limits=httpx.Limits(max_connections=80)) as http:
            for url in set(urls[:4]):
                async def healthy(url=url):
                    return (await http.get(url + "/api/v2/health/mesh", timeout=1)).status_code == 200
                await until(healthy)

            async def info():
                return (await http.get(urls[4] + "/probe/info")).json()

            async def online():
                return (await info())["connection"]

            async def route_ready():
                return (await info())["route"]

            async def call(method, marker, **params):
                return await http.post(urls[4] + "/probe/mesh/" + method,
                                       json={"params": {"marker": marker, **params}, "timeout": 10})

            connector = FunctionalConnector(urls[4], env["PROBE_TOKEN"], http)
            connector_task = asyncio.create_task(connector.run())
            base = await until(online)
            methods = [method for method in CONTROL_METHODS if method != "workspace.refresh"]
            for method in methods:
                marker = "blocked-" + method
                response = await call(method, marker)
                assert response.status_code == 200, response.text
                assert connector.counts[marker] == connector.legacy_calls[marker] == 1
            assert (await info())["route"] is None
            passed("bootstrap 503 leaves all 41 business methods usable over WebSocket without waiting for Mesh", methods=41)

            held = [pending(call("shell.exec", f"held-{index}", block=True)) for index in range(8)]
            async def eight_running():
                return sum(connector.started[f"held-{index}"] for index in range(8)) == 8
            await until(eight_running)
            gate.write_text("")
            await until(route_ready)
            assert (await info())["connection"] == base
            passed("Mesh bootstrap and registration recover while eight WebSocket business slots are occupied")
            queued = [pending(call("shell.exec", f"mesh-queued-{index}", block=True)) for index in range(4)]
            critical = [pending(call("interaction.respond", f"approval-{index}", block=True)) for index in range(3)]
            async def overlap():
                return len(connector.control.executor._tasks) == 15
            await until(overlap)
            assert connector.lanes == {"regular": 8, "critical": 2}
            assert all(connector.started[f"mesh-queued-{index}"] == 0 for index in range(4))
            connector.release.set()
            assert all(reply.status_code == 200 for reply in await asyncio.gather(*held, *queued, *critical))
            assert connector.peaks == {"regular": 8, "critical": 2}
            assert all(connector.counts[f"held-{index}"] == 1 for index in range(8))
            passed("mixed transports retain global 8+2 capacity and execute each held request once")
            assert (await call("fs.readText", "recovered-mesh")).status_code == 200
            assert not connector.legacy_calls["recovered-mesh"]
            passed("subsequent requests automatically use the published Mesh route")

            for fault in ("bootstrap404", "deny_mesh"):
                gate.write_text(fault)
                for link in tuple(connector.control._links):
                    await connector.control._close_link(link)
                async def absent():
                    return (await info())["route"] is None
                await until(absent)
                marker = "fault-" + fault
                assert (await call("fs.readText", marker)).status_code == 200
                assert connector.legacy_calls[marker] == connector.counts[marker] == 1
                assert (await info())["connection"] == base
                passed("base session remains usable during " + fault)

            large = "回退\\\"\n" * 200000
            written = await call("fs.writeFile", "real-write", realLocal=True, root=str(workspace), path="fallback.txt", content=large)
            assert written.status_code == 200, written.text
            actual = (workspace / "fallback.txt").read_bytes()
            assert actual == large.encode()
            read = await call("fs.prepareDownload", "real-hash", realLocal=True, root=str(workspace), path="fallback.txt")
            digest = hashlib.sha256(actual).hexdigest()
            assert read.json()["result"]["sha256"] == digest
            passed("fallback writes an encoded frame over 1 MiB and independent file/hash checks agree", bytes=len(actual), sha256=digest)
            shell = await call("shell.exec", "real-shell", realLocal=True, root=str(workspace), cwd=".",
                               command="printf FALLBACK_SHELL_OK", timeoutMs=3000)
            assert shell.status_code == 200 and "FALLBACK_SHELL_OK" in str(shell.json()["result"])
            passed("fallback executes the real Shell handler and returns process output")

            terminal = await call("terminal.create", "real-terminal", realLocal=True, root=str(workspace), cwd=".",
                                  terminalId="fallback-terminal", sessionId="probe-session", command="/bin/sh", args=["-i"])
            assert terminal.status_code == 200, terminal.text
            attached = await call("terminal.relay.connect", "real-relay", realLocal=True, terminalId="fallback-terminal")
            assert attached.status_code == 200, attached.text
            async def relay_output():
                for task in connector.relay_tasks:
                    if task.done():
                        task.result()
                state = (await http.get(urls[3] + "/probe/relay-result")).json()
                return state["ready"] and "FALLBACK_RELAY_OK" in state["output"]
            await until(relay_output)
            snapshot = await call("terminal.snapshot", "real-snapshot", realLocal=True, terminalId="fallback-terminal")
            assert "FALLBACK_RELAY_OK" in base64.b64decode(snapshot.json()["result"]["dataBase64"]).decode(errors="replace")
            passed("terminal create over fallback precedes a real PTY relay connection and persisted snapshot output")
            await connector.close_local()
            connector_task.cancel()
            await asyncio.gather(connector_task, return_exceptions=True)
            async def gone():
                return (await info())["connection"] is None
            await until(gone)

            gate.write_text("")
            connector = FunctionalConnector(urls[4], env["PROBE_TOKEN"], http, fallback_enabled=False)
            connector_task = asyncio.create_task(connector.run())
            await until(route_ready)
            for method in methods:
                marker = "legacy-" + method
                response = await call(method, marker)
                assert response.status_code == 200, response.text
                assert connector.legacy_calls[marker] == connector.counts[marker] == 1
            passed("old Mesh-capable peers remain WebSocket-primary even after their Mesh route is published", methods=41)
            oversized = await call("fs.writeFile", "old-too-large", text="x" * (1024 * 1024))
            assert oversized.status_code != 200 and connector.counts["old-too-large"] == 0
            assert (await call("fs.readText", "old-still-usable")).status_code == 200
            passed("old receiver budget rejects oversize before dispatch without poisoning later requests")
    finally:
        if connector_task is not None:
            connector_task.cancel()
            await asyncio.gather(connector_task, return_exceptions=True)
        if connector is not None:
            await connector.close_local()
        for task in requests:
            task.cancel()
        await asyncio.gather(*requests, return_exceptions=True)
        for process in reversed(processes):
            with contextlib.suppress(ProcessLookupError):
                process.terminate()
        for process in reversed(processes):
            try:
                await asyncio.wait_for(process.wait(), 15)
            except TimeoutError:
                process.kill()
                await process.wait()
        for log in logs:
            log.close()
        if redis is not None:
            keys = [key async for key in redis.scan_iter(prefix + ":*")]
            if keys:
                await redis.delete(*keys)
            await redis.aclose()
        (output / "results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--redis-url", default="")
    parser.add_argument("--output", required=True)
    asyncio.run(probe(parser.parse_args()))


if __name__ == "__main__":
    main()
