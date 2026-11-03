from __future__ import annotations

import asyncio
import json
from typing import Any

from runtime_fixtures import describe_inventory
from test_runtime_config import _make_client, _runtime_url

PROFILE_KEY = "sk-profile-secret-5678"
OLD_KEY = "sk-old-gateway-key-0000"
RELAY = "https://relay.example/v1"

CODEX_LIKE = {
    "maturity": "stable",
    "configField": "modelGateway",
    "modelsField": None,
    "protocols": ["openai_responses"],
    "modes": [],
    "modeField": None,
    "scope": "instance",
    "catalog": {"auto": False, "manual": True},
    "apply": "restart",
}
PI_LIKE = {
    "maturity": "beta",
    "configField": "modelGateway",
    "modelsField": "customModels",
    "protocols": ["openai_chat"],
    "modes": [
        {"id": "managed", "supported": True, "reason": None},
        {"id": "local", "supported": False, "reason": "Local mode reads its own settings"},
    ],
    "modeField": "executionMode",
    "scope": "instance",
    "catalog": {"auto": True, "manual": True},
    "apply": "restart",
}


def _client(tmp_path, capability: dict[str, Any], **type_fields: Any):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    item = rpc.inventory["runtimes"][0]
    item["maturity"] = capability["maturity"]
    item["modelConnection"] = capability
    item.update(type_fields)
    properties = item["schema"]["properties"]
    properties["modelGateway"] = {
        "type": "object",
        "required": ["baseUrl", "apiKey"],
        "properties": {
            "baseUrl": {"type": "string", "minLength": 1},
            "apiKey": {"type": "string", "minLength": 1},
            "protocol": {"type": "string"},
        },
        "additionalProperties": False,
    }
    properties["customModels"] = {"type": "array", "items": {"type": "object"}}
    properties["executionMode"] = {"type": "string", "enum": ["local", "managed"]}
    item["defaults"] = {"environment": {}, "executionMode": "local"}
    asyncio.run(
        client.app.state.device_runtime_service.ingest_runtime_types(
            connector_id, describe_inventory(rpc.inventory)
        )
    )
    return client, rpc, connector_id, headers


def _profile(
    client,
    headers,
    *,
    formats=("openai_responses",),
    models: int = 2,
    key: str = PROFILE_KEY,
) -> dict[str, Any]:
    offers = [
        {
            "format": protocol,
            "baseUrl": RELAY,
            "models": [{"id": f"m{index}"} for index in range(models)],
        }
        for protocol in formats
    ]
    response = client.post(
        "/model-profiles",
        headers=headers,
        json={"name": "Relay", "apiKey": key, "offers": offers},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _target(connector_id: str, runtime_id: str = "codex") -> dict[str, str]:
    return {"connectorId": connector_id, "runtimeId": runtime_id}


def _apply(client, headers, profile_id, targets, *, key="op-1", **extra) -> Any:
    return client.post(
        "/model-config/assignments",
        headers={**headers, "Idempotency-Key": key},
        json={"profileId": profile_id, "targets": targets, **extra},
    )


def _applied(client, headers, profile_id, targets, **kwargs) -> dict[str, Any]:
    response = _apply(client, headers, profile_id, targets, **kwargs)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["finished"] is True
    return body


def _runtimes(client, connector_id, headers) -> dict[str, dict[str, Any]]:
    response = client.get(f"/connectors/{connector_id}/runtimes", headers=headers)
    assert response.status_code == 200, response.text
    return {runtime["runtimeId"]: runtime for runtime in response.json()["runtimes"]}


def _save_config(client, connector_id, headers, config) -> None:
    response = client.put(
        f"{_runtime_url(connector_id)}/config", headers=headers, json={"config": config}
    )
    assert response.status_code == 200, response.text


def _overview(client, headers) -> dict[str, Any]:
    response = client.get("/model-profiles", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_profile_key_is_write_only(tmp_path, server_secret):
    client, _rpc, _connector_id, headers = _client(tmp_path, CODEX_LIKE)

    created = _profile(client, headers)
    overview = _overview(client, headers)

    assert created["keyHint"] == "sk-prof…5678"
    assert created["source"] == "manual"
    assert created["originHost"] == "relay.example"
    assert overview["secretConfigured"] is True
    assert [profile["id"] for profile in overview["profiles"]] == [created["id"]]
    assert PROFILE_KEY not in json.dumps(created)
    assert PROFILE_KEY not in json.dumps(overview)


def test_profiles_need_a_server_secret(tmp_path, monkeypatch):
    monkeypatch.delenv("AGENT_SERVER_SECRET", raising=False)
    client, _rpc, _connector_id, headers = _client(tmp_path, CODEX_LIKE)

    response = client.post(
        "/model-profiles",
        headers=headers,
        json={
            "name": "Relay",
            "apiKey": PROFILE_KEY,
            "offers": [{"format": "openai_responses", "baseUrl": RELAY}],
        },
    )

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "secret_unconfigured"
    assert _overview(client, headers)["secretConfigured"] is False


def test_profile_edits_check_etag_and_key(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    profile = _profile(client, headers)
    url = f"/model-profiles/{profile['id']}"

    moved = client.patch(
        url,
        headers={**headers, "If-Match": profile["etag"]},
        json={"offers": [{"format": "openai_responses", "baseUrl": "https://other.example/v1"}]},
    )
    renamed = client.patch(url, headers={**headers, "If-Match": profile["etag"]}, json={"name": "Mine"})
    stale = client.patch(url, headers={**headers, "If-Match": profile["etag"]}, json={"name": "Late"})

    assert moved.status_code == 422, moved.text
    assert moved.json()["detail"]["code"] == "secret_required"
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Mine"
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["code"] == "profile_changed"

    _applied(client, headers, profile["id"], [_target(connector_id)])
    in_use = client.delete(url, headers=headers)
    assert in_use.status_code == 409, in_use.text
    assert in_use.json()["detail"]["code"] == "profile_in_use"


def test_apply_writes_the_connection_once_per_idempotency_key(tmp_path, server_secret):
    client, rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    profile = _profile(client, headers)

    preview = client.post(
        "/model-config/assignments/preview", headers=headers, json={"profileId": profile["id"]}
    )
    assert preview.status_code == 200, preview.text
    [decision] = preview.json()["targets"]
    assert decision["decision"] == "apply"
    assert decision["offerFormat"] == "openai_responses"
    assert decision["effect"] == "restart"
    assert decision["scope"] == "instance"
    assert decision["requiresConfirmation"] is False

    applied = _applied(client, headers, profile["id"], [_target(connector_id)])
    [result] = applied["results"]
    assert result["result"] == "applied"
    runtime = _runtimes(client, connector_id, headers)["codex"]
    assert runtime["config"]["modelGateway"] == {"baseUrl": RELAY}
    assert runtime["secretFields"]["modelGateway.apiKey"]["hint"] == "sk-prof…5678"
    assert runtime["active"] is True
    [assignment] = _overview(client, headers)["assignments"]
    assert assignment["status"] == "applied"
    assert assignment["profileId"] == profile["id"]

    requests = len(rpc.requests)
    again = _applied(client, headers, profile["id"], [_target(connector_id)])
    assert again["operationId"] == applied["operationId"]
    assert len(rpc.requests) == requests

    reused = _apply(client, headers, profile["id"], [_target(connector_id)], allowInterrupt=True)
    assert reused.status_code == 409, reused.text
    assert reused.json()["detail"]["code"] == "idempotency_key_reused"

    missing = client.post(
        "/model-config/assignments",
        headers=headers,
        json={"profileId": profile["id"], "targets": [_target(connector_id)]},
    )
    assert missing.status_code == 400, missing.text


def test_runtime_without_a_common_protocol_is_skipped(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    profile = _profile(client, headers, formats=("anthropic",))

    preview = client.post(
        "/model-config/assignments/preview", headers=headers, json={"profileId": profile["id"]}
    ).json()
    applied = _applied(client, headers, profile["id"], [_target(connector_id)])

    assert preview["targets"][0]["decision"] == "skip"
    assert preview["targets"][0]["reason"] == "format_unsupported"
    assert applied["results"][0]["result"] == "skipped"
    assert applied["results"][0]["reason"] == "format_unsupported"
    assert _runtimes(client, connector_id, headers)["codex"]["configured"] is False


def test_native_global_scope_needs_confirmation(tmp_path, server_secret):
    capability = {**CODEX_LIKE, "scope": "native_global", "apply": "immediate", "maturity": "experimental"}
    client, _rpc, connector_id, headers = _client(tmp_path, capability)
    profile = _profile(client, headers)

    preview = client.post(
        "/model-config/assignments/preview", headers=headers, json={"profileId": profile["id"]}
    ).json()
    refused = _applied(client, headers, profile["id"], [_target(connector_id)])
    confirmed = _applied(
        client, headers, profile["id"], [_target(connector_id)], key="op-2", confirmNativeGlobal=True
    )

    assert preview["targets"][0]["requiresConfirmation"] is True
    assert refused["results"][0]["reason"] == "confirmation_required"
    assert confirmed["results"][0]["result"] == "applied"


def test_running_tasks_need_permission_to_interrupt(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    profile = _profile(client, headers)
    _applied(client, headers, profile["id"], [_target(connector_id)])
    runtime = _runtimes(client, connector_id, headers)["codex"]
    assert runtime["active"] is True
    assert runtime["status"] in {"starting", "running"}

    async def one_running_session(**_kwargs):
        return [{"id": "ses_running"}]

    store = client.app.state.store
    store.list_running_sessions_for_connector_agent = one_running_session
    busy = _applied(client, headers, profile["id"], [_target(connector_id)], key="op-2")
    # Restarting stops the real sessions, which a stub cannot stand in for.
    del store.list_running_sessions_for_connector_agent
    allowed = _applied(
        client, headers, profile["id"], [_target(connector_id)], key="op-3", allowInterrupt=True
    )

    assert busy["results"][0]["result"] == "skipped"
    assert busy["results"][0]["reason"] == "busy"
    assert allowed["results"][0]["result"] == "applied"


def test_imported_models_stay_apart_from_the_users_own(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, PI_LIKE)
    _save_config(
        client,
        connector_id,
        headers,
        {
            "executionMode": "managed",
            "customModels": [{"modelId": "mine", "displayName": "Mine"}],
        },
    )
    profile = _profile(client, headers, formats=("openai_chat",), models=70)

    too_many = _applied(client, headers, profile["id"], [_target(connector_id)])
    assert too_many["results"][0]["reason"] == "too_many_models"

    _applied(client, headers, profile["id"], [_target(connector_id)], key="op-2", modelIds=["m0", "m1"])
    config = _runtimes(client, connector_id, headers)["codex"]["config"]
    assert [model["modelId"] for model in config["customModels"]] == ["mine", "m0", "m1"]

    _applied(client, headers, profile["id"], [_target(connector_id)], key="op-3", modelIds=["m1"])
    config = _runtimes(client, connector_id, headers)["codex"]["config"]
    assert [model["modelId"] for model in config["customModels"]] == ["mine", "m1"]

    restored = client.delete(
        f"/model-config/assignments/{connector_id}/codex",
        headers=headers,
        params={"allow_interrupt": "true"},
    )
    assert restored.status_code == 200, restored.text
    runtime = _runtimes(client, connector_id, headers)["codex"]
    assert runtime["configured"] is True
    assert "modelGateway" not in runtime["config"]
    assert runtime["config"]["executionMode"] == "managed"
    assert [model["modelId"] for model in runtime["config"]["customModels"]] == ["mine"]
    assert _overview(client, headers)["assignments"] == []


def test_restore_brings_back_the_previous_connection(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    _save_config(
        client,
        connector_id,
        headers,
        {"modelGateway": {"baseUrl": "https://old.example/v1", "apiKey": OLD_KEY}},
    )
    profile = _profile(client, headers)

    preview = client.post(
        "/model-config/assignments/preview", headers=headers, json={"profileId": profile["id"]}
    ).json()
    assert preview["targets"][0]["replaces"] == {
        "kind": "manual",
        "profileId": None,
        "host": "old.example",
    }
    _applied(client, headers, profile["id"], [_target(connector_id)])
    restored = client.delete(
        f"/model-config/assignments/{connector_id}/codex",
        headers=headers,
        params={"allow_interrupt": "true"},
    )

    assert restored.status_code == 200, restored.text
    runtime = _runtimes(client, connector_id, headers)["codex"]
    assert runtime["configured"] is True
    assert runtime["config"]["modelGateway"] == {"baseUrl": "https://old.example/v1"}
    assert runtime["secretFields"]["modelGateway.apiKey"]["hint"] == "sk-old-…0000"


def test_unconfigured_runtime_in_an_unsupported_mode_stays_untouched(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(
        tmp_path, PI_LIKE, instancePolicy="multiple", maxInstances=4
    )
    profile = _profile(client, headers, formats=("openai_chat",))

    [created] = _applied(client, headers, profile["id"], [_target(connector_id)])["results"]

    assert created["createdRuntime"] is True
    assert _runtimes(client, connector_id, headers)["codex"]["configured"] is False


def test_unsupported_mode_gets_a_managed_instance(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(
        tmp_path, PI_LIKE, instancePolicy="multiple", maxInstances=4
    )
    _save_config(client, connector_id, headers, {"executionMode": "local"})
    profile = _profile(client, headers, formats=("openai_chat",))

    preview = client.post(
        "/model-config/assignments/preview", headers=headers, json={"profileId": profile["id"]}
    ).json()
    assert preview["targets"][0]["effect"] == "new_instance"

    first = _applied(client, headers, profile["id"], [_target(connector_id)])
    [created] = first["results"]
    assert created["createdRuntime"] is True
    assert created["servesRuntimeId"] == "codex"
    managed_id = created["runtimeId"]
    runtimes = _runtimes(client, connector_id, headers)
    assert runtimes["codex"]["config"] == {"executionMode": "local"}
    assert runtimes[managed_id]["managedBy"] == "model-config"
    assert runtimes[managed_id]["config"]["executionMode"] == "managed"
    assert runtimes[managed_id]["config"]["modelGateway"] == {"baseUrl": RELAY}

    second = _applied(client, headers, profile["id"], [_target(connector_id)], key="op-2")
    assert second["results"][0]["runtimeId"] == managed_id
    assert "createdRuntime" not in second["results"][0]

    restored = client.delete(
        f"/model-config/assignments/{connector_id}/{managed_id}",
        headers=headers,
        params={"allow_interrupt": "true"},
    )
    assert restored.status_code == 200, restored.text
    runtimes = _runtimes(client, connector_id, headers)
    assert managed_id in runtimes
    assert runtimes[managed_id]["active"] is False

    # Applying again starts the same managed instance and keeps it this module's own.
    again = _applied(client, headers, profile["id"], [_target(connector_id)], key="op-3")
    assert again["results"][0]["runtimeId"] == managed_id
    assert _runtimes(client, connector_id, headers)[managed_id]["active"] is True
    [assignment] = _overview(client, headers)["assignments"]
    assert assignment["createdRuntime"] is True
    restored = client.delete(
        f"/model-config/assignments/{connector_id}/{managed_id}",
        headers=headers,
        params={"allow_interrupt": "true"},
    )
    assert restored.status_code == 200, restored.text
    runtime = _runtimes(client, connector_id, headers)[managed_id]
    assert runtime["active"] is False
    assert runtime["config"]["modelGateway"] == {"baseUrl": RELAY}


def test_dashboard_snapshot_carries_model_config(tmp_path, server_secret):
    client, _rpc, _connector_id, headers = _client(tmp_path, CODEX_LIKE)
    profile = _profile(client, headers)
    ticket = client.post(
        "/ws-ticket",
        headers=headers,
        json={"clientId": "web_model_config", "scope": {"dashboard": True}},
    ).json()["ticket"]

    with client.websocket_connect(f"/dashboard/ws?ticket={ticket}") as ws:
        snapshot = ws.receive_json()

    assert snapshot["type"] == "dashboard.snapshot"
    assert snapshot["modelConfig"]["secretConfigured"] is True
    assert [item["id"] for item in snapshot["modelConfig"]["profiles"]] == [profile["id"]]
    runtime = next(item for item in snapshot["runtimes"] if item["runtimeId"] == "codex")
    assert runtime["maturity"] == "stable"
    assert PROFILE_KEY not in json.dumps(snapshot)


def test_a_runtime_with_several_protocols_is_told_which_one(tmp_path, server_secret):
    capability = {
        **CODEX_LIKE,
        "maturity": "experimental",
        "protocols": ["openai_chat", "anthropic"],
        "modelsField": "customModels",
        "scope": "native_global",
        "apply": "immediate",
    }
    client, _rpc, connector_id, headers = _client(tmp_path, capability)
    profile = _profile(client, headers, formats=("anthropic",))

    applied = _applied(client, headers, profile["id"], [_target(connector_id)], confirmNativeGlobal=True)

    assert applied["results"][0]["result"] == "applied"
    config = _runtimes(client, connector_id, headers)["codex"]["config"]
    assert config["modelGateway"] == {"baseUrl": RELAY, "protocol": "anthropic"}
    assert [model["modelId"] for model in config["customModels"]] == ["m0", "m1"]


def test_a_runtime_that_needs_models_is_skipped_without_them(tmp_path, server_secret):
    capability = {
        **CODEX_LIKE,
        "modelsField": "customModels",
        "catalog": {"auto": False, "manual": True, "required": True},
    }
    client, _rpc, connector_id, headers = _client(tmp_path, capability)
    profile = _profile(client, headers, models=0)

    preview = client.post(
        "/model-config/assignments/preview", headers=headers, json={"profileId": profile["id"]}
    ).json()
    applied = _applied(client, headers, profile["id"], [_target(connector_id)])

    assert preview["targets"][0]["reason"] == "models_required"
    assert applied["results"][0]["reason"] == "models_required"
    assert _runtimes(client, connector_id, headers)["codex"]["configured"] is False
