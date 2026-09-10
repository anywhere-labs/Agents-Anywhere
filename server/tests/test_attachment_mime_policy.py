import asyncio

import pytest

from agent_server.services.session_run import SessionRunConflictError, SessionRunService


class Store:
    def __init__(self, metadata):
        self.metadata = metadata

    async def get_protocol_capabilities(self, connector_id, *, user_id):
        return {"revision": 1, "capabilities": [{
            "capabilityId": "runtime.attachment", "runtime": "dsh", "scope": "runtime",
            "supported": True, "available": True, "allowed": True, "metadata": self.metadata,
        }]}


def test_runtime_attachment_gate_uses_mime_metadata():
    async def run():
        service = SessionRunService(Store({"allowedMimeTypes": ["image/png", "image/jpeg", "image/webp", "image/gif"]}), None, None)
        await service._require_runtime_capability("connector", "dsh", "instance", "runtime.attachment", user_id="user",
                                                  attachment_media_types=["image/png", "IMAGE/JPEG"])
        for mime in ["application/pdf", "image/svg+xml", "image/avif", "application/octet-stream"]:
            with pytest.raises(SessionRunConflictError, match="attachment type is not supported"):
                await service._require_runtime_capability("connector", "dsh", "instance", "runtime.attachment", user_id="user",
                                                          attachment_media_types=[mime])
    asyncio.run(run())


@pytest.mark.parametrize("metadata, permitted", [({}, True), ({"allowedMimeTypes": []}, False), ({"allowedMimeTypes": None}, False), ({"allowedMimeTypes": ["image/*"]}, False)])
def test_missing_policy_is_compatible_but_empty_or_invalid_policy_refuses(metadata, permitted):
    async def run():
        service = SessionRunService(Store(metadata), None, None)
        request = service._require_runtime_capability("connector", "dsh", "instance", "runtime.attachment", user_id="user",
                                                      attachment_media_types=["application/pdf"])
        if permitted:
            await request
        else:
            with pytest.raises(SessionRunConflictError):
                await request
    asyncio.run(run())
