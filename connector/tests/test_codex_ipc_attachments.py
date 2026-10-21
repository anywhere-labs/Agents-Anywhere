from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

import pytest

from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeAttachmentContent,
    RuntimeSessionStateCache,
    SessionNotice,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.domain.pending_messages import (
    PendingClientMessageRegistry,
)
from connector.runtimes.codex.ipc import (
    CodexIpcOwnerService,
    CodexIpcTurnController,
    FollowedThread,
    IpcRequest,
    IpcResponse,
)
from connector.runtimes.codex.ipc.control import turn_input
from connector.runtimes.codex.sdk.runtime_client import (
    CodexStartTurnRequest,
    CodexTurnInputAttachment,
    CodexTurnResult,
)

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="Codex IPC uses Unix sockets"
)

THREAD = "01a124e5-815c-7e42-aea7-25d46a8450c3"


def test_turn_input_places_images_and_file_notes() -> None:
    items = turn_input(
        "看看这两个文件",
        (
            CodexTurnInputAttachment(name="shot.png", path="/tmp/a/shot.png", media_type="image/png", byte_size=10),
            CodexTurnInputAttachment(name="notes.txt", path="/tmp/a/notes.txt", media_type="text/plain", byte_size=20),
        ),
    )
    assert items[0]["type"] == "text"
    assert items[0]["text"].startswith("看看这两个文件\n\n[Attached file: notes.txt (text/plain, 20 bytes) at /tmp/a/notes.txt]")
    assert items[1] == {"type": "localImage", "path": "/tmp/a/shot.png"}
    assert turn_input("hi") == [{"type": "text", "text": "hi", "text_elements": []}]


class _Host(RuntimeHostClient):
    def __init__(self, root: Path) -> None:
        self.root = root
        self.downloads: list[str] = []

    @property
    def connector_id(self) -> str:
        return "conn_test"

    async def attachment_download(self, session_id: str, file_id: str) -> RuntimeAttachmentContent:
        self.downloads.append(file_id)
        if file_id == "img":
            return RuntimeAttachmentContent(file_id=file_id, name="shot.png", media_type="image/png", content=b"\x89PNG")
        return RuntimeAttachmentContent(file_id=file_id, name="notes.txt", media_type="text/plain", content=b"hello")

    async def session_state_update(self, *a, **k):
        pass

    async def session_capabilities_update(self, c):
        pass

    async def notice_upsert(self, notice: SessionNotice) -> None:
        pass


class _Client:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.client_id = "self"

    async def request(self, method, params, *, target_client_id=None, host_id=None, timeout_ms=None):
        self.calls.append((method, params))
        return IpcResponse(request_id="r", result_type="success", method=method, handled_by_client_id=target_client_id, result={"result": {"turn": {"id": "turn-x"}}})


class _Follower:
    def __init__(self, thread: FollowedThread) -> None:
        self.thread = thread

    def get(self, thread_id: str):
        return self.thread if thread_id == THREAD else None


def test_controller_materialises_attachments_for_ipc_turns(monkeypatch: pytest.MonkeyPatch) -> None:
    root = Path(tempfile.mkdtemp(prefix="aa-ipca-", dir="/tmp"))
    try:
        from connector.runtimes.codex.turns import attachments as attachment_module

        monkeypatch.setattr(
            attachment_module,
            "attachment_target",
            lambda session_id, file_id, name: root / session_id / file_id / name,
        )

        async def run() -> None:
            host = _Host(root)
            client = _Client()
            thread = FollowedThread(thread_id=THREAD, status="following", owner_client_id="owner", revision=1, state={"cwd": "/w", "currentPermissions": {}})
            controller = CodexIpcTurnController(
                client=client,  # type: ignore[arg-type]
                follower=_Follower(thread),  # type: ignore[arg-type]
                host=host,
                session_states=RuntimeSessionStateCache("codex", host),
                active_turn_ids={},
                notices=CodexNoticeRegistry(),
                pending_messages=PendingClientMessageRegistry(connector_id="conn_test"),
            )
            result = await controller.start_turn(
                "sess_1",
                thread,
                "看看",
                attachments=(RuntimeAttachment(file_id="img", name="shot.png", media_type="image/png"), RuntimeAttachment(file_id="doc", name="notes.txt", media_type="text/plain")),
                client_message_id="cm-1",
            )
            assert result.ok and result.result["attachments"] == 2
            assert host.downloads == ["img", "doc"]
            request = client.calls[-1][1]["turnStart"]["request"]
            text_item, image_item = request["input"]
            assert text_item["text"].startswith("看看\n\n[Attached file: notes.txt (text/plain, 5 bytes) at ")
            assert image_item["type"] == "localImage"
            assert image_item["path"].endswith("/sess_1/img/shot.png")
            assert Path(image_item["path"]).read_bytes() == b"\x89PNG"

            steer = await controller.steer_turn("sess_1", thread, "再看", attachments=(RuntimeAttachment(file_id="img", name="shot.png", media_type="image/png"),), client_message_id="cm-2")
            assert steer.ok
            assert client.calls[-1][1]["input"][1]["type"] == "localImage"

        asyncio.run(run())
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_owner_turns_local_images_into_sdk_attachments() -> None:
    async def run() -> None:
        calls: list[CodexStartTurnRequest] = []

        class Sdk:
            async def start_turn(self, request: CodexStartTurnRequest) -> CodexTurnResult:
                calls.append(request)
                return CodexTurnResult(turn_id="t", payload={"turn": {"id": "t"}})

        class Ipc:
            client_id = "self"

            def add_request_handler(self, *a, **k):
                return lambda: None

            def add_broadcast_handler(self, *a, **k):
                return lambda: None

        host = _Host(Path("/tmp"))
        states = RuntimeSessionStateCache("codex", host)
        owner = CodexIpcOwnerService(
            client=Ipc(),  # type: ignore[arg-type]
            sdk=Sdk(),  # type: ignore[arg-type]
            session_states=states,
            notices=CodexNoticeRegistry(),
            active_turn_ids={},
            session_id_for=lambda tid: codex_sessions.stable_session_id("conn_test", tid),
        )
        request = IpcRequest(
            request_id="r",
            method="thread-follower-start-turn",
            params={
                "conversationId": THREAD,
                "turnStart": {
                    "request": {
                        "threadId": THREAD,
                        "input": [
                            {"type": "text", "text": "描述图片"},
                            {"type": "localImage", "path": "/tmp/pics/shot.png"},
                        ],
                        "clientUserMessageId": "w-1",
                    }
                },
            },
            version=2,
        )
        response = await owner._handle_follower(request)
        assert response["result"]["turn"]["id"] == "t"
        sent = calls[-1]
        assert sent.content == "描述图片"
        assert [(a.name, a.path, a.media_type) for a in sent.attachments] == [("shot.png", "/tmp/pics/shot.png", "image/png")]

    asyncio.run(run())

