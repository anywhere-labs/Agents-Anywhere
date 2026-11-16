"""A real MeshCall Router for tests (``9334405``).

Tests that need it are skipped unless ``MESHCALL_ROUTER_BINARY`` points to a
Router binary or ``meshcall-router`` is on ``PATH`` (CI builds it from the
pinned commit).
"""

from __future__ import annotations

import contextlib
import os
import shutil
import socket
import subprocess
import tempfile
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from agent_server.infra.device_mesh import MeshSettings, init_router_auth


def router_binary() -> str | None:
    explicit = os.environ.get("MESHCALL_ROUTER_BINARY", "").strip()
    if explicit and Path(explicit).exists():
        return explicit
    return shutil.which("meshcall-router")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class RouterProcess:
    """One Router with the ``aa-server`` account; restartable on the same port."""

    def __init__(self, *extra: str) -> None:
        binary = router_binary()
        if binary is None:
            pytest.skip("MeshCall Router binary not available (set MESHCALL_ROUTER_BINARY)")
        self.binary = binary
        self.dir = Path(tempfile.mkdtemp(prefix="aa-test-router-"))
        self.auth_file = init_router_auth(self.dir)
        self.password = (self.dir / "aa-server.password").read_text().strip()
        self.port = _free_port()
        self.extra = extra
        self.proc: subprocess.Popen[bytes] | None = None

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    def settings(self, **overrides: object) -> MeshSettings:
        values = {"router_url": self.url, "password": self.password, **overrides}
        return MeshSettings(**values)  # type: ignore[arg-type]

    def start(self) -> None:
        self.proc = subprocess.Popen(
            [
                self.binary,
                "--host",
                "127.0.0.1",
                "--port",
                str(self.port),
                "--auth-file",
                str(self.auth_file),
                "--max-frame-size",
                str(4 * 1024 * 1024),
                "--max-calls-per-connection",
                "0",
                *self.extra,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            with contextlib.suppress(OSError), socket.create_connection(("127.0.0.1", self.port), 0.2):
                return
            time.sleep(0.05)
        raise RuntimeError("MeshCall Router did not start")

    def stop(self) -> None:
        if self.proc is not None:
            proc, self.proc = self.proc, None
            proc.kill()
            proc.wait(5)


@pytest.fixture
def mesh_router() -> Iterator[RouterProcess]:
    router = RouterProcess()
    router.start()
    try:
        yield router
    finally:
        router.stop()
