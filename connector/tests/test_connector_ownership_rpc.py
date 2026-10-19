from __future__ import annotations

import asyncio
import json
import os

import pytest
from meshcall import MeshCallError

from connector import cli
from connector.control import ConnectorController
from connector.core import runtime_owner
from connector.core.config import ConnectorConfig
from connector.core.runtime_owner import RuntimeLease, read_state, runtime_path
from tests.mesh_support import control_channel


@pytest.mark.parametrize("owner_kind", ["cli", "desktop-workbench", "dsh-plugin"])
@pytest.mark.parametrize("method", ["acquireOwnership", "start"])
def test_rpc_conflict_is_structured_and_the_same_channel_can_retry(tmp_path, owner_kind, method):
    async def exercise():
        started = []

        class Client:
            def __init__(self, config):
                self.config = config

            async def run_forever(self):
                started.append(self.config.connector_id)
                await asyncio.Event().wait()

        first = RuntimeLease(kind=owner_kind)
        first.claim(ConnectorConfig(server_url="https://example.test", connector_id="first", connector_token="private-first"))
        controller = ConnectorController(config_path=tmp_path / "other.json", client_factory=Client)
        config = {"serverUrl": "https://example.test", "connectorId": "second", "connectorToken": "private-second"}
        params = {"config": config} if method == "start" else {}
        try:
            async with control_channel(controller) as call:
                with pytest.raises(MeshCallError) as raised:
                    await call(method, **params)
                error = raised.value
                assert error.code == "connector_already_running"
                assert error.details == {"reason": "connector_already_running", "owner": {"kind": owner_kind, "pid": os.getpid()}}
                assert "private" not in json.dumps(error.details) + error.message
                assert started == []
                assert read_state(first.path)["connectorIds"] == ["first"]
                # A conflict is a call error; the channel keeps answering.
                assert (await call("getState"))["running"] is False
                first.release()
                assert (await call("start", config=config))["running"] is True
                await asyncio.sleep(0)
                assert started == ["second"]
                assert read_state(first.path)["connectorIds"] == ["first", "second"]
        finally:
            first.release()
            await controller.shutdown()

    asyncio.run(exercise())


def test_cli_start_records_each_used_id_once_and_releases_ownership(tmp_path, monkeypatch):
    observed = []

    class Client:
        def __init__(self, config):
            self.config = config

        async def run_forever(self):
            state = read_state(runtime_path())
            assert state["runtime"]["pid"] == os.getpid()
            assert state["runtime"]["kind"] == "cli"
            assert self.config.connector_id in state["connectorIds"]
            observed.append(self.config.connector_id)

    monkeypatch.setattr(cli, "BackendRpcClient", Client)
    for identifier in ["cli-first", "cli-second", "cli-first"]:
        config_file = tmp_path / identifier / "connector.json"
        ConnectorConfig(server_url="https://example.test", connector_id=identifier, connector_token="private-cli").save(config_file)
        cli.main(["start", "--config", str(config_file)])
        assert "runtime" not in read_state(runtime_path())
    assert observed == ["cli-first", "cli-second", "cli-first"]
    assert read_state(runtime_path())["connectorIds"] == ["cli-first", "cli-second"]
    assert "private-cli" not in runtime_path().read_text()


def test_failed_history_publish_prevents_runtime_start(tmp_path, monkeypatch):
    called = []
    controller = ConnectorController(config_path=tmp_path / "connector.json", client_factory=lambda config: called.append(config))

    def fail_write(*args):
        raise OSError("Cannot publish Connector history")

    monkeypatch.setattr(runtime_owner, "_write", fail_write)
    with pytest.raises(OSError, match="Cannot publish"):
        asyncio.run(controller.start({"serverUrl": "https://example.test", "connectorId": "blocked", "connectorToken": "private"}))
    assert called == []
    assert read_state(runtime_path())["connectorIds"] == []
