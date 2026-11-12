"""The Connector uploads a snapshot larger than one request as pages (docs/dsh-snapshot-uploads.md).

Every page names the ``orderSeq`` range it covers in ``snapshotRange`` and the Server replaces
only that range, writing changed rows and deleting rows the page no longer holds. A Connector
that predates ranges sends the first page with ``complete=true`` to replace the timeline and
appends later pages with ``complete=false``; that still rebuilds the same timeline because an
appended item that sorts after everything stored keeps its own ``orderSeq``. Both are pinned here."""

from __future__ import annotations

import pytest
from connector.server.snapshot_body import encode_snapshot
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


def _timeline_items(client, session_id: str, headers: dict) -> dict[str, dict]:
    response = client.get(f"/sessions/{session_id}/timeline", headers=headers)
    assert response.status_code == 200, response.text
    return {item["id"]: item for item in response.json()["items"]}


def _post_body(client, access_token: str, body: bytes) -> dict:
    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
        content=body,
    )
    assert response.status_code == 200, response.text
    return response.json()


def _upload_paged(client, access_token: str, session_id: str, items: list[dict], page_bytes: int) -> int:
    """Upload ``items`` exactly as the Connector cuts them into pages; returns the page count."""

    with encode_snapshot("dsh", "dsh", session_id, {"externalSessionId": "native"}, iter(items)) as snapshot:
        start, first, pages = 0, True, 0
        while first or start < len(snapshot):
            end = snapshot.page_end(start, page_bytes, first=first)
            body = b"".join(snapshot.page_chunks(start, end, first=first, chunk_bytes=64 * 1024))
            assert _post_body(client, access_token, body).get("rejected", []) == []
            start, first, pages = end, False, pages + 1
    return pages


@pytest.fixture
def write_spy(monkeypatch):
    """Record the rows every timeline write touches."""

    def install(client) -> dict[str, list]:
        timeline = client.app.state.store.timeline
        seen: dict[str, list] = {"written": [], "deleted": []}
        upsert_many, delete_items = timeline.upsert_many, timeline.delete_items

        async def spy_upsert_many(conn, items):
            seen["written"].extend(item.id for item in items)
            return await upsert_many(conn, items)

        async def spy_delete_items(conn, session_id, item_ids):
            seen["deleted"].extend(item_ids)
            return await delete_items(conn, session_id, item_ids)

        monkeypatch.setattr(timeline, "upsert_many", spy_upsert_many)
        monkeypatch.setattr(timeline, "delete_items", spy_delete_items)
        return seen

    return install


def test_an_unchanged_paged_resync_rewrites_nothing(tmp_path, write_spy):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client, runtime="dsh")
    items = [_item(session_id, index, "x" * 400) for index in range(1, 31)]
    _upload_paged(client, access_token, session_id, items, page_bytes=64 * 1024 * 1024)
    before = _timeline_items(client, session_id, headers)
    assert len(before) == 30

    seen = write_spy(client)
    assert _upload_paged(client, access_token, session_id, items, page_bytes=4096) > 3

    assert seen == {"written": [], "deleted": []}, "no row is deleted, inserted or updated"
    assert _timeline_items(client, session_id, headers) == before


def test_paged_resync_writes_only_changes_and_deletes_only_retracted_items(tmp_path, write_spy):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client, runtime="dsh")
    items = [_item(session_id, index, "x" * 400) for index in range(1, 31)]
    _upload_paged(client, access_token, session_id, items, page_bytes=64 * 1024 * 1024)
    before = _timeline_items(client, session_id, headers)

    # The plugin retracted tl_5 and tl_30, edited tl_17 and appended tl_31.
    resync = [
        _item(session_id, index, "edited" if index == 17 else "x" * 400)
        for index in range(1, 32)
        if index not in (5, 30)
    ]
    seen = write_spy(client)
    assert _upload_paged(client, access_token, session_id, resync, page_bytes=4096) > 3

    assert sorted(seen["written"]) == ["tl_17", "tl_31"]
    assert sorted(seen["deleted"]) == ["tl_30", "tl_5"]
    after = _timeline_items(client, session_id, headers)
    assert sorted(after, key=lambda item_id: after[item_id]["orderSeq"]) == [item["id"] for item in resync]
    assert after["tl_17"]["content"]["text"] == "edited"
    untouched = set(after) - {"tl_17", "tl_31"}
    assert all(after[item_id]["updatedSeq"] == before[item_id]["updatedSeq"] for item_id in untouched)


def test_a_failed_paged_upload_leaves_the_rest_of_the_timeline_in_place(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client, runtime="dsh")
    items = [_item(session_id, index, "x" * 400) for index in range(1, 31)]
    _upload_paged(client, access_token, session_id, items, page_bytes=64 * 1024 * 1024)

    with encode_snapshot("dsh", "dsh", session_id, {"externalSessionId": "native"}, iter(items)) as snapshot:
        end = snapshot.page_end(0, 4096, first=True)
        assert end < len(snapshot)
        first_page = b"".join(snapshot.page_chunks(0, end, first=True, chunk_bytes=64 * 1024))
    _post_body(client, access_token, first_page)

    assert len(_timeline_items(client, session_id, headers)) == 30, "items after the first page are not dropped"


@pytest.mark.parametrize(
    ("snapshot_range", "code"),
    [
        ({"afterOrderSeq": 10, "throughOrderSeq": 5}, "invalid_snapshot_range"),
        ({"throughOrderSeq": "5"}, "invalid_snapshot_range"),
        ({"afterOrderSeq": 2**31}, "invalid_snapshot_range"),
        ([1, 2], "invalid_snapshot_range"),
    ],
)
def test_an_invalid_snapshot_range_is_rejected_without_touching_the_timeline(tmp_path, snapshot_range, code):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client, runtime="dsh")
    _ingest(client, access_token, session_id, [_item(session_id, 1), _item(session_id, 2)], complete=True)

    response = client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"notifications": [{"method": "timeline.sync", "params": {
            "sessionId": session_id, "externalSessionId": "native", "items": [],
            "complete": True, "snapshotRange": snapshot_range,
        }}]},
    )

    assert response.status_code == 400, response.text
    assert response.json()["detail"]["code"] == code
    assert [item_id for item_id, _ in _timeline(client, session_id, headers)] == ["tl_1", "tl_2"]


def test_clients_never_reset_to_one_page_and_refetch_after_a_deletion(tmp_path):
    client = make_client(tmp_path)
    _, access_token, session_id, _headers = create_connector_and_session(client, runtime="dsh")
    items = [_item(session_id, index, "x" * 400) for index in range(1, 31)]
    _upload_paged(client, access_token, session_id, items, page_bytes=64 * 1024 * 1024)

    published: list[dict] = []
    broker = client.app.state.timeline_broker
    publish = broker.publish

    async def record(target_session_id, payload):
        if target_session_id == session_id:
            published.append(payload)
        return await publish(target_session_id, payload)

    broker.publish = record
    edited = [_item(session_id, index, "edited" if index == 3 else "x" * 400) for index in range(1, 31)]
    _upload_paged(client, access_token, session_id, edited, page_bytes=4096)
    assert published, "the edited page is published"
    assert not any(payload.get("timelineReset") for payload in published)
    assert [item["id"] for payload in published for item in payload.get("items", [])] == ["tl_3"]

    published.clear()
    retracted = [item for item in edited if item["id"] != "tl_20"]
    _upload_paged(client, access_token, session_id, retracted, page_bytes=4096)
    assert not any(payload.get("timelineReset") for payload in published)
    assert [payload.get("refetch") for payload in published] == [True]
