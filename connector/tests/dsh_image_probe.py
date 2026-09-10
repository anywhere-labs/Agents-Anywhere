"""Real Connector/Bridge image probe, run only against the TS fixture's private home."""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
from pathlib import Path

from connector.runtime_protocol import RuntimeAttachment, RuntimeAttachmentContent, RuntimeConfig, RuntimeInvalidRequestError
from connector.runtimes.dsh.bridge.client import BridgeClient
from connector.runtimes.dsh.discovery import load_endpoint
from connector.runtimes.dsh.runtime import DshRuntime


class Host:
    connector_id = "image-wire"
    session_namespace = "image-wire"

    def __init__(self, content: bytes):
        self.content = content
        self.downloads = 0

    async def attachment_download(self, session_id, file_id):
        assert session_id == "sess_python_image" and file_id in {"file_wire", "file_note"}
        self.downloads += 1
        if file_id == "file_note":
            return RuntimeAttachmentContent(file_id, "notes.txt", "text/plain", b"platform file")
        return RuntimeAttachmentContent(file_id, "input.png", "image/png", self.content)


async def ignore(*args):
    pass


async def main(home: Path, selections: dict[str, str]) -> None:
    host = Host((home / "input.png").read_bytes())
    values = {"dshHome": str(home), "defaultAgentPreset": "standard"}
    runtime = DshRuntime(RuntimeConfig("dsh", 1, values), host)
    # Exercise the real transport and adapter without an unrelated platform sync consumer.
    client = BridgeClient(endpoint=load_endpoint(values), connector_id=host.connector_id,
                          session_namespace=host.session_namespace, client_version="1.0",
                          startup_timeout=5, request_timeout=10,
                          notification_handler=ignore, exit_handler=ignore)
    await client.start()
    runtime._client = client
    image = RuntimeAttachment("file_wire", "input.png", "image/png", len(host.content), hashlib.sha256(host.content).hexdigest())
    document = RuntimeAttachment("file_note", "notes.txt", "text/plain", 13, hashlib.sha256(b"platform file").hexdigest())
    try:
        caps = await runtime.get_runtime_capabilities()
        capability = next(item for item in caps.capabilities if item.capability_id == "runtime.attachment")
        assert capability.supported and capability.allowed and capability.available
        assert "allowedMimeTypes" not in capability.metadata
        for _ in range(2):
            created = await runtime.create_and_start_session("sess_python_image", "", cwd=str(home),
                selections=selections, attachments=(image, document), client_message_id="image-only")
            assert created.ok, created
            assert list((home / "agents-anywhere/bridge/attachments/staging").iterdir()) == []
        external = created.result["externalSessionId"]
        assert (await runtime.start_turn("sess_python_image", external, "text still works", client_message_id="text")).ok
        for _ in range(100):
            snapshot = await runtime.get_session_snapshot("sess_python_image", external)
            users = [item for item in snapshot.items if item.role == "user"]
            if len(users) == 2:
                break
            await asyncio.sleep(0.02)
        assert len(users) == 2
        assert users[0].content["text"] == ""
        assert users[0].content["attachments"][0]["fileId"] == "file_wire"
        assert users[1].content["text"] == "text still works"
        assert users[0].content["attachments"][1]["fileId"] == "file_note"
        assert host.downloads == 4
    finally:
        await runtime.stop()
    print("DSH image integration passed")


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1]), json.loads(sys.argv[2])))
