from __future__ import annotations

import asyncio
import gc
import io

from PIL import Image
from test_backend_mvp import create_connector_and_session, make_client

from agent_server.services import thumbnails


def _png(width: int, height: int) -> bytes:
    image = Image.radial_gradient("L").resize((width, height)).convert("RGB")
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def test_attachment_thumbnail_renders_webp_and_is_cacheable(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)
    data = _png(1600, 1200)

    upload = client.post(
        f"/sessions/{session_id}/attachments",
        headers=headers,
        files={"files": ("photo.png", data, "image/png")},
    )

    assert upload.status_code == 200
    body = upload.json()["attachments"][0]
    assert body["thumbnailUrl"].endswith("/thumb?w=512")

    thumbnail = client.get(body["thumbnailUrl"], headers=headers)

    assert thumbnail.status_code == 200
    assert thumbnail.headers["content-type"] == "image/webp"
    assert thumbnail.headers["cache-control"] == "private, max-age=31536000, immutable"
    assert len(thumbnail.content) < len(data) // 4
    with Image.open(io.BytesIO(thumbnail.content)) as rendered:
        assert rendered.size == (512, 384)

    cached = client.get(
        body["thumbnailUrl"],
        headers={**headers, "If-None-Match": thumbnail.headers["etag"]},
    )
    assert cached.status_code == 304


def test_attachment_thumbnail_is_not_offered_for_unreadable_images(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)
    data = b"\x00definitely-not-an-image"

    upload = client.post(
        f"/sessions/{session_id}/attachments",
        headers=headers,
        files={"files": ("broken.png", data, "image/png")},
    )

    assert upload.status_code == 200
    body = upload.json()["attachments"][0]
    assert body["thumbnailUrl"]
    assert client.get(body["thumbnailUrl"], headers=headers).status_code == 404


def test_streamed_attachment_reads_reject_tampered_blob(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_SERVER_FILES_LOCAL_ROOT", str(tmp_path / "files"))
    client = make_client(tmp_path)
    _, connector_token, session_id, headers = create_connector_and_session(client)
    data = _png(64, 48)

    upload = client.post(
        f"/sessions/{session_id}/attachments",
        headers=headers,
        files={"files": ("photo.png", data, "image/png")},
    )
    assert upload.status_code == 200
    body = upload.json()["attachments"][0]
    blob = tmp_path / "files" / session_id / f"{body['fileId']}.bin"
    # Same length, different bytes: only the hash can tell.
    blob.write_bytes(bytes(byte ^ 0xFF for byte in data))

    assert client.get(body["openUrl"], headers=headers).status_code == 500
    connector_download = client.get(
        f"/api/v2/connector/sessions/{session_id}/attachments/{body['fileId']}/content",
        headers={"Authorization": f"Bearer {connector_token}"},
    )
    assert connector_download.status_code == 500


def test_attachment_thumbnail_skips_images_over_pixel_budget(tmp_path, monkeypatch):
    monkeypatch.setattr(thumbnails, "_MAX_THUMBNAIL_PIXELS", 1_000)
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)

    upload = client.post(
        f"/sessions/{session_id}/attachments",
        headers=headers,
        files={"files": ("photo.png", _png(1600, 1200), "image/png")},
    )

    assert upload.status_code == 200
    thumbnail_url = upload.json()["attachments"][0]["thumbnailUrl"]
    assert client.get(thumbnail_url, headers=headers).status_code == 404


def test_ensure_thumbnail_releases_per_file_locks(tmp_path):
    blob = tmp_path / "file_demo.bin"
    blob.write_bytes(_png(800, 600))

    async def render_concurrently():
        return await asyncio.gather(
            *(thumbnails.ensure_thumbnail(blob, 256) for _ in range(3))
        )

    results = asyncio.run(render_concurrently())

    assert results == [thumbnails.thumbnail_path(blob, 256)] * 3
    gc.collect()
    assert len(thumbnails._locks) == 0


def test_large_jpeg_gets_thumbnail_after_draft_decode(tmp_path):
    blob = tmp_path / "file_photo.bin"
    # 48 MP is over the pixel budget, but JPEG decodes at 1/4 scale here.
    Image.new("RGB", (8000, 6000), (120, 80, 40)).save(blob, "JPEG")

    thumb = asyncio.run(thumbnails.ensure_thumbnail(blob, 512))

    assert thumb == thumbnails.thumbnail_path(blob, 512)
    with Image.open(thumb) as rendered:
        assert rendered.size == (512, 384)
