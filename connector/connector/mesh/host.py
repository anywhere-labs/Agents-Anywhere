"""``anywhere-cli rpc``: a Connector controlled over its local Router.

The parent process reads one ready line from stdout, then talks to
``aa.local.v2.Control`` and ``aa.local.v2.Logs`` over MeshCall with the
``host`` key it carries. Closing stdin shuts the Connector, and with it the
Router, down; nothing else is ever written to stdout.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import sys
import threading
from pathlib import Path
from typing import Any

from connector.control import ConnectorController
from connector.core import runtime_owner
from connector.logging import install_rpc_log_sink
from connector.mesh.control import ControlEvents, ControlService
from connector.mesh.hub import HOST_ROLE, LocalHub, set_local_hub
from connector.mesh.logs import LogsService, open_log_hub

READY_KIND = "connector.ready"
READY_VERSION = 1


def ready_message(hub: LocalHub) -> dict[str, Any]:
    return {"kind": READY_KIND, "version": READY_VERSION, **hub.descriptor(HOST_ROLE)}


async def wait_for_stdin_eof(stream: Any = None) -> None:
    """Resolve once the parent closes our stdin (or exits)."""
    loop = asyncio.get_running_loop()
    closed = loop.create_future()
    source = stream if stream is not None else sys.stdin.buffer

    def read() -> None:
        try:
            while source.read(65536):
                pass
        except (OSError, ValueError):
            pass
        def close() -> None:
            if not closed.done():
                closed.set_result(None)

        with contextlib.suppress(RuntimeError):  # the loop already closed during shutdown
            loop.call_soon_threadsafe(close)

    threading.Thread(target=read, name="connector-stdin-watch", daemon=True).start()
    await closed


async def serve_host(
    *,
    config_path: str | Path | None,
    debug: bool = False,
    stdin: Any = None,
    stdout: Any = None,
) -> None:
    loop = asyncio.get_running_loop()
    events = ControlEvents()
    logs = open_log_hub(runtime_owner.system_home() / ".agents-anywhere" / "logs")
    controller = ConnectorController(config_path=config_path, notifier=events.notify)
    log_sink = install_rpc_log_sink(logs.notify, level="DEBUG" if debug else "INFO", remove_default_sink=True)
    hub = LocalHub()
    set_local_hub(hub)
    try:
        await hub.start()
        await hub.mount(ControlService(controller, events, loop), LogsService(logs))
        output = stdout if stdout is not None else sys.stdout
        output.write(json.dumps(ready_message(hub)) + "\n")
        output.flush()
        await wait_for_stdin_eof(stdin)
    finally:
        set_local_hub(None)
        try:
            await controller.shutdown()
        finally:
            try:
                await hub.stop()
            finally:
                await log_sink.close()
                logs.close()
