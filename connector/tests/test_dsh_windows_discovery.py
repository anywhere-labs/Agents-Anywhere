from __future__ import annotations

import asyncio
import json
import os
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock

import pytest
from meshcall import Mesh, query, service
from pydantic import BaseModel, ConfigDict

from connector.mesh.hub import (
    DSH_BRIDGE_ROLE,
    DSH_BRIDGE_SERVICE,
    LocalHub,
    set_local_hub,
)
from connector.runtimes.dsh import discovery, provider_config


class _Payload(BaseModel):
    model_config = ConfigDict(extra="allow")


@service(DSH_BRIDGE_SERVICE, description="Test double for the DSH plugin's Bridge service.")
class _BridgeProbe:
    def __init__(self, methods: list[str]) -> None:
        self.methods = methods

    @query
    async def initialize(self) -> _Payload:
        """Return the 2.0 identity the Connector validates."""
        self.methods.append("initialize")
        return _Payload(identity={
            "runtime": "dsh", "runtimeVersion": "test",
            "protocolVersion": "2.0", "bridgeVersion": "test",
        })

    @query
    async def ping(self) -> _Payload:
        """Prove the plugin is reachable through the local Router."""
        self.methods.append("ping")
        return _Payload()

    @query
    async def getRuntimeCapabilities(self) -> _Payload:
        """Declared capabilities; the probe records but does not require them."""
        self.methods.append("getRuntimeCapabilities")
        return _Payload(capabilities=[])

    @query
    async def listAgentPresets(self) -> _Payload:
        """Agent presets advertised by a writable plugin."""
        self.methods.append("listAgentPresets")
        return _Payload(presets=[])


@pytest.mark.parametrize("registered", [True, False])
def test_windows_discovery_uses_the_local_router_without_signalling_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, registered: bool
) -> None:
    """The 2.0 probe asks this process's Router; it never inspects or signals a pid.

    On Windows a liveness check based on ``os.kill`` would terminate the process
    it is asking about, so the probe must stay purely RPC-based. Registration on
    the Router (not a token in a file) decides availability.
    """
    kill = Mock(
        side_effect=AssertionError("Discovery must not signal Windows processes")
    )

    async def run() -> None:
        hub = LocalHub(directory=tmp_path / "router")
        await hub.start()
        set_local_hub(hub)
        try:
            methods: list[str] = []
            plugin = Mesh(hub.router, token=hub.key(DSH_BRIDGE_ROLE), peer_id="dsh-plugin")
            plugin.mount(_BridgeProbe(methods))
            async with plugin:
                serving = plugin.serve() if registered else nullcontext()
                async with serving:
                    with monkeypatch.context() as patch:
                        patch.setattr(os, "kill", kill)
                        result = await discovery.probe({"dshHome": str(tmp_path / "dsh")})
                    assert result.available is registered
                    if registered:
                        assert result.bridge_version == "test"
                        assert methods[:2] == ["initialize", "ping"]
                        assert "getRuntimeCapabilities" in methods
                    else:
                        assert result.reason
                    kill.assert_not_called()

            # The Connector publishes the MeshCall rendezvous the plugin reads:
            # Router endpoint plus the dsh-bridge key, with no TCP host/port/token.
            rendezvous = json.loads(provider_config.endpoint_path().read_text(encoding="utf-8"))
            assert rendezvous["version"] == 2
            assert rendezvous["protocol"] == "meshcall"
            assert rendezvous["instanceId"] == hub.instance_id
            assert rendezvous["pid"] == os.getpid()
            assert rendezvous["endpoint"] == hub.endpoint.to_json()
            assert rendezvous["key"] == hub.key(DSH_BRIDGE_ROLE)
            assert "host" not in rendezvous and "port" not in rendezvous and "token" not in rendezvous

            # With no Bridge registered on the Router the probe reports offline.
            with monkeypatch.context() as patch:
                patch.setattr(os, "kill", kill)
                result = await discovery.probe({"dshHome": str(tmp_path / "dsh")})
            assert not result.available
            assert result.reason
            kill.assert_not_called()
        finally:
            set_local_hub(None)
            await hub.stop()

    asyncio.run(run())
