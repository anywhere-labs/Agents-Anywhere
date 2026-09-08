from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent_server.infra.files import LocalFileStorage, S3FileStorage


@pytest.mark.anyio
async def test_local_session_cleanup_removes_blobs_sidecars_and_partial_uploads(
    tmp_path,
):
    files = LocalFileStorage(tmp_path / "files")
    await files.write("session", "file_1", b"private", {"name": "notes"})
    await files.write("session-other", "file_1", b"keep", {})
    (files.root / "session" / "unfinished.bin").write_bytes(b"unfinished")

    await files.delete_session("session")
    await files.delete_session("session")

    assert not (files.root / "session").exists()
    assert (await files.read("session-other", "file_1"))[0] == b"keep"


@pytest.mark.anyio
async def test_session_cleanup_does_not_follow_symlinks_outside_storage(tmp_path):
    files = LocalFileStorage(tmp_path / "files")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "keep.txt").write_text("keep")
    (files.root / "session").symlink_to(outside, target_is_directory=True)

    await files.delete_session("session")

    assert not (files.root / "session").exists()
    assert (outside / "keep.txt").read_text() == "keep"


@pytest.mark.anyio
@pytest.mark.parametrize(
    "session_id", ["", ".", "..", "../outside", "/outside", "a\\b"]
)
async def test_session_cleanup_rejects_unsafe_storage_paths(tmp_path, session_id):
    files = LocalFileStorage(tmp_path / "files")
    with pytest.raises(ValueError, match="invalid file storage session id"):
        await files.delete_session(session_id)
    assert files.root.exists()


@pytest.mark.anyio
async def test_s3_session_cleanup_drains_all_pages_with_an_exact_session_prefix():
    class PagedClient:
        def __init__(self):
            self.keys = {f"uploads/session/file_{i}.bin" for i in range(1005)}
            self.keys.update(
                {"uploads/session/file_0.json", "uploads/session-other/keep.bin"}
            )
            self.pages = []

        async def list_objects(self, bucket, *, prefix):
            assert bucket == "attachments"
            assert prefix == "uploads/session/"
            page = sorted(key for key in self.keys if key.startswith(prefix))[:1000]
            self.pages.append(len(page))
            return [SimpleNamespace(key=key) for key in page]

        async def delete_object(self, bucket, key):
            assert bucket == "attachments"
            self.keys.discard(key)

    files = object.__new__(S3FileStorage)
    files._bucket = "attachments"
    files._prefix = "uploads"
    files._client = PagedClient()

    await files.delete_session("session")
    await files.delete_session("session")

    assert files._client.keys == {"uploads/session-other/keep.bin"}
    assert files._client.pages == [1000, 6, 0, 0]
