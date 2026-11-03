from __future__ import annotations

import asyncio
import json
from typing import Any

from runtime_fixtures import describe_inventory
from test_runtime_config import _make_client, _runtime_url

from agent_server.services.model_channels import ChannelDriver, ChannelWakeIndex

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
PI_WITH_MODEL = {**PI_LIKE, "modelField": "model"}
CODEX_WITH_MODEL = {**CODEX_LIKE, "modelField": "model"}


def _client(tmp_path, capability: dict[str, Any], **type_fields: Any):
    client, rpc, connector_id, headers = _make_client(tmp_path)
    # Switches finish inside the request, so each test sees their outcome.
    client.app.state.channel_wake = ChannelWakeIndex(None)
    client.app.state.channel_driver = ChannelDriver(None, wait=True)
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
    properties["model"] = {"type": "object"}
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


def _set_channel(client, headers, channel: str) -> dict[str, Any]:
    response = client.put("/model-config/channel", headers=headers, json={"channel": channel})
    assert response.status_code == 200, response.text
    return response.json()


def _runtime_state(state: dict[str, Any], runtime_id: str = "codex") -> dict[str, Any]:
    return next(item for item in state["runtimes"] if item["runtimeId"] == runtime_id)


def _activate(client, connector_id, headers) -> None:
    response = client.put(f"{_runtime_url(connector_id)}/active", headers=headers, json={"active": True})
    assert response.status_code == 200, response.text


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

    _save_config(client, connector_id, headers, {})
    _set_channel(client, headers, profile["id"])
    in_use = client.delete(url, headers=headers)
    assert in_use.status_code == 409, in_use.text
    assert in_use.json()["detail"]["code"] == "profile_in_use"


def test_choosing_a_channel_writes_and_verifies_it(tmp_path, server_secret):
    client, rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    _save_config(client, connector_id, headers, {})
    _activate(client, connector_id, headers)
    profile = _profile(client, headers)
    rpc.requests.clear()

    state = _set_channel(client, headers, profile["id"])

    item = _runtime_state(state)
    assert state["channel"] == profile["id"]
    assert state["switch"]["state"] == "done"
    assert item["state"] == "applied"
    assert item["actual"] == item["desired"] == profile["id"]
    runtime = _runtimes(client, connector_id, headers)["codex"]
    assert runtime["config"]["modelGateway"] == {"baseUrl": RELAY}
    assert runtime["secretFields"]["modelGateway.apiKey"]["hint"] == "sk-prof…5678"
    assert runtime["active"] is True and runtime["status"] == "running"
    assert [request[1] for request in rpc.requests] == ["runtime.validateConfig", "runtime.stop", "runtime.start"]
    [assignment] = _overview(client, headers)["assignments"]
    assert assignment["status"] == "applied"
    assert _overview(client, headers)["channel"]["channel"] == profile["id"]

    # Asking for the same channel again changes nothing.
    rpc.requests.clear()
    _set_channel(client, headers, profile["id"])
    assert rpc.requests == []


def test_a_runtime_without_a_common_protocol_is_left_alone(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    _save_config(client, connector_id, headers, {})
    profile = _profile(client, headers, formats=("anthropic",))

    item = _runtime_state(_set_channel(client, headers, profile["id"]))

    assert item["state"] == "unsupported"
    assert item["reason"] == "format_unsupported"
    assert item["actual"] == "native"
    assert "modelGateway" not in _runtimes(client, connector_id, headers)["codex"]["config"]


def test_runtimes_not_set_up_yet_do_not_follow_the_channel(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    profile = _profile(client, headers)

    item = _runtime_state(_set_channel(client, headers, profile["id"]))

    assert item["state"] == "unsupported"
    assert item["reason"] == "not_configured"
    assert _runtimes(client, connector_id, headers)["codex"]["configured"] is False


def test_native_global_runtimes_only_take_a_confirmed_choice(tmp_path, server_secret):
    capability = {**CODEX_LIKE, "scope": "native_global", "apply": "immediate", "maturity": "experimental"}
    client, _rpc, connector_id, headers = _client(tmp_path, capability)
    _save_config(client, connector_id, headers, {})
    profile = _profile(client, headers)
    url = f"/model-config/channel/runtimes/{connector_id}/codex"

    followed = _runtime_state(_set_channel(client, headers, profile["id"]))
    refused = client.put(url, headers=headers, json={"channel": profile["id"]})
    confirmed = client.put(url, headers=headers, json={"channel": profile["id"], "confirmNativeGlobal": True})

    assert followed["state"] == "unsupported"
    assert followed["reason"] == "confirmation_required"
    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["code"] == "confirmation_required"
    assert confirmed.status_code == 200, confirmed.text
    item = _runtime_state(confirmed.json())
    assert item["override"] == profile["id"]
    assert item["state"] == "applied"


def test_running_tasks_wait_unless_the_user_switches_now(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    _save_config(client, connector_id, headers, {})
    _activate(client, connector_id, headers)
    profile = _profile(client, headers)

    async def one_running_session(**_kwargs):
        return [{"id": "ses_running"}]

    store = client.app.state.store
    store.list_running_sessions_for_connector_agent = one_running_session
    waiting = _runtime_state(_set_channel(client, headers, profile["id"]))
    assert waiting["state"] == "waiting_idle"
    assert waiting["runningSessions"] == 1
    assert "modelGateway" not in _runtimes(client, connector_id, headers)["codex"]["config"]

    # Restarting stops the real sessions, which a stub cannot stand in for.
    del store.list_running_sessions_for_connector_agent
    response = client.post(f"/model-config/channel/runtimes/{connector_id}/codex/switch-now", headers=headers)

    assert response.status_code == 200, response.text
    assert _runtime_state(response.json())["state"] == "applied"
    assert _runtimes(client, connector_id, headers)["codex"]["config"]["modelGateway"] == {"baseUrl": RELAY}


def test_an_idle_runtime_takes_its_waiting_switch_when_the_task_ends(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    _save_config(client, connector_id, headers, {})
    _activate(client, connector_id, headers)
    profile = _profile(client, headers)
    store = client.app.state.store

    async def one_running_session(**_kwargs):
        return [{"id": "ses_running"}]

    store.list_running_sessions_for_connector_agent = one_running_session
    _set_channel(client, headers, profile["id"])
    del store.list_running_sessions_for_connector_agent

    # The event a finished task raises; nothing polls for it.
    from agent_server.deps import model_channel_service_for

    asyncio.run(model_channel_service_for(client.app.state).runtime_event(connector_id, "codex"))

    state = client.get("/model-config/channel", headers=headers).json()
    assert _runtime_state(state)["state"] == "applied"


def test_a_failed_start_puts_the_previous_connection_back(tmp_path, server_secret):
    from agent_server.infra.connector_rpc import ConnectorRpcError

    client, rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    _save_config(client, connector_id, headers, {"modelGateway": {"baseUrl": "https://old.example/v1", "apiKey": OLD_KEY}})
    _activate(client, connector_id, headers)
    profile = _profile(client, headers)
    calls = {"start": 0}
    original = rpc.request

    async def first_start_fails(connector_id, method, params, **kwargs):
        if method == "runtime.start":
            calls["start"] += 1
            if calls["start"] == 1:
                rpc.requests.append((connector_id, method, params))
                raise ConnectorRpcError("start_failed", "the gateway refused the key")
        return await original(connector_id, method, params, **kwargs)

    rpc.request = first_start_fails
    item = _runtime_state(_set_channel(client, headers, profile["id"]))

    assert item["state"] == "restored"
    assert item["reason"] == "start_failed"
    assert item["actual"] == "native"
    runtime = _runtimes(client, connector_id, headers)["codex"]
    assert runtime["config"]["modelGateway"] == {"baseUrl": "https://old.example/v1"}
    assert runtime["secretFields"]["modelGateway.apiKey"]["hint"] == "sk-old-…0000"
    assert runtime["status"] == "running"
    assert _overview(client, headers)["assignments"] == []
    assert _overview(client, headers)["channel"]["switch"]["state"] == "attention"

    # A restored runtime stays put until the user retries.
    retried = client.post("/model-config/channel/retry", headers=headers, json={})
    assert retried.status_code == 200, retried.text
    assert _runtime_state(retried.json())["state"] == "applied"


def test_a_start_that_reports_an_error_is_not_counted_as_applied(tmp_path, server_secret):
    client, rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    _save_config(client, connector_id, headers, {})
    _activate(client, connector_id, headers)
    profile = _profile(client, headers)
    rpc.responses["runtime.start"] = {"status": "error", "error": {"code": "boom", "message": "exited"}}

    item = _runtime_state(_set_channel(client, headers, profile["id"]))

    # The rollback start reports an error too, so nothing could be put back.
    assert item["state"] == "failed"
    assert item["reason"] == "rollback_failed"
    rpc.responses.pop("runtime.start")
    retried = _runtime_state(client.post("/model-config/channel/retry", headers=headers, json={}).json())
    assert retried["state"] == "applied"


def test_a_newer_switch_on_the_connector_is_not_overwritten(tmp_path, server_secret):
    from agent_server.infra.connector_rpc import ConnectorRpcError

    client, rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    rpc.inventory["features"] = ["switchFence"]
    asyncio.run(client.app.state.device_runtime_service._remember_features(connector_id, ["switchFence"]))
    _save_config(client, connector_id, headers, {})
    _activate(client, connector_id, headers)
    profile = _profile(client, headers)
    original = rpc.request
    seen: list[dict[str, Any]] = []

    async def stale(connector_id, method, params, **kwargs):
        if method == "runtime.validateConfig":
            seen.append(params)
            raise ConnectorRpcError("switch_revision_stale", "a newer switch was accepted")
        return await original(connector_id, method, params, **kwargs)

    rpc.request = stale
    item = _runtime_state(_set_channel(client, headers, profile["id"]))

    assert seen and seen[0]["switchRevision"] >= 1 and seen[0]["operationId"].startswith("chs_")
    assert item["state"] == "restored"
    assert item["reason"] == "superseded"


def _probing(client, rpc, connector_id, capability, *, fails_for=lambda config: False):
    """Connector that probes the model connection of the instance it last started."""
    from agent_server.core.model_connection import connection_digest

    features = ["switchFence", "modelProbe"]
    rpc.inventory["features"] = features
    asyncio.run(client.app.state.device_runtime_service._remember_features(connector_id, features))
    original = rpc.request
    probed: list[dict[str, Any]] = []
    loaded: dict[str, Any] = {}

    async def request(connector_id, method, params, **kwargs):
        if method == "runtime.start":
            loaded["config"] = params["config"]
        if method == "runtime.probeModelConnection":
            rpc.requests.append((connector_id, method, params))
            config = loaded["config"]
            probed.append(config)
            failed = fails_for(config)
            return {
                "runtimeId": params["runtimeId"],
                "configDigest": connection_digest(config, capability),
                "probe": {
                    "state": "failed" if failed else "passed",
                    "code": "probe_unauthorized" if failed else None,
                    "message": "HTTP 401: invalid api key" if failed else None,
                },
            }
        return await original(connector_id, method, params, **kwargs)

    rpc.request = request
    return probed


def test_a_switch_counts_only_after_a_real_model_call(tmp_path, server_secret):
    client, rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    _save_config(client, connector_id, headers, {})
    _activate(client, connector_id, headers)
    profile = _profile(client, headers)
    probed = _probing(client, rpc, connector_id, CODEX_LIKE)
    rpc.requests.clear()

    item = _runtime_state(_set_channel(client, headers, profile["id"]))

    assert item["state"] == "applied"
    assert [request[1] for request in rpc.requests] == [
        "runtime.validateConfig", "runtime.stop", "runtime.start", "runtime.probeModelConnection",
    ]
    assert probed[0]["modelGateway"]["apiKey"] == PROFILE_KEY


def test_a_failed_model_call_puts_the_previous_channel_back(tmp_path, server_secret):
    client, rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    old = {"modelGateway": {"baseUrl": "https://old.example/v1", "apiKey": OLD_KEY}}
    _save_config(client, connector_id, headers, old)
    _activate(client, connector_id, headers)
    profile = _profile(client, headers)
    probed = _probing(
        client, rpc, connector_id, CODEX_LIKE,
        fails_for=lambda config: config["modelGateway"]["apiKey"] == PROFILE_KEY,
    )

    item = _runtime_state(_set_channel(client, headers, profile["id"]))

    assert item["state"] == "restored"
    assert item["reason"] == "probe_failed"
    assert item["message"] == "HTTP 401: invalid api key"
    assert item["actual"] == "native"
    # The previous connection is rebuilt and has to answer as well.
    assert [config["modelGateway"]["apiKey"] for config in probed] == [PROFILE_KEY, OLD_KEY]
    runtime = _runtimes(client, connector_id, headers)["codex"]
    assert runtime["config"]["modelGateway"] == {"baseUrl": "https://old.example/v1"}
    assert _overview(client, headers)["assignments"] == []


def test_a_previous_channel_that_no_longer_answers_is_reported_unusable(tmp_path, server_secret):
    client, rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    _save_config(client, connector_id, headers, {"modelGateway": {"baseUrl": "https://old.example/v1", "apiKey": OLD_KEY}})
    _activate(client, connector_id, headers)
    profile = _profile(client, headers)
    _probing(client, rpc, connector_id, CODEX_LIKE, fails_for=lambda config: True)

    item = _runtime_state(_set_channel(client, headers, profile["id"]))

    assert item["state"] == "failed"
    assert item["reason"] == "rollback_failed"


def test_every_switch_waits_for_running_tasks_whatever_the_apply_mode(tmp_path, server_secret):
    capability = {**CODEX_LIKE, "apply": "new_session"}
    client, _rpc, connector_id, headers = _client(tmp_path, capability)
    _save_config(client, connector_id, headers, {})
    _activate(client, connector_id, headers)
    profile = _profile(client, headers)

    async def one_running_session(**_kwargs):
        return [{"id": "ses_running"}]

    client.app.state.store.list_running_sessions_for_connector_agent = one_running_session
    item = _runtime_state(_set_channel(client, headers, profile["id"]))

    # The instance is rebuilt, so a running task is never cut off unasked.
    assert item["state"] == "waiting_idle"
    assert "modelGateway" not in _runtimes(client, connector_id, headers)["codex"]["config"]


def test_switching_back_to_native_restores_the_previous_connection(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    _save_config(client, connector_id, headers, {"modelGateway": {"baseUrl": "https://old.example/v1", "apiKey": OLD_KEY}})
    profile = _profile(client, headers)

    _set_channel(client, headers, profile["id"])
    item = _runtime_state(_set_channel(client, headers, "native"))

    assert item["state"] == "applied" and item["actual"] == "native"
    runtime = _runtimes(client, connector_id, headers)["codex"]
    assert runtime["config"]["modelGateway"] == {"baseUrl": "https://old.example/v1"}
    assert runtime["secretFields"]["modelGateway.apiKey"]["hint"] == "sk-old-…0000"
    assert _overview(client, headers)["assignments"] == []


def test_imported_models_stay_apart_from_the_users_own(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, PI_LIKE)
    own = [{"modelId": "mine", "displayName": "Mine"}]
    _save_config(client, connector_id, headers, {"executionMode": "managed", "customModels": own})
    profile = _profile(client, headers, formats=("openai_chat",), models=70)

    _set_channel(client, headers, profile["id"])
    models = _runtimes(client, connector_id, headers)["codex"]["config"]["customModels"]
    # As many as fit, the user's own first.
    assert len(models) == 64 and models[0]["modelId"] == "mine"

    _set_channel(client, headers, "native")
    runtime = _runtimes(client, connector_id, headers)["codex"]
    assert "modelGateway" not in runtime["config"]
    assert runtime["config"]["executionMode"] == "managed"
    assert [model["modelId"] for model in runtime["config"]["customModels"]] == ["mine"]


def test_unsupported_mode_gets_a_managed_instance(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, PI_LIKE, instancePolicy="multiple", maxInstances=4)
    _save_config(client, connector_id, headers, {"executionMode": "local"})
    profile = _profile(client, headers, formats=("openai_chat",))

    state = _set_channel(client, headers, profile["id"])

    assert [item["runtimeId"] for item in state["runtimes"]] == ["codex"]
    assert _runtime_state(state)["actual"] == profile["id"]
    runtimes = _runtimes(client, connector_id, headers)
    [managed_id] = [rid for rid, runtime in runtimes.items() if runtime.get("managedBy") == "model-config"]
    assert runtimes["codex"]["config"] == {"executionMode": "local"}
    assert runtimes[managed_id]["config"]["executionMode"] == "managed"
    assert runtimes[managed_id]["config"]["modelGateway"] == {"baseUrl": RELAY}
    assert runtimes[managed_id]["active"] is True

    # Sessions go to the instance while the channel is there, and back after.
    from agent_server.deps import model_channel_service_for

    channels = model_channel_service_for(client.app.state)
    user_id = state_user(client, headers)
    assert asyncio.run(channels.prepare_runtime(connector_id, "codex", user_id=user_id)) == managed_id
    native = _runtime_state(_set_channel(client, headers, "native"))
    assert native["actual"] == "native"
    assert _runtimes(client, connector_id, headers)[managed_id]["active"] is False
    assert asyncio.run(channels.prepare_runtime(connector_id, "codex", user_id=user_id)) == "codex"

    # Choosing it again starts the same instance.
    _set_channel(client, headers, profile["id"])
    runtimes = _runtimes(client, connector_id, headers)
    assert [rid for rid, runtime in runtimes.items() if runtime.get("managedBy") == "model-config"] == [managed_id]
    assert runtimes[managed_id]["active"] is True


def state_user(client, headers) -> str:
    response = client.get("/auth/me", headers=headers)
    assert response.status_code == 200, response.text
    body = response.json()
    return body.get("userId") or body.get("id") or body["user"]["id"]


def test_a_runtime_that_needs_models_is_left_alone_without_them(tmp_path, server_secret):
    capability = {**CODEX_LIKE, "modelsField": "customModels", "catalog": {"auto": False, "manual": True, "required": True}}
    client, _rpc, connector_id, headers = _client(tmp_path, capability)
    _save_config(client, connector_id, headers, {})
    profile = _profile(client, headers, models=0)

    item = _runtime_state(_set_channel(client, headers, profile["id"]))

    assert item["state"] == "unsupported"
    assert item["reason"] == "models_required"
    assert "modelGateway" not in _runtimes(client, connector_id, headers)["codex"]["config"]


def test_a_runtime_with_several_protocols_is_told_which_one(tmp_path, server_secret):
    capability = {
        **CODEX_LIKE, "maturity": "experimental", "protocols": ["openai_chat", "anthropic"],
        "modelsField": "customModels", "scope": "native_global", "apply": "immediate",
    }
    client, _rpc, connector_id, headers = _client(tmp_path, capability)
    _save_config(client, connector_id, headers, {})
    profile = _profile(client, headers, formats=("anthropic",))

    response = client.put(
        f"/model-config/channel/runtimes/{connector_id}/codex", headers=headers,
        json={"channel": profile["id"], "confirmNativeGlobal": True},
    )

    assert response.status_code == 200, response.text
    config = _runtimes(client, connector_id, headers)["codex"]["config"]
    assert config["modelGateway"] == {"baseUrl": RELAY, "protocol": "anthropic"}
    assert [model["modelId"] for model in config["customModels"]] == ["m0", "m1"]


def test_unknown_channels_are_refused(tmp_path, server_secret):
    client, _rpc, _connector_id, headers = _client(tmp_path, CODEX_LIKE)

    missing = client.put("/model-config/channel", headers=headers, json={"channel": "mpr_nope"})
    tokens = client.put("/model-config/channel", headers=headers, json={"channel": "tokens"})

    assert missing.status_code == 404 and missing.json()["detail"]["code"] == "channel_not_found"
    assert tokens.status_code == 409 and tokens.json()["detail"]["code"] == "tokens_not_linked"


def test_requests_wait_while_a_switch_closes_the_runtime(tmp_path, server_secret):
    from agent_server.deps import model_channel_service_for
    from agent_server.services import model_channels

    client, _rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    _save_config(client, connector_id, headers, {})
    store = client.app.state.store
    channels = model_channel_service_for(client.app.state)
    user_id = state_user(client, headers)

    async def closed_then_admitted() -> list[str]:
        await store.save_channel_switch(connector_id, "codex", {
            "userId": user_id, "state": "switching", "step": "activating", "leaseUntil": "2999-01-01T00:00:00Z",
        })
        events: list[str] = []

        async def open_later() -> None:
            await asyncio.sleep(1.2)
            events.append("opened")
            await store.save_channel_switch(connector_id, "codex", {"state": "applied", "step": None})

        opener = asyncio.create_task(open_later())
        async with channels.admit(connector_id, "codex", user_id=user_id):
            events.append("admitted")
            closed = await store.close_runtime_for_switch(
                connector_id, "codex", {}, count_runtime_ids=["codex"], now="2000-01-01T00:00:00Z",
            )
            events.append(f"admissions={closed}")
        await opener
        return events

    previous = model_channels.ADMISSION_WAIT_SECONDS
    model_channels.ADMISSION_WAIT_SECONDS = 10.0
    try:
        events = asyncio.run(closed_then_admitted())
    finally:
        model_channels.ADMISSION_WAIT_SECONDS = previous

    # The request waited for the switch, and a switch closing now sees it.
    assert events == ["opened", "admitted", "admissions=1"]


def test_changing_the_model_later_does_not_mark_the_assignment_modified(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, PI_WITH_MODEL)
    _save_config(client, connector_id, headers, {"executionMode": "managed"})
    profile = _profile(client, headers, formats=("openai_chat",))
    _set_channel(client, headers, profile["id"])

    config = _runtimes(client, connector_id, headers)["codex"]["config"]
    _save_config(client, connector_id, headers, {**config, "model": {"modelId": "m1"}})

    [assignment] = _overview(client, headers)["assignments"]
    assert assignment["status"] == "applied"
    # A model the channel still serves survives switching it again.
    _set_channel(client, headers, "native")
    assert "model" not in _runtimes(client, connector_id, headers)["codex"]["config"]


def test_switching_away_keeps_a_model_of_the_runtimes_own(tmp_path, server_secret):
    client, _rpc, connector_id, headers = _client(tmp_path, PI_WITH_MODEL)
    own = [{"modelId": "mine", "displayName": "Mine"}]
    _save_config(client, connector_id, headers, {"executionMode": "managed", "customModels": own})
    profile = _profile(client, headers, formats=("openai_chat",))

    _set_channel(client, headers, profile["id"])
    config = _runtimes(client, connector_id, headers)["codex"]["config"]
    _save_config(client, connector_id, headers, {**config, "model": {"modelId": "mine"}})
    _set_channel(client, headers, "native")

    assert _runtimes(client, connector_id, headers)["codex"]["config"]["model"] == {"modelId": "mine"}


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


def test_open_dashboards_get_the_saved_profile_without_a_refresh(tmp_path, server_secret):
    client, _rpc, _connector_id, headers = _client(tmp_path, CODEX_LIKE)
    ticket = client.post(
        "/ws-ticket",
        headers=headers,
        json={"clientId": "web_model_config_live", "scope": {"dashboard": True}},
    ).json()["ticket"]

    with client.websocket_connect(f"/dashboard/ws?ticket={ticket}") as ws:
        assert ws.receive_json()["modelConfig"]["profiles"] == []
        profile = _profile(client, headers)
        snapshot = ws.receive_json()
        while snapshot.get("type") != "dashboard.snapshot":
            snapshot = ws.receive_json()

    assert [item["id"] for item in snapshot["modelConfig"]["profiles"]] == [profile["id"]]


def test_a_capability_names_its_model_field_only_when_it_has_one():
    from agent_server.core.model_connection import ModelConnectionCapability

    assert ModelConnectionCapability.model_validate(PI_WITH_MODEL).model_dump()["modelField"] == "model"
    assert "modelField" not in ModelConnectionCapability.model_validate(PI_LIKE).model_dump()


