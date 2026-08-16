from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import Any

import pytest

from connector.launch import launch_target
from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.dsh.discovery import DshDiscovery
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

    async def sync_state_read(self, key: str) -> dict[str, Any] | None:
        if key.startswith("dsh/history/"):
            return self.sync_state
        return self.sync_values.get(key)

    async def sync_state_write(self, key: str, value: dict[str, Any]) -> None:
        self.sync_writes.append((key, value))
        self.sync_values[key] = value

    async def timeline_item_upsert(self, item: Any) -> None:
        self.timeline_items.append(item)


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
    executable = tmp_path / "dsh"
    executable.touch(mode=0o700)

    async def discover(values: dict[str, Any]) -> DshDiscovery:
        return DshDiscovery(
            available=True,
            configured=True,
            target=launch_target("configured", str(executable)),
            version="0.1.0-rc.5",
            metadata={"profile": values["profile"]},
        )

    async def run() -> None:
        provider = DshProvider(discoverer=discover)
        assert provider.runtime == "dsh"
        assert provider.runtime_type == "local-process"
        assert provider.display_name == "DeepSeek Harness"
        schema = await provider.get_config_schema()
        assert schema.defaults["profile"] == "aa"
        assert schema.defaults["maxRestartAttempts"] == 3
        assert schema.ui_schema["environment"]["writeOnly"] is True

        config = await provider.validate_config(
            {
                **schema.defaults,
                "executablePath": str(executable),
                "dshHome": str(tmp_path / "home"),
                "environment": {"EXAMPLE": "value"},
            }
        )
        assert config.runtime == "dsh"
        assert config.metadata["profile"] == "aa"
        assert config.metadata["storageMode"] == "dsh-native"
        assert config.metadata["crossProcessWriterExclusion"] is False
        assert "environment" not in config.metadata

        with pytest.raises(RuntimeInvalidRequestError):
            await provider.validate_config(
                {
                    **schema.defaults,
                    "executablePath": str(executable),
                    "environment": {"DSH_HOME": "forbidden"},
                }
            )

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
