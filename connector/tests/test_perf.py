from __future__ import annotations

from connector.logging import logger
from connector.perf import StageTimer, elapsed_ms, log_stage, span_stage


def _capture_logs(level: str = "INFO") -> tuple[list[str], int]:
    messages: list[str] = []

    def sink(message: object) -> None:
        messages.append(str(message).rstrip("\n"))

    sink_id = logger.add(sink, level=level, format="{message}")
    return messages, sink_id


def test_log_stage_formats_ordered_fields() -> None:
    messages, sink_id = _capture_logs()
    try:
        log_stage(
            "adapter.first_assistant_token",
            12.5,
            runtime="claude",
            session_id="sess_1",
            turn_id="turn_1",
            outcome="",
            extra="x",
        )
    finally:
        logger.remove(sink_id)

    assert messages
    assert messages[-1] == (
        "stage=adapter.first_assistant_token elapsed_ms=12.5 runtime=claude "
        "session_id=sess_1 turn_id=turn_1 extra=x"
    )


def test_stage_timer_marks_first_assistant_token_once() -> None:
    messages, sink_id = _capture_logs()
    try:
        timer = StageTimer()
        first = timer.mark_first_timeline(runtime="codex", session_id="sess_1", turn_id="turn_1")
        second = timer.mark_first_timeline(runtime="codex", session_id="sess_1", turn_id="turn_1")
        complete = timer.mark_turn_complete(
            outcome="done",
            runtime="codex",
            session_id="sess_1",
            turn_id="turn_1",
        )
    finally:
        logger.remove(sink_id)

    assert first is not None
    assert second is None
    assert complete >= 0
    stages = [line.split()[0] for line in messages if line.startswith("stage=")]
    assert stages == ["stage=adapter.first_assistant_token", "stage=adapter.turn_complete"]
    assert any("outcome=done" in line for line in messages)


def test_stage_timer_respects_stage_alias() -> None:
    messages, sink_id = _capture_logs()
    try:
        timer = StageTimer()
        timer.mark_first_timeline(
            runtime="claude",
            session_id="sess_1",
            turn_id="turn_1",
            stage_alias="adapter.first_assistant_token",
        )
    finally:
        logger.remove(sink_id)

    assert any("stage=adapter.first_assistant_token" in line for line in messages)


def test_span_stage_logs_elapsed() -> None:
    messages, sink_id = _capture_logs()
    try:
        with span_stage("connector.dispatch", method="turn.start", runtime="claude"):
            pass
    finally:
        logger.remove(sink_id)

    assert messages
    assert messages[-1].startswith("stage=connector.dispatch elapsed_ms=")
    assert "method=turn.start" in messages[-1]
    assert "runtime=claude" in messages[-1]


def test_elapsed_ms_rounds_to_one_decimal() -> None:
    assert elapsed_ms(__import__("time").perf_counter()) >= 0.0
