from __future__ import annotations

import io

from PIL import Image
from test_backend_mvp import create_connector_and_session, make_client


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
