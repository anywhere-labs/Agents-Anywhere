"""One parent-owned Router for all API workers; no worker launches a Router."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import tempfile
import threading
from pathlib import Path
from typing import Self

from loguru import logger
from meshcall import LocalRouter


class ManagedRouter:
    def __init__(self) -> None:
        self.ready = threading.Event()
        self.stop = threading.Event()
        self.error: BaseException | None = None
        self.thread = threading.Thread(
            target=self._thread, name="aa-mesh-router", daemon=True
        )

    def __enter__(self) -> Self:
        self.thread.start()
        if not self.ready.wait(20):
            self.stop.set()
            raise RuntimeError("MeshCall Router startup timed out")
        if self.error:
            raise RuntimeError("MeshCall Router startup failed") from self.error
        return self

    def __exit__(self, *args: object) -> None:
        self.stop.set()
        self.thread.join(15)

    def _thread(self) -> None:
        try:
            asyncio.run(self._run())
        except Exception as error:  # noqa: BLE001 - report thread startup failure to the parent
            self.error = error
            self.ready.set()
            logger.error("MeshCall Router supervisor failed: {}", type(error).__name__)

    async def _run(self) -> None:
        key = f"mk_server_{secrets.token_hex(32)}"
        with tempfile.TemporaryDirectory(prefix="aa-mesh-") as directory:
            auth = Path(directory) / "auth.json"
            salt = secrets.token_bytes(16)
            password_hash = (
                "pbkdf2-sha256$600000$"
                + salt.hex()
                + "$"
                + hashlib.pbkdf2_hmac("sha256", key.encode(), salt, 600000).hex()
            )
            auth.write_text(
                json.dumps(
                    {
                        "users": [
                            {
                                "username": "server",
                                "password_hash": password_hash,
                                "roles": ["client", "server"],
                                "register": ["*"],
                                "call": ["*"],
                            }
                        ]
                    }
                )
            )
            auth.chmod(0o600)
            router = LocalRouter(
                host="127.0.0.1", port=0, auth_file=auth, max_connections=4096
            )
            try:
                await router.start()
                # Keep the first bound port for every restart; worker env is immutable.
                port = router.port
                url = router.url
                from urllib.parse import urlsplit

                router.port = urlsplit(url).port or port
                os.environ["AGENT_SERVER_MESH_URL"] = url
                os.environ["AGENT_SERVER_MESH_KEY"] = key
                self.ready.set()
                logger.info("shared MeshCall Router ready")
                while not self.stop.is_set():
                    await asyncio.sleep(1)
                    if not router.is_running:
                        try:
                            await router.stop()
                            await router.start()
                            logger.warning(
                                "shared MeshCall Router restarted; peers must bootstrap again"
                            )
                        except Exception:  # noqa: BLE001 - supervision retries a failed child
                            logger.exception("shared MeshCall Router restart deferred")
            finally:
                await router.stop()
