from __future__ import annotations

from test_backend_mvp import (
    _create_extra_session,
    create_connector_and_session,
    dashboard_ws_ticket,
    make_client,
)


def test_inventory_and_push_include_all_owned_active_and_archived_sessions(tmp_path):
    with make_client(tmp_path) as client:
        connector_id, _, first_id, headers = create_connector_and_session(client)
        ids = [first_id]
        for index in range(209):
            ids.append(_create_extra_session(
                client, headers, connector_id, f"inventory-{index}", title=f"Session {index}"
            ))
        archived_ids = ids[:105]
        archived = client.post("/sessions/archive", headers=headers, json=archived_ids)
        assert archived.status_code == 200, archived.text
        _, _, foreign_id, _ = create_connector_and_session(client, user_id="other-user")
        removed_connector, _, removed_id, _ = create_connector_and_session(client)
        assert client.delete(f"/connectors/{removed_connector}", headers=headers).status_code == 204

        response = client.get("/sessions/list", headers=headers)
        assert response.status_code == 200, response.text
        rows = response.json()["sessions"]
        assert {row["id"] for row in rows} == set(ids)
        assert sum(row["archived"] for row in rows) == 105
        assert foreign_id not in {row["id"] for row in rows}
        assert removed_id not in {row["id"] for row in rows}
        assert all(row["projectId"] for row in rows)
        assert response.json()["serverTime"]

        ticket = dashboard_ws_ticket(client, headers)
        with client.websocket_connect(f"/dashboard/ws?ticket={ticket}") as ws:
            snapshot = ws.receive_json()
        assert {row["id"] for row in snapshot["sessions"]} == set(ids)
        assert snapshot["sessionPages"] == {
            "active": {"hasMore": False, "nextCursor": None},
            "archived": {"hasMore": False, "nextCursor": None},
        }
        assert {row["projectId"] for row in rows}.issubset({project["id"] for project in snapshot["projects"]})


def test_inventory_requires_authentication_and_does_not_change_paged_queries(tmp_path):
    with make_client(tmp_path) as client:
        assert client.get("/sessions/list").status_code == 401
        connector_id, _, first_id, headers = create_connector_and_session(client)
        second_id = _create_extra_session(client, headers, connector_id, "second", title="Second")
        page = client.get("/sessions", headers=headers, params={"archived": False, "limit": 1})
        assert page.status_code == 200, page.text
        assert len(page.json()["sessions"]) == 1
        assert page.json()["hasMore"] is True
        assert page.json()["nextCursor"]
        inventory = client.get("/sessions/list", headers=headers).json()
        assert {row["id"] for row in inventory["sessions"]} == {first_id, second_id}
