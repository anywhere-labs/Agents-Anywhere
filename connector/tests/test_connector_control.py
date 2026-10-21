from __future__ import annotations

import asyncio
from typing import Any, ClassVar

from meshcall import MeshCallError

from connector.control import ConnectorController, config_to_payload
from connector.core.config import ConnectorConfig
from connector.server.auth import ConnectorAuthenticationError
from tests.mesh_support import control_channel


class FakeBackendRpcClient:
    started: ClassVar[list[ConnectorConfig]] = []

    def __init__(self, config: ConnectorConfig) -> None:
        self.config = config

    async def run_forever(self) -> None:
        self.started.append(self.config)
        await asyncio.Event().wait()


class FailingAuthBackendRpcClient:
    def __init__(self, config: ConnectorConfig) -> None:
        self.config = config

    async def run_forever(self) -> None:
        raise ConnectorAuthenticationError("connector credential no longer valid")


def test_connector_controller_saves_config_and_starts_runtime(tmp_path) -> None:
    async def exercise() -> tuple[dict[str, Any], list[tuple[str, Any]]]:
        events: list[tuple[str, Any]] = []

        async def notify(method: str, params: Any) -> None:
            events.append((method, params))

        FakeBackendRpcClient.started = []
        controller = ConnectorController(
            config_path=tmp_path / "connector.json",
            notifier=notify,
            client_factory=FakeBackendRpcClient,  # type: ignore[arg-type]
        )
        config = {
            "serverUrl": "http://127.0.0.1:8000/",
            "connectorId": "conn_1",
            "connectorToken": "cxt_secret",
        }
        saved = await controller.save_config(config)
        state = await controller.start()
        await asyncio.sleep(0)
        assert FakeBackendRpcClient.started[0].server_url == "http://127.0.0.1:8000"
        assert state["running"] is True
        await controller.stop()
        from connector.core.runtime_owner import read_runtime
        assert read_runtime(controller.runtime_path) is not None, "Stop must retain ownership until RPC shutdown"
        await controller.shutdown()
        assert read_runtime(controller.runtime_path) is None
        assert controller.runtime_path.exists(), "Shared identity must outlive the process"
        return saved, events

    saved, events = asyncio.run(exercise())

    assert saved["serverUrl"] == "http://127.0.0.1:8000"
    assert [method for method, _params in events].count("connector/state") >= 2
    assert not (tmp_path / "connector-runtime.json").exists()


def test_connector_controller_returns_default_config_when_missing(tmp_path) -> None:
    controller = ConnectorController(config_path=tmp_path / "missing.json")

    config = controller.get_config()

    assert config["serverUrl"] == ""
    assert config["heartbeatSeconds"] == 20


def test_connector_controller_marks_auth_failure(tmp_path) -> None:
    async def exercise() -> dict[str, Any]:
        events: list[tuple[str, Any]] = []

        async def notify(method: str, params: Any) -> None:
            events.append((method, params))

        controller = ConnectorController(
            config_path=tmp_path / "connector.json",
            notifier=notify,
            client_factory=FailingAuthBackendRpcClient,  # type: ignore[arg-type]
        )
        await controller.save_config(
            {
                "serverUrl": "http://127.0.0.1:8000/",
                "connectorId": "conn_1",
                "connectorToken": "cxt_secret",
            }
        )
        await controller.start()
        for _ in range(10):
            await asyncio.sleep(0)
            if events[-1][1]["status"] != "running":
                break
        return events[-1][1]

    state = asyncio.run(exercise())

    assert state["status"] == "expired credential"
    assert state["authFailed"] is True
    assert "credential" in state["lastError"]


def test_control_service_answers_getters_over_the_router(tmp_path) -> None:
    async def exercise() -> list[dict[str, Any]]:
        controller = ConnectorController(config_path=tmp_path / "missing.json")
        async with control_channel(controller) as call:
            return [await call("getState"), await call("getConfig")]

    state, config = asyncio.run(exercise())

    assert state["status"] == "stopped"
    assert config["serverUrl"] == ""


def test_control_service_reports_missing_config_and_invalid_settings(tmp_path) -> None:
    async def exercise() -> list[MeshCallError]:
        controller = ConnectorController(config_path=tmp_path / "missing.json")
        errors = []
        async with control_channel(controller) as call:
            for method, params in [("start", {}), ("saveConfig", {"config": {"serverUrl": "https://x.test"}})]:
                try:
                    await call(method, **params)
                except MeshCallError as exc:
                    errors.append(exc)
        await controller.shutdown()
        return errors

    missing, invalid = asyncio.run(exercise())

    assert missing.code == "connector_error"
    assert "missing.json" in missing.message
    assert invalid.code == "invalid_argument"
    assert "required" in invalid.message


def test_config_to_payload_keeps_optional_state_path() -> None:
    payload = config_to_payload(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            state_path="/tmp/state.json",
        )
    )

    assert payload["statePath"] == "/tmp/state.json"


def test_connector_controller_rejects_existing_runtime_owner(tmp_path) -> None:
    from connector.core.runtime_owner import RuntimeLease

    async def exercise() -> dict[str, Any]:
        controller = ConnectorController(
            config_path=tmp_path / "connector.json",
            client_factory=FakeBackendRpcClient,  # type: ignore[arg-type]
        )
        config = ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="cxt_secret",
        )
        config.save(tmp_path / "connector.json")
        RuntimeLease(controller.runtime_path, kind="cli").claim(config)
        try:
            await controller.start()
        except RuntimeError:
            return controller.get_state()
        raise AssertionError("expected runtime owner rejection")

    state = asyncio.run(exercise())

    assert state["status"] == "error"
    assert "Another Connector is running" in state["lastError"]
