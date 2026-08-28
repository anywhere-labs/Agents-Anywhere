from __future__ import annotations

import asyncio
import inspect
from collections.abc import Mapping
from typing import Any

import pytest

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeAttachmentContent,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeConfig,
    RuntimeHostClient,
    RuntimeIdentity,
    RuntimeInstance,
    RuntimeInstanceHost,
    RuntimeInstanceSpec,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimePermissionCatalog,
    RuntimePermissionItem,
    RuntimeSourceKey,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionNotice,
    SessionSourceObservation,
    SessionSourceState,
    SessionState,
)
from connector.runtimes.session_identity import stable_runtime_session_id


class CompleteInventoryRuntime(AgentRuntime):
    def __init__(self) -> None:
        self.complete_inventory_calls: list[tuple[int, bool]] = []

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(runtime="dsh", runtime_version="test")

    async def get_config(self) -> RuntimeConfig:
        return RuntimeConfig(runtime="dsh", revision=1, values={"test": True})

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        return RuntimeCapabilitySet(
            runtime="dsh",
            revision=1,
            capabilities=(
                RuntimeCapability(
                    capability_id="session.send_message",
                    scope="runtime",
                    runtime="dsh",
                ),
            ),
        )

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        return RuntimeModelCatalog(
            runtime="dsh",
            revision=1,
            models=(RuntimeModelItem(id="model", title="Model"),),
        )

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        return RuntimePermissionCatalog(
            runtime="dsh",
            revision=1,
            permissions=(
                RuntimePermissionItem(
                    id="default",
                    title="Default",
                    selection_id="default",
                ),
            ),
        )

    async def list_complete_session_inventory(
        self,
        page_size: int = 100,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        self.complete_inventory_calls.append((page_size, force))
        return (
            SessionMeta(
                session_id="sess_native",
                external_session_id="native",
                runtime="dsh",
            ),
        )

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="dsh",
            items=(
                RuntimeTimelineItem(
                    id="item",
                    session_id=session_id,
                    type="message",
                    status="completed",
                    order_seq=1,
                    content_hash="hash",
                    source={"runtime": "dsh"},
                ),
            ),
        )

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        return SessionState(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="dsh",
            status="idle",
        )

    async def get_session_notices(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        return (
            SessionNotice(
                notice_id="notice",
                session_id=session_id,
                runtime="dsh",
                type="notification",
                title="Notice",
            ),
        )


class RecordingHost(RuntimeHostClient):
    def __init__(self) -> None:
        self.calls: list[tuple[str, Mapping[str, Any]]] = []
        self.sync_values: dict[str, Mapping[str, Any]] = {}

    @property
    def connector_id(self) -> str:
        return "conn_test"

    async def session_meta_upsert(
        self,
        session_id: str,
        runtime: str,
        external_session_id: str | None = None,
        title: str | None = None,
        cwd: str | None = None,
        ordering_time: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self.calls.append(
            ("meta", {"runtime": runtime, "metadata": dict(metadata or {})})
        )

    async def session_source_update(
        self,
        observation: SessionSourceObservation,
    ) -> None:
        self.calls.append(
            (
                "source",
                {
                    "runtime": observation.runtime,
                    "runtimeId": observation.runtime_id,
                    "availability": observation.state.availability,
                },
            )
        )

    async def session_turn_ended(
        self,
        session_id: str,
        runtime: str,
        external_session_id: str | None = None,
        turn_id: str | None = None,
        outcome: str = "completed",
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self.calls.append(
            (
                "turn_end",
                {
                    "runtime": runtime,
                    "turnId": turn_id,
                    "outcome": outcome,
                    "metadata": dict(metadata or {}),
                },
            )
        )

    async def timeline_item_upsert(self, item: RuntimeTimelineItem) -> None:
        self.calls.append(("timeline", item.source))

    async def runtime_error(
        self,
        runtime: str,
        code: str,
        message: str,
        session_id: str | None = None,
        external_session_id: str | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        self.calls.append(
            ("error", {"runtime": runtime, "details": dict(details or {})})
        )

    async def attachment_download(
        self,
        session_id: str,
        file_id: str,
    ) -> RuntimeAttachmentContent:
        self.calls.append(("attachment", {"sessionId": session_id}))
        return RuntimeAttachmentContent(file_id, "file.txt", "text/plain", b"data")

    async def sync_state_read(self, key: str) -> Mapping[str, Any] | None:
        self.calls.append(("sync.read", {"key": key}))
        return self.sync_values.get(key)

    async def sync_state_write(
        self,
        key: str,
        value: Mapping[str, Any],
    ) -> None:
        self.calls.append(("sync.write", {"key": key}))
        self.sync_values[key] = dict(value)

    async def sync_state_delete(self, key: str) -> None:
        self.calls.append(("sync.delete", {"key": key}))
        self.sync_values.pop(key, None)


def test_runtime_instance_explicitly_forwards_complete_inventory() -> None:
    async def run() -> None:
        native = CompleteInventoryRuntime()
        instance = RuntimeInstanceSpec("rti_dsh_one", "dsh", "DSH One")
        runtime = RuntimeInstance(instance=instance, native_runtime=native)

        sessions = await runtime.list_complete_session_inventory(
            page_size=37,
            force=True,
        )

        assert native.complete_inventory_calls == [(37, True)]
        assert sessions[0].runtime == "dsh"
        assert sessions[0].runtime_id == "rti_dsh_one"
        assert sessions[0].metadata["runtimeType"] == "dsh"
        assert sessions[0].metadata["runtimeId"] == "rti_dsh_one"

    asyncio.run(run())


def test_runtime_instance_preserves_type_and_adds_instance_scope() -> None:
    async def run() -> None:
        instance = RuntimeInstanceSpec("rti_dsh_one", "dsh", "DSH One")
        runtime = RuntimeInstance(instance, CompleteInventoryRuntime())

        config = await runtime.get_config()
        capabilities = await runtime.get_runtime_capabilities()
        models = await runtime.list_model_catalog()
        permissions = await runtime.list_permission_catalog()
        snapshot = await runtime.get_session_snapshot("sess")
        state = await runtime.get_session_state("sess")
        notices = await runtime.get_session_notices("sess")

        assert runtime.identity.runtime == "dsh"
        assert runtime.identity.runtime_id == "rti_dsh_one"
        assert config.runtime == models.runtime == permissions.runtime == "dsh"
        assert config.runtime_id == models.runtime_id == "rti_dsh_one"
        assert permissions.runtime_id == "rti_dsh_one"
        assert capabilities.runtime == "dsh"
        assert capabilities.runtime_id == "rti_dsh_one"
        assert capabilities.capabilities[0].runtime == "dsh"
        assert capabilities.capabilities[0].runtime_id == "rti_dsh_one"
        assert snapshot.runtime == "dsh"
        assert snapshot.runtime_id == "rti_dsh_one"
        assert snapshot.items[0].source["runtime"] == "dsh"
        assert snapshot.items[0].source["runtimeId"] == "rti_dsh_one"
        assert state is not None and state.runtime_id == "rti_dsh_one"
        assert notices[0].runtime_id == "rti_dsh_one"
        assert notices[0].source["runtimeId"] == "rti_dsh_one"

    asyncio.run(run())


def test_runtime_instance_host_scopes_side_effects_and_storage() -> None:
    async def run() -> None:
        base = RecordingHost()
        instance = RuntimeInstanceSpec("rti_codex_one", "codex", "Codex One")
        source = RuntimeSourceKey("codex_home", "/tmp/codex-home")
        host = RuntimeInstanceHost(base=base, instance=instance, source_key=source)

        await host.session_meta_upsert("sess", "codex", metadata={"native": True})
        await host.session_source_update(
            SessionSourceObservation(
                session_id="sess",
                external_session_id="thread",
                runtime="codex",
                state=SessionSourceState(
                    availability="archived",
                    observation_origin="event",
                ),
            )
        )
        await host.session_turn_ended(
            "sess",
            "codex",
            turn_id="turn_1",
            metadata={"native": True},
        )
        await host.timeline_item_upsert(
            RuntimeTimelineItem(
                id="item",
                session_id="sess",
                type="message",
                status="completed",
                order_seq=1,
                content_hash="hash",
            )
        )
        await host.runtime_error("codex", "code", "message")
        await host.sync_state_write("codex/history/cursor", {"cursor": 1})
        await host.attachment_download("sess", "file")

        meta = base.calls[0][1]
        assert meta["runtime"] == "codex"
        assert meta["metadata"]["runtimeType"] == "codex"
        assert meta["metadata"]["runtimeId"] == "rti_codex_one"
        assert meta["metadata"]["runtimeSource"] == {
            "kind": "codex_home",
            "key": "/tmp/codex-home",
        }
        source_observation = base.calls[1][1]
        assert source_observation == {
            "runtime": "codex",
            "runtimeId": "rti_codex_one",
            "availability": "archived",
        }
        turn_end = base.calls[2][1]
        assert turn_end["turnId"] == "turn_1"
        assert turn_end["metadata"]["runtimeId"] == "rti_codex_one"
        timeline = base.calls[3][1]
        assert timeline["runtime"] == "codex"
        assert timeline["runtimeId"] == "rti_codex_one"
        assert base.calls[4][1]["details"]["runtimeId"] == "rti_codex_one"
        sync_key = base.calls[5][1]["key"]
        assert sync_key.startswith("codex/instances/rti_codex_one/")
        assert sync_key.endswith("/history/cursor")
        assert host.session_namespace.startswith("conn_test:codex:rti_codex_one:")
        assert "/tmp/codex-home" not in host.session_namespace

    asyncio.run(run())


def test_runtime_instance_host_falls_back_to_runtime_id_namespace() -> None:
    host = RuntimeInstanceHost(
        base=RecordingHost(),
        instance=RuntimeInstanceSpec("rti_codex_one", "codex", "Codex One"),
    )

    assert host.session_namespace == "conn_test:codex:rti_codex_one"
    assert host.instance_sync_key("codex/history/cursor") == (
        "codex/instances/rti_codex_one/history/cursor"
    )


@pytest.mark.parametrize("runtime_type", ["codex", "claude", "dsh"])
def test_legacy_instance_preserves_pre_instance_session_ids(runtime_type: str) -> None:
    base = RecordingHost()
    host = RuntimeInstanceHost(
        base=base,
        instance=RuntimeInstanceSpec(runtime_type, runtime_type, runtime_type.title()),
        source_key=RuntimeSourceKey(f"{runtime_type}_source", "/tmp/source"),
    )

    assert host.session_namespace == base.connector_id
    assert stable_runtime_session_id(
        host.session_namespace,
        runtime_type,
        "external-session",
    ) == stable_runtime_session_id(
        base.connector_id,
        runtime_type,
        "external-session",
    )


@pytest.mark.parametrize("runtime_type", ["codex", "claude", "dsh"])
def test_legacy_instance_preserves_sync_keys(runtime_type: str) -> None:
    key = f"{runtime_type}/history/cursor/session"
    host = RuntimeInstanceHost(
        base=RecordingHost(),
        instance=RuntimeInstanceSpec(runtime_type, runtime_type, runtime_type.title()),
        source_key=RuntimeSourceKey(f"{runtime_type}_source", "/tmp/source"),
    )

    assert host.instance_sync_key(key) == key


@pytest.mark.parametrize("runtime_type", ["codex", "dsh"])
def test_named_instance_namespaces_bind_id_and_source(runtime_type: str) -> None:
    source = RuntimeSourceKey(f"{runtime_type}_source", "/tmp/source-one")
    first = RuntimeInstanceHost(
        base=RecordingHost(),
        instance=RuntimeInstanceSpec(
            f"rti_{runtime_type}_one",
            runtime_type,
            f"{runtime_type.title()} One",
        ),
        source_key=source,
    )
    reused_source = RuntimeInstanceHost(
        base=RecordingHost(),
        instance=RuntimeInstanceSpec(
            f"rti_{runtime_type}_two",
            runtime_type,
            f"{runtime_type.title()} Two",
        ),
        source_key=source,
    )
    changed_source = RuntimeInstanceHost(
        base=RecordingHost(),
        instance=first.instance,
        source_key=RuntimeSourceKey(
            f"{runtime_type}_source",
            "/tmp/source-two",
        ),
    )

    key = f"{runtime_type}/history/cursor/session"
    first_key = first.instance_sync_key(key)
    reused_key = reused_source.instance_sync_key(key)
    changed_key = changed_source.instance_sync_key(key)
    session_ids = {
        stable_runtime_session_id(
            host.session_namespace,
            runtime_type,
            "external-session",
        )
        for host in (first, reused_source, changed_source)
    }

    assert f":{runtime_type}:rti_{runtime_type}_one:" in first.session_namespace
    assert "/tmp/source-one" not in first.session_namespace
    assert f"{runtime_type}/instances/rti_{runtime_type}_one/" in first_key
    assert len(session_ids) == 3
    assert first.session_namespace != reused_source.session_namespace
    assert first.session_namespace != changed_source.session_namespace
    assert first_key != reused_key
    assert first_key != changed_key


def test_runtime_instance_wrappers_explicitly_cover_protocol_methods() -> None:
    runtime_methods = {
        name
        for name, value in AgentRuntime.__dict__.items()
        if inspect.iscoroutinefunction(value)
    }
    host_methods = {
        name
        for name, value in RuntimeHostClient.__dict__.items()
        if inspect.iscoroutinefunction(value)
    }

    assert runtime_methods <= RuntimeInstance.__dict__.keys()
    assert host_methods <= RuntimeInstanceHost.__dict__.keys()
    assert "__getattr__" not in RuntimeInstance.__dict__
    assert "__getattr__" not in RuntimeInstanceHost.__dict__
