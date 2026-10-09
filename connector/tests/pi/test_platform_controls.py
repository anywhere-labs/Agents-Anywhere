"""Pi controls exposed to AA clients: thinking levels, commands, attachments.

These cover what a real AA run exercises through the Server: the web and
desktop pick a thinking level from the model catalog's reasoning items, run
slash commands with arguments, and show the files a user attached.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeAttachmentContent,
    RuntimeInvalidRequestError,
)
from connector.runtimes.pi import runtime as pi_runtime
from connector.runtimes.pi.runtime import platform_session_id

from .conftest import FAKE_PNG_BYTES, FakeHost, wait_for
from .test_runtime import make_runtime
from .test_runtime_features import commands, form_answer

BASE_LEVELS = ("off", "minimal", "low", "medium", "high")


def test_supported_thinking_levels_follow_pi() -> None:
    supported_thinking_levels = pi_runtime.supported_thinking_levels
    assert supported_thinking_levels({"reasoning": False}) == ()
    assert supported_thinking_levels({}) == ()
    assert supported_thinking_levels({"reasoning": True}) == BASE_LEVELS
    mapped = {
        "reasoning": True,
        "thinkingLevelMap": {"minimal": None, "xhigh": "xhigh", "max": "max"},
    }
    assert supported_thinking_levels(mapped) == ("off", "low", "medium", "high", "xhigh", "max")


def test_dialog_forms_show_the_placeholder_and_the_editor_prefill() -> None:
    editor = pi_runtime.PendingInteraction(
        {"id": "e1", "method": "editor", "title": "Edit", "prefill": "line one\nline two"}
    )
    prompt = editor.form.action()["input"]["uiSchema"]["questions"][0]["prompt"]
    assert prompt.startswith("Edit") and prompt.endswith("line one\nline two")
    text_input = pi_runtime.PendingInteraction(
        {"id": "i1", "method": "input", "title": "Name", "placeholder": "e.g. main"}
    )
    prompt = text_input.form.action()["input"]["uiSchema"]["questions"][0]["prompt"]
    assert prompt == "Name\n\n提示：e.g. main"


async def test_model_catalog_offers_thinking_levels_as_reasoning_items(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost
) -> None:
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        catalog = await runtime.list_model_catalog()
        reasoning, plain = catalog.models[0], catalog.models[1]
        assert [item.id for item in reasoning.reasoning_items] == list(BASE_LEVELS)
        assert reasoning.reasoning_items[3].selection_id == "test:test-model#medium"
        assert reasoning.reasoning_items[3].title == "Medium"
        # The model alone stays selectable; Pi keeps the session's level.
        assert reasoning.selection_id == "test:test-model"
        assert plain.reasoning_items == ()
        assert plain.selection_id == "test:other-model"
    finally:
        await runtime.stop()


async def test_reasoning_selection_sets_model_and_level_only_when_they_change(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    log = tmp_path / "commands.jsonl"
    monkeypatch.setenv("PI_FAKE_COMMAND_LOG", str(log))
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("levels", "hi")
        await wait_for(lambda: bool(fake_host.turn_ends))
        await runtime.update_session_selections(
            "levels", None, {"model": "test:other-model#high"}
        )
        state = await runtime.get_session_state("levels")
        assert state.selections["model"] == "test:other-model#high"
        assert state.selections["thinkingLevel"] == "high"

        def sent(kind: str) -> int:
            return sum(1 for c in commands(log) if c["type"] == kind)

        model_sets, level_sets = sent("set_model"), sent("set_thinking_level")
        assert (model_sets, level_sets) == (1, 1)
        # Clients resend their selections with every message; Pi would record
        # each set_model in the session file, so unchanged ones are not sent.
        ended = len(fake_host.turn_ends)
        await runtime.start_turn(
            "levels",
            None,
            "again",
            selections={"model": "test:other-model#high", "permission": "ask-writes"},
        )
        await wait_for(lambda: len(fake_host.turn_ends) > ended)
        assert (sent("set_model"), sent("set_thinking_level")) == (1, 1)
        await runtime.update_session_selections("levels", None, {"model": "test:other-model#low"})
        assert (sent("set_model"), sent("set_thinking_level")) == (1, 2)
        assert (await runtime.get_session_state("levels")).selections["model"] == (
            "test:other-model#low"
        )
    finally:
        await runtime.stop()


def _entry(entry_id: str, parent: str | None, **fields) -> str:
    return json.dumps({"id": entry_id, "parentId": parent, "timestamp": "2026-01-01T00:00:00Z", **fields})


async def test_idle_session_state_reports_the_model_and_level_pi_restores(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost
) -> None:
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    path = sessions / "restored.jsonl"
    user = {"role": "user", "content": "hello", "timestamp": 1}
    assistant = {
        "role": "assistant",
        "content": [{"type": "text", "text": "hi"}],
        "provider": "test",
        "model": "test-model",
        "stopReason": "stop",
        "timestamp": 2,
    }
    lines = [
        json.dumps({"type": "session", "version": 3, "id": "s1", "timestamp": "2026-01-01T00:00:00Z", "cwd": str(tmp_path)}),
        _entry("m1", None, type="model_change", provider="test", modelId="other-model"),
        _entry("t1", "m1", type="thinking_level_change", thinkingLevel="high"),
        _entry("u1", "t1", type="message", message=user),
        _entry("a1", "u1", type="message", message=assistant),
        # An abandoned branch: its later model change is not restored.
        _entry("x1", "t1", type="model_change", provider="alt", modelId="test-model"),
        _entry("u2", "a1", type="message", message=user),
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        session_id = platform_session_id(fake_host.session_namespace, str(path))
        state = await runtime.get_session_state(session_id, str(path))
        assert state is not None and state.status == "idle"
        assert state.selections["model"] == "test:test-model#high"
        assert state.selections["thinkingLevel"] == "high"
    finally:
        await runtime.stop()


async def test_extension_command_waiting_on_a_dialog_is_accepted(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    log = tmp_path / "commands.jsonl"
    monkeypatch.setenv("PI_FAKE_COMMAND_LOG", str(log))
    monkeypatch.setattr(pi_runtime, "PROMPT_ACCEPT_SECONDS", 0.3, raising=False)
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("held", "hi")
        await wait_for(lambda: bool(fake_host.turn_ends))
        started = time.monotonic()
        result = await runtime.execute_command("held", "hold-dialog")
        # Pi answers this prompt only after the dialog; AA must not wait for it.
        assert time.monotonic() - started < 3
        assert result.ok is True
        assert result.result["executionState"] == "accepted"
        await wait_for(lambda: any(n.status == "open" for n in fake_host.notices))
        notice = next(n for n in reversed(fake_host.notices) if n.status == "open")
        live = runtime._live["held"]
        assert live.busy
        # A session still running a command is not reclaimed as idle.
        runtime._idle_timeout = 0.01
        live.last_activity -= 60
        await runtime._reclaim_idle_sessions()
        assert runtime._live.get("held") is live and live.alive
        assert (
            await runtime.respond_interaction(
                "held", notice.notice_id, "submit", form_answer(option_ids=["o_1"])
            )
        ).ok
        await wait_for(lambda: not live.pending_prompts)
        assert "held dialog answered: beta" in session_file.read_text(encoding="utf-8")
        # What the command recorded is published when it finishes, not at the
        # next inventory scan (this runtime has no scanner).
        await wait_for(
            lambda: any(
                "held dialog answered: beta" in str(item.content.get("text"))
                for sync in fake_host.timeline_syncs
                for item in sync["items"]
            )
        )
        # Outside a run it is not streamed under a temporary identity, which
        # would list it twice.
        assert not any(
            "held dialog answered" in str(item.content.get("text"))
            for item in fake_host.timeline_items
        )
    finally:
        await runtime.stop()


def test_last_entry_id_reads_back_across_large_entries(tmp_path: Path) -> None:
    path = tmp_path / "s.jsonl"
    big = {"role": "user", "content": "x" * 300_000, "timestamp": 2}
    path.write_text(
        "\n".join(
            [
                json.dumps({"type": "session", "version": 3, "id": "header"}),
                _entry("e1", None, type="message", message={"role": "user", "content": "a"}),
                _entry("e2", "e1", type="message", message=big),
            ]
        )
        + "\n{\"type\": \"mess",  # a line still being written
        encoding="utf-8",
    )
    assert pi_runtime.last_entry_id(path) == "e2"
    header_only = tmp_path / "h.jsonl"
    header_only.write_text(json.dumps({"type": "session", "id": "header"}) + "\n", encoding="utf-8")
    assert pi_runtime.last_entry_id(header_only) is None


async def test_a_session_another_pi_process_wrote_is_reloaded_before_the_next_turn(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    log = tmp_path / "commands.jsonl"
    monkeypatch.setenv("PI_FAKE_COMMAND_LOG", str(log))
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("shared", "first")
        await wait_for(lambda: bool(fake_host.turn_ends))

        def startups() -> int:
            return sum(1 for c in commands(log) if c["type"] == "startup")

        ended = len(fake_host.turn_ends)
        await runtime.start_turn("shared", None, "second")
        await wait_for(lambda: len(fake_host.turn_ends) > ended)
        # Only this process wrote the file: no reload.
        assert startups() == 1

        # A Pi terminal continues the same session file.
        last = pi_runtime.last_entry_id(session_file)
        user = {"role": "user", "content": "from the terminal", "timestamp": 50}
        with session_file.open("a", encoding="utf-8") as handle:
            handle.write(_entry("ext-1", last, type="message", message=user) + "\n")
        ended = len(fake_host.turn_ends)
        await runtime.start_turn("shared", None, "third")
        await wait_for(lambda: len(fake_host.turn_ends) > ended)
        # The live process reopened the file before the prompt, so it
        # continues after the terminal's entry instead of branching.
        assert startups() == 2
        assert str(session_file) in [c for c in commands(log) if c["type"] == "startup"][-1]["argv"]
        assert not any(t.get("outcome") == "failed" for t in fake_host.turn_ends)
    finally:
        await runtime.stop()


async def test_commands_take_arguments_and_compact_runs_natively(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    log = tmp_path / "commands.jsonl"
    monkeypatch.setenv("PI_FAKE_COMMAND_LOG", str(log))
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        listed = {command.id: command for command in await runtime.list_commands("cmds")}
        assert listed["compact"].metadata["source"] == "builtin"
        assert listed["fix-tests"].args_schema == {"type": "string"}
        assert listed["fix-tests"].metadata["ui"] == {"kind": "execute", "acceptsMultiline": True}

        await runtime.create_and_start_session("cmds", "hi")
        await wait_for(lambda: bool(fake_host.turn_ends))
        ended = len(fake_host.turn_ends)
        result = await runtime.execute_command("cmds", "fix-tests", raw="/fix-tests only unit")
        assert result.ok and result.result["executionState"] == "accepted"
        assert any(
            c["type"] == "prompt" and c["message"] == "/fix-tests only unit" for c in commands(log)
        )
        await wait_for(lambda: len(fake_host.turn_ends) > ended)

        syncs = len(fake_host.timeline_syncs)
        result = await runtime.execute_command("cmds", "compact", raw="/compact keep decisions")
        assert result.ok and result.result["executionState"] == "completed"
        assert "1000 → 200" in (result.message or "")
        (compact,) = (c for c in commands(log) if c["type"] == "compact")
        assert compact["customInstructions"] == "keep decisions"
        # The compaction marker is published without waiting for a scan.
        await wait_for(
            lambda: any(
                item.type == "marker" and item.content.get("kind") == "compact"
                for sync in fake_host.timeline_syncs[syncs:]
                for item in sync["items"]
            )
        )
        runtime._live["cmds"].is_streaming = True
        with pytest.raises(RuntimeInvalidRequestError):
            await runtime.execute_command("cmds", "compact")
    finally:
        await runtime.stop()


async def test_attachment_message_shows_what_the_user_sent(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost, session_file: Path, monkeypatch
) -> None:
    monkeypatch.setenv("AGENT_CONNECTOR_ATTACHMENTS_ROOT", str(tmp_path / "attachments"))

    async def download(session_id, file_id):
        if file_id == "image":
            return RuntimeAttachmentContent(file_id, "image.png", "image/png", FAKE_PNG_BYTES)
        return RuntimeAttachmentContent(file_id, "readme.txt", "text/plain", b"attached text")

    monkeypatch.setattr(fake_host, "attachment_download", download)
    attachments = (
        RuntimeAttachment(file_id="text", name="readme.txt", media_type="text/plain", size=13),
        RuntimeAttachment(file_id="image", name="image.png", media_type="image/png"),
    )
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("shown", "first")
        await wait_for(lambda: bool(fake_host.turn_ends))
        ended = len(fake_host.turn_ends)
        await runtime.start_turn(
            "shown", None, "look at these", attachments=attachments, client_message_id="client-1"
        )
        await wait_for(lambda: len(fake_host.turn_ends) > ended)

        def user_item(items):
            return next(i for i in items if i.source.get("clientMessageId") == "client-1")

        expected = [
            {"fileId": "text", "name": "readme.txt", "mediaType": "text/plain", "size": 13},
            {"fileId": "image", "name": "image.png", "mediaType": "image/png"},
        ]
        item = user_item(fake_host.timeline_syncs[-1]["items"])
        assert item.content["text"] == "look at these"
        assert item.content["attachments"] == expected
        # Pi still received the notes and the image.
        assert "attached text" in session_file.read_text(encoding="utf-8")

        await runtime.stop()
        runtime = make_runtime(fake_pi, tmp_path, fake_host)
        await runtime.start()
        session_id = platform_session_id(fake_host.session_namespace, str(session_file))
        snapshot = await runtime.get_session_snapshot(session_id, str(session_file))
        item = user_item(snapshot.items)
        assert item.content["text"] == "look at these"
        assert item.content["attachments"] == expected
    finally:
        await runtime.stop()
