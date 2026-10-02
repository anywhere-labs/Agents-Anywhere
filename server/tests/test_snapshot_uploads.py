import asyncio
import hashlib
import json

import pytest
from conftest import ApiV2TestClient
from test_backend_mvp import create_connector_and_session, make_client

from agent_server.app import create_app
from agent_server.core.snapshot_upload import CHUNK_BYTES

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
    from sqlalchemy import update

    from agent_server.infra.db.schema import connector_uploads

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
    from sqlalchemy import select, update

    import agent_server.app as module
    from agent_server.infra.db.schema import connector_upload_chunks, connector_uploads

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
