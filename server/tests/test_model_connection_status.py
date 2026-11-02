from __future__ import annotations

import asyncio

from runtime_fixtures import describe_inventory
from test_runtime_config import (
    GATEWAY_KEY,
    _make_client,
    _runtime_url,
    _with_gateway_schema,
)

from agent_server.infra.connector_rpc import ConnectorRpcError

CAPABILITY = {
    "maturity": "beta",
    "configField": "modelGateway",
    "modelsField": None,
    "protocols": ["openai_responses"],
    "modes": [],
    "modeField": None,
    "scope": "instance",
    "catalog": {"auto": False, "manual": True},
    "apply": "restart",
}
GATEWAY = {"baseUrl": "https://gateway.example/v1", "apiKey": GATEWAY_KEY}
APPLIED = {
    "state": "applied",
    "protocol": "openai_responses",
    "scope": "instance",
    "mode": None,
    "reason": None,
    "externalOwner": "codex_app",
}


def _client_with_capability(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    rpc.inventory["runtimes"][0]["maturity"] = "beta"
    rpc.inventory["runtimes"][0]["modelConnection"] = CAPABILITY
    _with_gateway_schema(client, rpc, connector_id)
    return client, rpc, connector_id, headers


def _runtime(client, connector_id, headers):
    response = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["runtimes"][0]


def _activate(client, connector_id, headers):
    response = client.put(
        f"{_runtime_url(connector_id)}/active", headers=headers, json={"active": True}
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_runtime_view_carries_maturity_and_capability(tmp_path):
    client, _rpc, connector_id, headers = _client_with_capability(tmp_path)

    runtime = _runtime(client, connector_id, headers)

    assert runtime["maturity"] == "beta"
    assert runtime["modelConnection"] == CAPABILITY
    assert runtime["modelConnectionStatus"] == {"state": "not_configured"}
    assert "modelConnectionReport" not in runtime or runtime["modelConnectionReport"] is None


def test_saved_connection_is_pending_until_the_runtime_reports_it(tmp_path):
    client, rpc, connector_id, headers = _client_with_capability(tmp_path)

    saved = client.put(
        f"{_runtime_url(connector_id)}/config",
        headers=headers,
        json={"config": {"modelGateway": GATEWAY}},
    )

    assert saved.status_code == 200, saved.text
    assert saved.json()["modelConnectionStatus"]["state"] == "saved_pending"

    rpc.responses["runtime.start"] = {
        "runtimeId": "codex",
        "status": "running",
        "modelConnection": APPLIED,
    }
    started = _activate(client, connector_id, headers)

    assert started["modelConnectionStatus"] == APPLIED
    assert GATEWAY_KEY not in str(started)


def test_changing_the_key_reads_as_a_saved_change(tmp_path):
    client, rpc, connector_id, headers = _client_with_capability(tmp_path)
    rpc.responses["runtime.start"] = {
        "runtimeId": "codex",
        "status": "running",
        "modelConnection": APPLIED,
    }
    url = f"{_runtime_url(connector_id)}/config"
    assert client.put(url, headers=headers, json={"config": {"modelGateway": GATEWAY}}).status_code == 200
    _activate(client, connector_id, headers)
    rpc.responses.pop("runtime.start")

    # A running runtime restarts with the new key, but this Connector does
    # not report the connection, so the change stays unconfirmed.
    rotated = client.put(
        url,
        headers=headers,
        json={"config": {"modelGateway": {**GATEWAY, "apiKey": GATEWAY_KEY + "-new"}}},
    )

    assert rotated.status_code == 200, rotated.text
    assert rotated.json()["modelConnectionStatus"]["state"] == "saved_pending"


def test_a_failed_start_is_reported_as_failed(tmp_path):
    client, rpc, connector_id, headers = _client_with_capability(tmp_path)
    url = f"{_runtime_url(connector_id)}/config"
    assert client.put(url, headers=headers, json={"config": {"modelGateway": GATEWAY}}).status_code == 200
    rpc.errors["runtime.start"] = ConnectorRpcError("runtime_upstream_error", "gateway refused")

    response = client.put(
        f"{_runtime_url(connector_id)}/active", headers=headers, json={"active": True}
    )

    assert response.status_code == 502
    status = _runtime(client, connector_id, headers)["modelConnectionStatus"]
    assert status["state"] == "failed"
    assert status["reason"] == "gateway refused"


def test_externally_managed_connection_is_shown_as_such(tmp_path):
    client, rpc, connector_id, headers = _client_with_capability(tmp_path)
    url = f"{_runtime_url(connector_id)}/config"
    assert client.put(url, headers=headers, json={"config": {"modelGateway": GATEWAY}}).status_code == 200
    rpc.responses["runtime.start"] = {
        "runtimeId": "codex",
        "status": "running",
        "modelConnection": {**APPLIED, "state": "managed_externally"},
    }

    started = _activate(client, connector_id, headers)

    assert started["modelConnectionStatus"]["state"] == "managed_externally"
    assert started["modelConnectionStatus"]["externalOwner"] == "codex_app"


def test_unsupported_connection_is_rejected_with_422(tmp_path):
    client, rpc, connector_id, headers = _client_with_capability(tmp_path)
    rpc.errors["runtime.validateConfig"] = ConnectorRpcError(
        "model_connection_unsupported", "Local mode uses its own model settings."
    )

    response = client.put(
        f"{_runtime_url(connector_id)}/config",
        headers=headers,
        json={"config": {"modelGateway": GATEWAY}},
    )

    assert response.status_code == 422, response.text
    assert response.json()["detail"]["code"] == "model_connection_unsupported"


def test_runtime_without_a_capability_has_no_status(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    asyncio.run(
        client.app.state.device_runtime_service.ingest_runtime_types(
            connector_id, describe_inventory(rpc.inventory)
        )
    )

    runtime = _runtime(client, connector_id, headers)

    assert runtime["maturity"] is None
    assert runtime["modelConnection"] is None
    assert runtime["modelConnectionStatus"] is None
