from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from connector.runtime_protocol import (
    CAPABILITY_CATALOG_PERMISSION,
    RuntimeAttachment,
    RuntimeAttachmentContent,
    RuntimeInvalidRequestError,
)
from connector.runtimes.pi.permissions import APPROVAL_EXTENSION_PATH, PERMISSION_MODES
from connector.runtimes.pi.runtime import PendingInteraction, platform_session_id
from connector.server.runtime_rpc_payloads import session_notice_payload

from .conftest import FAKE_PNG_BYTES, FakeHost, wait_for
from .test_runtime import make_runtime


def commands(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


PROTOCOL_SCHEMA = (
    Path(__file__).resolve().parents[3]
    / "contracts" / "protocol" / "1.0" / "schemas" / "session-snapshot-response.schema.json"
)


def contract_notice(notice) -> dict:
    """The notice.upsert payload, validated as the server's NoticeIn."""

    definitions = json.loads(PROTOCOL_SCHEMA.read_text(encoding="utf-8"))["$defs"]
    # The server validates source.runtime as any discovered runtime type; the
    # 1.0 schema still advertises only the original names.
    definitions["NoticeSource"]["properties"]["runtime"] = {"type": ["string", "null"]}
    payload = session_notice_payload(notice)
    Draft202012Validator({"$ref": "#/$defs/NoticeIn", "$defs": definitions}).validate(payload)
    return payload


def form_answer(*, option_ids: list[str] | None = None, text: str | None = None) -> dict:
    answer: dict = {"optionIds": option_ids or []}
    if text is not None:
        answer["customText"] = text
    return {"answers": {"answer": answer}}


async def test_streaming_before_settle_and_final_identity(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    monkeypatch.setenv("PI_FAKE_THINKING", "1")
    monkeypatch.setenv("PI_FAKE_TOOLS", "1")
    monkeypatch.setenv("PI_FAKE_STREAM_DELAY", "0.16")
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session(
            "stream", "hello", selections={"permission": "full-auto"}
        )
        await wait_for(
            lambda: any(i.content.get("text") == "reply " for i in fake_host.timeline_items)
        )
        assert not fake_host.timeline_syncs
        partial = await runtime.get_session_snapshot("stream", str(session_file))
        assert any(i.status == "running" for i in partial.items)
        inventory_id = platform_session_id(fake_host.session_namespace, str(session_file))
        inventory = await runtime.get_session_snapshot(inventory_id, str(session_file))
        assert any(i.status == "running" for i in inventory.items)
        assert all(i.session_id == inventory_id for i in inventory.items)
        await wait_for(lambda: len(fake_host.turn_ends) == 1)
        final = {i.id: i for i in fake_host.timeline_syncs[-1]["items"]}
        revisions: dict[str, int] = {}
        for item in fake_host.timeline_items:
            assert item.id in final
            assert item.revision > revisions.get(item.id, 0)
            assert final[item.id].revision >= item.revision
            assert final[item.id].order_seq == item.order_seq
            revisions[item.id] = item.revision
        assert any(
            i.content.get("kind") == "reasoning" and i.status == "running"
            for i in fake_host.timeline_items
        )
        assert any(
            i.content.get("output") == "partial output" and i.status == "running"
            for i in fake_host.timeline_items
        )
        assert any(
            i.content.get("output") == "tool complete" and i.status == "done"
            for i in final.values()
        )

        # A second run must keep first-turn markers and history IDs. A revived
        # process must use the transcript as its seed, not restart ordinals.
        await runtime.start_turn("stream", str(session_file), "again")
        await wait_for(lambda: runtime._live["stream"].is_streaming)
        snapshot = await runtime.get_session_snapshot("stream", str(session_file))
        assert any(i.type == "turn.end" and i.turn_id == "turn-1" for i in snapshot.items)
        await wait_for(lambda: len(fake_host.turn_ends) == 2)
        before = {i.id for i in fake_host.timeline_syncs[-1]["items"]}
        await runtime.stop()
        runtime = make_runtime(fake_pi, tmp_path, fake_host)
        await runtime.start()
        offset = len(fake_host.timeline_items)
        await runtime.start_turn("resumed", str(session_file), "after restart")
        await wait_for(lambda: len(fake_host.turn_ends) == 3)
        after = {i.id for i in fake_host.timeline_syncs[-1]["items"]}
        assert before <= after
        assert {i.id for i in fake_host.timeline_items[offset:]} <= after - before
    finally:
        await runtime.stop()


@pytest.mark.parametrize("action,allowed", [("approve", True), ("reject", False)])
async def test_tool_approval_roundtrip(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
    session_file: Path,
    monkeypatch,
    action: str,
    allowed: bool,
) -> None:
    log = tmp_path / "commands.jsonl"
    monkeypatch.setenv("PI_FAKE_COMMAND_LOG", str(log))
    monkeypatch.setenv("PI_FAKE_TOOLS", "1")
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("approval", "hello")
        await wait_for(lambda: bool(fake_host.notices))
        notice = (await runtime.get_session_notices("approval"))[0]
        assert notice.interaction_type == "approval"
        assert notice.severity == "warning"
        assert notice.context["toolName"] == "bash"
        assert notice.context["toolInput"] == {"command": "echo hello"}
        assert notice.context["turnId"] == "turn-1"
        assert {a["actionId"] for a in notice.actions} == {"approve", "reject"}
        assert (await runtime.get_session_state("approval")).status == "waiting_approval"
        result = await runtime.respond_interaction(
            "approval", notice.notice_id, action, {"confirmed": not allowed}
        )
        assert result.ok
        await wait_for(lambda: bool(fake_host.turn_ends))
        response = next(c for c in commands(log) if c["type"] == "extension_ui_response")
        assert response["confirmed"] is allowed
        resolved = next(n for n in fake_host.notices if n.status == "resolved")
        assert resolved.context["decision"] == ("approved" if allowed else "rejected")
        assert resolved.blocking is None and not resolved.actions
        tool = next(i for i in fake_host.timeline_syncs[-1]["items"] if i.type == "tool")
        assert tool.status == ("done" if allowed else "failed")
    finally:
        await runtime.stop()


async def test_permission_catalog_restart_and_persistence(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    log = tmp_path / "commands.jsonl"
    monkeypatch.setenv("PI_FAKE_COMMAND_LOG", str(log))
    monkeypatch.setenv("PI_FAKE_TOOLS", "1")
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        catalog = await runtime.list_permission_catalog()
        assert tuple(i.id for i in catalog.permissions) == PERMISSION_MODES
        assert [i.id for i in (await runtime.list_permission_catalog("read", 1)).permissions] == [
            "read-only"
        ]
        assert any(
            c.capability_id == CAPABILITY_CATALOG_PERMISSION
            for c in (await runtime.get_runtime_capabilities()).capabilities
        )
        await runtime.create_and_start_session("modes", "hello")
        await wait_for(lambda: bool(fake_host.notices))
        live = runtime._live["modes"]
        previous_pid = live.process.pid
        await runtime.update_session_selections(
            "modes",
            str(session_file),
            {"permission": "read-only", "model": "test:other-model", "thinkingLevel": "high"},
        )
        assert live.process.pid != previous_pid
        assert live.external_id == str(session_file)
        assert not await runtime.get_session_notices("modes")
        state = await runtime.get_session_state("modes")
        assert state.selections == {
            "permission": "read-only",
            "model": "test:other-model#high",
            "thinkingLevel": "high",
        }
        starts = [c for c in commands(log) if c["type"] == "startup"]
        assert [c["permissionMode"] for c in starts] == ["ask-writes", "read-only"]
        assert str(APPROVAL_EXTENSION_PATH) in starts[-1]["argv"]
        assert str(session_file) in starts[-1]["argv"]
        count = len(fake_host.notices)
        ended = len(fake_host.turn_ends)
        await runtime.start_turn("modes", None, "denied without asking")
        await wait_for(lambda: len(fake_host.turn_ends) > ended)
        assert len(fake_host.notices) == count
        assert any(
            i.type == "tool" and i.status == "failed" for i in fake_host.timeline_syncs[-1]["items"]
        )
        pid = live.process.pid
        with pytest.raises(RuntimeInvalidRequestError):
            await runtime.update_session_selections("modes", None, {"permission": "bad"})
        assert live.process.pid == pid
        await runtime.stop()
        runtime = make_runtime(fake_pi, tmp_path, fake_host)
        await runtime.start()
        inventory_id = platform_session_id(fake_host.session_namespace, str(session_file))
        state = await runtime.get_session_state(inventory_id, str(session_file))
        assert state.selections["permission"] == "read-only"
        ended = len(fake_host.turn_ends)
        await runtime.start_turn(inventory_id, str(session_file), "restored")
        await wait_for(lambda: len(fake_host.turn_ends) > ended)
        assert runtime._live[inventory_id].permission_mode == "read-only"
    finally:
        await runtime.stop()


@pytest.mark.parametrize("operation", ["create", "prompt", "steer"])
async def test_full_attachments_in_all_send_paths(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
    session_file: Path,
    monkeypatch,
    operation: str,
) -> None:
    log = tmp_path / "commands.jsonl"
    attachment_root = tmp_path / "attachments"
    monkeypatch.setenv("PI_FAKE_COMMAND_LOG", str(log))
    monkeypatch.setenv("AGENT_CONNECTOR_ATTACHMENTS_ROOT", str(attachment_root))

    async def download(session_id, file_id):
        if file_id == "broken":
            raise OSError("download unavailable")
        if file_id == "image":
            return RuntimeAttachmentContent(file_id, "image.png", "image/png", FAKE_PNG_BYTES)
        return RuntimeAttachmentContent(file_id, "readme.txt", "text/plain", b"attached text")

    monkeypatch.setattr(fake_host, "attachment_download", download)
    attachments = tuple(
        RuntimeAttachment(file_id=key, name=key) for key in ("broken", "text", "image")
    )
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        if operation == "create":
            await runtime.create_and_start_session(
                "files", "inspect", attachments=attachments, client_message_id="client-files"
            )
        elif operation == "prompt":
            await runtime.start_turn(
                "files", None, "inspect", attachments=attachments, client_message_id="client-files"
            )
        else:
            await runtime.create_and_start_session("files", "first")
            await wait_for(lambda: bool(fake_host.turn_ends))
            runtime._live["files"].is_streaming = True
            await runtime.steer_turn(
                "files", None, "inspect", attachments=attachments, client_message_id="client-files"
            )
        kind = "steer" if operation == "steer" else "prompt"
        await wait_for(
            lambda: any(
                c["type"] == kind and c.get("message", "").startswith("inspect")
                for c in commands(log)
            )
        )
        command = next(
            c
            for c in commands(log)
            if c["type"] == kind and c.get("message", "").startswith("inspect")
        )
        path = attachment_root / "files" / "text-readme.txt"
        assert path.read_bytes() == b"attached text"
        assert str(path) in command["message"]
        assert "readme.txt" in command["message"] and "text/plain" in command["message"]
        assert "size=13 bytes" in command["message"]
        assert "download failed" in command["message"]
        assert command["images"][0]["mimeType"] == "image/png"
        if operation != "steer":
            await wait_for(lambda: bool(fake_host.turn_ends))
            assert any(
                i.source.get("clientMessageId") == "client-files"
                for i in fake_host.timeline_syncs[-1]["items"]
            )
    finally:
        await runtime.stop()


@pytest.mark.parametrize(
    "method,interaction,action,data,expected",
    [
        ("confirm", "confirmation", "confirm", None, {"confirmed": True}),
        ("select", "input_request", "submit", form_answer(option_ids=["o_1"]), {"value": "beta"}),
        ("input", "input_request", "submit", form_answer(text="answer"), {"value": "answer"}),
        (
            "editor",
            "input_request",
            "submit",
            form_answer(text="  line one\nline two"),
            {"value": "  line one\nline two"},
        ),
        # Callers that answer with a direct value keep working.
        ("input", "input_request", "submit", {"text": "direct"}, {"value": "direct"}),
    ],
)
async def test_extension_dialogs_use_platform_interaction_contract(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
    session_file: Path,
    monkeypatch,
    method: str,
    interaction: str,
    action: str,
    data: dict | None,
    expected: dict,
) -> None:
    """The server only stores notices that validate as NoticeIn; a ``pi.*``
    interaction type was rejected and the dialog could never be answered."""

    log = tmp_path / "commands.jsonl"
    monkeypatch.setenv("PI_FAKE_COMMAND_LOG", str(log))
    monkeypatch.setenv("PI_FAKE_UI", method)
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("dialog", "hello")
        await wait_for(lambda: bool(fake_host.notices))
        notice = fake_host.notices[-1]
        payload = contract_notice(notice)
        assert payload["interactionType"] == interaction
        assert payload["context"]["method"] == method
        if interaction == "input_request":
            (submit,) = (a for a in payload["actions"] if a["actionId"] == "submit")
            ui = submit["input"]["uiSchema"]
            assert ui["component"] == "inputRequest" and ui["version"] == 1
            (question,) = ui["questions"]
            labels = [option["label"] for option in question["options"]]
            assert labels == (["alpha", "beta"] if method == "select" else [])
            assert question["allowCustom"] is (method != "select")
        assert (await runtime.respond_interaction("dialog", notice.notice_id, action, data)).ok
        await wait_for(lambda: bool(fake_host.turn_ends))
        (response,) = (c for c in commands(log) if c["type"] == "extension_ui_response")
        assert {key: response[key] for key in expected} == expected
        contract_notice(fake_host.notices[-1])
    finally:
        await runtime.stop()


def test_dialog_answers_are_validated_against_the_form() -> None:
    select = PendingInteraction(
        {"id": "r1", "method": "select", "title": "Pick", "options": ["alpha", " ", "beta"]}
    )
    contract_notice(select.as_notice("sess"))
    assert select.response_payload("submit", form_answer(option_ids=["o_2"]))["value"] == "beta"
    for invalid in (form_answer(option_ids=["o_1"]), form_answer(text="free text"), {}):
        with pytest.raises(RuntimeInvalidRequestError):
            select.response_payload("submit", invalid)
    assert select.response_payload("cancel", None) == {
        "type": "extension_ui_response",
        "id": "r1",
        "cancelled": True,
    }

    # A select without usable options still has to be answerable.
    empty = PendingInteraction({"id": "r2", "method": "select", "title": "Pick", "options": []})
    assert empty.response_payload("submit", form_answer(text="mine"))["value"] == "mine"

    text = PendingInteraction({"id": "r3", "method": "input", "title": "Name?"})
    with pytest.raises(RuntimeInvalidRequestError):
        text.response_payload("submit", form_answer())
