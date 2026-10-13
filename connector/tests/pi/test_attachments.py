from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from connector.runtime_protocol import RuntimeAttachment, RuntimeAttachmentContent
from connector.runtime_protocol.attachments import attachment_target
from connector.runtimes.pi.attachments import MAX_INLINE_TEXT_BYTES, prepare_attachments

from .conftest import FAKE_PNG_BYTES, FakeHost


class AttachmentHost(FakeHost):
    def __init__(self, results: dict[str, RuntimeAttachmentContent | Exception]) -> None:
        super().__init__()
        self.results = results

    async def attachment_download(self, session_id: str, file_id: str) -> RuntimeAttachmentContent:
        self.attachment_downloads.append({"session_id": session_id, "file_id": file_id})
        result = self.results[file_id]
        if isinstance(result, Exception):
            raise result
        return result


@pytest.fixture
def attachment_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "attachments"
    monkeypatch.setenv("AGENT_CONNECTOR_ATTACHMENTS_ROOT", str(root))
    return root


async def test_mixed_attachments_keep_images_and_save_other_files(attachment_store: Path) -> None:
    host = AttachmentHost(
        {
            "image": RuntimeAttachmentContent("image", "photo.png", "image/png", FAKE_PNG_BYTES),
            "text": RuntimeAttachmentContent("text", "notes.txt", "text/plain", b"hello\nworld"),
            "binary": RuntimeAttachmentContent(
                "binary", "sample.bin", "application/octet-stream", b"\x00\xff\x01"
            ),
        }
    )
    images, note = await prepare_attachments(
        host,
        "session",
        (
            RuntimeAttachment("image", media_type="application/octet-stream"),
            RuntimeAttachment("text", name="old-name", size=999),
            RuntimeAttachment("binary"),
        ),
    )

    assert images == (
        {
            "type": "image",
            "data": base64.b64encode(FAKE_PNG_BYTES).decode("ascii"),
            "mimeType": "image/png",
        },
    )
    assert len(host.attachment_downloads) == 3
    for file_id, name, content in (
        ("text", "notes.txt", b"hello\nworld"),
        ("binary", "sample.bin", b"\x00\xff\x01"),
    ):
        target = attachment_target("session", file_id, name)
        assert target.is_absolute()
        assert target.read_bytes() == content
        assert f"path={json.dumps(str(target))}" in note
        assert f"name={json.dumps(name)}" in note
        assert f"size={len(content)} bytes" in note
    assert 'mediaType="text/plain"' in note
    assert 'mediaType="application/octet-stream"' in note
    assert "```text\nhello\nworld\n```" in note
    assert "size=999" not in note
    assert len(list(attachment_store.rglob("*.*"))) == 2


async def test_download_and_write_failures_allow_remaining_attachments(
    attachment_store: Path, caplog: pytest.LogCaptureFixture
) -> None:
    attachment_store.mkdir()
    blocked = attachment_target("session", "blocked", "blocked.txt")
    blocked.mkdir(parents=True)
    host = AttachmentHost(
        {
            "missing": OSError("secret attachment content"),
            "blocked": RuntimeAttachmentContent("blocked", "blocked.txt", "text/plain", b"hidden"),
            "good": RuntimeAttachmentContent("good", "good.txt", "text/plain", b"delivered"),
        }
    )

    images, note = await prepare_attachments(
        host, "session", tuple(RuntimeAttachment(file_id) for file_id in host.results)
    )

    assert images == ()
    assert "download failed (OSError)" in note
    assert "local save failed (ValueError)" in note
    assert attachment_target("session", "good", "good.txt").read_bytes() == b"delivered"
    assert len(host.attachment_downloads) == 3
    assert "secret attachment content" not in note + caplog.text
    assert "hidden" not in caplog.text


async def test_untrusted_names_are_sanitized_and_metadata_stays_on_one_line(
    attachment_store: Path,
) -> None:
    name = '../../outside\\evil"\n```\n.txt'
    host = AttachmentHost(
        {"../../file": RuntimeAttachmentContent("../../file", name, "text/plain", b"safe")}
    )

    _, note = await prepare_attachments(host, "../../session", (RuntimeAttachment("../../file"),))

    files = [path for path in attachment_store.rglob("*") if path.is_file()]
    assert len(files) == 1
    assert files[0].parent == attachment_store / "session"
    assert files[0].read_bytes() == b"safe"
    assert json.dumps(name, ensure_ascii=False) in note


@pytest.mark.parametrize("symlink_kind", ["session", "file"])
async def test_symlink_targets_cannot_escape_attachment_store(
    attachment_store: Path, tmp_path: Path, symlink_kind: str
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    victim = outside / "victim.txt"
    victim.write_bytes(b"keep")
    target = attachment_target("session", "file", "note.txt")
    attachment_store.mkdir()
    if symlink_kind == "session":
        target.parent.symlink_to(outside, target_is_directory=True)
    else:
        target.parent.mkdir()
        target.symlink_to(victim)
    host = AttachmentHost(
        {"file": RuntimeAttachmentContent("file", "note.txt", "text/plain", b"overwrite")}
    )

    images, note = await prepare_attachments(host, "session", (RuntimeAttachment("file"),))

    assert images == ()
    assert "local save failed (ValueError)" in note
    assert victim.read_bytes() == b"keep"
    assert list(outside.iterdir()) == [victim]


async def test_repeated_attachment_does_not_overwrite_an_existing_file(
    attachment_store: Path,
) -> None:
    host = AttachmentHost(
        {"file": RuntimeAttachmentContent("file", "note.txt", "text/plain", b"first")}
    )
    await prepare_attachments(host, "session", (RuntimeAttachment("file"),))
    host.results["file"] = RuntimeAttachmentContent("file", "note.txt", "text/plain", b"second")

    _, note = await prepare_attachments(host, "session", (RuntimeAttachment("file"),))

    files = list((attachment_store / "session").iterdir())
    assert len(files) == 2
    assert sorted(path.read_bytes() for path in files) == [b"first", b"second"]
    second = next(path for path in files if path.read_bytes() == b"second")
    assert json.dumps(str(second)) in note


@pytest.mark.parametrize(
    ("content", "inlined"),
    [
        (b"a" * MAX_INLINE_TEXT_BYTES, True),
        (b"a" * (MAX_INLINE_TEXT_BYTES + 1), False),
        (("\u00e9" * (MAX_INLINE_TEXT_BYTES // 2 + 1)).encode("utf-8"), False),
        (b"not UTF-8: \xff", False),
        (b"binary\x00data", False),
    ],
)
async def test_inline_text_is_bounded_by_bytes_and_valid_utf8(
    attachment_store: Path, content: bytes, inlined: bool
) -> None:
    host = AttachmentHost(
        {"file": RuntimeAttachmentContent("file", "note.txt", "text/plain", content)}
    )

    _, note = await prepare_attachments(host, "session", (RuntimeAttachment("file"),))

    assert attachment_target("session", "file", "note.txt").read_bytes() == content
    assert ("UTF-8 attachment content" in note) is inlined
    assert f"size={len(content)} bytes" in note


async def test_inline_fence_cannot_be_closed_by_attachment_content(attachment_store: Path) -> None:
    content = b"```\nuntrusted text\n``````\nend"
    host = AttachmentHost(
        {"file": RuntimeAttachmentContent("file", "note.md", "text/markdown", content)}
    )

    _, note = await prepare_attachments(host, "session", (RuntimeAttachment("file"),))

    assert f"```````text\n{content.decode()}\n```````" in note


async def test_no_attachments_need_no_note_or_storage(attachment_store: Path) -> None:
    host = AttachmentHost({})
    assert await prepare_attachments(host, "session", ()) == ((), "")
    assert host.attachment_downloads == []
    assert not attachment_store.exists()
