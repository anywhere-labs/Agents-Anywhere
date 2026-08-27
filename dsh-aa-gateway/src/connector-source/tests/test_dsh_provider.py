from __future__ import annotations

import asyncio
import hashlib
import os
from pathlib import Path
from typing import Any

import pytest

from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.dsh.discovery import BridgeEndpoint, DshDiscovery
from connector.runtimes.dsh.provider import DshProvider
from connector.runtimes.dsh.runtime import DshRuntime
from connector.runtimes.providers import default_runtime_providers
from connector.server.runtime_sync import session_requires_timeline_sync


class _Host:
    connector_id = "connector-test"

    def __init__(self, sync_state: dict[str, Any] | None = None) -> None:
        self.sync_state = sync_state
        self.sync_values: dict[str, dict[str, Any]] = {}
        self.sync_writes: list[tuple[str, dict[str, Any]]] = []
        self.timeline_items: list[Any] = []
        self.runtime_errors: list[tuple[str, str, str, dict[str, Any]]] = []

    async def sync_state_read(self, key: str) -> dict[str, Any] | None:
        if key.startswith("dsh/history/"):
            return self.sync_state
        return self.sync_values.get(key)

    async def sync_state_write(self, key: str, value: dict[str, Any]) -> None:
        self.sync_writes.append((key, value))
        self.sync_values[key] = value

    async def timeline_item_upsert(self, item: Any) -> None:
        self.timeline_items.append(item)

    async def runtime_error(
        self,
        runtime: str,
        code: str,
        message: str,
        **kwargs: Any,
    ) -> None:
        self.runtime_errors.append((runtime, code, message, kwargs))


class _RecoveredClient:
    async def request(self, method: str, params: Any = None) -> Any:
        assert method == "session.list"
        return {"sessions": [], "nextCursor": None}

    async def close(self) -> None:
        return None


class _RecoveringRuntime(DshRuntime):
    connect_attempts = 0

    async def _start_client(self) -> None:
        self.connect_attempts += 1
        if self.connect_attempts == 1:
            raise ConnectionError("DSH Web is restarting")
        self._client = _RecoveredClient()  # type: ignore[assignment]
        self._restart_attempts = 0


class _ListRuntime(DshRuntime):
    async def _request(self, method: str, params: Any = None) -> Any:
        assert method == "session.list"
        return {
            "sessions": [
                {
                    "externalSessionId": "session-external",
                    "runtime": "dsh",
                    "title": "History",
                    "revision": "revision-2",
                    "metadata": {},
                }
            ]
        }


class _PagedListRuntime(DshRuntime):
    def __init__(
        self, *args: Any, repeated_cursor: bool = False, **kwargs: Any
    ) -> None:
        super().__init__(*args, **kwargs)
        self.repeated_cursor = repeated_cursor
        self.requests: list[dict[str, Any]] = []

    async def _request(self, method: str, params: Any = None) -> Any:
        assert method == "session.list"
        assert isinstance(params, dict)
        self.requests.append(dict(params))
        cursor = params.get("cursor")
        if cursor is None:
            return {
                "sessions": [
                    {
                        "externalSessionId": "session-one",
                        "runtime": "dsh",
                        "title": "One",
                        "revision": "revision-1",
                        "localArchived": True,
                    }
                ],
                "nextCursor": "cursor-1",
            }
        return {
            "sessions": [
                {
                    "externalSessionId": "session-two",
                    "runtime": "dsh",
                    "title": "Two",
                    "revision": "revision-2",
                }
            ],
            "nextCursor": "cursor-1" if self.repeated_cursor else None,
        }


class _SnapshotRuntime(DshRuntime):
    async def _request(self, method: str, params: Any = None) -> Any:
        assert method == "session.getSnapshot"
        return {
            "sessionId": "sess_1",
            "externalSessionId": "session-external",
            "runtime": "dsh",
            "items": [],
            "complete": True,
            "watermark": {"seq": 7, "revision": "revision-7"},
        }


class _StateRuntime(DshRuntime):
    async def _request(self, method: str, params: Any = None) -> Any:
        assert method == "session.getState"
        return {
            "sessionId": params["sessionId"],
            "externalSessionId": params["externalSessionId"],
            "runtime": "dsh",
            "status": "idle",
            "selections": {},
        }


class _StartTurnRuntime(DshRuntime):
    async def _request(self, method: str, params: Any = None) -> Any:
        assert method == "session.startTurn"
        assert isinstance(params, dict)
        client_message_id = params["clientMessageId"]
        session_id = params["sessionId"]
        native_message_id = (
            "aa-"
            + hashlib.sha256(f"{session_id}\0{client_message_id}".encode()).hexdigest()
        )
        await self._handle_notification(
            "timeline.item.upsert",
            {
                "sessionId": session_id,
                "externalSessionId": params["externalSessionId"],
                "runtime": "dsh",
                "item": {
                    "id": "dsh-user-message",
                    "type": "message",
                    "payload": {
                        "role": "user",
                        "text": params["content"],
                        "messageId": native_message_id,
                    },
                    "orderSeq": 8,
                    "revision": 1,
                },
            },
        )
        return {"ok": True, "result": {"accepted": True}}


def test_dsh_is_third_default_provider() -> None:
    assert [provider.runtime for provider in default_runtime_providers()] == [
        "codex",
        "claude",
        "dsh",
    ]


def test_dsh_provider_identity_schema_and_validation(tmp_path: Path) -> None:
    endpoint_path = tmp_path / "home" / "agents-anywhere" / "bridge" / "endpoint.json"
    endpoint = BridgeEndpoint("127.0.0.1", 12345, "token", os.getpid(), endpoint_path)

    async def discover(values: dict[str, Any]) -> DshDiscovery:
        return DshDiscovery(
            available=True,
            configured=True,
            endpoint=endpoint,
            metadata={"profile": "web"},
        )

    async def run() -> None:
        provider = DshProvider(discoverer=discover)
        assert provider.runtime == "dsh"
        assert provider.runtime_type == "local-service"
        assert provider.display_name == "DeepSeek Harness"
        schema = await provider.get_config_schema()
        assert schema.defaults["maxRestartAttempts"] == 3

        config = await provider.validate_config(
            {
                **schema.defaults,
                "dshHome": str(tmp_path / "home"),
            }
        )
        assert config.runtime == "dsh"
        assert config.metadata["profile"] == "web"
        assert config.metadata["storageMode"] == "dsh-native"
        assert config.metadata["crossProcessWriterExclusion"] is False

        migrated = await provider.validate_config(
            {
                **schema.defaults,
                "dshHome": str(tmp_path / "home"),
                "executablePath": "/legacy/dsh",
                "profile": "aa",
                "environment": {"OLD": "value"},
                "shutdownTimeoutMs": 15_000,
                "killGraceMs": 5_000,
            }
        )
        assert migrated.values == config.values

        with pytest.raises(RuntimeInvalidRequestError):
            await provider.validate_config(
                {
                    **schema.defaults,
                    "dshHome": "relative/home",
                }
            )
        with pytest.raises(RuntimeInvalidRequestError):
            await provider.validate_config({**schema.defaults, "unexpected": True})

    asyncio.run(run())


def test_dsh_session_revision_requests_timeline_sync() -> None:
    async def run() -> None:
        runtime = _ListRuntime(
            config=RuntimeConfig(runtime="dsh", revision=1),
            host=_Host(sync_state={"revision": "revision-1"}),  # type: ignore[arg-type]
        )

        sessions = await runtime.list_sessions()

        assert len(sessions) == 1
        assert sessions[0].metadata["revision"] == "revision-2"
        assert sessions[0].metadata["sync"] == {
            "key": "dsh/history/cursor/68c04cbee23556a53997bf93a62cbc8ecf6f6eff009015c87248b62f678116d6",
            "revision": "revision-2",
            "previous_revision": "revision-1",
            "changed": True,
            "requires_timeline_sync": True,
            "history_cursor_missing": False,
        }
        assert session_requires_timeline_sync(sessions[0]) is True

    asyncio.run(run())


def test_dsh_first_scan_forces_state_sync_after_connector_restart() -> None:
    async def run() -> None:
        runtime = _ListRuntime(
            config=RuntimeConfig(runtime="dsh", revision=1),
            host=_Host(sync_state={"revision": "revision-2"}),  # type: ignore[arg-type]
        )

        first = await runtime.list_sessions()
        second = await runtime.list_sessions()

        assert first[0].metadata["sync"]["changed"] is True
        assert first[0].metadata["sync"]["requires_timeline_sync"] is True
        assert second[0].metadata["sync"]["changed"] is False
        assert second[0].metadata["sync"]["requires_timeline_sync"] is False

    asyncio.run(run())


def test_dsh_complete_inventory_follows_pagination_and_preserves_source_flags() -> None:
    async def run() -> None:
        runtime = _PagedListRuntime(
            config=RuntimeConfig(runtime="dsh", revision=1),
            host=_Host(),  # type: ignore[arg-type]
        )

        sessions = await runtime.list_complete_session_inventory(page_size=1)

        assert [session.external_session_id for session in sessions] == [
            "session-one",
            "session-two",
        ]
        assert sessions[0].metadata["localArchived"] is True
        assert runtime.requests == [
            {"limit": 1, "force": False},
            {"limit": 1, "force": False, "cursor": "cursor-1"},
        ]

    asyncio.run(run())


def test_dsh_complete_inventory_rejects_repeated_cursor() -> None:
    async def run() -> None:
        runtime = _PagedListRuntime(
            config=RuntimeConfig(runtime="dsh", revision=1),
            host=_Host(),  # type: ignore[arg-type]
            repeated_cursor=True,
        )

        with pytest.raises(RuntimeError, match="repeated nextCursor"):
            await runtime.list_complete_session_inventory(page_size=1)

    asyncio.run(run())


def test_dsh_request_recovers_after_proactive_restart_attempts_are_exhausted() -> None:
    async def run() -> None:
        host = _Host()
        runtime = _RecoveringRuntime(
            config=RuntimeConfig(
                runtime="dsh",
                revision=2,
                values={
                    "maxRestartAttempts": 1,
                    "restartBackoffMs": 0,
                },
            ),
            host=host,  # type: ignore[arg-type]
        )

        await runtime._restart_loop()

        assert runtime._client is None
        assert runtime.connect_attempts == 1
        assert host.runtime_errors[0][1] == "DSH_BRIDGE_RESTART_FAILED"

        sessions = await runtime.list_sessions(limit=100, force=True)

        assert sessions == ()
        assert runtime.connect_attempts == 2
        assert runtime._restart_attempts == 0
        await runtime.stop()

    asyncio.run(run())


def test_dsh_non_conflict_state_releases_cached_writer_block() -> None:
    async def run() -> None:
        runtime = _StateRuntime(
            config=RuntimeConfig(runtime="dsh", revision=1),
            host=_Host(),  # type: ignore[arg-type]
        )
        runtime._concurrent_writer_sessions.add("sess_1")

        state = await runtime.get_session_state("sess_1", "session-external")

        assert state is not None
        assert state.status == "idle"
        assert "sess_1" not in runtime._concurrent_writer_sessions

    asyncio.run(run())


def test_dsh_snapshot_watermark_commits_history_cursor() -> None:
    async def run() -> None:
        host = _Host()
        runtime = _SnapshotRuntime(
            config=RuntimeConfig(runtime="dsh", revision=1),
            host=host,  # type: ignore[arg-type]
        )

        prepared = await runtime.prepare_session_timeline_sync(
            "sess_1",
            "session-external",
        )

        assert prepared is not None
        assert prepared.snapshot is not None
        assert prepared.snapshot.metadata == {
            "revision": "revision-7",
            "watermarkSeq": 7,
        }
        assert prepared.commit is not None
        await prepared.commit()
        assert host.sync_writes == [
            (
                "dsh/history/cursor/68c04cbee23556a53997bf93a62cbc8ecf6f6eff009015c87248b62f678116d6",
                {
                    "revision": "revision-7",
                    "externalSessionIdHash": "68c04cbee23556a53997bf93a62cbc8ecf6f6eff009015c87248b62f678116d6",
                },
            )
        ]

    asyncio.run(run())


def test_dsh_live_timeline_notification_unwraps_item_envelope() -> None:
    async def run() -> None:
        host = _Host()
        runtime = DshRuntime(
            config=RuntimeConfig(runtime="dsh", revision=1),
            host=host,  # type: ignore[arg-type]
        )

        await runtime._handle_notification(
            "timeline.item.upsert",
            {
                "sessionId": "sess_1",
                "externalSessionId": "session-external",
                "runtime": "dsh",
                "item": {
                    "id": "message_1",
                    "type": "message",
                    "payload": {"role": "assistant", "text": "hello from DSH"},
                    "orderSeq": 7,
                    "revision": 1,
                },
            },
        )

        assert len(host.timeline_items) == 1
        item = host.timeline_items[0]
        assert item.id == "message_1"
        assert item.session_id == "sess_1"
        assert item.type == "message"
        assert item.role == "assistant"
        assert item.content["text"] == "hello from DSH"
        assert item.source["itemType"] == "message"

    asyncio.run(run())


def test_dsh_live_user_message_restores_client_message_id() -> None:
    async def run() -> None:
        host = _Host()
        runtime = _StartTurnRuntime(
            config=RuntimeConfig(runtime="dsh", revision=1),
            host=host,  # type: ignore[arg-type]
        )

        result = await runtime.start_turn(
            "sess_1",
            "session-external",
            "hello from Web",
            client_message_id="client-message-1",
        )

        assert result.ok is True
        assert len(host.timeline_items) == 1
        assert host.timeline_items[0].source["clientMessageId"] == "client-message-1"
        assert host.sync_writes[0][0].startswith("dsh/client-messages/")
        assert host.sync_writes[0][1] == {"clientMessageId": "client-message-1"}

    asyncio.run(run())
