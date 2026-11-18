"""v3 end to end: a public share exported by a real TS Connector.

The same stack as ``test_v3_e2e.py`` (a real Server, Router and TS Connector with the fake ACP Agent):

- ``POST /sessions/{id}/shares`` calls ``Store/exportShare`` on the device; the public share shows the items the
  device exported and serves an uploaded attachment the Server copied back from the device through
  ``Store/readBlob`` (its staged copy is gone once the device took it);
- a reply share holds only the selected assistant message;
- with the device offline the Server refuses a new share and keeps serving the existing one.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from v3_e2e_harness import (
    E2E,
    STARTUP_TIMEOUT,
    create_project,
    e2e_environment,
    enable_fake_agent,
    new_session,
    skip_reason,
    wait_for,
    wait_session,
    wait_text,
)

pytestmark = pytest.mark.skipif(skip_reason() is not None, reason=skip_reason() or "")

PICTURE = b"\x89PNG\r\n\x1a\nshared picture bytes"


@pytest.fixture(scope="module")
def e2e(request: pytest.FixtureRequest) -> Iterator[E2E]:
    with e2e_environment(request) as env:
        env.wait_status("online", STARTUP_TIMEOUT)
        enable_fake_agent(env)
        create_project(env)
        yield env


def _timeline(e2e: E2E, session_id: str) -> list[dict[str, Any]]:
    return e2e.api.get(f"/sessions/{session_id}/timeline", params={"mode": "latest", "limit": 200})["items"]


def _staged_gone(e2e: E2E, session_id: str, file_id: str) -> bool:
    # Once the device stored the file it reports it consumed and the Server drops its staged copy.
    return not (e2e.root / "files" / session_id / f"{file_id}.bin").exists()


def test_share_is_exported_by_the_device_and_read_publicly(e2e: E2E) -> None:
    session_id = new_session(e2e, "share base")
    wait_text(e2e, session_id, "echo: share base")
    wait_session(e2e, session_id, "idle")
    uploaded = e2e.api.call(
        "POST", f"/sessions/{session_id}/attachments",
        files={"files": ("shot.png", PICTURE, "image/png")},
    ).json()["attachments"][0]
    file_id = uploaded["fileId"]
    sent = e2e.api.post(f"/sessions/{session_id}/runtime/messages", {
        "content": "look at the shot", "clientMessageId": f"cm_{uuid.uuid4().hex}",
        "attachments": [{"fileId": file_id}],
    })
    assert sent["ok"] is True, sent
    wait_text(e2e, session_id, "echo: look at the shot")
    wait_session(e2e, session_id, "idle")
    timeline = _timeline(e2e, session_id)
    wait_for(lambda: _staged_gone(e2e, session_id, file_id), 20, 0.2, "the staged copy dropped after the device took it")

    created = e2e.api.call("POST", f"/sessions/{session_id}/shares", expect=201, json={"scope": "session"}).json()
    assert created["scope"] == "session" and created["sharePath"] == f"/share/{created['shareId']}", created
    public = e2e.api.call("GET", f"/public/shares/{created['shareId']}").json()
    assert public["session"]["id"] == session_id
    assert [item["id"] for item in public["items"]] == [item["id"] for item in timeline]
    shared_texts = [str((item.get("content") or {}).get("text") or "") for item in public["items"]]
    assert any("echo: share base" in text for text in shared_texts), shared_texts
    assert any("echo: look at the shot" in text for text in shared_texts), shared_texts

    # The attachment the user sent is in the snapshot, and the Server copied its bytes from the device.
    referenced = {
        attachment.get("fileId")
        for item in public["items"]
        for attachment in (item.get("content") or {}).get("attachments") or []
    }
    assert file_id in referenced, public["items"]
    copy = e2e.api.call("GET", f"/public/shares/{created['shareId']}/attachments/{file_id}")
    assert copy.content == PICTURE
    assert copy.headers["content-type"].startswith("image/png")

    # A reply share holds only the selected assistant message.
    reply_id = next(
        item["id"] for item in reversed(timeline)
        if item["type"] == "message" and item["role"] == "assistant" and "look at the shot" in str(item["content"].get("text"))
    )
    reply = e2e.api.call("POST", f"/sessions/{session_id}/shares", expect=201,
                         json={"scope": "message", "itemIds": [reply_id]}).json()
    shared_reply = e2e.api.get(f"/public/shares/{reply['shareId']}")
    assert shared_reply["scope"] == "message"
    assert [item["id"] for item in shared_reply["items"]] == [reply_id]
    # A user message cannot be shared as a reply; an unknown item is not found.
    user_id = next(item["id"] for item in timeline if item["type"] == "message" and item["role"] == "user")
    refused = e2e.api.call("POST", f"/sessions/{session_id}/shares", expect=None,
                           json={"scope": "message", "itemIds": [user_id]})
    assert refused.status_code == 422, refused.text
    unknown = e2e.api.call("POST", f"/sessions/{session_id}/shares", expect=None,
                           json={"scope": "message", "itemIds": ["tl_nope"]})
    assert unknown.status_code == 404, unknown.text

    # Offline: no new share, the existing one still reads.
    e2e.device.stop()
    e2e.wait_status("offline", 30)
    offline = e2e.api.call("POST", f"/sessions/{session_id}/shares", expect=None, json={"scope": "session"})
    assert offline.status_code == 409, offline.text
    assert offline.json()["detail"]["code"] == "share_requires_online_device"
    still = e2e.api.get(f"/public/shares/{created['shareId']}")
    assert [item["id"] for item in still["items"]] == [item["id"] for item in timeline]
