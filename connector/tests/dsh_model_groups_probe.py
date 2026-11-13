"""Real Connector/Bridge probe: DSH providers become protocol model groups.

Run only against the TS fixture's private home. Prints the model catalog payload
the Connector sends to the Server, after checking it against the protocol model.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from connector.core import runtime_owner
from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.dsh.bridge.client import BridgeClient, BridgeUnavailableError
from connector.runtimes.dsh.bridge.host import bridge_host
from connector.runtimes.dsh.runtime import DshRuntime
from connector.server.protocol import ProtocolModelCatalog
from connector.server.runtime_rpc_payloads import model_catalog_payload


class Host:
    connector_id = "groups-wire"
    session_namespace = "groups-wire"


async def ignore(*args):
    pass


async def main(home: Path) -> None:
    host = Host()
    runtime = DshRuntime(RuntimeConfig("dsh", 1, {"dshHome": str(home)}), host)
    client = BridgeClient(await bridge_host(), connector_id=host.connector_id,
                          session_namespace=host.session_namespace, client_version="2.0",
                          startup_timeout=15, request_timeout=10, exit_handler=ignore)
    # One start() waits at most DISCOVERY_BUDGET_SECONDS; the runtime retries.
    deadline = asyncio.get_running_loop().time() + 20
    while True:
        try:
            await client.start()
            break
        except BridgeUnavailableError:
            if asyncio.get_running_loop().time() > deadline:
                raise
            await asyncio.sleep(0.5)
    runtime._client = client
    try:
        payload = model_catalog_payload(await runtime.list_model_catalog())
    finally:
        await client.close()
    ProtocolModelCatalog.model_validate(payload)
    print(json.dumps(payload))


if __name__ == "__main__":
    home = Path(sys.argv[1])
    # The TS fixture points the Host's per-user paths at the same private home.
    runtime_owner.system_home = lambda: home
    asyncio.run(main(home))
