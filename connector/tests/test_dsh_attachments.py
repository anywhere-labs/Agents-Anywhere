from __future__ import annotations

import asyncio
import hashlib

import pytest

from connector.runtime_protocol import RuntimeAttachment, RuntimeAttachmentContent, RuntimeConfig, RuntimeInvalidRequestError
from connector.runtimes.dsh.attachments import staged_images
from connector.runtimes.dsh.runtime import DshRuntime


class Host:
    def __init__(self, content=b"image", fail_on=None):
        self.content = content
        self.fail_on = fail_on
        self.downloads = []

    async def attachment_download(self, session_id, file_id):
        self.downloads.append((session_id, file_id))
        if file_id == self.fail_on:
            raise OSError("download failed")
        return RuntimeAttachmentContent(file_id, "image.png", "image/png", self.content)


def image(file_id="file_image", content=b"image"):
    return RuntimeAttachment(file_id, "image.png", "image/png", len(content), hashlib.sha256(content).hexdigest())


def test_only_supported_images_download_and_stage(tmp_path):
    async def run():
        host = Host()
        for mime in ["application/pdf", "image/svg+xml", "image/avif", "application/octet-stream"]:
            with pytest.raises(RuntimeInvalidRequestError, match="only accepts"):
                async with staged_images(host, "session", (RuntimeAttachment("file_bad", media_type=mime),), tmp_path):
                    pytest.fail("must reject before staging")
        assert host.downloads == []
        async with staged_images(host, "session", (image(),), tmp_path) as refs:
            assert refs[0]["fileId"] == "file_image"
            path = tmp_path / "attachments/staging" / refs[0]["uploadId"]
            assert path.read_bytes() == b"image"
            assert "contentBase64" not in refs[0] and "path" not in refs[0]
        assert not path.exists()
    asyncio.run(run())


def test_failed_batch_and_checksum_mismatch_clean_up(tmp_path):
    async def run():
        host = Host(fail_on="file_second")
        with pytest.raises(OSError, match="download failed"):
            async with staged_images(host, "session", (image(), image("file_second")), tmp_path):
                pytest.fail("partial batches must not be submitted")
        assert list((tmp_path / "attachments/staging").iterdir()) == []
        with pytest.raises(RuntimeInvalidRequestError, match="content does not match"):
            async with staged_images(Host(b"other"), "session", (image(),), tmp_path):
                pytest.fail("corrupt download must be refused")
    asyncio.run(run())


def test_image_only_turn_keeps_large_bytes_out_of_rpc_and_cleans_up(tmp_path):
    content = b"x" * (9 * 1024 * 1024)

    class Runtime(DshRuntime):
        async def _request(self, method, params=None):
            if method == "runtime.getCapabilities":
                return {"capabilities": [{"capabilityId": "runtime.attachment", "supported": True, "available": True, "allowed": True}]}
            assert method == "session.startTurn" and params["content"] == ""
            reference = params["attachments"][0]
            path = tmp_path / "agents-anywhere/bridge/attachments/staging" / reference["uploadId"]
            assert path.read_bytes() == content
            assert len(str(params)) < 1024
            return {"accepted": True}

    async def run():
        runtime = Runtime(RuntimeConfig("dsh", 1, {"dshHome": str(tmp_path)}), Host(content))
        result = await runtime.start_turn("session", "native", "", attachments=(image(content=content),), client_message_id="message")
        assert result.ok
        assert list((tmp_path / "agents-anywhere/bridge/attachments/staging").iterdir()) == []
    asyncio.run(run())
