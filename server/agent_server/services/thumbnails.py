from __future__ import annotations

import asyncio
from pathlib import Path

THUMBNAIL_WIDTHS = (256, 512, 1024)
DEFAULT_THUMBNAIL_WIDTH = 512
_QUALITY = 76

_locks: dict[str, asyncio.Lock] = {}
# Decoding a 12 MP photo costs ~50 MB of pixels; cap how many run at once so a
# six-photo upload cannot balloon the worker while previews warm up.
_render_slots = asyncio.Semaphore(2)


def normalise_width(width: int | None) -> int:
    """Snap a requested width onto the nearest supported thumbnail size."""
    if not width or width <= 0:
        return DEFAULT_THUMBNAIL_WIDTH
    return min(THUMBNAIL_WIDTHS, key=lambda size: abs(size - width))


def thumbnail_path(blob: Path, width: int) -> Path:
    return blob.with_name(f"{blob.stem}.thumb-{width}.webp")


def _lock_for(path: Path) -> asyncio.Lock:
    key = str(path)
    lock = _locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _locks[key] = lock
    return lock


def _render(blob: Path, destination: Path, width: int) -> bool:
    """Decode one image off the event loop and write a small WebP beside it."""
    try:
        from PIL import Image, ImageOps
    except ModuleNotFoundError:  # pragma: no cover - pillow is a hard dependency
        return False
    temp = destination.with_name(destination.name + ".part")
    try:
        with Image.open(blob) as image:
            if getattr(image, "is_animated", False):
                return False
            # JPEG can decode at 1/2, 1/4 or 1/8 scale: a 12 MP phone photo
            # drops to ~1 MP before it ever reaches the RGB buffer.
            try:
                image.draft("RGB", (width * 2, width * 2))
            except Exception:
                pass
            image.load()
            image = ImageOps.exif_transpose(image)
            if image.width > width:
                height = max(1, round(image.height * width / image.width))
                image = image.resize((width, height), Image.LANCZOS)
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            image.save(temp, "WEBP", quality=_QUALITY, method=4)
        temp.replace(destination)
        return True
    except Exception:
        temp.unlink(missing_ok=True)
        return False


async def ensure_thumbnail(blob: Path, width: int = DEFAULT_THUMBNAIL_WIDTH) -> Path | None:
    """Return a WebP thumbnail for ``blob``, rendering it once on first use.

    Thumbnails sit next to the original as ``<file_id>.thumb-<width>.webp`` and
    are immutable, so the HTTP layer can hand them an ``immutable`` cache
    header. Rendering happens in a worker thread; a per-file lock keeps two
    concurrent readers from decoding the same photo twice.
    """
    if width not in THUMBNAIL_WIDTHS:
        width = normalise_width(width)
    destination = thumbnail_path(blob, width)
    if destination.is_file() and destination.stat().st_size > 0:
        return destination
    async with _lock_for(destination):
        if destination.is_file() and destination.stat().st_size > 0:
            return destination
        if not blob.is_file():
            return None
        async with _render_slots:
            rendered = await asyncio.to_thread(_render, blob, destination, width)
        return destination if rendered else None


def is_supported_media_type(media_type: str | None) -> bool:
    return bool(media_type) and media_type.split(";", 1)[0].strip().lower() in {
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/bmp",
        "image/tiff",
    }
