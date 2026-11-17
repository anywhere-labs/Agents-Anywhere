"""Public command dispatch boundaries, backed by the shared PostgreSQL test database."""

from test_backend_mvp import create_connector_and_session, make_client


def test_runtime_commands_on_a_v2_device_require_an_upgrade(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)

    response = client.post(
        f"/sessions/{session_id}/runtime/commands", headers=headers, json={"command": "compact"}
    )

    assert response.status_code == 409, response.text
    assert response.json()["detail"]["code"] == "device_upgrade_required"
