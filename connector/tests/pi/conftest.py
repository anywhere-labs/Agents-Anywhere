from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

import pytest

from connector.runtime_protocol import RuntimeAttachmentContent
from connector.runtime_protocol.host import RuntimeHostClient

FAKE_PNG_BYTES = b"\x89PNG\r\n\x1a\nfake-image-bytes"


class FakeHost(RuntimeHostClient):
    """Records every runtime -> connector callback for assertions."""

    def __init__(self) -> None:
        self.notices: list[Any] = []
        self.timeline_syncs: list[dict[str, Any]] = []
        self.timeline_items: list[Any] = []
        self.states: list[dict[str, Any]] = []
        self.metas: list[dict[str, Any]] = []
        self.turn_ends: list[dict[str, Any]] = []
        self.capability_sets: list[Any] = []
        self.attachment_downloads: list[dict[str, str]] = []
        self.sync_state: dict[str, Any] = {}

    @property
    def connector_id(self) -> str:
        return "test-connector"

    async def notice_upsert(self, notice: Any) -> None:
        self.notices.append(notice)

    async def timeline_sync(
        self,
        session_id: str,
        runtime: str,
        items: Any,
        external_session_id: str | None = None,
        complete: bool = False,
        metadata: Any = None,
    ) -> None:
        self.timeline_syncs.append(
            {
                "session_id": session_id,
                "runtime": runtime,
                "items": tuple(items),
                "external_session_id": external_session_id,
                "complete": complete,
            }
        )

    async def timeline_item_upsert(self, item: Any) -> None:
        self.timeline_items.append(item)

    async def session_state_update(self, session_id: str, runtime: str, **kwargs: Any) -> None:
        self.states.append({"session_id": session_id, "runtime": runtime, **kwargs})

    async def session_meta_upsert(self, session_id: str, runtime: str, **kwargs: Any) -> None:
        self.metas.append({"session_id": session_id, "runtime": runtime, **kwargs})

    async def session_turn_ended(self, session_id: str, runtime: str, **kwargs: Any) -> None:
        self.turn_ends.append({"session_id": session_id, "runtime": runtime, **kwargs})

    async def session_capabilities_update(self, capabilities: Any) -> None:
        self.capability_sets.append(capabilities)

    async def runtime_capabilities_update(self, capabilities: Any) -> None:
        self.capability_sets.append(capabilities)

    async def attachment_download(self, session_id: str, file_id: str) -> RuntimeAttachmentContent:
        self.attachment_downloads.append({"session_id": session_id, "file_id": file_id})
        return RuntimeAttachmentContent(
            file_id=file_id,
            name="test.png",
            media_type="image/png",
            content=FAKE_PNG_BYTES,
        )

    async def publish_runtime_notifications(
        self, runtime: str, notifications: list[dict[str, Any]], runtime_id: str | None = None
    ) -> None:
        return None

    async def sync_state_read(self, key: str) -> dict[str, Any] | None:
        return self.sync_state.get(key)

    async def sync_state_write(self, key: str, value: dict[str, Any]) -> None:
        self.sync_state[key] = dict(value)

    async def sync_state_delete(self, key: str) -> None:
        self.sync_state.pop(key, None)


@pytest.fixture
def fake_host() -> FakeHost:
    return FakeHost()


@pytest.fixture
def fake_pi(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An executable fake ``pi`` on PATH (under the name ``pi``)."""

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    script = bin_dir / "pi"
    shutil.copy(Path(__file__).parent / "fake_pi_rpc.py", script)
    script.chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("PI_FAKE_SESSIONS_DIR", str(tmp_path / "sessions"))
    return script


@pytest.fixture
def session_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "sessions" / "fake-session.jsonl"
    monkeypatch.setenv("PI_FAKE_SESSION_FILE", str(path))
    return path


async def wait_for(predicate, timeout: float = 8.0, interval: float = 0.02) -> None:
    import asyncio
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(interval)
    raise AssertionError("condition was not met before the timeout")
