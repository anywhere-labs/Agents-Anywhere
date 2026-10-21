"""The Connector's local MeshCall Router.

Every Connector process that serves local RPC owns one Go Router on a private
endpoint: a Unix socket under ``~/.agents-anywhere/router`` or, on Windows, a
named pipe. The Router exits with this process (it watches its stdin), and a
Router that dies on its own is restarted on the same endpoint with the same
keys, so MeshCall's reconnects bring every peer back.

The Router's auth file holds one random API key per role, regenerated for each
process and limited to what that role needs (see ``ROLE_PERMISSIONS``). The
``host`` key goes to the process that launched ``anywhere-cli rpc`` on stdout;
the ``dsh-bridge`` key is published in a 0600 file while a DSH runtime runs.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import secrets
import socket
import sys
import tempfile
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from meshcall import LocalRouter, Mesh, RouterCredentials, RunningServer

from connector.core import runtime_owner
from connector.logging import logger

CONTROL_SERVICE = "aa.local.v2.Control"
LOGS_SERVICE = "aa.local.v2.Logs"
DSH_SYNC_SERVICE = "aa.dsh.v2.Sync"
DSH_BRIDGE_SERVICE = "aa.dsh.v2.Bridge"
REGISTRY_SERVICE = "meshcall.router.v1.Registry"

HOST_ROLE = "host"
CONNECTOR_ROLE = "connector"
DSH_BRIDGE_ROLE = "dsh-bridge"

# register: services the role may serve; call: service/method rules.
ROLE_PERMISSIONS: dict[str, dict[str, list[str]]] = {
    CONNECTOR_ROLE: {
        "register": [CONTROL_SERVICE, LOGS_SERVICE, DSH_SYNC_SERVICE],
        "call": [f"{DSH_BRIDGE_SERVICE}/*", f"{REGISTRY_SERVICE}/*"],
    },
    # The Registry lets `meshcall router inspect` / `call` describe the services.
    HOST_ROLE: {
        "register": [],
        "call": [f"{CONTROL_SERVICE}/*", f"{LOGS_SERVICE}/*", f"{REGISTRY_SERVICE}/*"],
    },
    DSH_BRIDGE_ROLE: {
        "register": [DSH_BRIDGE_SERVICE],
        "call": [f"{DSH_SYNC_SERVICE}/*", *[f"{LOGS_SERVICE}/{method}" for method in ("write", "read", "tail")]],
    },
}

_UNIX_PATH_LIMIT = 103
_RESTART_DELAY = 1.0
_WATCH_INTERVAL = 1.0


@dataclass(frozen=True)
class LocalEndpoint:
    """Where the Router listens: exactly one of a Unix socket or a named pipe."""

    unix_path: Path | None = None
    pipe: str | None = None

    def to_json(self) -> dict[str, str]:
        if self.pipe is not None:
            return {"pipe": self.pipe}
        return {"unixPath": str(self.unix_path)}

    def router_options(self) -> dict[str, Any]:
        if self.pipe is not None:
            return {"pipe": self.pipe}
        return {"unix_path": self.unix_path}


def router_directory() -> Path:
    return runtime_owner.system_home() / ".agents-anywhere" / "router"


def _api_key(role: str) -> tuple[str, str]:
    """A MeshCall API key (``mk_<id>_<secret>``) and the digest the Router stores."""
    key_id = role.replace("_", "-")
    key = f"mk_{key_id}_{secrets.token_hex(32)}"
    return key, hashlib.sha256(key.encode()).hexdigest()


def _private_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    if sys.platform != "win32":
        path.chmod(0o700)
    return path


def _socket_live(path: Path) -> bool:
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    probe.settimeout(0.2)
    try:
        probe.connect(str(path))
    except OSError:
        return False
    finally:
        probe.close()
    return True


def sweep_stale_sockets(directory: Path) -> None:
    """Remove sockets left by Routers that died without unlinking them."""
    for candidate in directory.glob("*.sock"):
        if not _socket_live(candidate):
            with contextlib.suppress(OSError):
                candidate.unlink()


def write_private_json(path: Path, payload: dict[str, Any]) -> None:
    """Atomically replace ``path`` with ``payload``, readable by this user only."""
    _private_directory(path.parent)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.replace(temporary, path)
    except BaseException:
        with contextlib.suppress(OSError):
            temporary.unlink()
        raise


async def run_on_loop[T](loop: asyncio.AbstractEventLoop, work: Coroutine[Any, Any, T]) -> T:
    """Run ``work`` on the Connector's loop from a MeshCall handler.

    MeshCall runs handlers on its own service worker loop; the Connector's
    state, tasks and subprocesses belong to the loop that created them.
    Cancelling the call cancels the work.
    """
    future = asyncio.run_coroutine_threadsafe(work, loop)
    try:
        return await asyncio.wrap_future(future)
    except asyncio.CancelledError:
        future.cancel()
        raise


class LocalHub:
    """One Router and one Mesh per Connector process, with per-role API keys."""

    def __init__(self, directory: Path | None = None) -> None:
        self.instance_id = secrets.token_hex(8)
        self.directory = directory if directory is not None else router_directory()
        self._keys = {role: _api_key(role) for role in ROLE_PERMISSIONS}
        self.endpoint = self._endpoint()
        self.router: LocalRouter | None = None
        self.mesh: Mesh | None = None
        self._serve: Any = None
        self._server: RunningServer | None = None
        self._services: list[object] = []
        self._supervisor: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        self._stopping = False
        self._cleanups: list[Callable[[], Awaitable[None]]] = []

    def _endpoint(self) -> LocalEndpoint:
        if sys.platform == "win32":
            return LocalEndpoint(pipe=f"agents-anywhere-{self.instance_id}")
        path = self.directory / f"{self.instance_id}.sock"
        if len(str(path.absolute()).encode()) > _UNIX_PATH_LIMIT:
            self.directory = Path(tempfile.gettempdir()) / f"agents-anywhere-{os.getuid()}"
            path = self.directory / f"{self.instance_id}.sock"
        return LocalEndpoint(unix_path=path)

    @property
    def running(self) -> bool:
        return self.router is not None and self.router.is_running

    def key(self, role: str) -> str:
        return self._keys[role][0]

    def credentials(self, role: str = CONNECTOR_ROLE) -> RouterCredentials:
        return RouterCredentials.bearer(self.key(role))

    def auth_document(self) -> dict[str, Any]:
        return {
            "api_keys": [
                {
                    "id": role.replace("_", "-"),
                    "key_hash": digest,
                    "roles": ["client", "server"] if ROLE_PERMISSIONS[role]["register"] else ["client"],
                    "register": ROLE_PERMISSIONS[role]["register"],
                    "call": ROLE_PERMISSIONS[role]["call"],
                }
                for role, (_key, digest) in self._keys.items()
            ]
        }

    def descriptor(self, role: str) -> dict[str, Any]:
        """What a peer needs to reach this Router as ``role``."""
        return {
            "instanceId": self.instance_id,
            "pid": os.getpid(),
            "endpoint": self.endpoint.to_json(),
            "key": self.key(role),
        }

    def on_stop(self, cleanup: Callable[[], Awaitable[None]]) -> None:
        """Run ``cleanup`` before the Router stops (mounted services, published files)."""
        self._cleanups.append(cleanup)

    async def start(self) -> None:
        async with self._lock:
            if self.running and self.mesh is not None:
                return
            self._stopping = False
            await self._launch()
            if self._supervisor is None or self._supervisor.done():
                self._supervisor = asyncio.create_task(self._supervise())

    async def mount(self, *services: object) -> None:
        """Serve the given services on this Mesh; mounting after start restarts serving."""
        async with self._lock:
            if self._stopping:
                raise RuntimeError("The local router is stopping")
            if self.router is None or not self.router.is_running or self.mesh is None:
                # The supervisor may be waiting to restart a crashed Router; a
                # mount must not try to start it without the auth file and sweep.
                with contextlib.suppress(Exception):
                    if self.router is not None:
                        await self.router.stop()
                await self._launch()
            mesh = self.mesh
            if mesh is None:
                raise RuntimeError("The local router is not started")
            await self._stop_serving()
            mesh.mount(*services, instance_id=f"connector-{self.instance_id}")
            self._services.extend(services)
            await self._start_serving()

    async def stop(self) -> None:
        self._stopping = True
        async with self._lock:
            supervisor, self._supervisor = self._supervisor, None
            if supervisor is not None:
                supervisor.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await supervisor
            await self._stop_serving()
            # Stop advertising this Router before it goes away, but only after
            # the supervisor can no longer restart it.
            cleanups, self._cleanups = self._cleanups, []
            for cleanup in reversed(cleanups):
                try:
                    await cleanup()
                except Exception:  # noqa: BLE001 - one failed cleanup must not keep the Router alive.
                    logger.exception("local router cleanup failed")
            mesh, self.mesh = self.mesh, None
            if mesh is not None:
                with contextlib.suppress(Exception):
                    await mesh.close()
            router, self.router = self.router, None
            if router is not None:
                await router.stop()

    async def _launch(self) -> None:
        _private_directory(self.directory)
        if self.endpoint.unix_path is not None:
            sweep_stale_sockets(self.directory)
        auth_file = self.directory / f"{self.instance_id}.auth.json"
        write_private_json(auth_file, self.auth_document())
        # Restart the same instance: the endpoint and keys stay, so the Mesh
        # client and the running server driver reconnect by themselves.
        router = self.router or LocalRouter(**self.endpoint.router_options(), auth_file=auth_file)
        try:
            await router.start()
        finally:
            # The Router reads its accounts once, at startup.
            with contextlib.suppress(OSError):
                auth_file.unlink()
        self.router = router
        if self.mesh is None:
            self.mesh = Mesh(router, token=self.key(CONNECTOR_ROLE), peer_id=f"connector-{self.instance_id}")
        logger.info("local router listening endpoint={}", self.endpoint.to_json())

    async def _start_serving(self) -> None:
        if self.mesh is None:
            raise RuntimeError("The local router is not started")
        serve = self.mesh.serve(log_level="DEBUG")
        try:
            server = await serve.__aenter__()
        except BaseException:
            # Keep the serving state empty so the supervisor retries instead of
            # treating the dead Router's old server handle as a live one.
            with contextlib.suppress(Exception):
                await serve.__aexit__(None, None, None)
            raise
        self._serve, self._server = serve, server

    async def _stop_serving(self) -> None:
        server, self._server = self._server, None
        if server is not None:
            # Control/Logs streams never finish; draining them would stall for
            # the whole drain timeout (Desktop and the plugin keep them open).
            with contextlib.suppress(Exception):
                await server.stop(drain=False)
        serve, self._serve = self._serve, None
        if serve is not None:
            with contextlib.suppress(Exception):
                await serve.__aexit__(None, None, None)

    async def _supervise(self) -> None:
        while True:
            await asyncio.sleep(_WATCH_INTERVAL)
            router = self.router
            if self._stopping or router is None:
                return
            if router.is_running:
                if self._services and self._server is None:
                    async with self._lock:
                        if not self._stopping and self._server is None:
                            try:
                                await self._start_serving()
                            except Exception:  # noqa: BLE001 - retry on the next tick.
                                logger.exception("local router serving restart failed")
                continue
            logger.warning("local router exited; restarting")
            await asyncio.sleep(_RESTART_DELAY)
            async with self._lock:
                if self._stopping or self.router is None or self.router.is_running:
                    continue
                try:
                    with contextlib.suppress(Exception):
                        await self.router.stop()
                    # The old server handle died with the Router; drop it before
                    # re-entering serve so a failure cannot leave a stale handle
                    # that blocks the recovery branch above.
                    await self._stop_serving()
                    await self._launch()
                    if self._services:
                        await self._start_serving()
                except Exception:  # noqa: BLE001 - keep watching; peers report the Router gone meanwhile.
                    logger.exception("local router restart failed")


_hub: LocalHub | None = None


async def local_hub() -> LocalHub:
    """The process's Router, started on first use."""
    global _hub
    if _hub is None:
        _hub = LocalHub()
    await _hub.start()
    return _hub


def set_local_hub(hub: LocalHub | None) -> None:
    global _hub
    _hub = hub
