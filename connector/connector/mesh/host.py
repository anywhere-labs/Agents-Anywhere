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
from connector.logging import install_rpc_log_sink, logger
from connector.mesh.control import ControlEvents, ControlService
from connector.mesh.hub import HOST_ROLE, LocalHub, set_local_hub
from connector.mesh.logs import LogsService, open_log_hub

READY_KIND = "connector.ready"
READY_VERSION = 1


async def mount_host_services(hub: LocalHub, *services: object) -> None:
    """Mount the DSH bridge, then ``services``, and publish the bridge last.

    MeshCall freezes its service list when serving starts, so mounting the DSH
    SyncService later stops and restarts serving and cancels the Desktop's
    Control/Logs streams. Mounting it before those streams exist puts that
    restart before the Desktop connects; the rendezvous is published only
    afterwards so the DSH plugin cannot connect during the restart.
    """

    from connector.runtimes.dsh.bridge.host import bridge_host

    dsh_host = None
    try:
        dsh_host = await bridge_host(publish=False)
    except Exception as exc:  # noqa: BLE001 - DSH is optional; control/logs still start
        logger.warning(
            "DSH bridge could not be mounted before serving error_type={} error={}",
            type(exc).__name__,
            exc,
        )
    await hub.mount(*services)
    if dsh_host is not None:
        try:
            dsh_host.publish()
        except Exception as exc:  # noqa: BLE001 - DSH must not block the control plane
            logger.warning(
                "DSH bridge rendezvous could not be published error_type={} error={}",
                type(exc).__name__,
                exc,
            )


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
        await mount_host_services(
            hub,
            ControlService(controller, events, loop),
            LogsService(logs),
        )
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
