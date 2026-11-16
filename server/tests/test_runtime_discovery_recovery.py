from __future__ import annotations



from test_runtime_instances_lifecycle import _make_client, _v2_discovery


def test_failed_discovery_can_be_retried_without_reconnecting(tmp_path):
    client, rpc, connector_id, headers = _make_client(tmp_path, {"invalid": True})
    url = f"/connectors/{connector_id}/runtime-types/discover"
    first = client.post(url, headers=headers)
    assert first.status_code == 502
    rpc.discovery = _v2_discovery()
    second = client.post(url, headers=headers)
    assert second.status_code == 200, second.text
    assert second.json()["runtimeTypes"][0]["runtimeType"] == "codex"
    assert [
        params for _, method, params in rpc.requests if method == "runtime.discover"
    ] == [{}, {}]
