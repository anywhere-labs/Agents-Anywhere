"""A real Connector log service for the TypeScript cross-language test (no DB)."""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from connector.logging import install_rpc_log_sink
from connector.mesh.host import wait_for_stdin_eof
from connector.mesh.hub import CONNECTOR_ROLE, DSH_BRIDGE_ROLE, LocalHub
from connector.mesh.logs import LogHub, LogsService


async def main() -> None:
    home = Path(sys.argv[1])
    logs = LogHub(home / 'logs')
    sink = install_rpc_log_sink(logs.notify, level='DEBUG', remove_default_sink=True)
    hub = LocalHub(home / 'router')
    try:
        await hub.start()
        await hub.mount(LogsService(logs))
        print(json.dumps({**hub.descriptor(DSH_BRIDGE_ROLE), "callerKey": hub.key(CONNECTOR_ROLE)}), flush=True)
        await wait_for_stdin_eof()
    finally:
        await hub.stop()
        await sink.close()
        logs.close()


if __name__ == '__main__':
    asyncio.run(main())
