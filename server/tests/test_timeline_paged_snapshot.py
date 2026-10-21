"""The Connector uploads a snapshot larger than one request as pages (docs/dsh-snapshot-uploads.md):
the first page replaces the timeline with ``complete=true``, later pages append with
``complete=false``. That only rebuilds the same timeline because an appended item that sorts
after everything stored keeps its own ``orderSeq``; this test pins that contract."""

from __future__ import annotations

from test_backend_mvp import create_connector_and_session, make_client


def _item(session_id: str, index: int, text: str | None = None) -> dict:
    return {
        "id": f"tl_{index}", "sessionId": session_id, "type": "message", "status": "done", "role": "assistant",
        "content": {"text": text or f"message {index}", "format": "markdown"},
        "source": {"runtime": "dsh", "itemId": f"item_{index}"},
        "orderSeq": index, "revision": 1, "contentHash": f"sha256:{index}:{text or ''}",
    }


def _ingest(client, access_token: str, session_id: str, items: list[dict], *, complete: bool) -> None:
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"notifications": [{"method": "timeline.sync", "params": {
            "sessionId": session_id, "externalSessionId": "native", "items": items, "complete": complete,
        }}]},
    )
    assert response.status_code == 200, response.text
    assert response.json().get("rejected", []) == []


def _timeline(client, session_id: str, headers: dict) -> list[tuple[str, int]]:
    response = client.get(f"/sessions/{session_id}/timeline", headers=headers)
    assert response.status_code == 200, response.text
    return [(item["id"], item["orderSeq"]) for item in response.json()["items"]]


def test_paged_snapshot_rebuilds_the_same_timeline_as_one_complete_request(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client, runtime="dsh")

    # Earlier history: one item that the plugin later retracts (tl_25) and one that changes.
    _ingest(client, access_token, session_id, [_item(session_id, 10), _item(session_id, 20, "old text"), _item(session_id, 25), _item(session_id, 30)], complete=True)
    assert [item_id for item_id, _ in _timeline(client, session_id, headers)] == ["tl_10", "tl_20", "tl_25", "tl_30"]

    # The same capture as three pages, ascending by orderSeq.
    _ingest(client, access_token, session_id, [_item(session_id, 10), _item(session_id, 20, "new text")], complete=True)
    assert _timeline(client, session_id, headers) == [("tl_10", 10), ("tl_20", 20)], "the first page replaces and drops the retracted item"
    _ingest(client, access_token, session_id, [_item(session_id, 30), _item(session_id, 40)], complete=False)
    _ingest(client, access_token, session_id, [_item(session_id, 50)], complete=False)
    assert _timeline(client, session_id, headers) == [("tl_10", 10), ("tl_20", 20), ("tl_30", 30), ("tl_40", 40), ("tl_50", 50)]

    # Re-sending an accepted page is harmless; the whole thing equals the single request.
    _ingest(client, access_token, session_id, [_item(session_id, 30), _item(session_id, 40)], complete=False)
    paged = _timeline(client, session_id, headers)
    _ingest(client, access_token, session_id, [_item(session_id, index, "new text" if index == 20 else None) for index in (10, 20, 30, 40, 50)], complete=True)
    assert _timeline(client, session_id, headers) == paged
    response = client.get(f"/sessions/{session_id}/timeline", headers=headers)
    assert [item["content"]["text"] for item in response.json()["items"]][1] == "new text"
