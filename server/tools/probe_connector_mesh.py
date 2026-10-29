"""Compare legacy WS and Mesh control over real Redis, Routers and API workers.

Run from server with PYTHONPATH=.:../connector and --redis-url pointing to a
disposable Redis. This probe uses synthetic auth/domain handlers, no database
or installed Connector ownership, and removes only its random Redis namespace.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import copy
import hashlib
import json
import os
import secrets
import socket
import subprocess
import sys
import time
from collections import Counter
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace

import httpx
import psutil
import uvicorn
import websockets
from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.server.mesh_transport import RemoteConnectorControl
from connector.server.rpc import ConnectorRpcChannel
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from meshcall import MeshCallError
from meshcall.transport import DEFAULT_MAX_FRAME_SIZE
from redis.asyncio import Redis
from redis.exceptions import RedisError
from websockets.exceptions import WebSocketException

from agent_server.api.connector_mesh import router as mesh_api
from agent_server.infra.connector_mesh import ConnectorMesh
from agent_server.infra.connector_mesh_contract import CONTROL_METHODS
from agent_server.infra.connector_mesh_control import MeshConnectorControlTransport
from agent_server.infra.connector_rpc import (
    ConnectorNotDispatchedError,
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)
from agent_server.infra.connector_session_auth import ConnectorSessionAuthorization
from agent_server.infra.mesh_router import ManagedRouter
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.websocket_limits import (
    CLIENT_WS_MAX_MESSAGE_BYTES,
    ControlWebSocketProtocol,
    allow_large_control_messages,
)


def create_probe_app() -> FastAPI:
    """Real transport composition; auth and business implementations are fixtures."""
    if os.environ.get("PROBE_GRANT_TTL"):
        from agent_server.api import connector_mesh as proxy_module
        from agent_server.infra import connector_mesh as mesh_module
        from agent_server.infra import connector_mesh_routes as routes_module

        # Short lifetimes are injected only into isolated probe processes.
        mesh_module.GRANT_TTL_SECONDS = int(os.environ["PROBE_GRANT_TTL"])
        routes_module.GRANT_TTL_SECONDS = int(os.environ["PROBE_GRANT_TTL"])
        proxy_module.ROUTE_RENEW_SECONDS = 1
    redis = RedisCoordinator(os.environ["PROBE_REDIS"] or None, prefix=os.environ["PROBE_PREFIX"])
    rpc = ConnectorRpcManager(redis)
    mesh = ConnectorMesh(rpc, redis, credential_loader=lambda identity: store.connector_credential_fingerprint(identity))
    rpc.bind_request_transport(MeshConnectorControlTransport(mesh, rpc))
    connector_id, token = os.environ["PROBE_CONNECTOR"], os.environ["PROBE_TOKEN"]

    class Store:
        def __init__(self):
            self.fingerprint_reads = 0
            self.fingerprint = hashlib.sha256(token.encode()).hexdigest()

        async def authenticate_connector_access(self, candidate):
            fingerprint = await self.connector_credential_fingerprint(connector_id)
            return connector_id if candidate == token and fingerprint == hashlib.sha256(token.encode()).hexdigest() else None

        def connector_lifecycle(self, identity):
            return rpc.lifecycle_guard(identity)

        async def connector_credential_fingerprint(self, identity):
            self.fingerprint_reads += 1
            if redis.distributed and await redis.client.get(redis.key("probe-revoked")):
                return ""
            if redis.distributed:
                replacement = await redis.client.get(redis.key("probe-fingerprint"))
                if replacement:
                    return replacement
            return self.fingerprint if identity == connector_id else ""

    store = Store()

    @asynccontextmanager
    async def lifespan(app):
        await redis.start()
        await rpc.start()
        await mesh.credentials.start()
        try:
            yield
        finally:
            await mesh.close()
            await rpc.close()
            await redis.close()

    app = FastAPI(lifespan=lifespan)
    app.state.store, app.state.rpc, app.state.connector_mesh = store, rpc, mesh
    app.include_router(mesh_api, prefix="/api/v2")

    @app.middleware("http")
    async def bootstrap_failure(request: Request, call_next):
        gate_path = os.environ.get("PROBE_MESH_GATE_FILE")
        gate = Path(gate_path).read_text() if gate_path and Path(gate_path).exists() else ""
        if request.url.path.endswith("/connector/mesh/bootstrap") and gate in {"bootstrap404", "bootstrap503"}:
            return JSONResponse({"detail": "injected bootstrap failure"}, status_code=int(gate[-3:]))
        if request.url.path.endswith("/connector/mesh/status") and gate == 'status_html':
            return Response('<html>injected status response</html>', status_code=200, media_type='text/html')
        if (request.url.path.endswith("/connector/mesh/bootstrap") and redis.distributed
                and await redis.client.get(redis.key("probe-bootstrap-fail"))):
            return JSONResponse({"detail": "injected admission failure"}, status_code=503)
        if request.url.path.endswith("/connector/mesh/status") and redis.distributed:
            keep_link = await redis.client.get(redis.key("probe-status-fail-except"))
            if keep_link:
                candidate = await mesh.grant(request.headers.get("authorization", "").removeprefix("Bearer "))
                if candidate and candidate["linkId"] != keep_link:
                    await redis.client.incr(redis.key("probe-status-fail-count"))
                    return JSONResponse({"detail": "injected publication confirmation failure"}, status_code=503)
        return await call_next(request)

    @app.get("/probe/info")
    async def info():
        route = await mesh.routes.get(connector_id)
        return {"worker": rpc.instance_id, "pid": os.getpid(), "router": mesh.router_id,
                "route": json.loads(route.encoded()) if route else None,
                "connection": await rpc.current_connection_id(connector_id),
                "credentialQueries": store.fingerprint_reads}

    @app.get("/probe/redis-health")
    async def redis_health():
        try:
            await redis.ping(timeout_seconds=0.3)
            return {"ready": True}
        except (RedisError, ConnectionError, TimeoutError):
            return JSONResponse({"ready": False}, status_code=503)

    @app.post("/probe/expire-grants")
    async def expire_grants():
        if redis.distributed:
            keys = [key async for key in redis.client.scan_iter(redis.key("mesh-grant", "*"))]
            for key in keys:
                grant = json.loads(await redis.client.get(key))
                grant["expiresAt"] = time.time() - 1
                await redis.client.set(key, json.dumps(grant), ex=900)
        else:
            for grant in mesh.local_grants.values():
                grant["expiresAt"] = time.time() - 1
        return {"expired": True}

    @app.post("/probe/disconnect")
    async def disconnect():
        await rpc.disconnect(connector_id, reason="probe connection replacement")
        return {"disconnected": True}

    @app.post("/probe/credential/{action}")
    async def credential(action: str):
        if redis.distributed:
            if action == "revoke":
                await redis.client.set(redis.key("probe-revoked"), "1", ex=60)
            elif action == "rotate":
                await redis.client.set(redis.key("probe-fingerprint"), secrets.token_hex(32), ex=60)
            else:
                await redis.client.delete(redis.key("probe-revoked"), redis.key("probe-fingerprint"))
        else:
            store.fingerprint = ("" if action == "revoke" else secrets.token_hex(32) if action == "rotate"
                                 else hashlib.sha256(token.encode()).hexdigest())
        await mesh.credentials.invalidate(connector_id)
        return {"revoked": action == "revoke"}

    relay_result = {"ready": False, "output": ""}

    @app.get("/probe/relay-result")
    async def relay_status():
        return relay_result

    @app.websocket("/api/v2/connector/terminals/{terminal_id}/relay")
    async def terminal_relay(ws: WebSocket, terminal_id: str):
        if ws.query_params.get("token") != token:
            await ws.close(code=1008)
            return
        await ws.accept()
        await ws.send_json({"type": "start", "mode": "attach", "terminalId": terminal_id, "sessionId": "probe-session"})
        try:
            while True:
                frame = await ws.receive_json()
                if frame.get("type") == "ready":
                    relay_result["ready"] = True
                    await ws.send_json({"type": "input", "requestId": "relay-input", "data": base64.b64encode(
                        b"printf '%s%s\\n' 'FALLBACK_' 'RELAY_OK'\n").decode()})
                if frame.get("type") in {"replay", "output"}:
                    relay_result["output"] += base64.b64decode(frame.get("data") or "").decode(errors="replace")
        except (WebSocketDisconnect, RuntimeError):
            pass

    @app.post("/probe/stale-route")
    async def stale_route(request: Request):
        from agent_server.infra.connector_mesh_routes import MeshRoute
        stale = MeshRoute.decode(json.dumps(await request.json()))
        assert stale is not None
        await mesh.routes.remove(stale)
        return {"published": await mesh.routes.publish(stale)}

    @app.post("/probe/remove-route")
    async def remove_route(request: Request):
        from agent_server.infra.connector_mesh_routes import MeshRoute
        route = MeshRoute.decode(json.dumps(await request.json()))
        assert route is not None and route.connector_id == connector_id
        await mesh.routes.remove(route)
        return {"connection": await rpc.current_connection_id(connector_id)}

    @app.websocket("/api/v2/connector/ws")
    async def base_socket(ws: WebSocket):
        fingerprint = await store.connector_credential_fingerprint(connector_id)
        if (ws.headers.get("authorization") != f"Bearer {token}"
                or fingerprint != hashlib.sha256(token.encode()).hexdigest()):
            await ws.close(code=1008)
            return
        if (ws.headers.get("x-aa-control-transport") == "meshcall/1.0"
                and ws.headers.get("x-aa-control-fallback") == "websocket/1.0"):
            allow_large_control_messages(ws.scope)
        await ws.accept()
        connection = await rpc.register(connector_id, ws,
                                        mesh_capable=ws.headers.get("x-aa-control-transport") == "meshcall/1.0",
                                        control_fallback_capable=ws.headers.get("x-aa-control-fallback") == "websocket/1.0")
        authorization = ConnectorSessionAuthorization(
            connector_id, connection.connection_id, hashlib.sha256(fingerprint.encode()).hexdigest(), mesh.credentials,
            lambda: rpc.is_connection_id_current(connector_id, connection.connection_id),
            lambda: rpc._disconnect_local(connector_id, expected_connection_id=connection.connection_id,
                                          reason="probe authorization changed"))
        connection.authorize_control = authorization.valid
        authorization.start()
        try:
            while True:
                message = await ws.receive_json()
                if not await rpc.touch(connector_id, connection):
                    return
                if message.get("type") == "response":
                    rpc.resolve_response(connector_id, message, connection=connection)
        finally:
            await authorization.close()
            await rpc.unregister(connector_id, connection)

    @app.post("/probe/{transport}/{method}")
    async def call(transport: str, method: str, request: Request):
        body = await request.json()
        params, timeout = body.get("params", {}), body.get("timeout", 10)
        try:
            if transport == "mesh":
                result = await rpc.request(connector_id, method, params, timeout=timeout)
            elif transport == "mesh-stale":
                from agent_server.infra.connector_mesh_routes import MeshRoute

                stale = MeshRoute.decode(json.dumps(body["staleRoute"]))
                assert stale is not None and stale.router_id == mesh.router_id
                forwarding = MeshConnectorControlTransport(mesh, rpc)
                local_call = forwarding._call_local
                first, rejections = True, []

                async def raced_call(route, *args):
                    nonlocal first
                    selected, first = (stale if first else route), False
                    try:
                        return await local_call(selected, *args)
                    except ConnectorNotDispatchedError as error:
                        rejections.append((error.__cause__.details or {}).get("reason"))
                        raise

                # Inject a route-read/dispatch race on this request only. The
                # production selector must reject the stale link and fall back once.
                forwarding._call_local = raced_call
                selector = copy.copy(rpc)  # Per-request transport, shared owner/relay state.
                selector.bind_request_transport(forwarding)
                result, _ = await selector.request_bound(connector_id, method, params, timeout=timeout)
                return {"result": result, "staleRejections": rejections}
            elif transport == "legacy":
                # The unmodified legacy last hop and cross-worker owner route.
                connection = rpc._connections.get(connector_id)
                if connection is not None:
                    result = await rpc._request_local(connection, method, params, timeout=timeout)
                else:
                    lease = await rpc._get_lease(connector_id)
                    if lease is None:
                        raise HTTPException(409, "connector offline")
                    result = await rpc._route(lease, {
                        "type": "request", "connectorId": connector_id,
                        "method": method, "params": params, "timeout": timeout,
                    }, timeout=timeout)
            else:
                raise HTTPException(404)
            return {"result": result}
        except (ConnectorOfflineError, ConnectorRpcError, TimeoutError, RedisError, HTTPException) as error:
            return JSONResponse({"error": getattr(error, "code", type(error).__name__),
                                 "details": getattr(error, "details", None)}, status_code=502)

    return app


def create_front_app() -> FastAPI:
    """An intentionally non-sticky load balancer for the four transport entrypoints."""
    urls = json.loads(os.environ["PROBE_URLS"])
    app = FastAPI()

    def target(path):
        if path.endswith("/connector/ws"):
            return urls[0]
        if path.endswith("/bootstrap"):
            return urls[1]
        if path.endswith("/connector/mesh"):
            return urls[2]
        return urls[3]

    @app.api_route("/{path:path}", methods=["GET", "POST"])
    async def http_proxy(path: str, request: Request):
        headers = {key: value for key, value in request.headers.items()
                   if key.lower() not in {"host", "connection", "content-length"}}
        async with httpx.AsyncClient(timeout=40, trust_env=False) as client:
            response = await client.request(request.method, target(path) + "/" + path,
                                            params=request.query_params, headers=headers,
                                            content=await request.body())
        return Response(response.content, status_code=response.status_code,
                        media_type=response.headers.get("content-type"))

    @app.websocket("/{path:path}")
    async def ws_proxy(path: str, ws: WebSocket):
        gate_path = os.environ.get("PROBE_MESH_GATE_FILE")
        if (path.endswith("/connector/mesh") and gate_path and Path(gate_path).exists()
                and Path(gate_path).read_text() == "deny_mesh"):
            await ws.close(code=1008)
            return
        headers = {"Authorization": ws.headers.get("authorization", "")}
        fallback = ws.headers.get("x-aa-control-fallback")
        if fallback:
            headers["X-AA-Control-Fallback"] = fallback
        capability = ws.headers.get("x-aa-control-transport")
        if capability:
            headers["X-AA-Control-Transport"] = capability
        try:
            query = "?" + ws.url.query if ws.url.query else ""
            async with websockets.connect(target(path).replace("http:", "ws:") + "/" + path + query,
                                          additional_headers=headers, proxy=None,
                                          max_size=DEFAULT_MAX_FRAME_SIZE) as remote:
                await ws.accept()

                async def incoming():
                    while True:
                        frame = await ws.receive()
                        if frame["type"] == "websocket.disconnect":
                            return
                        await remote.send(frame.get("bytes") if frame.get("bytes") is not None else frame["text"])

                async def outgoing():
                    async for frame in remote:
                        if isinstance(frame, bytes):
                            await ws.send_bytes(frame)
                        else:
                            await ws.send_text(frame)

                tasks = [asyncio.create_task(incoming()), asyncio.create_task(outgoing())]
                try:
                    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            with contextlib.suppress(Exception):
                await ws.close()

    return app


class ProbeConnector:
    def __init__(self, url: str, token: str, http: httpx.AsyncClient, *, mesh_enabled=True, fallback_enabled=True):
        self.url, self.token, self.http = url, token, http
        self.mesh_enabled, self.fallback_enabled = mesh_enabled, fallback_enabled
        self.counts: Counter = Counter()
        self.started: Counter = Counter()
        self.finished: Counter = Counter()
        self.cancelled: Counter = Counter()
        self.active: Counter = Counter()
        self.peak: Counter = Counter()
        self.legacy_calls: Counter = Counter()
        self.release = asyncio.Event()
        self.backend = SimpleNamespace(
            config=SimpleNamespace(server_url=url, connector_id=os.environ["PROBE_CONNECTOR"]),
            _get_http_client=lambda: http, _dispatcher=SimpleNamespace(dispatch=self.dispatch),
            ensure_access_token=self.access_token, _mesh_connection_token="",
        )
        self.control = RemoteConnectorControl(self.backend)

    async def access_token(self, **kwargs):
        return self.token

    async def dispatch(self, method, params):
        marker = params.get("marker", "")
        self.counts[marker] += 1
        self.started[marker] += 1
        self.active[marker] += 1
        self.peak[marker] = max(self.peak[marker], self.active[marker])
        try:
            return await self._dispatch(method, params)
        finally:
            self.active[marker] -= 1

    async def _dispatch(self, method, params):
        marker = params.get("marker", "")
        if params.get("block"):
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                self.cancelled[marker] += 1
                raise
        if params.get("delay"):
            await asyncio.sleep(params["delay"])
        if params.get("fail"):
            raise RuntimeInvalidRequestError("probe-error")
        if params.get("missing"):
            raise FileNotFoundError("probe-missing")
        if params.get("domainCode"):
            raise MeshCallError(params["domainCode"], "probe domain error")
        self.finished[marker] += 1
        return {"method": method, "params": params,
                **({"ok": False, "accepted": False} if params.get("refuse") else {})}

    async def run(self):
        while True:
            tasks = []
            channel = ConnectorRpcChannel()
            self.backend._mesh_connection_token = secrets.token_urlsafe(24)
            self.control.executor.open_session(self.dispatch, self.backend._mesh_connection_token)
            try:
                async with websockets.connect(self.url.replace("http:", "ws:") + "/api/v2/connector/ws",
                                              additional_headers={"Authorization": f"Bearer {self.token}",
                                                                  **({"X-AA-Control-Transport": "meshcall/1.0"}
                                                                     if self.mesh_enabled else {}),
                                                                  **({"X-AA-Control-Fallback": "websocket/1.0"}
                                                                     if self.mesh_enabled and self.fallback_enabled else {})},
                                              proxy=None, max_size=DEFAULT_MAX_FRAME_SIZE) as ws:
                    channel.set_connection(ws, executor=self.control.executor,
                                           generation=self.backend._mesh_connection_token,
                                           business_methods=frozenset(CONTROL_METHODS) - {"workspace.refresh"})

                    async def dispatch(method, params):
                        if method == "connector.mesh.connection":
                            return {"connectionToken": self.backend._mesh_connection_token}
                        return await self.dispatch(method, params)

                    async def reader(channel=channel, ws=ws, dispatch=dispatch):
                        async for frame in ws:
                            message = json.loads(frame)
                            if message.get("method") != "connector.mesh.connection":
                                self.legacy_calls[message.get("params", {}).get("marker", "")] += 1
                            channel.start_request(message, dispatch)

                    async def heartbeat(channel=channel):
                        while True:
                            await channel.send_notification("connector.heartbeat", {})
                            await asyncio.sleep(1)

                    tasks = [asyncio.create_task(reader()), asyncio.create_task(heartbeat())]
                    if self.mesh_enabled:
                        tasks.append(asyncio.create_task(self.control.run()))
                    await asyncio.wait(tasks[:2], return_when=asyncio.FIRST_COMPLETED)
            except asyncio.CancelledError:
                raise
            except (OSError, ConnectionError, WebSocketException):
                await asyncio.sleep(0.3)
            finally:
                await self.control.executor.close_session()
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                await channel.close_connection()


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def until(check, *, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = await check()
            if result:
                return result
        except (httpx.HTTPError, OSError):
            pass
        await asyncio.sleep(0.1)
    raise TimeoutError("probe condition did not become ready")


async def probe(args):
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    prefix = "aa441-probe-" + secrets.token_hex(8)
    os.environ["PROBE_CONNECTOR"] = "probe-" + secrets.token_hex(8)
    env = dict(os.environ, PROBE_PREFIX=prefix, PROBE_REDIS=args.redis_url,
               PROBE_TOKEN=secrets.token_urlsafe(24))
    processes, logs = [], []
    redis = Redis.from_url(args.redis_url, decode_responses=True) if args.redis_url else None
    results = []
    connector_task = None
    requests = []

    def request(coroutine):
        task = asyncio.create_task(coroutine)
        requests.append(task)
        return task

    async def saturated(marker, limit, admitted, pending):
        async def check():
            assert connector.started[marker] <= limit, (marker, dict(connector.started))
            for task in pending:
                if task.done():
                    response = task.result()
                    raise AssertionError(f"{marker}: queued request ended before release: HTTP {response.status_code}")
            return connector.started[marker] == limit and len(connector.control.executor._tasks) == admitted
        # Arrival is scheduler/network dependent. Observe actual admission while
        # blocked handlers make exceeding the concurrency limit deterministic.
        await until(check, timeout=10)

    def start(port, *, front=False, workers=1):
        log = (output / f"process-{port}.log").open("w")
        logs.append(log)
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--serve", "--port", str(port),
             "--workers", str(workers), *(["--front"] if front else [])],
            env=env, stdout=log, stderr=subprocess.STDOUT,
        )
        processes.append(process)
        return process

    try:
        ports = [free_port() for _ in range(2 if args.single_process else 5)]
        urls = [f"http://127.0.0.1:{port}" for port in ports]
        if args.single_process:
            urls = [urls[0]] * 4 + [urls[1]]
        for index, port in enumerate(ports[:-1]):
            start(port, workers=2 if index in (0, 2) and not args.single_process else 1)
        env["PROBE_URLS"] = json.dumps(urls[:4])
        start(ports[-1], front=True)
        async with httpx.AsyncClient(timeout=35, trust_env=False, limits=httpx.Limits(max_connections=80)) as http:
            for url in urls[:4]:
                async def healthy(url=url):
                    return (await http.get(url + "/api/v2/health/mesh", timeout=1)).status_code == 200
                await until(healthy)
            connector = ProbeConnector(urls[4], env["PROBE_TOKEN"], http)
            connector_task = asyncio.create_task(connector.run())

            async def ready():
                response = await http.get(urls[4] + "/probe/info", timeout=1)
                return response.json().get("route")

            route = await until(ready)
            results.append({"scenario": "single process without Redis" if args.single_process else
                            "four separated entrypoints; first Server has two workers", "passed": True})

            async def call(method, params, *, transport="mesh", timeout=10):
                return await http.post(urls[4] + f"/probe/{transport}/{method}",
                                       json={"params": params, "timeout": timeout})

            for method in CONTROL_METHODS:
                if method == "workspace.refresh":
                    continue
                params = {"marker": method, "value": [None, False, 0, "", "中文\\\"😀"]}
                old = await call(method, params, transport="legacy")
                new = await call(method, params)
                assert old.status_code == new.status_code == 200, (method, old.text, new.text)
                assert old.json() == new.json(), method
                assert connector.legacy_calls[method] == 1, "negotiated Mesh call fell back to legacy"
                for sample in ({"refuse": True}, {"fail": True}, {"missing": True},
                               {"domainCode": "unavailable"}, {"domainCode": "deadline_exceeded"}):
                    old = await call(method, sample, transport="legacy")
                    new = await call(method, sample)
                    assert old.status_code == new.status_code, method
                    if "error" in old.json():
                        assert old.json()["error"] == new.json()["error"], method
                    else:
                        assert old.json() == new.json(), method
            results.append({"scenario": "41 mappings: legacy WS versus Mesh, synthetic domain", "passed": True})

            for params, code in [({"fail": True}, "runtime_invalid_request"),
                                 ({"missing": True}, "FileNotFoundError")]:
                old, new = await call("fs.readText", params, transport="legacy"), await call("fs.readText", params)
                assert old.json()["error"] == new.json()["error"] == code, (old.text, new.text)
            assert (await call("session.send_message", {"refuse": True})).json()["result"]["ok"] is False
            results.append({"scenario": "business refusal and exception codes preserved", "passed": True})

            waiting = [request(call("shell.exec", {"block": True, "marker": "queue"}))
                       for _ in range(40)]
            await saturated("queue", 8, 40, waiting)
            critical = await call("interaction.respond", {"marker": "critical"}, timeout=2)
            assert critical.status_code == 200, critical.text
            assert connector.started["queue"] == 8
            critical_waiting = [request(call("interaction.respond", {"block": True, "marker": "critical-queue"}))
                                for _ in range(3)]
            await saturated("critical-queue", 2, 43, critical_waiting)
            connector.release.set()
            responses = await asyncio.gather(*waiting, *critical_waiting)
            assert all(response.status_code == 200 for response in responses)
            assert connector.peak["queue"] == 8 and connector.peak["critical-queue"] == 2
            results.append({"scenario": "40 queued calls, 8 regular slots, independent critical slots", "passed": True,
                            "regularPeak": connector.peak["queue"], "criticalPeak": connector.peak["critical-queue"]})

            connector.release.clear()
            pending = request(call("shell.exec", {"block": True, "marker": "deadline"}, timeout=2))
            async def deadline_dispatched():
                return connector.started["deadline"] == 1
            await until(deadline_dispatched, timeout=2)
            response = await pending
            assert response.status_code == 502, response.text
            assert connector.finished["deadline"] == 0
            connector.release.set()
            async def deadline_finished():
                return connector.finished["deadline"] == 1
            await until(deadline_finished)
            assert connector.counts["deadline"] == connector.finished["deadline"] == 1
            assert connector.legacy_calls["deadline"] == 0
            results.append({"scenario": "caller deadline: completes once without replay", "passed": True})

            for content in ["a" * (4 * 1024 * 1024), "\x01" * (2 * 1024 * 1024)]:
                response = await call("fs.readText", {"content": content}, timeout=20)
                assert response.status_code == 200, response.text[:200]
                assert response.json()["result"]["params"]["content"] == content
            results.append({"scenario": "4 MiB text and 12 MiB escaped JSON through all hops", "passed": True})
            oversized = await call("fs.writeFile", {"content": "a" * (DEFAULT_MAX_FRAME_SIZE + 1024),
                                                   "marker": "oversized"}, timeout=20)
            assert oversized.status_code != 200 and connector.counts["oversized"] == 0
            assert (await call("fs.readText", {"marker": "after-oversized"})).status_code == 200
            results.append({"scenario": "oversized frame rejected before dispatch; following normal call succeeds", "passed": True})

            if not args.single_process:
                async def owner_process():
                    info = (await http.get(urls[2] + "/probe/info")).json()
                    return info["pid"] if info["worker"] == route["worker_id"] else None
                owner_pid = await until(owner_process)
                assert owner_pid in {child.pid for child in psutil.Process(processes[2].pid).children()}
                pending = request(call("shell.exec", {"delay": 0.6, "marker": "worker-exit"}, timeout=2))
                async def worker_dispatched():
                    return connector.started["worker-exit"] == 1
                await until(worker_dispatched)
                psutil.Process(owner_pid).kill()
                assert (await pending).status_code == 502
                await asyncio.sleep(0.8)
                assert connector.counts["worker-exit"] == connector.finished["worker-exit"] == 1
                previous = route
                async def worker_recovered():
                    current = await ready()
                    return current if current and current["link_id"] != previous["link_id"] else None
                route = await until(worker_recovered, timeout=75)
                assert route["worker_id"] != previous["worker_id"]
                assert (await call("fs.readText", {"marker": "worker-restored"})).status_code == 200
                results.append({"scenario": "target API worker killed after dispatch; no replay; lease and link recovery", "passed": True})

            pending = request(call("shell.exec", {"delay": 0.6, "marker": "lost-response"}, timeout=2))
            async def dispatched():
                return connector.started["lost-response"] == 1
            await until(dispatched)
            children = psutil.Process(processes[0 if args.single_process else 2].pid).children(recursive=True)
            routers = [child for child in children if "meshcall-router" in child.name()]
            assert len(routers) == 1
            routers[0].kill()
            failed = await pending
            assert failed.status_code == 502, failed.text
            await asyncio.sleep(0.8)
            assert connector.counts["lost-response"] == connector.finished["lost-response"] == 1
            assert connector.legacy_calls["lost-response"] == 0
            async def recovered():
                current = await ready()
                return current if current and current["link_id"] != route["link_id"] else None
            route = await until(recovered, timeout=30)
            assert (await call("fs.readText", {"marker": "recovery"})).status_code == 200
            results.append({"scenario": "Router exit, lost response, bootstrap and route recovery", "passed": True})

            old_route = route
            await http.post(urls[2] + "/probe/expire-grants")
            async def refreshed():
                current = await ready()
                return current if current and current["link_id"] != old_route["link_id"] else None
            route = await until(refreshed)
            results.append({"scenario": "proxy authorization expiry and refresh", "passed": True})

            connector.release.clear()
            queued = [request(call("shell.exec", {"block": True, "marker": "disconnect"}))
                      for _ in range(9)]
            async def running():
                return connector.started["disconnect"] == 8
            await until(running)
            await http.post(urls[3] + "/probe/disconnect")
            failures = await asyncio.gather(*queued)
            assert all(response.status_code != 200 for response in failures)
            async def reconnected():
                current = await ready()
                return current if current and current["connection_id"] != route["connection_id"] else None
            replacement = await until(reconnected)
            assert connector.cancelled["disconnect"] == 8
            assert connector.finished["disconnect"] == 0
            stale = await http.post(urls[2] + "/probe/stale-route", json=route)
            assert stale.json()["published"] is False
            assert (await ready())["link_id"] == replacement["link_id"]
            connector.release.set()
            results.append({"scenario": "base disconnect cancels old queue; stale route cannot overwrite replacement", "passed": True})

            if args.redis_container:
                await asyncio.to_thread(subprocess.run, ["docker", "pause", args.redis_container],
                                        check=True, capture_output=True)
                try:
                    response = await http.get(urls[3] + "/probe/redis-health")
                    assert response.status_code == 503
                finally:
                    await asyncio.to_thread(subprocess.run, ["docker", "unpause", args.redis_container],
                                            check=True, capture_output=True)
                assert (await http.get(urls[3] + "/probe/redis-health")).status_code == 200
                assert (await call("fs.readText", {"marker": "redis-restored"})).status_code == 200
                results.append({"scenario": "dedicated Redis pause and restore", "passed": True})

            if redis is not None:
                await http.post(urls[3] + "/probe/credential/revoke")
                try:
                    async def revoked():
                        return not await ready()
                    await until(revoked)
                    response = await call("fs.writeFile", {"marker": "revoked"}, timeout=0.2)
                    assert response.status_code != 200 and connector.counts["revoked"] == 0
                finally:
                    await http.post(urls[3] + "/probe/credential/restore")
                await until(ready)
                assert (await call("fs.readText", {"marker": "credential-restored"})).status_code == 200
                results.append({"scenario": "credential revocation removes link, blocks dispatch and recovers after restore", "passed": True})

            previous = (await ready())["connection_id"]
            connector_task.cancel()
            await asyncio.gather(connector_task, return_exceptions=True)
            connector = ProbeConnector(urls[4], env["PROBE_TOKEN"], http, mesh_enabled=False)
            connector_task = asyncio.create_task(connector.run())
            async def legacy_ready():
                current = (await http.get(urls[4] + "/probe/info")).json()
                return current.get("connection") and current["connection"] != previous
            await until(legacy_ready)
            response = await call("fs.readText", {"marker": "legacy-capability"})
            assert response.status_code == 200, response.text
            assert connector.legacy_calls["legacy-capability"] == 1
            results.append({"scenario": "legacy Connector without Mesh capability remains routable", "passed": True})
    finally:
        for task in requests:
            if not task.done():
                task.cancel()
        await asyncio.gather(*requests, return_exceptions=True)
        if connector_task:
            connector_task.cancel()
            await asyncio.gather(connector_task, return_exceptions=True)
        for process in reversed(processes):
            process.terminate()
        for process in reversed(processes):
            try:
                await asyncio.to_thread(process.wait, 15)
            except subprocess.TimeoutExpired:
                process.kill()
                await asyncio.to_thread(process.wait)
        for log in logs:
            log.close()
        if redis is not None:
            keys = [key async for key in redis.scan_iter(prefix + ":*")]
            if keys:
                await redis.delete(*keys)
            await redis.aclose()
        (output / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print(json.dumps(results, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--redis-url")
    parser.add_argument("--single-process", action="store_true", help="Check the no-Redis single-process fallback")
    parser.add_argument("--redis-container", help="Dedicated QA container only; pauses it during the fault probe")
    parser.add_argument("--output", default="../.local-dev/mesh-parity-probe")
    parser.add_argument("--serve", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--front", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--port", type=int)
    parser.add_argument("--workers", type=int, default=1)
    args = parser.parse_args()
    if args.serve:
        factory = "tools.probe_connector_mesh:create_front_app" if args.front else "tools.probe_connector_mesh:create_probe_app"
        if args.front:
            uvicorn.run(factory, factory=True, host="127.0.0.1", port=args.port, access_log=False,
                        ws_max_size=DEFAULT_MAX_FRAME_SIZE)
        else:
            with ManagedRouter():
                uvicorn.run(factory, factory=True, host="127.0.0.1", port=args.port, workers=args.workers,
                            access_log=False, ws=ControlWebSocketProtocol, ws_max_size=CLIENT_WS_MAX_MESSAGE_BYTES)
    elif args.redis_url or args.single_process:
        args.redis_url = args.redis_url or ""
        asyncio.run(probe(args))
    else:
        parser.error("--redis-url is required")


if __name__ == "__main__":
    main()
