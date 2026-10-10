"""Edge cases of the live Pi session: restarts, receipts, background results."""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

import pytest

from connector.runtime_protocol import RuntimeAttachment, RuntimeAttachmentContent
from connector.runtimes.pi import runtime as pi_runtime
from connector.runtimes.pi import sessions
from connector.runtimes.pi.rpc import PiRpcError
from connector.runtimes.pi.runtime import PiSessionRetired, platform_session_id

from .conftest import FAKE_PNG_BYTES, FakeHost, wait_for
from .test_runtime import make_runtime
from .test_runtime_features import commands, contract_notice


def startups(log: Path) -> list[dict]:
    return [c for c in commands(log) if c["type"] == "startup"]


async def test_a_permission_restart_cannot_be_raced_by_another_start(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    log = tmp_path / "commands.jsonl"
    monkeypatch.setenv("PI_FAKE_COMMAND_LOG", str(log))
    monkeypatch.setenv("PI_FAKE_EXIT_DELAY", "0.5")
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("race", "hi")
        await wait_for(lambda: bool(fake_host.turn_ends))
        live = runtime._live["race"]
        switch = asyncio.create_task(
            runtime.update_session_selections("race", None, {"permission": "read-only"})
        )
        # While the old process is shutting down, another request needs one.
        await wait_for(lambda: live.process is None)
        await runtime.list_commands("race")
        await switch
        started = startups(log)
        assert [s["permissionMode"] for s in started[1:]] == ["read-only"]
        assert runtime._live["race"].alive
    finally:
        await runtime.stop()


async def test_a_new_session_without_its_identity_fails_to_start(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, monkeypatch
) -> None:
    monkeypatch.setenv("PI_FAKE_GET_STATE_FAIL", "1")
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        with pytest.raises(PiRpcError):
            await runtime.create_and_start_session("blind", "hi")
        # No process is left behind that later calls would take as started.
        live = runtime._live["blind"]
        assert live.process is None
    finally:
        await runtime.stop()


async def test_receipts_keep_each_message_its_own_attachments(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    monkeypatch.setenv("AGENT_CONNECTOR_ATTACHMENTS_ROOT", str(tmp_path / "attachments"))
    # Pi appends image notes to the text, so it differs from what was sent.
    monkeypatch.setenv("PI_FAKE_IMAGE_HINT", "1")

    async def download(session_id, file_id):
        return RuntimeAttachmentContent(file_id, f"{file_id}.png", "image/png", FAKE_PNG_BYTES)

    monkeypatch.setattr(fake_host, "attachment_download", download)
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("pics", "first")
        await wait_for(lambda: bool(fake_host.turn_ends))
        for client_id, file_id in (("c1", "img-a"), ("c2", "img-b")):
            ended = len(fake_host.turn_ends)
            await runtime.start_turn(
                "pics",
                None,
                "look",  # the same text and the same image placeholder
                attachments=(RuntimeAttachment(file_id=file_id, media_type="image/png"),),
                client_message_id=client_id,
            )
            await wait_for(lambda ended=ended: len(fake_host.turn_ends) > ended)

        def shown(items) -> list[tuple[str, str, list[str]]]:
            return [
                (
                    item.source.get("clientMessageId"),
                    item.content["text"],
                    [a["fileId"] for a in item.content.get("attachments", [])],
                )
                for item in items
                if item.role == "user" and item.content.get("attachments")
            ]

        expected = [("c1", "look", ["img-a"]), ("c2", "look", ["img-b"])]
        assert shown(fake_host.timeline_syncs[-1]["items"]) == expected
        await runtime.stop()
        runtime = make_runtime(fake_pi, tmp_path, fake_host)
        await runtime.start()
        session_id = platform_session_id(fake_host.session_namespace, str(session_file))
        snapshot = await runtime.get_session_snapshot(session_id, str(session_file))
        assert shown(snapshot.items) == expected
    finally:
        await runtime.stop()


async def test_receipts_with_attachments_outlive_the_binding_limit(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost
) -> None:
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    path = str(tmp_path / "sessions" / "long.jsonl")
    display = {"text": "look", "attachments": [{"fileId": "f1"}]}
    await runtime._persist_receipt(path, "1", {"clientMessageId": "c1", "display": display})
    for n in range(2, 260):
        await runtime._persist_receipt(path, str(n), {"clientMessageId": f"c{n}"})
    runtime._receipts.clear()  # as after a restart
    receipts = await runtime._load_receipts(path)
    assert receipts["1"]["display"] == display
    assert len([r for r in receipts.values() if "display" not in r]) == (
        pi_runtime.MAX_CLIENT_MESSAGE_BINDINGS_PER_SESSION
    )


async def test_a_command_is_in_flight_from_submission(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    monkeypatch.setattr(pi_runtime, "PROMPT_ACCEPT_SECONDS", 5.0)
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("slow", "hi")
        await wait_for(lambda: bool(fake_host.turn_ends))
        live = runtime._live["slow"]
        task = asyncio.create_task(runtime.execute_command("slow", "hold-sleep", raw="/hold-sleep 1.5"))
        await wait_for(lambda: bool(live.pending_prompts))
        assert live.busy
        runtime._idle_timeout = 0.01
        live.last_activity -= 60
        await runtime._reclaim_idle_sessions()
        assert live.alive  # not reclaimed while Pi works on the command
        result = await task
        assert result.ok and result.result["executionState"] == "completed"
        assert not live.pending_prompts
    finally:
        await runtime.stop()


async def test_a_late_failure_becomes_a_session_notification(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    monkeypatch.setattr(pi_runtime, "PROMPT_ACCEPT_SECONDS", 0.2)
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("late", "hi")
        await wait_for(lambda: bool(fake_host.turn_ends))
        result = await runtime.execute_command("late", "fail-late", raw="/fail-late 0.6")
        assert result.result["executionState"] == "accepted"

        def failures():
            return [n for n in fake_host.notices if n.type == "notification"]

        await wait_for(lambda: bool(failures()))
        payload = contract_notice(failures()[-1])
        assert (payload["severity"], payload["status"]) == ("error", "open")
        assert "late failure" in payload["message"]
        # A client opening the session later reads notices from the runtime.
        listed = await runtime.get_session_notices("late")
        assert [n.notice_id for n in listed] == [failures()[-1].notice_id]
        # An automatic compaction that fails is reported the same way.
        live = runtime._live["late"]
        await runtime.handle_live_event(
            live,
            {"type": "compaction_end", "reason": "threshold", "aborted": False, "errorMessage": "too long"},
        )
        await wait_for(lambda: "too long" in (failures()[-1].message or ""))
        # Idle reclaim closes the process, not the notification.
        runtime._idle_timeout = 0.01
        live.last_activity -= 60
        await runtime._reclaim_idle_sessions()
        assert "late" not in runtime._live
        listed = await runtime.get_session_notices("late")
        assert [n.notice_id for n in listed] == [failures()[-1].notice_id]
        runtime._idle_timeout = 0
        # The next message closes it.
        ended = len(fake_host.turn_ends)
        await runtime.start_turn("late", None, "again")
        await wait_for(lambda: len(fake_host.turn_ends) > ended)
        assert failures()[-1].status == "resolved"
        assert not await runtime.get_session_notices("late")
    finally:
        await runtime.stop()


async def test_a_throwing_extension_command_is_reported(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path
) -> None:
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("throw", "hi")
        await wait_for(lambda: bool(fake_host.turn_ends))
        await runtime.execute_command("throw", "throw-command", raw="/throw-command")
        await wait_for(lambda: any(n.type == "notification" for n in fake_host.notices))
        notice = next(n for n in reversed(fake_host.notices) if n.type == "notification")
        payload = contract_notice(notice)
        assert payload["title"] == "Pi 扩展命令出错"
        assert payload["message"] == "/throw-command 失败：boom"
    finally:
        await runtime.stop()


async def test_a_model_an_extension_switched_is_picked_up(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    log = tmp_path / "commands.jsonl"
    monkeypatch.setenv("PI_FAKE_COMMAND_LOG", str(log))
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("ext", "hi")
        await wait_for(lambda: bool(fake_host.turn_ends))
        live = runtime._live["ext"]
        await runtime.execute_command("ext", "switch-model", raw="/switch-model")
        await wait_for(lambda: (live.model or {}).get("id") == "other-model")
        state = await runtime.get_session_state("ext")
        assert state.selections["model"] == "test:other-model"
        # Choosing the first model again must reach Pi.
        before = sum(1 for c in commands(log) if c["type"] == "set_model")
        await runtime.update_session_selections("ext", None, {"model": "test:test-model"})
        assert sum(1 for c in commands(log) if c["type"] == "set_model") == before + 1
    finally:
        await runtime.stop()


def test_thinking_selection_ids_never_take_a_model_id_apart() -> None:
    split = pi_runtime._split_thinking_selection
    assert split("p:foo#thinking=high") == ("p:foo", "high")
    # A model whose own id ends like a level suffix stays that model.
    assert split("p:foo#thinking=high", {"p:foo#thinking=high": {}}) == ("p:foo#thinking=high", None)
    assert split("p:foo#high") == ("p:foo#high", None)
    assert split("p:foo#thinking=extreme") == ("p:foo#thinking=extreme", None)


def test_last_entry_id_survives_cut_lines_and_reports_an_unread_tail(tmp_path: Path) -> None:
    path = tmp_path / "s.jsonl"
    complete = json.dumps({"type": "message", "id": "e1", "message": {"content": "a"}})
    cut = '{"type": "message", "id": "e2", "message": {"content": "中'.encode()[:-1]
    path.write_bytes(complete.encode() + b"\n" + cut)  # cut inside a UTF-8 character
    assert sessions.last_entry_id(path) == "e1"
    big = tmp_path / "big.jsonl"
    big.write_text(
        complete + "\n" + json.dumps({"type": "message", "id": "e3", "pad": "x" * 200_000}) + "\n",
        encoding="utf-8",
    )
    assert sessions.last_entry_id(big) == "e3"
    with pytest.raises(sessions.LastEntryUnknown):
        sessions.last_entry_id(big, limit=10_000)


async def test_a_session_being_revived_is_not_reclaimed_under_it(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("idle", "hi")
        await wait_for(lambda: bool(fake_host.turn_ends))
        live = runtime._live["idle"]
        # Hold requests inside their external-writer check.
        entered, release = threading.Event(), threading.Event()
        read_tail = pi_runtime.last_entry_id

        def held(path, **kwargs):
            entered.set()
            release.wait(5)
            return read_tail(path, **kwargs)

        monkeypatch.setattr(pi_runtime, "last_entry_id", held)

        async def turn_while_reclaiming(text: str) -> None:
            entered.clear()
            release.clear()
            ended = len(fake_host.turn_ends)
            turn = asyncio.create_task(runtime.start_turn("idle", None, text))
            await wait_for(entered.is_set)
            await runtime._reclaim_idle_sessions()
            release.set()
            await turn
            await wait_for(lambda: len(fake_host.turn_ends) > ended)

        # Idle past the timeout when the request arrives: taking it counts
        # as activity, so the reclaim pass leaves it alone.
        runtime._idle_timeout = 30
        live.last_activity -= 60
        await turn_while_reclaiming("again")
        assert runtime._live["idle"] is live and live.alive

        # Reclaimed anyway (the request outlasted the timeout): the request
        # opens the session again instead of reviving a process nobody tracks.
        runtime._idle_timeout = 0.01
        await turn_while_reclaiming("back")
        assert live.retired and live.process is None
        assert runtime._live["idle"] is not live and runtime._live["idle"].alive
        with pytest.raises(PiSessionRetired):
            await live.ensure_started()
    finally:
        await runtime.stop()


async def test_a_send_pi_never_took_does_not_lend_its_attachments(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    monkeypatch.setenv("AGENT_CONNECTOR_ATTACHMENTS_ROOT", str(tmp_path / "attachments"))

    async def download(session_id, file_id):
        return RuntimeAttachmentContent(file_id, f"{file_id}.png", "image/png", FAKE_PNG_BYTES)

    monkeypatch.setattr(fake_host, "attachment_download", download)
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("retry", "first")
        await wait_for(lambda: bool(fake_host.turn_ends))
        live = runtime._live["retry"]

        def image(file_id: str) -> tuple[RuntimeAttachment, ...]:
            return (RuntimeAttachment(file_id=file_id, media_type="image/png"),)

        # Fails before Pi takes the prompt (an unknown model).
        with pytest.raises(PiRpcError):
            await runtime.start_turn(
                "retry",
                None,
                "look",
                attachments=image("img-a"),
                client_message_id="c1",
                selections={"model": "nope:missing"},
            )
        # An extension command consumes the prompt: no user message follows.
        await runtime.start_turn("retry", None, "/throw-command", client_message_id="c2")
        assert not live.pending_sends
        ended = len(fake_host.turn_ends)
        await runtime.start_turn(
            "retry", None, "look", attachments=image("img-b"), client_message_id="c3"
        )
        await wait_for(lambda: len(fake_host.turn_ends) > ended)
        shown = [
            (item.source.get("clientMessageId"), [a["fileId"] for a in item.content["attachments"]])
            for item in fake_host.timeline_syncs[-1]["items"]
            if item.role == "user" and item.content.get("attachments")
        ]
        assert shown == [("c3", ["img-b"])]
    finally:
        await runtime.stop()


async def test_an_interrupt_does_not_wait_on_an_open_dialog(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    log = tmp_path / "commands.jsonl"
    monkeypatch.setenv("PI_FAKE_COMMAND_LOG", str(log))
    monkeypatch.setenv("PI_FAKE_TOOLS", "1")  # the run waits on a tool approval
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("stop", "hello")
        await wait_for(lambda: bool(fake_host.notices))
        assert (await runtime.get_session_state("stop")).status == "waiting_approval"
        # Pi's abort waits for the run, which waits for the dialog's answer.
        result = await asyncio.wait_for(runtime.interrupt_session("stop"), 10)
        assert result.ok
        await wait_for(lambda: bool(fake_host.turn_ends))
        assert fake_host.turn_ends[-1]["outcome"] == "interrupted"
        # Abort first, then the dismissal: the run then ends interrupted
        # instead of carrying on with the refused tool.
        sent = [c for c in commands(log) if c["type"] in ("extension_ui_response", "abort")]
        assert [c["type"] for c in sent] == ["abort", "extension_ui_response"]
        assert sent[1]["cancelled"] is True
        assert fake_host.notices[-1].status == "cancelled"
        assert not await runtime.get_session_notices("stop")
    finally:
        await runtime.stop()
