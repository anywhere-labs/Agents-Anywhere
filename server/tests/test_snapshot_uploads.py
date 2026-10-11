import asyncio
import hashlib
import json

import pytest
from agent_server.app import create_app
from agent_server.core.snapshot_upload import CHUNK_BYTES
from conftest import ApiV2TestClient
from test_backend_mvp import create_connector_and_session, make_client

ROOT = "/connector/ingest/uploads"


def capture(client, connector_id, session_id, seq=12, text="x" * 600_000):
    session = asyncio.run(client.app.state.store.get_session(session_id))
    binding = {"sessionId": session_id, "runtime": "dsh", "runtimeId": "dsh", "externalSessionId": session.externalSessionId}
    item = {"id": "reply", "sessionId": session_id, "type": "message", "status": "done", "role": "assistant",
            "content": {"text": text}, "source": {"runtime": "dsh"}, "orderSeq": 1, "revision": 1, "contentHash": hashlib.sha256(text.encode()).hexdigest()}
    raw = json.dumps({"notifications": [
        {"method": "session.meta.upsert", "params": {**binding, "title": "uploaded"}},
        {"method": "timeline.sync", "params": {**binding, "items": [item], "complete": True, "snapshotSeq": seq}},
    ]}, separators=(",", ":")).encode()
    return raw, {"uploadId": hashlib.sha256(raw).hexdigest(), "sessionId": session_id,
                 "runtimeId": "dsh", "throughSeq": seq, "totalBytes": len(raw)}


def put(client, headers, manifest, raw, index):
    return client.put(f"{ROOT}/{manifest['uploadId']}/chunks/{index}", headers=headers,
                      content=raw[index * CHUNK_BYTES:(index + 1) * CHUNK_BYTES])


def test_restart_missing_chunk_resume_and_idempotent_commit(tmp_path):
    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    raw, manifest = capture(client, connector, session)
    assert client.post(ROOT, json=manifest, headers=headers).json()["receivedChunks"] == []
    assert put(client, headers, manifest, raw, 1).status_code == 200
    assert put(client, headers, manifest, raw, 1).status_code == 200
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).status_code == 409
    assert asyncio.run(client.app.state.store.timeline.read(session)) == []
    # A new app/Store instance proves that receipt is persisted beyond process memory.
    restarted = ApiV2TestClient(create_app(tmp_path / "test.sqlite3"))
    state = restarted.post(ROOT, json=manifest, headers=headers).json()
    assert state["receivedChunks"] == [1]
    for index in (0, 2):
        assert put(restarted, headers, manifest, raw, index).status_code == 200
    committed = restarted.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers)
    assert committed.status_code == 200, committed.text
    assert committed.json()["committed"] is True, committed.text
    history = asyncio.run(restarted.app.state.store.timeline.read(session))
    assert len(history) == 1 and history[0].content["text"] == "x" * 600_000
    seq = asyncio.run(restarted.app.state.store.get_session_seq(session))
    assert restarted.post(ROOT, json=manifest, headers=headers).json()["committed"] is True
    assert restarted.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).json()["committed"] is True
    assert asyncio.run(restarted.app.state.store.get_session_seq(session)) == seq


def test_chunk_conflict_superseded_snapshot_and_connector_isolation(tmp_path):
    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    raw, manifest = capture(client, connector, session)
    assert client.post(ROOT, json=manifest, headers=headers).status_code == 200
    assert put(client, headers, manifest, raw, 0).status_code == 200
    conflict = client.put(f"{ROOT}/{manifest['uploadId']}/chunks/0", headers=headers, content=b"z" * CHUNK_BYTES)
    assert conflict.status_code == 409
    _, other_token, _, _ = create_connector_and_session(client, runtime="dsh")
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers={"Authorization": f"Bearer {other_token}"}).status_code == 404
    _, new = capture(client, connector, session, seq=13, text="new")
    assert client.post(ROOT, json=new, headers=headers).status_code == 200
    assert client.post(ROOT, json=manifest, headers=headers).status_code == 409
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).status_code == 409
    assert asyncio.run(client.app.state.store.timeline.read(session)) == []


def test_invalid_digest_chunk_bounds_expiration_and_quota(tmp_path):
    from agent_server.infra.db.schema import connector_uploads
    from sqlalchemy import update

    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    raw, manifest = capture(client, connector, session, text="small")
    manifest["uploadId"] = "a" * 64
    assert client.post(ROOT, json=manifest, headers=headers).status_code == 200
    assert put(client, headers, manifest, raw, 1).status_code == 400
    assert client.put(f"{ROOT}/{manifest['uploadId']}/chunks/0", headers=headers, content=b"x" * (CHUNK_BYTES + 1)).status_code == 413
    assert put(client, headers, manifest, raw, 0).status_code == 200
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).status_code == 400
    assert asyncio.run(client.app.state.store.timeline.read(session)) == []

    async def expire():
        async with client.app.state.store.engine.begin() as conn:
            await conn.execute(update(connector_uploads).values(expires_at="2000-01-01T00:00:00Z"))
    asyncio.run(expire())
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).status_code == 404
    # begin cleans the expired manifest and its chunks.
    assert client.post(ROOT, json=manifest, headers=headers).json()["receivedChunks"] == []
    for index in range(3):
        big = {**manifest, "uploadId": str(index) * 64, "sessionId": f"quota-{index}", "totalBytes": 256 * 1024 * 1024}
        response = client.post(ROOT, json=big, headers=headers)
        assert response.status_code == (200 if index == 0 else 413)


@pytest.mark.parametrize("committed", [False, True])
def test_background_cleanup_without_new_upload_preserves_unexpired_data(tmp_path, monkeypatch, committed):
    import agent_server.app as module
    from agent_server.infra.db.schema import connector_upload_chunks, connector_uploads
    from sqlalchemy import select, update

    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    raw, expired = capture(client, connector, session, text="expired upload")
    assert client.post(ROOT, json=expired, headers=headers).status_code == 200
    assert put(client, headers, expired, raw, 0).status_code == 200
    if committed:
        assert client.post(f"{ROOT}/{expired['uploadId']}/commit", headers=headers).json()["committed"] is True

    active = {**expired, "uploadId": "b" * 64, "sessionId": "active-upload"}
    assert client.post(ROOT, json=active, headers=headers).status_code == 200
    assert put(client, headers, active, raw, 0).status_code == 200

    async def stop_after_sweep(seconds):
        assert seconds == module.SNAPSHOT_UPLOAD_SWEEP_SECONDS
        raise asyncio.CancelledError

    monkeypatch.setattr(module.asyncio, "sleep", stop_after_sweep)

    async def run():
        store = client.app.state.store
        previous_seq = await store.get_session_seq(session)
        async with store.engine.begin() as conn:
            await conn.execute(update(connector_uploads).where(
                connector_uploads.c.upload_id == expired["uploadId"],
            ).values(expires_at="2000-01-01T00:00:00Z"))
        with pytest.raises(asyncio.CancelledError):
            await module._snapshot_upload_cleanup(client.app)
        async with store.engine.connect() as conn:
            assert (await conn.execute(select(connector_uploads.c.upload_id))).scalars().all() == [active["uploadId"]]
            assert (await conn.execute(select(connector_upload_chunks.c.upload_id))).scalars().all() == [active["uploadId"]]
        assert await store.get_session_seq(session) == previous_seq
        history = await store.timeline.read(session)
        assert len(history) == (1 if committed else 0)

    asyncio.run(run())

    monkeypatch.undo()
    restarted = ApiV2TestClient(create_app(tmp_path / "test.sqlite3"))
    assert restarted.post(ROOT, json={**expired, "throughSeq": expired["throughSeq"] - 1}, headers=headers).status_code == 409
    assert restarted.post(ROOT, json=expired, headers=headers).json()["receivedChunks"] == []


def test_real_connector_resumes_after_server_restart_and_lost_chunk_reply(tmp_path):
    import sys
    from pathlib import Path
    from unittest.mock import AsyncMock

    import httpx

    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "connector"))
    from connector.server.ingest import ConnectorIngestClient

    client = make_client(tmp_path)
    connector, token, session_id, _ = create_connector_and_session(client, runtime="dsh")
    raw, _ = capture(client, connector, session_id)
    notices = json.loads(raw)["notifications"]
    item = notices[1]["params"]["items"][0]
    meta = notices[0]["params"]
    old = {**item, "id": "old", "content": {"text": "previous history"}}
    previous = client.post("/connector/ingest", headers={"Authorization": f"Bearer {token}"}, json={
        "notifications": [{"method": "timeline.sync", "params": {**meta, "items": [old], "complete": True}}],
    })
    assert previous.status_code == 200 and not previous.json()["rejected"]

    async def run():
        class Wire(httpx.AsyncBaseTransport):
            def __init__(self, app, lose=False):
                self.inner = httpx.ASGITransport(app)
                self.lose = lose
                self.writes = []

            async def handle_async_request(self, request):
                response = await self.inner.handle_async_request(request)
                await response.aread()
                if "/chunks/" in request.url.path:
                    index = int(request.url.path.rsplit("/", 1)[1])
                    self.writes.append(index)
                    if self.lose and index == 1:
                        self.lose = False
                        raise httpx.ReadError("lost receipt after real database commit", request=request)
                return response

        first = Wire(client.app, lose=True)
        async with httpx.AsyncClient(transport=first) as http:
            ingest = ConnectorIngestClient("http://test", AsyncMock(return_value=token), lambda: http, lambda _: http)
            with pytest.raises(RuntimeError, match="lost receipt"):
                await ingest.ingest_snapshot("dsh", "dsh", session_id, meta, iter([item]), 12)
        assert first.writes == [0, 1]
        assert [i.id for i in await client.app.state.store.timeline.read(session_id)] == ["old"]
        await client.app.state.store.close()
        app = create_app(tmp_path / "test.sqlite3")
        second = Wire(app)
        async with httpx.AsyncClient(transport=second) as http:
            ingest = ConnectorIngestClient("http://test", AsyncMock(return_value=token), lambda: http, lambda _: http)
            await ingest.ingest_snapshot("dsh", "dsh", session_id, meta, iter([item]), 12)
            assert second.writes == [2]
            saved = await app.state.store.timeline.read(session_id)
            assert [i.id for i in saved] == ["reply"] and saved[0].content == item["content"]
            seq = await app.state.store.get_session_seq(session_id)
            await ingest.ingest_snapshot("dsh", "dsh", session_id, meta, iter([item]), 12)
            assert second.writes == [2]
            assert await app.state.store.get_session_seq(session_id) == seq
        await app.state.store.close()

    asyncio.run(run())


@pytest.mark.parametrize("field,value", [("runtimeId", "foreign"), ("complete", False), ("snapshotSeq", True), ("externalSessionId", "foreign")])
def test_manifest_binding_is_validated_before_publishing_metadata(tmp_path, field, value):
    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    raw, manifest = capture(client, connector, session, seq=1, text="small")
    payload = json.loads(raw)
    payload["notifications"][1]["params"][field] = value
    raw = json.dumps(payload).encode()
    manifest.update(uploadId=hashlib.sha256(raw).hexdigest(), totalBytes=len(raw))
    assert client.post(ROOT, json=manifest, headers=headers).status_code == 200
    assert put(client, headers, manifest, raw, 0).status_code == 200
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).status_code == 400
    assert asyncio.run(client.app.state.store.get_session(session)).title == "Demo"
    assert asyncio.run(client.app.state.store.timeline.read(session)) == []


@pytest.mark.parametrize("bad_index", [0, 1, 2])
def test_invalid_history_item_leaves_metadata_history_and_receipt_unchanged(tmp_path, bad_index):
    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    raw, manifest = capture(client, connector, session, seq=1, text="old history")
    assert client.post(ROOT, json=manifest, headers=headers).status_code == 200
    assert put(client, headers, manifest, raw, 0).status_code == 200
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).json()["committed"]
    before = asyncio.run(client.app.state.store.get_session(session))
    old_history = asyncio.run(client.app.state.store.timeline.read(session))

    raw, manifest = capture(client, connector, session, seq=2, text="new history")
    payload = json.loads(raw)
    payload["notifications"][0]["params"]["title"] = "must not be published"
    template = payload["notifications"][1]["params"]["items"][0]
    items = [{**template, "id": f"new-{index}", "orderSeq": index + 1} for index in range(3)]
    items[bad_index]["revision"] = "invalid"
    payload["notifications"][1]["params"]["items"] = items
    raw = json.dumps(payload).encode()
    manifest.update(uploadId=hashlib.sha256(raw).hexdigest(), totalBytes=len(raw))
    assert client.post(ROOT, json=manifest, headers=headers).status_code == 200
    assert put(client, headers, manifest, raw, 0).status_code == 200

    failed = client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers)
    assert failed.status_code == 400
    assert asyncio.run(client.app.state.store.get_session(session)) == before
    assert asyncio.run(client.app.state.store.timeline.read(session)) == old_history
    receipt = client.post(ROOT, json=manifest, headers=headers).json()
    assert receipt["committed"] is False and receipt["receivedChunks"] == [0]


@pytest.mark.parametrize("failure", ["history", "receipt", "chunk_cleanup"])
def test_snapshot_database_failures_roll_back_all_writes_and_can_retry(tmp_path, monkeypatch, failure):
    from agent_server.infra.db.schema import connector_upload_chunks, connector_uploads
    from sqlalchemy.ext.asyncio import AsyncConnection

    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    raw, manifest = capture(client, connector, session, seq=1, text="old history")
    assert client.post(ROOT, json=manifest, headers=headers).status_code == 200
    assert put(client, headers, manifest, raw, 0).status_code == 200
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).json()["committed"]
    before = asyncio.run(client.app.state.store.get_session(session))
    old_history = asyncio.run(client.app.state.store.timeline.read(session))

    raw, manifest = capture(client, connector, session, seq=2, text="new history")
    payload = json.loads(raw)
    payload["notifications"][0]["params"]["title"] = "new title"
    raw = json.dumps(payload).encode()
    manifest.update(uploadId=hashlib.sha256(raw).hexdigest(), totalBytes=len(raw))
    assert client.post(ROOT, json=manifest, headers=headers).status_code == 200
    assert put(client, headers, manifest, raw, 0).status_code == 200
    events = []

    async def capture_event(session_id, envelope):
        events.append(envelope)

    monkeypatch.setattr(client.app.state.timeline_broker, "publish", capture_event)
    execute = AsyncConnection.execute
    upsert = client.app.state.store.timeline.upsert_many

    async def fail_history(conn, items):
        await upsert(conn, items)
        raise RuntimeError("injected history failure")

    async def fail_execute(conn, statement, *args, **kwargs):
        result = await execute(conn, statement, *args, **kwargs)
        table = getattr(statement, "table", None)
        if (failure == "receipt" and table is connector_uploads and statement.is_update) or (
            failure == "chunk_cleanup" and table is connector_upload_chunks and statement.is_delete
        ):
            raise RuntimeError("injected database failure")
        return result

    with monkeypatch.context() as patch:
        if failure == "history":
            patch.setattr(client.app.state.store.timeline, "upsert_many", fail_history)
        else:
            patch.setattr(AsyncConnection, "execute", fail_execute)
        with pytest.raises(RuntimeError, match="injected"):
            client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers)

    assert asyncio.run(client.app.state.store.get_session(session)) == before
    assert asyncio.run(client.app.state.store.timeline.read(session)) == old_history
    assert events == []
    receipt = client.post(ROOT, json=manifest, headers=headers).json()
    assert receipt["committed"] is False and receipt["receivedChunks"] == [0]
    committed = client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers)
    assert committed.json()["committed"] is True
    assert asyncio.run(client.app.state.store.get_session(session)).title == "new title"
    assert [item.content["text"] for item in asyncio.run(client.app.state.store.timeline.read(session))] == ["new history"]
    assert events and all(event.get("session", {}).get("title", "new title") == "new title" for event in events)


def stage_payload(client, headers, manifest, payload):
    raw = json.dumps(payload).encode()
    manifest = {**manifest, "uploadId": hashlib.sha256(raw).hexdigest(), "totalBytes": len(raw)}
    assert client.post(ROOT, json=manifest, headers=headers).status_code == 200
    for index in range((len(raw) + CHUNK_BYTES - 1) // CHUNK_BYTES):
        assert put(client, headers, manifest, raw, index).status_code == 200
    return manifest


@pytest.mark.parametrize("field,value", [
    ("cwd", 123), ("title", []),
    ("sourceState", {"availability": "invalid"}),
    ("items", None), ("items", {"not": "a list"}),
])
def test_invalid_snapshot_fields_do_not_change_session(tmp_path, field, value):
    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    before = asyncio.run(client.app.state.store.get_session(session))
    raw, manifest = capture(client, connector, session, text="small")
    payload = json.loads(raw)
    notice = payload["notifications"][1 if field == "items" else 0]
    notice["params"][field] = value
    manifest = stage_payload(client, headers, manifest, payload)
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).status_code == 400
    assert asyncio.run(client.app.state.store.get_session(session)) == before
    assert asyncio.run(client.app.state.store.timeline.read(session)) == []
    receipt = client.post(ROOT, json=manifest, headers=headers).json()
    assert not receipt["committed"] and receipt["receivedChunks"] == [0]


def test_cancelled_snapshot_write_rolls_back_and_can_retry(tmp_path, monkeypatch):
    from agent_server.services.snapshot_uploads import SnapshotUploadService

    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    raw, manifest = capture(client, connector, session, text="small")
    manifest = stage_payload(client, headers, manifest, json.loads(raw))
    store = client.app.state.store
    before = asyncio.run(store.get_session(session))
    upsert = store.timeline.upsert_many
    events = []

    async def cancel_after_write(conn, items):
        await upsert(conn, items)
        raise asyncio.CancelledError

    async def record_event(session_id, envelope):
        events.append(envelope)

    monkeypatch.setattr(client.app.state.timeline_broker, "publish", record_event)
    with monkeypatch.context() as patch:
        patch.setattr(store.timeline, "upsert_many", cancel_after_write)
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(SnapshotUploadService(store).commit(connector, manifest["uploadId"]))
    assert asyncio.run(store.get_session(session)) == before
    assert asyncio.run(store.timeline.read(session)) == []
    assert not events
    assert client.post(ROOT, json=manifest, headers=headers).json()["receivedChunks"] == [0]
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).json()["committed"]


def test_snapshot_events_observe_committed_data_and_concurrent_retries_are_idempotent(tmp_path, monkeypatch):
    import httpx
    from agent_server.infra.db.schema import connector_upload_chunks, connector_uploads
    from sqlalchemy import func, select

    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    raw, manifest = capture(client, connector, session, text="small")
    manifest = stage_payload(client, headers, manifest, json.loads(raw))
    store = client.app.state.store
    events = []

    async def observe_event(session_id, envelope):
        assert (await store.get_session(session)).title == "uploaded"
        assert [item.content["text"] for item in await store.timeline.read(session)] == ["small"]
        async with store.engine.connect() as conn:
            assert await conn.scalar(select(connector_uploads.c.status).where(
                connector_uploads.c.upload_id == manifest["uploadId"],
            )) == "committed"
            assert await conn.scalar(select(func.count()).select_from(connector_upload_chunks)) == 0
        events.append(envelope)

    monkeypatch.setattr(client.app.state.timeline_broker, "publish", observe_event)

    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(client.app), base_url="http://test") as http:
            path = f"/api/v2{ROOT}/{manifest['uploadId']}/commit"
            responses = await asyncio.gather(*(http.post(path, headers=headers) for _ in range(2)))
            assert all(response.status_code == 200 and response.json()["committed"] for response in responses)
        seq = await store.get_session_seq(session)
        assert len(events) == 1
        assert events[0]["timelineReset"] is True
        assert events[0]["session"]["title"] == "uploaded"
        assert events[0]["nextSeq"] == seq
        assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).json()["committed"]
        assert await store.get_session_seq(session) == seq
        assert len(events) == 1

    asyncio.run(run())


def test_real_connector_lost_final_reply_survives_restart_without_reupload(tmp_path, monkeypatch):
    from pathlib import Path
    from unittest.mock import AsyncMock

    import httpx

    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2] / "connector"))
    from connector.server.ingest import ConnectorIngestClient

    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    raw, _ = capture(client, connector, session, text="small")
    notices = json.loads(raw)["notifications"]
    metadata = notices[0]["params"]
    items = notices[1]["params"]["items"]

    async def run():
        class Wire(httpx.AsyncBaseTransport):
            def __init__(self, app, lose=False):
                self.inner = httpx.ASGITransport(app)
                self.lose = lose
                self.writes = []

            async def handle_async_request(self, request):
                response = await self.inner.handle_async_request(request)
                await response.aread()
                if request.method == "PUT":
                    self.writes.append(request.url.path)
                if self.lose and request.url.path.endswith("/commit") and response.status_code == 200:
                    self.lose = False
                    raise httpx.ReadError("lost final reply", request=request)
                return response

        first = Wire(client.app, lose=True)
        async with httpx.AsyncClient(transport=first) as http:
            ingest = ConnectorIngestClient("http://test", AsyncMock(return_value=token), lambda: http, lambda _: http)
            with pytest.raises(RuntimeError, match="lost final reply"):
                await ingest.ingest_snapshot("dsh", "dsh", session, metadata, iter(items), 12)
        assert len(first.writes) == 1
        seq = await client.app.state.store.get_session_seq(session)
        assert [item.content["text"] for item in await client.app.state.store.timeline.read(session)] == ["small"]
        await client.app.state.store.close()
        app = create_app(tmp_path / "test.sqlite3")
        second = Wire(app)
        async with httpx.AsyncClient(transport=second) as http:
            ingest = ConnectorIngestClient("http://test", AsyncMock(return_value=token), lambda: http, lambda _: http)
            await ingest.ingest_snapshot("dsh", "dsh", session, metadata, iter(items), 12)
        assert second.writes == []
        assert await app.state.store.get_session_seq(session) == seq
        assert [item.content["text"] for item in await app.state.store.timeline.read(session)] == ["small"]
        await app.state.store.close()

    asyncio.run(run())


@pytest.mark.parametrize("fail", [False, True])
def test_new_session_import_is_atomic_with_history_and_receipt(tmp_path, monkeypatch, fail):
    from agent_server.infra.db.schema import connector_uploads, projects
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncConnection

    client = make_client(tmp_path)
    connector, token, existing, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    raw, manifest = capture(client, connector, existing, text="small")
    payload = json.loads(raw)
    session = "sess_native_import"
    manifest["sessionId"] = session
    for notice in payload["notifications"]:
        notice["params"].update(sessionId=session, externalSessionId="native-import", cwd="/native-import")
    payload["notifications"][1]["params"]["items"][0]["sessionId"] = session
    manifest = stage_payload(client, headers, manifest, payload)
    store = client.app.state.store

    async def project_ids():
        async with store.engine.connect() as conn:
            return (await conn.execute(select(projects.c.id))).scalars().all()

    before_projects = asyncio.run(project_ids())
    if fail:
        execute = AsyncConnection.execute

        async def fail_receipt(conn, statement, *args, **kwargs):
            result = await execute(conn, statement, *args, **kwargs)
            if getattr(statement, "table", None) is connector_uploads and statement.is_update:
                raise RuntimeError("injected receipt failure")
            return result

        with monkeypatch.context() as patch:
            patch.setattr(AsyncConnection, "execute", fail_receipt)
            with pytest.raises(RuntimeError, match="injected receipt"):
                client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers)
        with pytest.raises(KeyError):
            asyncio.run(store.get_session(session))
        assert asyncio.run(project_ids()) == before_projects
        assert asyncio.run(store.timeline.read(session)) == []
        receipt = client.post(ROOT, json=manifest, headers=headers).json()
        assert not receipt["committed"] and receipt["receivedChunks"] == [0]

    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).json()["committed"]
    saved = asyncio.run(store.get_session(session))
    assert saved.title == "uploaded" and saved.cwd == "/native-import"
    assert saved.externalSessionId == "native-import"
    assert saved.projectId not in before_projects
    assert [item.sessionId for item in asyncio.run(store.timeline.read(session))] == [session]


def test_snapshot_alias_preserves_user_title_and_archive(tmp_path):
    from agent_server.infra.db.schema import sessions
    from sqlalchemy import update

    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    store = client.app.state.store

    async def user_changes():
        async with store.engine.begin() as conn:
            await conn.execute(update(sessions).where(sessions.c.id == session).values(
                title="my own title", title_source="user", archived=1,
            ))

    asyncio.run(user_changes())
    raw, manifest = capture(client, connector, session, text="small")
    payload = json.loads(raw)
    alias = "sess_native_alias"
    manifest["sessionId"] = alias
    for notice in payload["notifications"]:
        notice["params"]["sessionId"] = alias
    payload["notifications"][1]["params"]["items"][0]["sessionId"] = alias
    payload["notifications"][0]["params"]["sourceState"] = {"availability": "available"}
    manifest = stage_payload(client, headers, manifest, payload)
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).json()["committed"]
    saved = asyncio.run(store.get_session(session))
    assert saved.title == "my own title" and saved.archived
    assert [item.sessionId for item in asyncio.run(store.timeline.read(session))] == [session]
    with pytest.raises(KeyError):
        asyncio.run(store.get_session(alias))


def test_failed_event_publication_keeps_committed_receipt_and_repairs_without_rewrite(tmp_path, monkeypatch):
    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    raw, manifest = capture(client, connector, session, text="small")
    manifest = stage_payload(client, headers, manifest, json.loads(raw))
    store = client.app.state.store
    attempts = []

    async def fail_once(session_id, envelope):
        assert (await store.get_snapshot_upload(connector, manifest["uploadId"]))["status"] == "committed"
        assert [item.content["text"] for item in await store.timeline.read(session)] == ["small"]
        attempts.append(envelope)
        if len(attempts) == 1:
            raise RuntimeError("injected publication failure")

    monkeypatch.setattr(client.app.state.timeline_broker, "publish", fail_once)
    with pytest.raises(RuntimeError, match="injected publication"):
        client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers)
    seq = asyncio.run(store.get_session_seq(session))
    assert len(attempts) == 2 and attempts[1]["refetch"] is True
    assert attempts[1]["nextSeq"] == seq
    assert attempts[1]["session"]["title"] == "uploaded"
    receipt = client.post(ROOT, json=manifest, headers=headers).json()
    assert receipt["committed"] and receipt["receivedChunks"] == []
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).json()["committed"]
    assert asyncio.run(store.get_session_seq(session)) == seq
    assert len(attempts) == 2


def test_snapshot_replacement_invalidates_live_item_deduplication_cache(tmp_path):
    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    raw, _ = capture(client, connector, session, text="live state")
    notices = json.loads(raw)["notifications"]
    live = {"notifications": [{"method": "timeline.itemUpsert", "params": {
        **notices[0]["params"], "item": notices[1]["params"]["items"][0],
    }}]}
    response = client.post("/connector/ingest", headers=headers, json=live)
    assert response.status_code == 200 and not response.json()["rejected"]
    raw, manifest = capture(client, connector, session, text="snapshot state")
    manifest = stage_payload(client, headers, manifest, json.loads(raw))
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).json()["committed"]
    store = client.app.state.store
    assert [item.content["text"] for item in asyncio.run(store.timeline.read(session))] == ["snapshot state"]

    response = client.post("/connector/ingest", headers=headers, json=live)
    assert response.status_code == 200 and not response.json()["rejected"]
    asyncio.run(client.app.state.timeline_write_buffer.flush_session(session))
    saved = asyncio.run(store.timeline.read(session))
    assert [item.content["text"] for item in saved] == ["live state"]
    assert saved[0].revision == 3


@pytest.mark.parametrize("scenario", ["empty", "duplicate", "refetch"])
def test_complete_snapshot_replacement_edges(tmp_path, monkeypatch, scenario):
    client = make_client(tmp_path)
    connector, token, session, _ = create_connector_and_session(client, runtime="dsh")
    headers = {"Authorization": f"Bearer {token}"}
    raw, manifest = capture(client, connector, session, seq=1, text="old")
    manifest = stage_payload(client, headers, manifest, json.loads(raw))
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).json()["committed"]
    raw, manifest = capture(client, connector, session, seq=2, text="new")
    payload = json.loads(raw)
    params = payload["notifications"][1]["params"]
    item = params["items"][0]
    if scenario == "empty":
        params["items"] = []
    elif scenario == "duplicate":
        params["items"] = [
            {**item, "content": {"text": "discarded duplicate"}, "contentHash": "discarded"}, item,
        ]
    else:
        params["items"] = [{**item, "id": f"new-{index}", "orderSeq": index + 1} for index in range(101)]
    manifest = stage_payload(client, headers, manifest, payload)
    events = []

    async def record_event(session_id, envelope):
        events.append(envelope)

    monkeypatch.setattr(client.app.state.timeline_broker, "publish", record_event)
    assert client.post(f"{ROOT}/{manifest['uploadId']}/commit", headers=headers).json()["committed"]
    saved = asyncio.run(client.app.state.store.timeline.read(session))
    assert len(events) == 1
    if scenario == "refetch":
        assert len(saved) == 101 and len({item.id for item in saved}) == 101
        assert events[0]["refetch"] is True and "items" not in events[0]
    else:
        assert [item.content["text"] for item in saved] == ([] if scenario == "empty" else ["new"])
        assert events[0]["timelineReset"] is True
        assert len(events[0]["items"]) == len(saved)
