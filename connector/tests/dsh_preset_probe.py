"""Real Connector/Bridge probe for a Runtime config saved while DSH was offline.

Run only against the TS fixture's private home. ``offline`` validates a config
with no Bridge reachable and prints its values; ``create`` uses those values to
create a session once DSH is running, without naming an Agent mode.
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
from connector.runtimes.dsh.provider import DshProvider
from connector.runtimes.dsh.runtime import DshRuntime


class Host:
    connector_id = "preset-wire"
    session_namespace = "preset-wire"


async def ignore(*args):
    pass


async def offline(home: Path) -> None:
    config = await DshProvider().validate_config({"dshHome": str(home)})
    assert "defaultAgentPreset" not in config.values, config.values
    # Leave like a Connector that exits cleanly: withdraw this process's rendezvous.
    await (await bridge_host()).stop()
    print(json.dumps(dict(config.values)))


async def create(home: Path, values: dict, selections: dict[str, str]) -> None:
    host = Host()
    runtime = DshRuntime(RuntimeConfig("dsh", 1, values), host)
    client = BridgeClient(await bridge_host(), connector_id=host.connector_id,
                          session_namespace=host.session_namespace, client_version="2.0",
                          startup_timeout=15, request_timeout=10, exit_handler=ignore)
    # One start() waits at most DISCOVERY_BUDGET_SECONDS; the runtime retries
    # with backoff, so keep trying while the plugin discovers this new Router.
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
        result = await runtime.create_and_start_session(
            "sess_default_preset", "hello", cwd=str(home), selections=selections,
            client_message_id="preset-1",
        )
        assert result.ok, (result.code, result.message)
    finally:
        await client.close()
    print("DSH default preset probe passed")


if __name__ == "__main__":
    phase, home = sys.argv[1], Path(sys.argv[2])
    # The TS fixture points the Host's per-user paths at the same private home.
    runtime_owner.system_home = lambda: home
    if phase == "offline":
        asyncio.run(offline(home))
    else:
        asyncio.run(create(home, json.loads(sys.argv[3]), json.loads(sys.argv[4])))
