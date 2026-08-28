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
        "serverUrl": "http://127.0.0.1:8001",
        "connectorId": "conn_test",
        "connectorToken": "token_test",
        **overrides,
    }
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()


def test_decode_connector_credential() -> None:
    assert decode_connector_credential(_credential()) == {
        "serverUrl": "http://127.0.0.1:8001",
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
        "serverUrl": "http://127.0.0.1:8001",
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
