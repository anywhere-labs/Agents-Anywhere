from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from connector.runtime_protocol import (
    MessageTimelineContent,
    MessageTimelineItem,
    RuntimeConfig,
    RuntimeInvalidRequestError,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.antigravity.runtime import (
    AntigravityRuntime,
    antigravity_model_selection_id,
    resolve_model_id,
)
from connector.runtimes.antigravity.sessions import AntigravitySessionReader
from connector.runtimes.antigravity.timeline import AntigravityTimelineReader
from connector.server.protocol import protocol_selection_id


class FakeHost(RuntimeHostClient):
    def __init__(self) -> None:
        self.state_updates: list[dict[str, Any]] = []
        self.timeline_syncs: list[dict[str, Any]] = []
        self.turn_ends: list[dict[str, Any]] = []
        self.health_updates: list[tuple[str, Any]] = []
        self.meta_upserts: list[dict[str, Any]] = []
        self.capabilities_updates: list[Any] = []

    @property
    def connector_id(self) -> str:
        return "conn_test"

    async def runtime_health_update(self, status: str, details: Any = None) -> None:
        self.health_updates.append((status, details))

    async def session_meta_upsert(self, **kwargs: Any) -> None:
        self.meta_upserts.append(kwargs)

    async def session_state_update(
        self,
        session_id: str,
        runtime: str,
        status: Any = None,
        selections: Mapping[str, str | None] | None = None,
        external_session_id: str | None = None,
        status_reason: str | None = None,
        error: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self.state_updates.append(
            {
                "session_id": session_id,
                "runtime": runtime,
                "status": status,
                "selections": dict(selections or {}),
                "external_session_id": external_session_id,
                "status_reason": status_reason,
                "error": dict(error) if error is not None else None,
                "metadata": dict(metadata or {}),
            }
        )

    async def session_source_update(self, observation: Any) -> None:
        pass

    async def session_turn_ended(
        self,
        session_id: str,
        runtime: str,
        external_session_id: str | None = None,
        turn_id: str | None = None,
        outcome: str = "completed",
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self.turn_ends.append(
            {
                "session_id": session_id,
                "runtime": runtime,
                "external_session_id": external_session_id,
                "turn_id": turn_id,
                "outcome": outcome,
                "metadata": dict(metadata or {}),
            }
        )

    async def runtime_capabilities_update(self, capabilities: Any) -> None:
        self.capabilities_updates.append(capabilities)

    async def session_capabilities_update(self, capabilities: Any) -> None:
        self.capabilities_updates.append(capabilities)

    async def timeline_sync(
        self,
        session_id: str,
        runtime: str,
        items: tuple[RuntimeTimelineItem, ...],
        external_session_id: str | None = None,
        complete: bool = False,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self.timeline_syncs.append(
            {
                "session_id": session_id,
                "runtime": runtime,
                "items": items,
                "external_session_id": external_session_id,
                "complete": complete,
                "metadata": dict(metadata or {}),
            }
        )


class FakeSessionReader(AntigravitySessionReader):
    def __init__(self, initial_status: str = "idle") -> None:
        self.status = initial_status
        self.preview = "Test conversation preview"

    def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        default_model: str = "flash",
    ) -> SessionState:
        effective_selections = (
            dict(selections)
            if selections is not None
            else {
                "model": protocol_selection_id(
                    "antigravity", "model", {"model_id": default_model}
                )
            }
        )
        return SessionState(
            session_id=session_id,
            external_session_id=external_session_id or session_id,
            runtime="antigravity",
            status=self.status,
            selections=effective_selections,
            metadata={"preview": self.preview},
        )


class FakeTimelineReader(AntigravityTimelineReader):
    def __init__(self, items: list[RuntimeTimelineItem] | None = None) -> None:
        self.items = list(items or [])

    def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external_session_id or session_id,
            runtime="antigravity",
            items=tuple(self.items),
            complete=True,
        )


def _config(
    default_model: str = "flash", custom_models: list[dict[str, Any]] | None = None
) -> RuntimeConfig:
    values: dict[str, Any] = {"defaultModel": default_model}
    if custom_models is not None:
        values["customModels"] = custom_models
    return RuntimeConfig(
        runtime="antigravity",
        revision=1,
        values=values,
    )


# 1. Model Catalog Tests
def test_antigravity_runtime_model_catalog_builtins_and_custom() -> None:
    asyncio.run(_test_antigravity_runtime_model_catalog_builtins_and_custom())


async def _test_antigravity_runtime_model_catalog_builtins_and_custom() -> None:
    host = FakeHost()
    cfg = _config(
        default_model="pro",
        custom_models=[
            {"modelId": "custom-tuned-1", "displayName": "Fine-Tuned Model 1"},
        ],
    )
    runtime = AntigravityRuntime(config=cfg, host=host)

    catalog = await runtime.list_model_catalog()
    assert catalog.runtime == "antigravity"
    assert len(catalog.models) == 4

    model_ids = [m.id for m in catalog.models]
    assert model_ids == ["flash", "pro", "flash_lite", "custom-tuned-1"]

    # Check recommendation matches defaultModel ("pro")
    pro_item = next(m for m in catalog.models if m.id == "pro")
    assert pro_item.metadata["is_recommended"] is True

    flash_item = next(m for m in catalog.models if m.id == "flash")
    assert flash_item.metadata["is_recommended"] is False

    # Check custom model metadata
    custom_item = next(m for m in catalog.models if m.id == "custom-tuned-1")
    assert custom_item.title == "Fine-Tuned Model 1"
    assert custom_item.metadata.get("custom") is True

    # Filter query
    filtered = await runtime.list_model_catalog(query="lite")
    assert len(filtered.models) == 1
    assert filtered.models[0].id == "flash_lite"


# 2. Model Resolution & Rejection Tests
def test_antigravity_model_resolution_and_rejection() -> None:
    # Built-in models resolve directly
    assert resolve_model_id("flash") == "flash"
    assert resolve_model_id("pro") == "pro"
    assert resolve_model_id("flash_lite") == "flash_lite"

    # Built-in selection IDs resolve directly
    assert resolve_model_id(antigravity_model_selection_id("flash")) == "flash"
    assert resolve_model_id(antigravity_model_selection_id("pro")) == "pro"
    assert resolve_model_id(antigravity_model_selection_id("flash_lite")) == "flash_lite"

    # Default fallback when None/empty
    assert resolve_model_id(None, default_model="pro") == "pro"
    assert resolve_model_id("", default_model="flash_lite") == "flash_lite"

    # Custom models resolve when allowed
    allowed = {"flash", "pro", "flash_lite", "custom-model"}
    assert resolve_model_id("custom-model", allowed_models=allowed) == "custom-model"
    assert (
        resolve_model_id(
            antigravity_model_selection_id("custom-model"), allowed_models=allowed
        )
        == "custom-model"
    )

    # UNKNOWN MODELS MUST BE REJECTED (contract requirement: do not coerce to Pro/Flash)
    for unknown in ("claude-opus-4-6", "claude-sonnet-4-6", "gpt-4o", "random-model"):
        with pytest.raises(RuntimeInvalidRequestError) as exc_info:
            resolve_model_id(unknown)
        assert "Unsupported model" in str(exc_info.value)


# 3. Update Session Selections & Readback Tests
def test_antigravity_runtime_update_session_selections_and_readback() -> None:
    asyncio.run(_test_antigravity_runtime_update_session_selections_and_readback())


async def _test_antigravity_runtime_update_session_selections_and_readback() -> None:
    host = FakeHost()
    session_reader = FakeSessionReader(initial_status="idle")
    runtime = AntigravityRuntime(
        config=_config(default_model="flash"),
        host=host,
        session_reader=session_reader,
    )

    # 1. Initial session state has default "flash"
    initial_state = await runtime.get_session_state("sess_1", "conv_1")
    assert initial_state is not None
    assert initial_state.selections["model"] == antigravity_model_selection_id("flash")

    # 2. Update selections to "pro"
    res = await runtime.update_session_selections(
        session_id="sess_1",
        external_session_id="conv_1",
        selections={"model": antigravity_model_selection_id("pro")},
    )
    assert res.ok is True
    assert res.result["selections"]["model"] == antigravity_model_selection_id("pro")

    # Verify host received state update with "pro"
    assert len(host.state_updates) > 0
    assert host.state_updates[-1]["selections"]["model"] == antigravity_model_selection_id(
        "pro"
    )

    # 3. Readback via get_session_state must return "pro" and NOT revert to "flash"!
    readback_state = await runtime.get_session_state("sess_1", "conv_1")
    assert readback_state is not None
    assert readback_state.selections["model"] == antigravity_model_selection_id("pro")

    # 4. Reject unknown model selections
    invalid_res = await runtime.update_session_selections(
        session_id="sess_1",
        external_session_id="conv_1",
        selections={"model": "claude-opus-4-6"},
    )
    assert invalid_res.ok is False
    assert invalid_res.code == "antigravity_invalid_selection"
    assert "Unsupported model" in invalid_res.message

    # Readback still retains "pro"
    assert (
        runtime.get_effective_session_selections("sess_1", "conv_1")["model"]
        == antigravity_model_selection_id("pro")
    )


# 4. Session Continuation Preserves Active Selection
def test_antigravity_runtime_continuation_preserves_selection() -> None:
    asyncio.run(_test_antigravity_runtime_continuation_preserves_selection())


async def _test_antigravity_runtime_continuation_preserves_selection() -> None:
    host = FakeHost()
    session_reader = FakeSessionReader(initial_status="idle")
    runtime = AntigravityRuntime(
        config=_config(default_model="flash"),
        host=host,
        session_reader=session_reader,
    )

    # Update session to flash_lite
    await runtime.update_session_selections(
        session_id="sess_active",
        external_session_id="conv_active",
        selections={"model": "flash_lite"},
    )

    # When start_turn is called without selections, effective selection must be flash_lite
    effective = runtime.get_effective_session_selections("sess_active", "conv_active")
    assert effective["model"] == antigravity_model_selection_id("flash_lite")


# 5. Turn Completion Idle Semantics
def test_antigravity_runtime_turn_completion_idle_semantics() -> None:
    asyncio.run(_test_antigravity_runtime_turn_completion_idle_semantics())


async def _test_antigravity_runtime_turn_completion_idle_semantics() -> None:
    host = FakeHost()
    session_reader = FakeSessionReader(initial_status="idle")
    timeline_reader = FakeTimelineReader()

    runtime = AntigravityRuntime(
        config=_config(),
        host=host,
        session_reader=session_reader,
        timeline_reader=timeline_reader,
        poll_interval=0.01,
        max_duration_seconds=0.1,
    )

    # Add an assistant timeline item
    item = MessageTimelineItem(
        id="item_1",
        type="message",
        status="done",
        source="system",
        role="assistant",
        content=MessageTimelineContent(text="Done!"),
    )
    timeline_reader.items.append(item)

    # Poll turn completion
    await runtime._poll_turn_completion(
        session_id="sess_1",
        external_session_id="conv_1",
        selections={"model": antigravity_model_selection_id("flash")},
        max_duration_seconds=0.1,
        poll_interval=0.01,
    )

    # When turn completes normally:
    # 1. Timeline sync must be complete=True
    assert len(host.timeline_syncs) > 0
    assert host.timeline_syncs[-1]["complete"] is True

    # 2. Session state update must be idle
    assert len(host.state_updates) > 0
    assert host.state_updates[-1]["status"] == "idle"

    # 3. session_turn_ended MUST be called
    assert len(host.turn_ends) == 1
    assert host.turn_ends[0]["session_id"] == "sess_1"


# 6. Turn Timeout Still-Running Semantics (Contract Requirement #3)
def test_antigravity_runtime_turn_timeout_still_running_semantics() -> None:
    asyncio.run(_test_antigravity_runtime_turn_timeout_still_running_semantics())


async def _test_antigravity_runtime_turn_timeout_still_running_semantics() -> None:
    host = FakeHost()
    # Native status remains "running"
    session_reader = FakeSessionReader(initial_status="running")
    timeline_reader = FakeTimelineReader()

    runtime = AntigravityRuntime(
        config=_config(),
        host=host,
        session_reader=session_reader,
        timeline_reader=timeline_reader,
        poll_interval=0.01,
        max_duration_seconds=0.03,
    )

    # Poll turn completion which will time out
    await runtime._poll_turn_completion(
        session_id="sess_timeout",
        external_session_id="conv_timeout",
        selections={"model": antigravity_model_selection_id("flash")},
        max_duration_seconds=0.03,
        poll_interval=0.01,
    )

    # When still running on timeout:
    # 1. Timeline sync must have complete=False
    assert len(host.timeline_syncs) > 0
    assert host.timeline_syncs[-1]["complete"] is False

    # 2. Session state status must remain "running"
    assert len(host.state_updates) > 0
    assert host.state_updates[-1]["status"] == "running"

    # 3. session_turn_ended MUST NOT be called!
    assert len(host.turn_ends) == 0


# 7. SQLite SessionReader Tests (URI ro mode)
def test_antigravity_session_reader_sqlite(tmp_path: Path) -> None:
    db_file = tmp_path / "test_summaries.db"
    con = sqlite3.connect(db_file)
    con.execute(
        """
        CREATE TABLE conversation_summaries (
            conversation_id TEXT PRIMARY KEY,
            title TEXT,
            preview TEXT,
            last_modified_time REAL,
            status TEXT,
            workspace_uris TEXT,
            nesting_depth INTEGER,
            killed INTEGER
        )
    """
    )
    con.execute(
        """
        INSERT INTO conversation_summaries VALUES
        ('conv_run', 'Running Task', 'Working...', 1700000000.0, 'CASCADE_RUN_STATUS_RUNNING', '["file:///Users/mac/Anti"]', 0, 0),
        ('conv_idle', 'Finished Task', 'Done', 1699999000.0, 'CASCADE_RUN_STATUS_SUCCESS', '["file:///Users/mac/Anti"]', 0, 0),
        ('conv_killed', 'Killed Task', '', 1699998000.0, 'CASCADE_RUN_STATUS_SUCCESS', '[]', 0, 1)
    """
    )
    con.commit()
    con.close()

    reader = AntigravitySessionReader(db_path=db_file)
    sessions = reader.list_sessions()

    # Killed session is excluded (WHERE nesting_depth = 0 AND killed = 0)
    assert len(sessions) == 2
    assert sessions[0].session_id == "conv_run"
    assert sessions[0].metadata["status"] == "running"
    assert sessions[0].cwd == "/Users/mac/Anti"

    assert sessions[1].session_id == "conv_idle"
    assert sessions[1].metadata["status"] == "idle"

    # Test get_session_state
    state_run = reader.get_session_state("conv_run")
    assert state_run.status == "running"
    assert state_run.metadata["preview"] == "Working..."

    state_idle = reader.get_session_state("conv_idle")
    assert state_idle.status == "idle"
    assert state_idle.metadata["preview"] == "Done"
