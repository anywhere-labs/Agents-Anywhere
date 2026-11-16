from __future__ import annotations

import asyncio
import gc
import io

from PIL import Image

from agent_server.services import thumbnails


def _png(width: int, height: int) -> bytes:
    image = Image.radial_gradient("L").resize((width, height)).convert("RGB")
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


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
