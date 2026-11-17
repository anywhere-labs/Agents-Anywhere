"""Offline devices, device reconnection and admitted requests around a channel switch."""

from __future__ import annotations

import asyncio
from typing import Any

from test_model_config import (
    CODEX_LIKE,
    _activate,
    _client,
    _profile,
    _runtime_state,
    _save_config,
    _set_channel,
    state_user,
)

from agent_server.deps import model_channel_service_for
from agent_server.services import model_channels


def _reconcilable(tmp_path):
    client, rpc, connector_id, headers = _client(tmp_path, CODEX_LIKE)
    _save_config(client, connector_id, headers, {})
    _activate(client, connector_id, headers)
    return client, rpc, connector_id, headers


def _applied_on(tmp_path):
    client, rpc, connector_id, headers = _reconcilable(tmp_path)
    profile = _profile(client, headers)
    state = _set_channel(client, headers, profile["id"])
    assert _runtime_state(state)["state"] == "applied", state
    rpc.requests.clear()
    return client, rpc, connector_id, headers, profile


def _switch(client, connector_id) -> dict[str, Any]:
    return asyncio.run(client.app.state.store.get_channel_switch(connector_id, "codex"))


def _periodic_scan(client, connector_id, user_id) -> None:
    channels = model_channel_service_for(client.app.state)

    async def scan() -> None:
        await channels._plan(user_id, connector=connector_id, reconnect=True)
        await channels.settle()

    asyncio.run(scan())


def test_a_periodic_scan_leaves_an_applied_runtime_on_an_offline_device_alone(tmp_path, server_secret):
    client, rpc, connector_id, headers, _ = _applied_on(tmp_path)
    user_id = state_user(client, headers)
    before = _switch(client, connector_id)
    rpc.online = False

    for _ in range(2):
        _periodic_scan(client, connector_id, user_id)

    after = _switch(client, connector_id)
    assert after["state"] == "applied"
    assert after["updatedAt"] == before["updatedAt"]
    assert rpc.requests == []


def test_a_drive_of_an_applied_runtime_on_an_offline_device_changes_nothing(tmp_path, server_secret):
    client, rpc, connector_id, headers, _ = _applied_on(tmp_path)
    user_id = state_user(client, headers)
    rpc.online = False

    asyncio.run(model_channel_service_for(client.app.state)._drive(connector_id, "codex", user_id))

    assert _switch(client, connector_id)["state"] == "applied"


def test_a_periodic_scan_does_not_rewrite_a_runtime_already_waiting_for_its_device(tmp_path, server_secret):
    client, rpc, connector_id, headers = _reconcilable(tmp_path)
    user_id = state_user(client, headers)
    profile = _profile(client, headers)
    rpc.online = False
    state = _set_channel(client, headers, profile["id"])
    assert _runtime_state(state)["state"] == "waiting_online"
    before = _switch(client, connector_id)

    _periodic_scan(client, connector_id, user_id)

    after = _switch(client, connector_id)
    assert after["state"] == "waiting_online"
    assert after["updatedAt"] == before["updatedAt"]

    # The device coming back is what finishes it.
    rpc.online = True
    asyncio.run(model_channel_service_for(client.app.state).connector_event(connector_id))
    assert _switch(client, connector_id)["state"] == "applied"


def test_a_scan_rechecks_an_old_connector_only_once_it_supports_channels(tmp_path, server_secret):
    client, _rpc, connector_id, headers, _ = _applied_on(tmp_path)
    user_id = state_user(client, headers)
    runtimes = client.app.state.device_runtime_service
    channels = model_channel_service_for(client.app.state)
    asyncio.run(runtimes._remember_features(connector_id, []))
    asyncio.run(channels._drive(connector_id, "codex", user_id))
    before = _switch(client, connector_id)
    assert (before["state"], before["reason"]) == ("unsupported", "connector_upgrade_required")

    _periodic_scan(client, connector_id, user_id)
    assert _switch(client, connector_id)["updatedAt"] == before["updatedAt"]

    asyncio.run(runtimes._remember_features(connector_id, ["channelReconcileFence"]))
    _periodic_scan(client, connector_id, user_id)
    assert _switch(client, connector_id)["state"] == "applied"


def _restarted(rpc) -> bool:
    return any(request[1] in {"runtime.apply", "channel.switch"} for request in rpc.requests)


def test_a_switch_waits_for_a_request_admitted_before_it_closed_the_runtime(tmp_path, server_secret):
    client, rpc, connector_id, headers = _reconcilable(tmp_path)
    user_id = state_user(client, headers)
    profile = _profile(client, headers)
    store = client.app.state.store
    channels = model_channel_service_for(client.app.state)
    rpc.requests.clear()

    async def scenario() -> dict[str, Any]:
        async with channels.admit(connector_id, "codex", user_id=user_id):
            switching = asyncio.create_task(channels.set_channel(profile["id"], user_id=user_id))
            for _ in range(200):
                switch = await store.get_channel_switch(connector_id, "codex")
                if switch and switch["step"] == "activating":
                    break
                await asyncio.sleep(0.05)
            await asyncio.sleep(3 * model_channels.ADMISSION_DRAIN_INTERVAL_SECONDS)
            observed = {"step": switch["step"], "restarted": _restarted(rpc)}
        await switching
        return observed

    observed = asyncio.run(scenario())

    assert observed == {"step": "activating", "restarted": False}
    assert _restarted(rpc)
    assert _switch(client, connector_id)["state"] == "applied"


def test_a_stuck_admitted_request_does_not_hold_a_switch_forever(tmp_path, server_secret, monkeypatch):
    monkeypatch.setattr(model_channels, "ADMISSION_DRAIN_SECONDS", 0.2)
    client, rpc, connector_id, headers = _reconcilable(tmp_path)
    user_id = state_user(client, headers)
    profile = _profile(client, headers)
    channels = model_channel_service_for(client.app.state)
    rpc.requests.clear()

    async def scenario() -> bool:
        async with channels.admit(connector_id, "codex", user_id=user_id):
            await channels.set_channel(profile["id"], user_id=user_id)
            return _restarted(rpc)

    assert asyncio.run(scenario()) is True
    assert _switch(client, connector_id)["state"] == "applied"


def test_admissions_of_another_runtime_or_past_their_time_are_not_counted(tmp_path, server_secret):
    client, _rpc, connector_id, _headers = _reconcilable(tmp_path)
    store = client.app.state.store

    async def scenario() -> tuple[int, int, int]:
        await store.admit_runtime_request(
            connector_id, "codex", gate_runtime_ids=["codex"], token="adm_t", expires_at="2100-01-01T00:00:00Z", now="2000-01-01T00:00:00Z",
        )
        counts = (
            await store.count_runtime_admissions(connector_id, ["codex"], now="2000-01-01T00:00:00Z"),
            await store.count_runtime_admissions(connector_id, ["other"], now="2000-01-01T00:00:00Z"),
            await store.count_runtime_admissions(connector_id, ["codex"], now="2200-01-01T00:00:00Z"),
        )
        await store.release_runtime_request("adm_t")
        return counts

    assert asyncio.run(scenario()) == (1, 0, 0)
