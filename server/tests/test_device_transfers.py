"""v3 bytes: attachments to the device, blobs back through the relay, shares exported by the device."""

from __future__ import annotations

import asyncio
import hashlib

from device_link_helpers import (
    acked,
    eventually,
    offline,
    server,
    summary,
    timeline_item,
    user_and_device,
)
from mesh_fixtures import RouterProcess

from scripts.v3_fake_device import connect_device


async def _setup(app, client):
    headers, device_id, token = await user_and_device(app, client)
    device, _welcome, access = await connect_device(client, connector_id=device_id, connector_token=token)
    pushed = device.state.push_outbox("session.summary", summary("sess_t1", 0))
    await eventually(lambda: acked(device, pushed.oid))
    loop = asyncio.get_running_loop()

    def uploader(transfer, data):
        return asyncio.run_coroutine_threadsafe(
            client.put(
                transfer["path"],
                content=data,
                headers={"Authorization": f"Bearer {access}", "X-Transfer-Token": transfer["token"]},
            ),
            loop,
        )

    device.state.blob_uploader = uploader
    return headers, device_id, device, access


def test_attachment_goes_to_the_device_and_comes_back_through_the_relay(
    mesh_router: RouterProcess, monkeypatch
) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, device, access = await _setup(app, client)
            try:
                data = b"hello from the phone\n" * 1000
                uploaded = await client.post(
                    "/api/v2/sessions/sess_t1/attachments",
                    headers=headers,
                    files={"files": ("note.txt", data, "text/plain")},
                )
                assert uploaded.status_code == 200, uploaded.text
                file_id = uploaded.json()["attachments"][0]["fileId"]
                sha = hashlib.sha256(data).hexdigest()

                fetched = await client.get(
                    f"/api/v3/device/attachments/{file_id}?sessionId=sess_t1",
                    headers={"Authorization": f"Bearer {access}"},
                )
                assert fetched.status_code == 200 and fetched.content == data
                assert fetched.headers["X-File-Sha256"] == sha
                # Someone else's device cannot read it.
                denied = await client.get(
                    f"/api/v3/device/attachments/{file_id}?sessionId=sess_other",
                    headers={"Authorization": f"Bearer {access}"},
                )
                assert denied.status_code == 404

                # The device stored it: the staged copy goes away.
                consumed = device.state.push_outbox("attachment.consumed", {"fileId": file_id, "sha256": sha})
                await eventually(lambda: acked(device, consumed.oid))
                attachments = app.state.store.attachments

                async def gone() -> bool:
                    try:
                        await attachments.staged_file_metadata(session_id="sess_t1", file_id=file_id)
                    except KeyError:
                        return True
                    return False

                await eventually(gone)

                # Opening it now reads the device's copy through Store/readBlob + the HTTP relay.
                device.state.blobs[file_id] = (data, "note.txt", "text/plain")
                opened = await client.get(f"/api/v2/sessions/sess_t1/attachments/{file_id}/open", headers=headers)
                assert opened.status_code == 200, opened.text
                assert opened.content == data
                assert opened.headers["content-type"].startswith("text/plain")
                assert "readBlob" in device.state.calls

                # A field the device moved to its blob store opens the same way.
                blob_id = "blob_" + "b" * 64
                device.state.blobs[blob_id] = (b"\x89PNG...", blob_id, "image/png")
                moved = await client.get(f"/api/v2/sessions/sess_t1/attachments/{blob_id}/open", headers=headers)
                assert moved.status_code == 200, moved.text
                assert moved.content == b"\x89PNG..." and moved.headers["content-type"] == "image/png"
                other = await client.get("/api/v2/sessions/sess_t1/attachments/x_unknown/open", headers=headers)
                assert other.status_code == 404

                # A transfer id cannot be reused or used by the wrong credentials.
                replay = await client.put(
                    "/api/v3/device/transfers/fsdl_nope",
                    content=b"x",
                    headers={"Authorization": f"Bearer {access}", "X-Transfer-Token": "nope"},
                )
                assert replay.status_code == 404
            finally:
                await device.stop()

            await eventually(lambda: offline(app.state.connector_presence, device_id))
            offline_open = await client.get(
                f"/api/v2/sessions/sess_t1/attachments/{file_id}/open", headers=headers
            )
            assert offline_open.status_code == 409
            assert offline_open.json()["detail"]["code"] == "connector_offline"

    asyncio.run(scenario())


def test_share_is_exported_by_the_device(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, device, _access = await _setup(app, client)
            try:
                image = b"\x89PNG fake image bytes"
                fake = device.state.session("sess_t1")
                fake.append(timeline_item("sess_t1", 1, "question"))
                answer = timeline_item("sess_t1", 2, "answer with a file")
                answer["content"]["attachments"] = [{"fileId": "file_shared1", "name": "a.png"}]
                fake.append(answer)
                device.state.blobs["file_shared1"] = (image, "a.png", "image/png")

                created = await client.post(
                    "/api/v2/sessions/sess_t1/shares", headers=headers, json={"scope": "session"}
                )
                assert created.status_code == 201, created.text
                share_id = created.json()["shareId"]
                public = await client.get(f"/api/v2/public/shares/{share_id}")
                assert public.status_code == 200, public.text
                assert [item["id"] for item in public.json()["items"]] == ["tl_1", "tl_2"]
                assert public.json()["session"]["title"] == "Fix the build"
                copy = await client.get(f"/api/v2/public/shares/{share_id}/attachments/file_shared1")
                assert copy.status_code == 200 and copy.content == image

                # A reply share only takes assistant messages.
                reply = await client.post(
                    "/api/v2/sessions/sess_t1/shares",
                    headers=headers,
                    json={"scope": "message", "itemIds": ["tl_2"]},
                )
                assert reply.status_code == 422

                # A selection the device refuses as too large is a 413 with its code.
                device.state.share_error = "share_too_large"
                too_large = await client.post(
                    "/api/v2/sessions/sess_t1/shares", headers=headers, json={"scope": "session"}
                )
                assert too_large.status_code == 413, too_large.text
                assert too_large.json()["detail"]["code"] == "share_too_large"
                device.state.share_error = None
            finally:
                await device.stop()

            await eventually(lambda: offline(app.state.connector_presence, device_id))
            refused = await client.post("/api/v2/sessions/sess_t1/shares", headers=headers, json={"scope": "session"})
            assert refused.status_code == 409
            assert refused.json()["detail"]["code"] == "share_requires_online_device"

    asyncio.run(scenario())
