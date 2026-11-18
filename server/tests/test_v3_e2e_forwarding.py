"""v3 end to end: the forwarded command routes that ``test_v3_e2e.py`` only touches in passing.

The same stack (a real Server, Router and TS Connector with the fake ACP Agent); every request below goes from the
Server to the device with ``Client/call``:

- ``POST /sessions/create-and-start``: the Server's directory row, inline attachments staged on the Server and fetched
  by the device, the receipt that answers a retry with the same session and refuses another request under its id;
- ``POST runtime/messages`` with an uploaded attachment (the Server's record goes to the device in ``server``);
- ``POST runtime/steer``: the device's refusals and the receipts that answer their retries;
- ``PATCH runtime/selections``: the batch, validation, read-only sessions.
"""

from __future__ import annotations

import base64
import time
import uuid
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from v3_e2e_harness import (
    E2E,
    RUNTIME_TYPE,
    STARTUP_TIMEOUT,
    create_project,
    e2e_environment,
    enable_fake_agent,
    session_meta,
    skip_reason,
    texts,
    wait_for,
    wait_session,
    wait_text,
)

pytestmark = pytest.mark.skipif(skip_reason() is not None, reason=skip_reason() or "")

# Bytes the fake Agent never decodes; the device only needs a non-empty file.
PICTURE = base64.b64encode(b"\x89PNG\r\n\x1a\nforwarded").decode()


@pytest.fixture(scope="module")
def e2e(request: pytest.FixtureRequest) -> Iterator[E2E]:
    with e2e_environment(request) as env:
        env.wait_status("online", STARTUP_TIMEOUT)
        enable_fake_agent(env)
        create_project(env)
        yield env


def _detail(response: httpx.Response) -> dict[str, Any]:
    detail = response.json()["detail"]
    return detail if isinstance(detail, dict) else {"message": detail}


def _create(e2e: E2E, content: str, client_message_id: str, **extra: Any) -> httpx.Response:
    return e2e.api.call("POST", "/sessions/create-and-start", expect=None, json={
        "connectorId": e2e.connector_id,
        "projectId": e2e.project_id,
        "runtime": RUNTIME_TYPE,
        "runtimeId": e2e.runtime_id,
        "content": content,
        "clientMessageId": client_message_id,
        **extra,
    })


def _project_sessions(e2e: E2E) -> list[dict[str, Any]]:
    return [s for s in e2e.api.get("/sessions")["sessions"] if s.get("projectId") == e2e.project_id]


def _new_session(e2e: E2E, content: str) -> str:
    created = _create(e2e, content, f"cm_{uuid.uuid4().hex}")
    assert created.status_code == 200, created.text
    session_id = created.json()["session"]["id"]
    wait_text(e2e, session_id, f"echo: {content}")
    wait_session(e2e, session_id, "idle")
    return session_id


def _steer(e2e: E2E, session_id: str, body: dict[str, Any]) -> httpx.Response:
    return e2e.api.call("POST", f"/sessions/{session_id}/runtime/steer", expect=None, json=body)


def _select(e2e: E2E, session_id: str, selections: dict[str, Any]) -> httpx.Response:
    return e2e.api.call("PATCH", f"/sessions/{session_id}/runtime/selections", expect=None,
                        json={"selections": selections})


def test_create_and_start_stages_attachments_and_replays_its_receipt(e2e: E2E) -> None:
    client_message_id = f"cm_{uuid.uuid4().hex}"
    picture = {"fileId": "inline_1", "name": "dot.png", "mediaType": "image/png", "contentBase64": PICTURE}
    before = len(_project_sessions(e2e))
    first = _create(e2e, "look at this", client_message_id, title="Forwarded", attachments=[picture])
    assert first.status_code == 200, first.text
    session_id = first.json()["session"]["id"]
    # The device fetched the staged file from the Server and gave it to the Agent with the text.
    wait_text(e2e, session_id, "echo: look at this [model=m1 permission=ask] sessions-in-cwd=1 attachments=1")
    meta = session_meta(e2e, session_id)
    assert meta["title"] == "Forwarded" and meta["takeover"] is True, meta
    assert meta["runtimeId"] == e2e.runtime_id and meta["cwd"] == str(e2e.device.workspace), meta

    # A retry is answered from the receipt: the same session, nothing created or sent again.
    again = _create(e2e, "look at this", client_message_id, title="Forwarded", attachments=[picture])
    assert again.status_code == 200, again.text
    assert again.json()["session"]["id"] == session_id
    assert len(_project_sessions(e2e)) == before + 1
    time.sleep(1)
    assert sum("echo: look at this" in text for text in texts(e2e, session_id)) == 1

    # Another request under the same id is a conflict, not a second session.
    conflict = _create(e2e, "something else", client_message_id)
    assert conflict.status_code == 409, conflict.text
    assert _detail(conflict)["code"] == "command_conflict"
    assert len(_project_sessions(e2e)) == before + 1


def test_a_message_carries_an_uploaded_attachment(e2e: E2E) -> None:
    session_id = _new_session(e2e, "plain start")
    uploaded = e2e.api.call(
        "POST", f"/sessions/{session_id}/attachments",
        files={"files": ("shot.png", base64.b64decode(PICTURE), "image/png")},
    ).json()["attachments"][0]
    sent = e2e.api.post(f"/sessions/{session_id}/runtime/messages", {
        "content": "with the upload", "clientMessageId": f"cm_{uuid.uuid4().hex}",
        "attachments": [{"fileId": uploaded["fileId"]}],
    })
    assert sent["ok"] is True, sent
    wait_text(e2e, session_id, "echo: with the upload [model=m1 permission=ask] sessions-in-cwd=2 attachments=1")
    # An attachment the Server does not hold is refused before anything reaches the device.
    missing = e2e.api.call("POST", f"/sessions/{session_id}/runtime/messages", expect=None, json={
        "content": "ghost", "clientMessageId": f"cm_{uuid.uuid4().hex}", "attachments": [{"fileId": "file_nope"}],
    })
    assert missing.status_code == 404, missing.text


def test_steer_refusals_and_their_receipts(e2e: E2E) -> None:
    session_id = _new_session(e2e, "steer base")
    idle = _steer(e2e, session_id, {"content": "too late", "clientMessageId": f"cm_{uuid.uuid4().hex}"})
    assert idle.status_code == 409, idle.text
    assert _detail(idle)["code"] == "session_not_running"

    e2e.api.post(f"/sessions/{session_id}/runtime/messages",
                 {"content": "#slow steered turn", "clientMessageId": f"cm_{uuid.uuid4().hex}"})
    wait_text(e2e, session_id, "working slowly")
    wait_session(e2e, session_id, "running")
    try:
        # The fake Agent (OpenCode's dialect) cannot steer: the device refuses and the receipt keeps the refusal.
        client_message_id = f"cm_{uuid.uuid4().hex}"
        body = {"content": "and also this", "clientMessageId": client_message_id}
        refused = _steer(e2e, session_id, body)
        assert refused.status_code == 409, refused.text
        assert _detail(refused)["code"] == "capability_unavailable"
        retried = _steer(e2e, session_id, body)
        assert retried.status_code == 409 and _detail(retried)["code"] == "capability_unavailable", retried.text
        conflict = _steer(e2e, session_id, {**body, "content": "something else"})
        assert conflict.status_code == 409 and _detail(conflict)["code"] == "command_conflict", conflict.text
        # An attachment the Server does not hold: refused by the Server.
        ghost = _steer(e2e, session_id, {"content": "ghost", "clientMessageId": f"cm_{uuid.uuid4().hex}",
                                         "attachments": [{"fileId": "file_nope"}]})
        assert ghost.status_code == 404, ghost.text
        assert session_meta(e2e, session_id)["status"] == "running"
    finally:
        e2e.api.post(f"/sessions/{session_id}/runtime/interrupt")
    wait_session(e2e, session_id, "idle")


def test_selections_batch_validation_and_read_only(e2e: E2E) -> None:
    session_id = _new_session(e2e, "select base")
    patched = _select(e2e, session_id, {"model": "m2", "permission": "auto"})
    assert patched.status_code == 200, patched.text
    assert patched.json()["state"]["selections"] == {"mode": "default", "model": "m2", "permission": "auto"}
    # The same batch again is a new command (no client id) and leaves the same state.
    again = _select(e2e, session_id, {"model": "m2", "permission": "auto"})
    assert again.status_code == 200 and again.json()["state"]["selections"]["model"] == "m2", again.text
    state = e2e.api.get(f"/sessions/{session_id}/runtime/state")["state"]
    assert state["selections"]["permission"] == "auto", state

    empty = _select(e2e, session_id, {})
    assert empty.status_code == 422, empty.text

    e2e.api.delete(f"/sessions/{session_id}/takeover")
    try:
        read_only = _select(e2e, session_id, {"model": "m1"})
        assert read_only.status_code == 409, read_only.text
        assert _detail(read_only)["code"] == "session_read_only"
    finally:
        e2e.api.post(f"/sessions/{session_id}/takeover")
    wait_for(lambda: session_meta(e2e, session_id)["takeover"] is True, 15, 0.2, "takeover back on")
    e2e.api.post(f"/sessions/{session_id}/runtime/messages",
                 {"content": "after the batch", "clientMessageId": f"cm_{uuid.uuid4().hex}"})
    wait_text(e2e, session_id, "echo: after the batch [model=m2 permission=auto]")


def _big_lines(count: int) -> str:
    return "\n".join(f"row {index}" for index in range(count))


def _read_blob(e2e: E2E, session_id: str, blob_ref: str, length: int) -> tuple[bytes, dict[str, Any]]:
    """Reads a device blob through ``GET /sessions/{id}/blobs/{ref}`` slice by slice."""

    parts: list[bytes] = []
    offset = 0
    while True:
        chunk = e2e.api.get(f"/sessions/{session_id}/blobs/{blob_ref}", params={"offset": offset, "length": length})
        assert chunk["offset"] == offset, chunk
        data = base64.b64decode(chunk["data"])
        parts.append(data)
        offset += len(data)
        if chunk["eof"]:
            assert offset == chunk["size"], chunk
            return b"".join(parts), chunk
        assert data, chunk


def test_spilled_tool_output_and_attachments_read_back_from_the_device(e2e: E2E) -> None:
    session_id = _new_session(e2e, "blob start")
    uploaded = e2e.api.call(
        "POST", f"/sessions/{session_id}/attachments",
        files={"files": ("shot.png", base64.b64decode(PICTURE), "image/png")},
    ).json()["attachments"][0]
    sent = e2e.api.post(f"/sessions/{session_id}/runtime/messages", {
        "content": "#big 9000 with a picture", "clientMessageId": f"cm_{uuid.uuid4().hex}",
        "attachments": [{"fileId": uploaded["fileId"]}],
    })
    assert sent["ok"] is True, sent
    wait_text(e2e, session_id, "echo: #big 9000 with a picture")
    timeline = e2e.api.get(f"/sessions/{session_id}/timeline")["items"]

    # The user message names its attachment, although the Agent never echoes attachments back.
    user = next(item for item in timeline if item["role"] == "user" and "#big 9000" in str(item["content"]))
    assert [a["fileId"] for a in user["content"].get("attachments", [])] == [uploaded["fileId"]], user
    assert user["content"]["attachments"][0]["name"] == "shot.png"
    # The attachment's bytes come from the device through the same route.
    picture, head = _read_blob(e2e, session_id, uploaded["fileId"], 1024 * 1024)
    assert picture == base64.b64decode(PICTURE) and head["mediaType"] == "image/png"

    # The tool's output and image moved to the device's blob store; the item keeps previews and refs.
    tool = next(item for item in timeline if item.get("blobRefs"))
    refs = {ref["mediaType"]: ref for ref in tool["blobRefs"]}
    text_ref, image_ref = refs["text/plain; charset=utf-8"], refs["image/png"]
    text, _ = _read_blob(e2e, session_id, text_ref["blobId"], 20_000)
    assert text.decode() == _big_lines(9000) and len(text) == text_ref["bytes"]
    image, _ = _read_blob(e2e, session_id, image_ref["blobId"], 1024 * 1024)
    assert image == bytes([7]) * 2048

    # Another session cannot read this session's blobs.
    other = _new_session(e2e, "blob other")
    foreign = e2e.api.call("GET", f"/sessions/{other}/blobs/{text_ref['blobId']}", expect=None)
    assert foreign.status_code == 404 and _detail(foreign)["code"] == "blob_not_found", foreign.text
