from __future__ import annotations

import base64
import http.client
import json
import stat
import threading
from pathlib import Path
from typing import Iterator

import pytest

from devtools import control
from devtools.control import (
    DevControlError,
    decode_connector_credential,
    save_connector_credential,
)


@pytest.fixture
def control_server(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[tuple[str, list[tuple[str, str | None]]]]:
    calls: list[tuple[str, str | None]] = []
    monkeypatch.setattr(
        control,
        "perform_restart",
        lambda target, credential=None: calls.append((target, credential)),
    )
    monkeypatch.setattr(
        control,
        "status_payload",
        lambda: {"server": True, "web": True, "connector": True, "legacy": False},
    )
    server = control.ThreadingHTTPServer(("127.0.0.1", 0), control.DevControlHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"127.0.0.1:{server.server_port}", calls
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def _credential(**overrides: object) -> str:
    payload = {
        "type": "agents-anywhere.connector-credentials",
        "version": 1,
        "serverUrl": "http://127.0.0.1:8000",
        "connectorId": "conn_test",
        "connectorToken": "token_test",
        **overrides,
    }
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


def test_decode_connector_credential() -> None:
    assert decode_connector_credential(_credential()) == {
        "serverUrl": "http://127.0.0.1:8000",
        "connectorId": "conn_test",
        "connectorToken": "token_test",
    }


@pytest.mark.parametrize(
    "credential",
    (
        "not-base64",
        _credential(type="other"),
        _credential(version=2),
        _credential(serverUrl="file:///tmp/server"),
        _credential(connectorToken=""),
    ),
)
def test_reject_invalid_connector_credential(credential: str) -> None:
    with pytest.raises(DevControlError):
        decode_connector_credential(credential)


def test_save_connector_credential_with_private_permissions(tmp_path: Path) -> None:
    config_path = tmp_path / "connector.json"
    save_connector_credential(_credential(), config_path)

    assert json.loads(config_path.read_text()) == {
        "serverUrl": "http://127.0.0.1:8000",
        "connectorId": "conn_test",
        "connectorToken": "token_test",
    }
    assert stat.S_IMODE(config_path.stat().st_mode) == 0o600


def test_control_api_restarts_connector_without_echoing_credential(
    control_server: tuple[str, list[tuple[str, str | None]]],
) -> None:
    address, calls = control_server
    credential = _credential()
    connection = http.client.HTTPConnection(address)
    connection.request(
        "POST",
        "/api/restart",
        body=json.dumps({"target": "connector", "credential": credential}),
        headers={"Content-Type": "application/json", "Origin": f"http://{address}"},
    )
    response = connection.getresponse()
    payload = json.loads(response.read())
    connection.close()

    assert response.status == 200
    assert payload["ok"] is True
    assert credential not in json.dumps(payload)
    assert calls == [("connector", credential)]


def test_control_api_rejects_non_local_host(
    control_server: tuple[str, list[tuple[str, str | None]]],
) -> None:
    address, calls = control_server
    connection = http.client.HTTPConnection(address)
    connection.putrequest("GET", "/api/status", skip_host=True)
    connection.putheader("Host", "example.com")
    connection.endheaders()
    response = connection.getresponse()
    response.read()
    connection.close()

    assert response.status == 403
    assert calls == []


def test_ensure_split_layout_recovers_orphaned_legacy_processes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = {control.SERVER_PORT: True, control.WEB_PORT: True}
    calls: list[str] = []

    monkeypatch.setattr(control, "screen_sessions", set)
    monkeypatch.setattr(control, "port_open", lambda port: state[port])
    monkeypatch.setattr(control, "_health_ok", lambda: state[control.SERVER_PORT])

    def stop_server() -> None:
        if state[control.SERVER_PORT]:
            calls.append("stop-server")
        state[control.SERVER_PORT] = False

    def stop_web() -> None:
        if state[control.WEB_PORT]:
            calls.append("stop-web")
        state[control.WEB_PORT] = False

    def start_server() -> None:
        calls.append("start-server")
        state[control.SERVER_PORT] = True

    def start_web() -> None:
        calls.append("start-web")
        state[control.WEB_PORT] = True

    monkeypatch.setattr(control, "_stop_server_processes", stop_server)
    monkeypatch.setattr(control, "_stop_web_processes", stop_web)
    monkeypatch.setattr(control, "ensure_infrastructure", lambda: calls.append("infra"))
    monkeypatch.setattr(control, "run_migrations", lambda: calls.append("migrate"))
    monkeypatch.setattr(control, "start_server", start_server)
    monkeypatch.setattr(control, "start_web", start_web)

    assert control.ensure_split_layout() is True
    assert calls == [
        "stop-server",
        "stop-web",
        "infra",
        "migrate",
        "start-server",
        "start-web",
    ]


def test_stop_port_processes_refuses_foreign_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(control, "port_open", lambda _port: True)
    monkeypatch.setattr(control, "_listener_pids", lambda _port: {123})
    monkeypatch.setattr(control, "_process_is_owned", lambda *_args, **_kwargs: False)

    with pytest.raises(DevControlError, match="outside this checkout"):
        control._stop_port_processes(
            name="Server",
            port=control.SERVER_PORT,
            cwd=control.ROOT / "server",
            command_markers=("uvicorn",),
        )


def test_stop_connector_cleans_orphaned_owned_process_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process_state = {100, 101}
    terminated: list[tuple[set[int], str]] = []

    monkeypatch.setattr(control, "stop_screen", lambda _name: None)
    monkeypatch.setattr(control, "_connector_process_pids", lambda: set(process_state))
    monkeypatch.setattr(
        control,
        "_process_cwd",
        lambda pid: control.ROOT / "connector" if pid == 101 else None,
    )
    monkeypatch.setattr(
        control,
        "_process_command",
        lambda pid: "python -m connector.cli start" if pid == 101 else "login",
    )
    monkeypatch.setattr(control, "_process_group_ids", lambda pids: {500} if pids else set())

    def terminate(pids: set[int], *, name: str) -> None:
        terminated.append((pids, name))
        process_state.clear()

    monkeypatch.setattr(control, "_terminate_process_groups", terminate)

    control.stop_connector()

    assert terminated == [({101}, "Connector")]
