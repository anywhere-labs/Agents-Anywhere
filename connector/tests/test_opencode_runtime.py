"""Tests for the OpenCode runtime adapter (provider config, timeline, runtime).

All tests run against fakes — no live ``opencode serve`` required.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from collections.abc import AsyncIterator
from contextlib import suppress
from pathlib import Path
from typing import Any, ClassVar

import pytest

from connector.runtime_protocol import (
    CAPABILITY_CATALOG_PERMISSION,
    CAPABILITY_SESSION_SEND_MESSAGE,
    RuntimeConfig,
    RuntimeInvalidRequestError,
    RuntimeUnavailableError,
)
from connector.runtimes.opencode import provider_config, serve_process, timeline
from connector.runtimes.opencode.pending_messages import (
    OpenCodePendingClientMessageRegistry,
)
from connector.runtimes.opencode.provider import OpenCodeProvider
from connector.runtimes.opencode.runtime import (
    PERMISSION_SELECTION_KEY,
    OpenCodeRuntime,
    _StreamSession,
)
from connector.runtimes.opencode.sdk.client import (
    OpenCodeClient,
    OpenCodeClientError,
    append_directory_param,
)


@pytest.fixture(autouse=True)
def _isolated_connector_data_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Keep auto-start's data-directory isolation out of the real home directory.

    A serve the connector starts gets its own opencode data directory (its log
    and database are held exclusively on 2.x), which normally lands under
    ``~/.agents-anywhere``.
    """

    monkeypatch.setenv("AGENT_CONNECTOR_DATA_DIR", str(tmp_path / "connector-data"))

# --------------------------------------------------------------------------- #
# provider config
# --------------------------------------------------------------------------- #


def test_config_schema_defaults() -> None:
    defaults = provider_config.default_config_values()
    assert defaults["serverUrl"] == provider_config.DEFAULT_SERVER_URL
    assert defaults["requestTimeoutSeconds"] == provider_config.DEFAULT_REQUEST_TIMEOUT_S


def test_normalized_config_values_trims_url() -> None:
    values = provider_config.normalized_config_values(
        {"serverUrl": "http://127.0.0.1:4096/"}
    )
    assert values["serverUrl"] == "http://127.0.0.1:4096"


def test_normalized_config_values_rejects_out_of_range_timeout() -> None:
    with pytest.raises(RuntimeInvalidRequestError):
        provider_config.normalized_config_values({"requestTimeoutSeconds": 99999})


def test_normalized_config_values_rejects_bad_url() -> None:
    with pytest.raises(RuntimeInvalidRequestError):
        provider_config.normalized_config_values({"serverUrl": "not-a-url"})


def test_validate_config_round_trips_through_provider() -> None:
    async def run() -> None:
        provider = OpenCodeProvider()
        config = await provider.validate_config({"serverUrl": "http://127.0.0.1:4096"})
        assert config.runtime == "opencode"
        assert config.values["serverUrl"] == "http://127.0.0.1:4096"

    asyncio.run(run())


def test_capabilities_declare_core_surface() -> None:
    caps = provider_config.opencode_capabilities()
    assert caps["modelCatalog"] is True
    assert caps["sessionDiscovery"] is True
    assert caps["startTurn"] is True
    assert caps["interruptTurn"] is True
    # Verified against serve 1.18.34: prompt file parts accept local file://
    # URLs, so platform uploads are supported.
    assert caps["attachments"] is True
    assert caps["commands"] is True
    assert caps["interactions"] is True


# --------------------------------------------------------------------------- #
# timeline mapping
# --------------------------------------------------------------------------- #

USER_MSG = {
    "info": {
        "id": "msg_user_1",
        "role": "user",
        "sessionID": "ses_x",
        "time": {"created": 1_000},
    },
    "parts": [{"type": "text", "text": "hello", "time": {"created": 1_000}}],
}

ASSISTANT_MSG = {
    "info": {
        "id": "msg_asst_1",
        "role": "assistant",
        "sessionID": "ses_x",
        "parentID": "msg_user_1",
        "time": {"created": 2_000, "completed": 3_000},
    },
    "parts": [
        {"type": "reasoning", "text": "thinking..."},
        {"type": "step-start"},
        {"type": "tool", "callID": "call_1", "tool": "bash", "state": {
            "status": "completed",
            "input": {"command": "ls"},
            "output": "file.txt",
            "title": "Run ls",
        }},
        {"type": "text", "text": "hi there", "time": {"created": 2_500}},
        {"type": "step-finish"},
    ],
}


def test_map_messages_user_and_assistant() -> None:
    items = timeline.map_messages_to_timeline("ses_x", [USER_MSG, ASSISTANT_MSG])
    kinds = [(item.type, item.role) for item in items]
    assert ("message", "user") in kinds
    assert ("message", "assistant") in kinds
    # reasoning -> system item, tool -> tool item, step-* dropped
    assert ("system", "system") in kinds
    assert ("tool", "tool") in kinds
    assert len(items) == 4


def test_map_messages_tool_status_mapping() -> None:
    items = timeline.map_messages_to_timeline("ses_x", [USER_MSG, ASSISTANT_MSG])
    tool_items = [item for item in items if item.type == "tool"]
    assert len(tool_items) == 1
    assert tool_items[0].status == "done"
    assert tool_items[0].content.title == "bash"
    assert tool_items[0].content.output == "file.txt"

    running = {
        "info": dict(ASSISTANT_MSG["info"]),
        "parts": [{
            "type": "tool",
            "callID": "call_2",
            "tool": "bash",
            "state": {"status": "running", "input": {}, "title": "running tool"},
        }],
    }
    items = timeline.map_messages_to_timeline("ses_x", [running])
    assert [i.status for i in items if i.type == "tool"] == ["running"]


def test_derive_session_status() -> None:
    # last message is a completed assistant -> idle
    assert timeline.derive_session_status([USER_MSG, ASSISTANT_MSG]) == "idle"
    # in-flight assistant (no completed time) -> running
    inflight = {
        "info": {
            "id": "msg_asst_2",
            "role": "assistant",
            "sessionID": "ses_x",
            "time": {"created": 2_000},
        },
        "parts": [],
    }
    assert timeline.derive_session_status([USER_MSG, inflight]) == "running"
    # no messages -> idle
    assert timeline.derive_session_status([]) == "idle"


# --------------------------------------------------------------------------- #
# runtime with a fake client
# --------------------------------------------------------------------------- #

# ``GET /agent`` payload shape, trimmed to what the runtime reads: only
# ``primary`` agents are user-selectable modes.
_FAKE_AGENTS: tuple[dict[str, Any], ...] = (
    {"name": "build", "mode": "primary", "permission": [{"permission": "*", "pattern": "*", "action": "allow"}]},
    {"name": "plan", "mode": "primary", "permission": [{"permission": "edit", "pattern": "*", "action": "deny"}]},
    {"name": "explore", "mode": "subagent", "permission": []},
    {"name": "compaction", "mode": "primary", "permission": []},
)


class FakeClient:
    """Mimics the OpenCodeClient surface used by the runtime."""

    def __init__(self) -> None:
        self.sessions: dict[str, dict[str, Any]] = {}
        self.messages: dict[str, list[dict[str, Any]]] = {}
        self.status: dict[str, dict[str, str]] = {}
        self.closed = False
        self.prompted: list[tuple[str, str, dict[str, str] | None, str | None]] = []
        self.created_directories: list[tuple[str, str | None]] = []
        self.aborted: list[str] = []
        self.api_key: str | None = None
        self.api_user: str | None = None
        self._events: list[dict[str, Any]] = []
        # Built-in slash command observability.
        self.skill_calls: list[tuple[str, str, str, str | None]] = []
        self.model_switches: list[tuple[str, str, str, str | None, str | None]] = []
        self.summaries: list[tuple[str, str, str, str | None]] = []
        self.compacts: list[tuple[str, str | None]] = []
        self.forks: list[tuple[str, str | None, str | None]] = []
        self.shares: list[tuple[str, str | None]] = []
        self.reverts: list[tuple[str, str | None, str | None]] = []
        # prompt_async part payloads (attachments land here).
        self.prompt_parts: list[tuple[str, tuple]] = []
        # prompt_async agent (Build/Plan mode) per session.
        self.prompt_agents: list[tuple[str, str | None]] = []
        # Build/Plan permission presets.
        self.agents: list[dict[str, Any]] = list(_FAKE_AGENTS)
        self.agent_directories: list[str | None] = []
        # Commands / skills.
        self.skills: list[dict[str, Any]] = []
        self.command_directories: list[str | None] = []
        # Interaction replies.
        self.permission_replies: list[tuple[str, str, str, str | None]] = []
        self.question_replies: list[tuple[str, str, str, str | None]] = []
        self.question_rejects: list[tuple[str, str, str | None]] = []
        # Pollable pending interaction lists keyed by native session id.
        self.pending_permissions: dict[str, list[dict[str, Any]]] = {}
        self.pending_forms: dict[str, list[dict[str, Any]]] = {}

    def set_credentials(self, api_user: str, api_key: str) -> None:
        if api_key:
            self.api_user = api_user
            self.api_key = api_key

    async def health(self, **_kwargs: Any) -> dict[str, Any]:
        return {"version": "1.18.34"}

    async def list_sessions(self) -> list[dict[str, Any]]:
        return list(self.sessions.values())

    async def get_session(self, session_id: str) -> dict[str, Any]:
        return self.sessions[session_id]

    async def list_messages(
        self, session_id: str, directory: str | None = None
    ) -> list[dict[str, Any]]:
        return self.messages.get(session_id, [])

    async def create_session(
        self, title: str | None = None, directory: str | None = None
    ) -> dict[str, Any]:
        sid = f"ses_new_{len(self.sessions)}"
        session = {
            "id": sid,
            "title": title,
            "directory": directory or "/work",
            "time": {"created": 100, "updated": 100},
        }
        self.sessions[sid] = session
        self.messages[sid] = []
        self.created_directories.append((sid, directory))
        return session

    async def prompt_async(
        self,
        session_id: str,
        content: str,
        model: dict[str, str] | None = None,
        agent: str | None = None,
        directory: str | None = None,
        extra_parts: tuple = (),
    ) -> None:
        self.prompted.append((session_id, content, model, directory))
        self.prompt_parts.append((session_id, tuple(extra_parts)))
        self.prompt_agents.append((session_id, agent))
        self.status[session_id] = {"type": "busy"}

    async def list_agents(self, directory: str | None = None) -> list[dict[str, Any]]:
        self.agent_directories.append(directory)
        return list(self.agents)

    async def abort(self, session_id: str, directory: str | None = None) -> None:
        self.aborted.append(session_id)
        self.status[session_id] = {"type": "idle"}

    # --- built-in slash command surface (used by execute_command tests) --- #
    # ``list_commands`` returns user-defined skills only; built-in slash
    # commands are injected by the runtime. Return an empty list here so
    # tests can assert the runtime adds builtins on top.
    async def list_commands(self, directory: str | None = None) -> list[dict[str, Any]]:
        self.command_directories.append(directory)
        return list(self.skills)

    async def execute_command(
        self,
        session_id: str,
        command: str,
        arguments: str = "",
        directory: str | None = None,
    ) -> dict[str, Any] | None:
        self.skill_calls.append((session_id, command, arguments, directory))
        return None

    async def switch_session_model(
        self,
        session_id: str,
        model_id: str,
        provider_id: str,
        variant: str | None = None,
        directory: str | None = None,
    ) -> None:
        self.model_switches.append(
            (session_id, model_id, provider_id, variant, directory)
        )

    async def summarize_session(
        self,
        session_id: str,
        provider_id: str,
        model_id: str,
        directory: str | None = None,
    ) -> bool:
        self.summaries.append((session_id, provider_id, model_id, directory))
        return True

    async def fork_session(
        self,
        session_id: str,
        message_id: str | None = None,
        directory: str | None = None,
    ) -> dict[str, Any] | None:
        self.forks.append((session_id, message_id, directory))
        return {"id": "ses_forked", "title": "forked"}

    async def share_session(
        self, session_id: str, directory: str | None = None
    ) -> dict[str, Any] | None:
        self.shares.append((session_id, directory))
        return {"id": session_id, "share": {"url": "https://opncd.ai/share/test123"}}

    async def revert_latest_message(
        self,
        session_id: str,
        message_id: str | None = None,
        directory: str | None = None,
    ) -> bool:
        self.reverts.append((session_id, message_id, directory))
        return True

    async def session_status_map(self, directory: str | None = None) -> dict[str, Any]:
        return self.status

    async def list_pending_permissions(
        self, session_id: str, directory: str | None = None
    ) -> list[dict[str, Any]]:
        # Default: nothing pending. Tests exercising the approval poll set
        # ``pending_permissions`` for a session.
        return list(self.pending_permissions.get(session_id, []))

    async def list_pending_forms(
        self, session_id: str, directory: str | None = None
    ) -> list[dict[str, Any]]:
        return list(self.pending_forms.get(session_id, []))

    async def reply_permission(
        self,
        session_id: str,
        permission_id: str,
        response: str,
        directory: str | None = None,
    ) -> None:
        self.permission_replies.append((session_id, permission_id, response, directory))

    async def reply_question(
        self,
        session_id: str,
        question_id: str,
        reply: str,
        directory: str | None = None,
    ) -> None:
        self.question_replies.append((session_id, question_id, reply, directory))

    async def reject_question(
        self,
        session_id: str,
        question_id: str,
        directory: str | None = None,
    ) -> None:
        self.question_rejects.append((session_id, question_id, directory))

    async def provider_overview(self) -> dict[str, Any]:
        return {
            "connected": ["local"],
            "all": [
                {
                    "id": "local",
                    "name": "Local",
                    "models": {
                        "nemotron35-dspark": {
                            "id": "nemotron35-dspark",
                            "name": "Nemotron 35 DSpark",
                            "limit": {"context": 262144, "output": 32768},
                            "capabilities": {
                                "toolcall": True,
                                "reasoning": True,
                                "output": {"text": True},
                            },
                            "variants": {
                                "low": {"reasoningEffort": "low"},
                                "medium": {"reasoningEffort": "medium"},
                                "high": {"reasoningEffort": "high"},
                            },
                        },
                        "embed-only": {
                            "id": "embed-only",
                            "name": "Embed Only",
                            "limit": {"context": 8192, "output": 0},
                            "capabilities": {
                                "toolcall": False,
                                "reasoning": False,
                                "output": {"text": True},
                            },
                        },
                        "image-only": {
                            "id": "image-only",
                            "name": "Image Only",
                            "limit": {"context": 4096, "output": 0},
                            "capabilities": {
                                "toolcall": True,
                                "reasoning": False,
                                "output": {"text": False, "image": True},
                            },
                        },
                    },
                }
            ],
        }

    def push_event(self, event: dict[str, Any]) -> None:
        self._events.append(event)

    async def stream_events(self) -> AsyncIterator[dict[str, Any]]:
        while True:
            if self._events:
                yield self._events.pop(0)
            else:
                await asyncio.sleep(0.01)

    async def close(self) -> None:
        self.closed = True


class FakeHost:
    def __init__(self) -> None:
        self.timeline_syncs: list[tuple[str, int]] = []
        self.meta_upserts: list[str] = []
        self.state_updates: list[tuple[str, str]] = []
        self.turn_ended: list[tuple[str, str]] = []
        self.health: list[tuple[str, dict[str, Any] | None]] = []
        self.attachment_downloads: list[tuple[str, str]] = []
        self.attachment_bytes: dict[str, bytes] = {}
        self.notices: list[Any] = []
        # Live timeline pushes (streaming) vs full snapshot rebuilds.
        self.item_upserts: list[Any] = []

    async def timeline_sync(
        self, session_id: str, runtime: str, items: tuple, external_session_id: str | None = None, complete: bool = False
    ) -> None:
        self.timeline_syncs.append((session_id, len(items)))

    async def session_meta_upsert(
        self, session_id: str, runtime: str, external_session_id: str | None = None, **_: Any
    ) -> None:
        self.meta_upserts.append(session_id)

    async def session_state_update(
        self, session_id: str, runtime: str, status: str, external_session_id: str | None = None
    ) -> None:
        self.state_updates.append((session_id, status))

    async def session_turn_ended(
        self, session_id: str, runtime: str, external_session_id: str | None = None, outcome: str = "completed"
    ) -> None:
        self.turn_ended.append((session_id, outcome))

    async def runtime_health_update(self, status: str, detail: dict[str, Any] | None = None) -> None:
        self.health.append((status, detail))

    async def notice_upsert(self, notice: Any) -> None:
        self.notices.append(notice)

    async def timeline_item_upsert(self, item: Any) -> None:
        self.item_upserts.append(item)

    async def attachment_download(self, session_id: str, file_id: str) -> Any:
        from connector.runtime_protocol import RuntimeAttachmentContent

        self.attachment_downloads.append((session_id, file_id))
        content = self.attachment_bytes.get(file_id)
        if content is None:
            raise KeyError(f"no attachment bytes registered for {file_id}")
        return RuntimeAttachmentContent(
            file_id=file_id,
            name="note.txt",
            media_type="text/plain",
            content=content,
        )


def _make_runtime(
    client: FakeClient, host: FakeHost, values: dict[str, Any] | None = None
) -> OpenCodeRuntime:
    provider = OpenCodeProvider()

    async def run() -> OpenCodeRuntime:
        config = await provider.validate_config(values or {"serverUrl": "http://127.0.0.1:4096"})
        return OpenCodeRuntime(config=config, host=host, client=client)

    return asyncio.run(run())


def test_runtime_identity_from_health() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime.start()
        try:
            assert runtime.identity.runtime_version == "1.18.34"
            assert runtime.identity.runtime == "opencode"
        finally:
            await runtime.stop()

    asyncio.run(run())


def test_default_client_streams_with_provider_timeout() -> None:
    """The SSE stream must not inherit the short REST request timeout."""
    provider = OpenCodeProvider()

    async def run() -> None:
        config = await provider.validate_config({"serverUrl": "http://127.0.0.1:4096"})
        runtime = OpenCodeRuntime(config=config, host=FakeHost())
        assert runtime._client.stream_timeout == provider_config.DEFAULT_STREAM_TIMEOUT_S
        assert runtime._client.timeout == provider_config.DEFAULT_REQUEST_TIMEOUT_S

    asyncio.run(run())


def test_client_sends_http_basic_credentials() -> None:
    """serve expects Basic auth (username default "opencode"), not Bearer."""
    import base64

    def expected(user: str, key: str) -> str:
        return "Basic " + base64.b64encode(f"{user}:{key}".encode()).decode()

    async def run() -> None:
        client = OpenCodeClient("http://127.0.0.1:4096", "pw", api_user="lcl")
        http = await client._client()
        assert http.headers["Authorization"] == expected("lcl", "pw")
        await client.close()

        quiet = OpenCodeClient("http://127.0.0.1:4096")
        http2 = await quiet._client()
        assert "Authorization" not in http2.headers
        quiet.set_credentials("lcl", "new")
        assert http2.headers["Authorization"] == expected("lcl", "new")
        await quiet.close()

    asyncio.run(run())


class _FakeSSEResponse:
    def __init__(self, lines: list[str]) -> None:
        self._lines = lines
        self.status_code = 200

    async def aiter_lines(self) -> AsyncIterator[str]:
        for line in self._lines:
            yield line

    async def aread(self) -> bytes:
        return b""


class _FakeSSEContext:
    def __init__(self, response: _FakeSSEResponse) -> None:
        self._response = response

    async def __aenter__(self) -> _FakeSSEResponse:
        return self._response

    async def __aexit__(self, *_: object) -> None:
        return None


class _FakeStreamingHTTP:
    def __init__(self, response: _FakeSSEResponse) -> None:
        self._response = response
        self.requested_url: str | None = None

    def stream(self, _method: str, url: str, **_kwargs: Any) -> _FakeSSEContext:
        self.requested_url = url
        return _FakeSSEContext(self._response)


def test_client_stream_events_adapts_v2_frames() -> None:
    """``GET /api/event`` frames are V2-shaped and must be translated.

    opencode 2.x publishes ``{id, created?, type, location?, data}`` frames with
    the session id inside ``data``; the runtime only knows the 1.x
    ``{type, properties}`` events, so the client maps execution start, text and
    reasoning streams, segment ends and step ends onto them — and drops frames
    that carry no session (mcp/provider/model updates and the like).
    """

    client = OpenCodeClient("http://127.0.0.1:4096")

    def frame(**payload: Any) -> str:
        return f"data: {json.dumps(payload)}"

    http = _FakeStreamingHTTP(
        _FakeSSEResponse(
            [
                frame(id="evt_1", type="server.connected", data={}),
                frame(id="evt_2", type="mcp.status.changed", data={"server": "context7"}),
                frame(
                    id="evt_3",
                    created=111,
                    type="session.execution.started",
                    data={"sessionID": "ses_1"},
                ),
                frame(
                    id="evt_4",
                    type="session.step.started",
                    data={
                        "sessionID": "ses_1",
                        "assistantMessageID": "msg_1",
                        "agent": "build",
                    },
                ),
                frame(
                    id="evt_5",
                    type="session.text.delta",
                    data={
                        "sessionID": "ses_1",
                        "assistantMessageID": "msg_1",
                        "ordinal": 0,
                        "delta": "PO",
                    },
                ),
                frame(
                    id="evt_6",
                    type="session.text.delta",
                    data={
                        "sessionID": "ses_1",
                        "assistantMessageID": "msg_1",
                        "ordinal": 0,
                        "delta": "NG",
                    },
                ),
                frame(
                    id="evt_7",
                    type="session.text.ended",
                    data={
                        "sessionID": "ses_1",
                        "assistantMessageID": "msg_1",
                        "ordinal": 0,
                        "text": "PONG",
                    },
                ),
                frame(
                    id="evt_8",
                    created=222,
                    type="session.step.ended",
                    data={
                        "sessionID": "ses_1",
                        "assistantMessageID": "msg_1",
                        "finish": "stop",
                    },
                ),
                ": keep-alive comment",
                "event: message",
            ]
        )
    )
    client._http = http  # type: ignore[assignment]

    async def run() -> list[dict[str, Any]]:
        return [event async for event in client.stream_events()]

    events = asyncio.run(run())
    assert [event["type"] for event in events] == [
        "session.status",
        "message.updated",
        "message.part.delta",
        "message.part.delta",
        "message.part.updated",
        "message.updated",
    ]
    assert events[0]["properties"]["status"] == {"type": "busy"}
    assert events[2]["properties"]["partID"] == "msg_1:text:0"
    assert events[4]["properties"]["part"]["text"] == "PONG"
    # step.ended finalizes the assistant message (what the runtime uses to flip
    # streamed items from running to done).
    assert events[5]["properties"]["info"]["time"]["completed"] == 222
    assert http.requested_url == "/api/event"


def test_probe_url_sends_http_basic_and_flags_401(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A credentialed serve answers even /api/info with 401; the probe must
    authenticate like the client and not report that as "unreachable"."""
    import base64

    import httpx

    from connector.runtimes.opencode import provider as provider_module

    captured: dict[str, Any] = {}

    class _Resp:
        def __init__(self, status_code: int) -> None:
            self.status_code = status_code
            self.content = b"{}"
            self.headers = {"content-type": "application/json"}
            self.text = '{"version":"2.0.27"}'

        def json(self) -> dict[str, Any]:
            return {"version": "2.0.27"}

    def fake_get(url: str, headers: dict[str, str] | None = None, timeout: float = 0.0):
        captured["url"] = url
        captured["headers"] = dict(headers or {})
        return _Resp(captured.get("_next_status", 200))

    monkeypatch.setattr(httpx, "get", fake_get)

    token = base64.b64encode(b"lcl:pw").decode()
    result = provider_module._probe_url("http://127.0.0.1:4096", api_user="lcl", api_key="pw")
    assert result == {"available": True, "version": "2.0.27"}
    assert captured["url"].endswith("/api/info")
    assert captured["headers"]["Authorization"] == f"Basic {token}"

    captured["_next_status"] = 401
    denied = provider_module._probe_url("http://127.0.0.1:4096")
    assert denied["available"] is False
    assert denied["status"] == 401
    assert denied["reason"] == "authentication required"


def test_probe_url_rejects_the_web_ui_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    """A pre-2.x serve answers /api/info with 200 + the web UI.

    That must read as "not a V2 opencode", not as a healthy instance: every
    request would fail once the client speaks V2.
    """

    import httpx

    from connector.runtimes.opencode import provider as provider_module

    class _Resp:
        status_code = 200
        content = b"<!doctype html><html><body>opencode</body></html>"
        headers: ClassVar[dict[str, str]] = {"content-type": "text/html; charset=utf-8"}
        text = "<!doctype html><html><body>opencode</body></html>"

        def json(self) -> dict[str, Any]:
            return {}

    monkeypatch.setattr(httpx, "get", lambda *a, **k: _Resp())

    result = provider_module._probe_url("http://127.0.0.1:4096")
    assert result["available"] is False
    assert "V2" in str(result["reason"])


def test_default_probe_adopts_env_password(monkeypatch: pytest.MonkeyPatch) -> None:
    """Auto-started serve inherits OPENCODE_SERVER_PASSWORD; discovery must reuse it."""
    import base64

    import httpx

    from connector.runtimes.opencode import provider as provider_module

    monkeypatch.setenv("OPENCODE_SERVER_PASSWORD", "secret")
    monkeypatch.setenv("OPENCODE_SERVER_USERNAME", "licon")

    captured: dict[str, Any] = {}

    class _Resp:
        status_code = 200
        content = b"{}"
        headers: ClassVar[dict[str, str]] = {"content-type": "application/json"}
        text = '{"version":"2.0.27"}'

        def json(self) -> dict[str, Any]:
            return {"version": "2.0.27"}

    def fake_get(url: str, headers: dict[str, str] | None = None, timeout: float = 0.0):
        captured["headers"] = dict(headers or {})
        return _Resp()

    monkeypatch.setattr(httpx, "get", fake_get)

    result = provider_module.default_probe()
    assert result["available"] is True
    assert result["version"] == "2.0.27"
    # opencode 2.x ignores OPENCODE_SERVER_USERNAME and always checks "opencode",
    # so discovery must authenticate as that user even when the environment
    # names another one.
    token = base64.b64encode(b"opencode:secret").decode()
    assert captured["headers"]["Authorization"] == f"Basic {token}"


def test_start_raises_when_unreachable(monkeypatch: pytest.MonkeyPatch) -> None:
    class DeadClient(FakeClient):
        async def health(self, **_kwargs: Any) -> dict[str, Any]:
            raise OpenCodeClientError("connection refused", status_code=None)

    # No resolvable opencode binary -> auto-start fails fast, nothing spawned.
    def _missing(*_a: Any, **_k: Any) -> list[str]:
        raise RuntimeError("opencode executable not found on PATH (and no npx fallback)")

    monkeypatch.setattr(serve_process, "resolve_serve_command", _missing)
    runtime = _make_runtime(DeadClient(), FakeHost())

    async def run() -> None:
        with pytest.raises(RuntimeUnavailableError):
            await runtime.start()

    asyncio.run(run())


def test_list_sessions_maps_meta() -> None:
    client, host = FakeClient(), FakeHost()
    client.sessions["ses_a"] = {
        "id": "ses_a",
        "title": "demo",
        "directory": "/work",
        "time": {"created": 1, "updated": 2},
        "model": {"providerID": "local", "id": "nemotron35-dspark"},
    }
    runtime = _make_runtime(client, host)

    async def run() -> None:
        metas = await runtime.list_sessions()
        assert len(metas) == 1
        assert metas[0].session_id == "ses_a"
        assert metas[0].external_session_id == "ses_a"
        assert metas[0].title == "demo"

    asyncio.run(run())


def test_snapshot_returns_platform_items() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        client.messages["ses_a"] = [USER_MSG, ASSISTANT_MSG]
        snap = await runtime.get_session_snapshot("ses_a", "ses_a")
        assert snap.complete is True
        assert len(snap.items) == 4
        assert snap.items[0].type == "message"
        assert snap.items[0].content.get("text") == "hello"

    asyncio.run(run())


def test_create_and_start_session_binds_ids() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.create_and_start_session(
            "plat_1", "do it", selections={"model": "local/nemotron35-dspark"}
        )
        assert result.ok is True
        native = result.result["externalSessionId"]
        assert native.startswith("ses_new_")
        # turn was started with the model ref
        assert client.prompted == [
            ("ses_new_0", "do it", {"providerID": "local", "modelID": "nemotron35-dspark"}, "/work")
        ]
        assert client.created_directories == [("ses_new_0", None)]
        # meta upsert under the platform id
        assert "plat_1" in host.meta_upserts
        # interrupt via platform id resolves to the native id
        interrupt = await runtime.interrupt_session("plat_1")
        assert interrupt.ok is True
        assert client.aborted == [native]

    asyncio.run(run())


def test_start_turn_without_selections_sends_no_model() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        client.sessions["ses_b"] = {"id": "ses_b"}
        result = await runtime.start_turn("ses_b", "ses_b", "plain prompt")
        assert result.ok is True
        assert client.prompted == [("ses_b", "plain prompt", None, None)]

    asyncio.run(run())


def test_continue_session_after_create_via_platform_id() -> None:
    """The desktop app continues a created session by platform id alone.

    The server forwards ``externalSessionId`` when it is stored, but after a
    connector restart the in-memory mapping is rebuilt from zero, so the
    platform-id-only path must also resolve correctly.
    """
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.create_and_start_session(
            "plat_continue", "first prompt", selections=None
        )
        assert result.ok is True
        native = result.result["externalSessionId"]

        # Server-side continuation with the stored external id.
        cont = await runtime.start_turn("plat_continue", native, "second prompt")
        assert cont.ok is True, cont.message
        assert client.prompted[-1] == (native, "second prompt", None, "/work")

        # Connector-restart path: mapping lost, platform id must self-resolve
        # through the identity fallback for discovered-style ids.
        assert runtime._platform_to_native["plat_continue"] == native

        # A discovered session (platform id == native id) resolves itself.
        client.sessions["ses_disc"] = {"id": "ses_disc"}
        disc = await runtime.start_turn("ses_disc", "ses_disc", "discovered turn")
        assert disc.ok is True
        assert client.prompted[-1] == ("ses_disc", "discovered turn", None, None)

    asyncio.run(run())


def test_get_session_state_busy() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        client.sessions["ses_c"] = {"id": "ses_c"}
        client.status["ses_c"] = {"type": "busy"}
        state = await runtime.get_session_state("ses_c", "ses_c")
        assert state.status == "running"
        client.status["ses_c"] = {"type": "idle"}
        state = await runtime.get_session_state("ses_c", "ses_c")
        assert state.status == "idle"

    asyncio.run(run())


def test_get_session_state_reasserts_idle_once() -> None:
    """Opening a session re-pushes idle once, unlocking stale running states."""
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        client.sessions["ses_h"] = {"id": "ses_h"}
        client.status["ses_h"] = {"type": "idle"}
        state = await runtime.get_session_state("plat_h", "ses_h")
        assert state.status == "idle"
        assert ("plat_h", "idle") in host.state_updates

        # only one push until a running transition is seen again
        await runtime.get_session_state("plat_h", "ses_h")
        assert host.state_updates.count(("plat_h", "idle")) == 1

        client.status["ses_h"] = {"type": "busy"}
        await runtime.get_session_state("plat_h", "ses_h")
        client.status["ses_h"] = {"type": "idle"}
        await runtime.get_session_state("plat_h", "ses_h")
        assert host.state_updates.count(("plat_h", "idle")) == 2

    asyncio.run(run())


def test_event_session_idle_publishes_and_ends_turn() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.create_and_start_session("plat_d", "hi", selections=None)
        native = result.result["externalSessionId"]
        client.messages[native] = [USER_MSG, ASSISTANT_MSG]

        await runtime._handle_event(
            {"type": "session.idle", "properties": {"sessionID": native}}
        )
        assert ("plat_d", "completed") in host.turn_ended
        assert ("plat_d", "idle") in host.state_updates
        assert ("plat_d", 4) in host.timeline_syncs

    asyncio.run(run())


def test_event_busy_ignored_without_active_turn() -> None:
    """A stray/replayed busy for an untracked session must not force "running".

    ``opencode serve`` replays session status on every SSE reconnect, so a busy
    can arrive after the turn's idle was already reported. Reflecting it would
    leave the platform session stuck in "running" (nothing reconciles untracked
    sessions), disabling the client send button after the turn showed as ended.
    """

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime._handle_event(
            {"type": "session.status", "properties": {"sessionID": "ses_e", "status": {"type": "busy"}}}
        )
        assert ("ses_e", "running") not in host.state_updates

    asyncio.run(run())


def test_event_busy_updates_state_for_active_turn() -> None:
    """A busy belonging to a tracked active turn still marks the session running."""

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.create_and_start_session("plat_e", "hi", selections=None)
        native = result.result["externalSessionId"]
        host.state_updates.clear()

        await runtime._handle_event(
            {"type": "session.status", "properties": {"sessionID": native, "status": {"type": "busy"}}}
        )
        assert ("plat_e", "running") in host.state_updates

    asyncio.run(run())


def test_duplicate_busy_status_is_pushed_once() -> None:
    """opencode repeats a status within milliseconds; push it once.

    A real turn produced 24 identical ``session.status busy`` events in the last
    60 log lines, and every one became another ``session state push`` to the
    Server. The window is bounded, so a genuinely later push still goes out.
    """

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.create_and_start_session("plat_dup", "hi", selections=None)
        native = result.result["externalSessionId"]
        host.state_updates.clear()
        busy = {"type": "session.status", "properties": {"sessionID": native, "status": {"type": "busy"}}}

        for _ in range(5):
            await runtime._handle_event(dict(busy))
        assert host.state_updates.count(("plat_dup", "running")) == 1, host.state_updates

        # Once the burst is older than the window, the same status is pushed again
        # -- a lost update must never leave the session in the wrong state.
        runtime._status_pushes[native] = ("running", time.monotonic() - 60.0)
        await runtime._handle_event(dict(busy))
        assert host.state_updates.count(("plat_dup", "running")) == 2, host.state_updates

    asyncio.run(run())


def test_event_status_idle_ends_tracked_turn() -> None:
    """``session.status idle`` precedes ``session.idle`` on the wire; ending
    the turn on it unlocks the client a beat earlier, and the later duplicate
    is a no-op rather than a second turn-end."""

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.create_and_start_session("plat_si", "hi", selections=None)
        native = result.result["externalSessionId"]
        client.messages[native] = [USER_MSG, ASSISTANT_MSG]

        await runtime._handle_event(
            {
                "type": "session.status",
                "properties": {"sessionID": native, "status": {"type": "idle"}},
            }
        )
        assert ("plat_si", "completed") in host.turn_ended
        assert ("plat_si", "idle") in host.state_updates

        await runtime._handle_event(
            {"type": "session.idle", "properties": {"sessionID": native}}
        )
        assert host.turn_ended.count(("plat_si", "completed")) == 1

    asyncio.run(run())


def test_event_status_idle_ignored_for_untracked_session() -> None:
    """A replayed idle for a session this process never started must not
    fabricate a turn-end or push state."""

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime._handle_event(
            {
                "type": "session.status",
                "properties": {"sessionID": "ses_untracked", "status": {"type": "idle"}},
            }
        )
        assert host.turn_ended == []
        assert host.state_updates == []

    asyncio.run(run())


def test_session_capabilities_carry_platform_session_id() -> None:
    """``session.send_message`` must be a session-scoped entry that carries the
    platform session id: the Server matches session-scoped capabilities by
    ``(runtime, scope, sessionId, runtimeId)``, and an entry without a session
    id (or one declared only on the runtime-scoped set) matches nothing —
    the send button then stays disabled forever after the first turn."""

    runtime = _make_runtime(FakeClient(), FakeHost())

    async def run() -> None:
        caps = await runtime.get_session_capabilities("sess_caps", "ses_native_caps")
        by_id = {cap.capability_id: cap for cap in caps.capabilities}
        send = by_id[CAPABILITY_SESSION_SEND_MESSAGE]
        assert send.scope == "session"
        assert send.session_id == "sess_caps"
        assert send.supported is True
        assert send.available is True

    asyncio.run(run())


def test_start_turn_rebuilds_binding_after_restart() -> None:
    """After a restart the in-memory maps are empty; a Server-driven call that
    carries both ids must rebuild them so every push addresses the platform
    session instead of an unresolvable native id."""

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.start_turn("plat_r", "ses_native_r", "hi", selections=None)
        assert result.ok
        assert runtime._platform_id("ses_native_r") == "plat_r"
        assert ("plat_r", "running") in host.state_updates

    asyncio.run(run())


def test_active_turn_tracked_until_idle() -> None:
    """A started turn is tracked as active and cleared by session.idle."""
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.create_and_start_session("plat_t", "hi", selections=None)
        native = result.result["externalSessionId"]
        assert native in runtime._active_turns

        await runtime._handle_event(
            {"type": "session.idle", "properties": {"sessionID": native}}
        )
        assert native not in runtime._active_turns
        assert ("plat_t", "completed") in host.turn_ended

    asyncio.run(run())


def test_lost_idle_reconciled_against_status_map() -> None:
    """A missed session.idle is recovered by reconciling against /session/status.

    This is the failure mode behind the 'send button stuck disabled after one
    turn' report: if the SSE stream drops mid-turn, the idle event is lost and
    the platform session would stay 'running' forever.
    """
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.create_and_start_session("plat_r", "hi", selections=None)
        native = result.result["externalSessionId"]
        assert native in runtime._active_turns

        # opencode finished the turn, but the idle event was lost
        # (the status map no longer lists the session as busy).
        del client.status[native]
        await runtime._reconcile_active_turns()
        assert native not in runtime._active_turns
        assert ("plat_r", "completed") in host.turn_ended
        assert ("plat_r", 0) in host.timeline_syncs

        # a genuinely busy turn is NOT reconciled away
        client.status[native] = {"type": "busy"}
        runtime._active_turns.add(native)
        await runtime._reconcile_active_turns()
        assert native in runtime._active_turns

    asyncio.run(run())


def test_reconcile_reads_the_global_active_map() -> None:
    """Reconcile ends a turn once the session leaves the active map.

    opencode 2.x replaced the directory-scoped ``/session/status`` with one
    global ``/api/session/active`` map (``{ses_x: {type: "running"}}``, empty
    when idle) and publishes no terminal ``session.idle`` event, so this poll
    is the only turn-end signal — and it must not be scoped per directory.
    """
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    calls: list[str | None] = []

    async def recording_status_map(directory: str | None = None) -> dict[str, Any]:
        calls.append(directory)
        return dict(client.status)

    client.session_status_map = recording_status_map  # type: ignore[method-assign]

    async def run() -> None:
        result = await runtime.create_and_start_session(
            "plat_scope", "hi", cwd="C:\\work\\proj", selections=None
        )
        native = result.result["externalSessionId"]
        assert runtime._directory_for(native)

        # serve reports it running: reconcile must not end the turn.
        client.status[native] = {"type": "busy"}
        await runtime._reconcile_active_turns()
        assert native in runtime._active_turns
        assert ("plat_scope", "completed") not in host.turn_ended
        # One global query, not one per candidate session.
        assert calls == [None]

        # once it left the active map, reconcile recovers the end.
        del client.status[native]
        await runtime._reconcile_active_turns()
        assert native not in runtime._active_turns
        assert ("plat_scope", "completed") in host.turn_ended

    asyncio.run(run())


def test_abort_reports_interrupted_once_without_duplicate_idle() -> None:
    """Abort ends the tracked turn as interrupted; the later idle does not re-report."""
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.create_and_start_session("plat_i", "hi", selections=None)
        native = result.result["externalSessionId"]
        ir = await runtime.interrupt_session("plat_i")
        assert ir.ok
        # FakeClient.abort flips the status to idle, so the inline reconcile
        # (or a watchdog pass) ends the turn immediately.
        assert ("plat_i", "interrupted") in host.turn_ended

        await runtime._handle_event(
            {"type": "session.idle", "properties": {"sessionID": native}}
        )
        ends = [t for t in host.turn_ended if t[0] == "plat_i"]
        assert ends == [("plat_i", "interrupted")]  # no duplicate completed end
        assert native not in runtime._active_turns
        assert native not in runtime._aborted_turns

        # a new turn clears the memo, so its idle reports completed again
        await runtime.start_turn("plat_i", None, "more")
        await runtime._handle_event(
            {"type": "session.idle", "properties": {"sessionID": native}}
        )
        assert host.turn_ended[-1] == ("plat_i", "completed")

    asyncio.run(run())


def test_reconcile_skipped_when_no_active_turns() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        assert runtime._active_turns == set()
        await runtime._reconcile_active_turns()  # must not call the status map
        assert host.turn_ended == []

    asyncio.run(run())


def test_turn_end_retried_after_host_delivery_failure() -> None:
    """A turn-end the host refuses (backend blip) is queued and retried.

    Swallowing it would leave the platform session stuck in "running": the
    server never forwards follow-up messages and the client cannot interact
    again even after reopening the history session.
    """

    class FlakyHost(FakeHost):
        def __init__(self) -> None:
            super().__init__()
            self.failures = 2

        async def session_turn_ended(
            self,
            session_id: str,
            runtime: str,
            external_session_id: str | None = None,
            outcome: str = "completed",
        ) -> None:
            if self.failures:
                self.failures -= 1
                raise RuntimeError("backend websocket closed")
            self.turn_ended.append((session_id, outcome))

    client, host = FakeClient(), FlakyHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.create_and_start_session("plat_f", "hi", selections=None)
        native = result.result["externalSessionId"]

        # idle must not raise even though the first turn-end delivery fails
        await runtime._handle_event(
            {"type": "session.idle", "properties": {"sessionID": native}}
        )
        assert host.turn_ended == []
        assert runtime._unended_turns[native] == "completed"

        await runtime._flush_unended_turns()
        assert host.turn_ended == [("plat_f", "completed")]
        assert ("plat_f", "idle") in host.state_updates
        assert native not in runtime._unended_turns

    asyncio.run(run())


def test_watchdog_flush_retries_unended_turns() -> None:
    """Queued turn-ends are retried, so recovery is automatic once backend returns."""

    class DownHost(FakeHost):
        def __init__(self) -> None:
            super().__init__()
            self.down = True

        async def session_turn_ended(
            self,
            session_id: str,
            runtime: str,
            external_session_id: str | None = None,
            outcome: str = "completed",
        ) -> None:
            if self.down:
                raise ConnectionError("offline")
            self.turn_ended.append((session_id, outcome))

    client, host = FakeClient(), DownHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.create_and_start_session("plat_w", "hi", selections=None)
        native = result.result["externalSessionId"]
        await runtime._handle_event(
            {"type": "session.idle", "properties": {"sessionID": native}}
        )
        assert runtime._unended_turns.get(native) == "completed"

        host.down = False
        await runtime._flush_unended_turns()
        assert ("plat_w", "completed") in host.turn_ended
        assert native not in runtime._unended_turns

    asyncio.run(run())


def test_watchdog_task_lifecycle() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime.start()
        assert runtime._event_task is not None
        assert runtime._watchdog_task is not None
        await runtime.stop()
        assert runtime._event_task is None
        assert runtime._watchdog_task is None
        assert client.closed is True

    asyncio.run(run())


# --------------------------------------------------------------------------- #
# auto-start of a local `opencode serve`
# --------------------------------------------------------------------------- #


class _FakeStream:
    """StreamReader-like: yields queued lines, then EOF."""

    def __init__(self, lines: list[bytes] | None = None) -> None:
        self._lines = list(lines or [])

    async def readline(self) -> bytes:
        if self._lines:
            return self._lines.pop(0)
        return b""


class _FakeProc:
    """A live child; wait() returns once terminate/kill/crash set returncode."""

    def __init__(self, stdout: _FakeStream | None = None) -> None:
        self.returncode: int | None = None
        self.pid = 42424
        self.terminated = False
        self.killed = False
        self.stdout = stdout or _FakeStream()
        self.stderr = None

    def terminate(self) -> None:
        self.terminated = True
        if self.returncode is None:
            self.returncode = 0

    def kill(self) -> None:
        self.killed = True
        if self.returncode is None:
            self.returncode = -9

    def crash(self, code: int, *lines: str) -> None:
        self.stdout._lines.extend(line.encode() + b"\n" for line in lines)
        self.returncode = code

    async def wait(self) -> int:
        while self.returncode is None:
            await asyncio.sleep(0.005)
        return self.returncode


class _ExitedProc(_FakeProc):
    def __init__(self, message: str) -> None:
        super().__init__(stdout=_FakeStream([message.encode() + b"\n"]))
        self.returncode = 1


_REAL_IS_LOCK_HELD = serve_process.is_serve_log_lock_held


@pytest.fixture(autouse=True)
def _no_real_log_lock(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unit tests must never probe the developer's real opencode.log."""

    monkeypatch.setattr(serve_process, "is_serve_log_lock_held", lambda environment: False)


def test_describe_exit_code_decodes_fatal_ntstatus() -> None:
    described = serve_process.describe_exit_code(3221226505)
    assert "0xC0000409" in described
    assert serve_process.describe_exit_code(1) == "code=1"
    assert serve_process.describe_exit_code(None) == "code=unknown"


def test_is_serve_log_lock_held_false_off_win32(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(serve_process, "is_serve_log_lock_held", _REAL_IS_LOCK_HELD)
    monkeypatch.setattr(sys, "platform", "linux")
    assert _REAL_IS_LOCK_HELD({"XDG_DATA_HOME": "/tmp/does-not-matter"}) is False


@pytest.mark.skipif(sys.platform != "win32", reason="share-mode probe is Windows-only")
def test_is_serve_log_lock_held_detects_exclusive_holder(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    import ctypes
    from ctypes import wintypes

    monkeypatch.setattr(serve_process, "is_serve_log_lock_held", _REAL_IS_LOCK_HELD)
    log_dir = tmp_path / "opencode" / "log"
    log_dir.mkdir(parents=True)
    log_file = log_dir / "opencode.log"
    log_file.write_text("x")
    env = {"XDG_DATA_HOME": str(tmp_path)}
    assert serve_process.opencode_log_path(env) == str(log_file)
    assert _REAL_IS_LOCK_HELD(env) is False

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateFileW.restype = wintypes.HANDLE
    handle = kernel32.CreateFileW(str(log_file), 0x80000000, 0, None, 3, 0, None)
    assert handle is not None and handle != ctypes.c_void_p(-1).value
    try:
        assert _REAL_IS_LOCK_HELD(env) is True
    finally:
        kernel32.CloseHandle(handle)
    assert _REAL_IS_LOCK_HELD(env) is False


def test_wait_healthy_message_decodes_fatal_exit_code() -> None:
    async def run() -> None:
        proc = _FakeProc()
        proc.crash(3221226505)
        serve = serve_process.ServeProcess()
        serve.process = proc

        async def dead() -> dict:
            raise OpenCodeClientError("connection refused")

        with pytest.raises(RuntimeError, match="0xC0000409"):
            await serve.wait_healthy(dead, OpenCodeClientError, 0.01)

    asyncio.run(run())


def _patch_serve(monkeypatch: pytest.MonkeyPatch, spawn_impl: Any) -> None:
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn_impl)
    monkeypatch.setattr(serve_process, "serve_environment", dict)

    def fake_tree_kill(proc: Any) -> None:  # stand-in for taskkill /T /F
        proc.terminate()

    monkeypatch.setattr(serve_process, "_kill_process_tree", fake_tree_kill)

    async def no_listener(host: str, port: int) -> bool:
        return False

    monkeypatch.setattr(OpenCodeRuntime, "_port_listening", staticmethod(no_listener))
    monkeypatch.setattr(
        serve_process,
        "resolve_serve_command",
        lambda port, environment=None, hostname="127.0.0.1": [
            "opencode",
            "serve",
            "--hostname",
            hostname,
            "--port",
            str(port),
        ],
    )


def test_auto_start_resolution_does_not_block_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    """Regression: a slow synchronous version check must not freeze the
    connector event loop (heartbeats stopping = supervisor kills the RPC)."""
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    def slow_resolve(port: int, environment: Any = None, hostname: str = "127.0.0.1") -> list[str]:
        time.sleep(0.3)
        raise RuntimeError("opencode executable not found on PATH (and no npx fallback)")

    async def down(**_kwargs: Any) -> dict[str, Any]:
        raise OpenCodeClientError("connection refused")

    monkeypatch.setattr(client, "health", down)
    monkeypatch.setattr(serve_process, "resolve_serve_command", slow_resolve)

    ticks = 0

    async def ticker() -> None:
        nonlocal ticks
        while True:
            await asyncio.sleep(0.02)
            ticks += 1

    async def run() -> None:
        task = asyncio.create_task(ticker())
        with suppress(RuntimeError):
            await runtime._auto_start_serve("http://127.0.0.1:4096")
        task.cancel()
        assert ticks >= 4  # loop kept ticking while resolution ran in a thread

    asyncio.run(run())


def test_serve_command_prefers_opencode_exe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        serve_process,
        "find_executable_on_path",
        lambda name, path: rf"C:\bin\{name}.cmd" if name == "opencode" else None,
    )
    monkeypatch.setattr(serve_process, "check_version_output", lambda candidate, env: None)
    assert OpenCodeRuntime._serve_command(4096) == [
        r"C:\bin\opencode.cmd",
        "serve",
        # --print-logs is required: without it serve dies when any other
        # opencode process holds the shared, exclusively-opened log file.
        "--print-logs",
        "--log-level",
        "info",
        "--hostname",
        "127.0.0.1",
        "--port",
        "4096",
    ]


def test_serve_command_falls_back_to_npx(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        serve_process,
        "find_executable_on_path",
        lambda name, path: rf"C:\node\{name}.cmd" if name == "npx" else None,
    )
    monkeypatch.setattr(serve_process, "check_version_output", lambda candidate, env: None)
    assert OpenCodeRuntime._serve_command(5000) == [
        r"C:\node\npx.cmd",
        "opencode",
        "serve",
        "--print-logs",
        "--log-level",
        "info",
        "--hostname",
        "127.0.0.1",
        "--port",
        "5000",
    ]


def test_serve_command_falls_back_when_version_check_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        serve_process,
        "find_executable_on_path",
        lambda name, path: rf"C:\bin\{name}.cmd",
    )
    monkeypatch.setattr(
        serve_process, "check_version_output", lambda candidate, env: "exited with code 1"
    )
    assert OpenCodeRuntime._serve_command(4096) == [
        r"C:\bin\npx.cmd",
        "opencode",
        "serve",
        "--print-logs",
        "--log-level",
        "info",
        "--hostname",
        "127.0.0.1",
        "--port",
        "4096",
    ]


def test_serve_command_raises_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(serve_process, "find_executable_on_path", lambda name, path: None)
    with pytest.raises(RuntimeError, match="not found"):
        OpenCodeRuntime._serve_command(4096)


def test_auto_start_allowed_only_for_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    assert runtime._should_auto_start("http://127.0.0.1:4096") is True
    assert runtime._should_auto_start("http://localhost:4096") is True
    assert runtime._should_auto_start("http://nas.liconglei.top:4096") is False
    assert runtime._should_auto_start("http://10.0.0.5:4096") is False

    # disabled by config
    values = dict(runtime.config.values)
    values["autoStart"] = False
    cfg = provider_config.normalized_config_values(values)
    cfg["autoStart"] = False
    disabled = OpenCodeRuntime(RuntimeConfig("opencode", 1, cfg), host)
    assert disabled._should_auto_start("http://127.0.0.1:4096") is False


def test_auto_start_waits_until_healthy(monkeypatch: pytest.MonkeyPatch) -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    state = {"calls": 0}

    async def flaky_health(**_kwargs: Any) -> dict:
        state["calls"] += 1
        if state["calls"] < 3:
            raise OpenCodeClientError("connection refused")
        return {"healthy": True, "version": "1.99"}

    monkeypatch.setattr(client, "health", flaky_health)
    spawned: list = []

    async def fake_spawn(*args: Any, **kwargs: Any) -> _FakeProc:
        spawned.append((args, kwargs))
        return _FakeProc()

    _patch_serve(monkeypatch, fake_spawn)

    async def run() -> None:
        await runtime._auto_start_serve("http://127.0.0.1:4096")
        assert runtime._serve.process is not None
        assert state["calls"] == 3
        assert len(spawned) == 1
        await runtime.stop()

    asyncio.run(run())


def test_auto_start_reports_early_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def dead_health(**_kwargs: Any) -> dict:
        raise OpenCodeClientError("connection refused")

    monkeypatch.setattr(client, "health", dead_health)

    async def fake_spawn(*args: Any, **kwargs: Any) -> _ExitedProc:
        return _ExitedProc("fatal: boom")

    _patch_serve(monkeypatch, fake_spawn)

    async def run() -> None:
        with pytest.raises(RuntimeError, match="exited early"):
            await runtime._auto_start_serve("http://127.0.0.1:4096")
        assert runtime._serve is None
        await runtime.stop()

    asyncio.run(run())


def test_auto_start_adopts_external_serve_on_port(monkeypatch: pytest.MonkeyPatch) -> None:
    """Port busy while our child exits -> keep the externally-started serve."""
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    state = {"calls": 0}

    async def booting_health(**_kwargs: Any) -> dict:
        state["calls"] += 1
        if state["calls"] <= 2:  # precheck + adoption poll fail, then external serve is up
            raise OpenCodeClientError("connection refused")
        return {"healthy": True, "version": "1.18"}

    monkeypatch.setattr(client, "health", booting_health)

    async def fake_spawn(*args: Any, **kwargs: Any) -> _ExitedProc:
        return _ExitedProc("listen EADDRINUSE 127.0.0.1:4096")

    _patch_serve(monkeypatch, fake_spawn)

    async def run() -> None:
        await runtime._auto_start_serve("http://127.0.0.1:4096")
        assert runtime._serve is None  # external serve adopted, nothing owned

    asyncio.run(run())


def test_auto_start_adopts_env_server_password(monkeypatch: pytest.MonkeyPatch) -> None:
    """serve inherits OPENCODE_SERVER_PASSWORD -> health needs Basic auth.

    The username is pinned to ``opencode``: serve ignores
    ``OPENCODE_SERVER_USERNAME``, so adopting the environment's ``lcl`` here is
    exactly what made every health call answer 401 against 2.x.
    """
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    monkeypatch.setattr(
        serve_process,
        "serve_environment",
        lambda: {"OPENCODE_SERVER_PASSWORD": "pw", "OPENCODE_SERVER_USERNAME": "lcl"},
    )

    async def run() -> None:
        await runtime._auto_start_serve("http://127.0.0.1:4096")
        assert client.api_key == "pw"
        assert client.api_user == "opencode"
        assert runtime._serve is None  # precheck health passed once the key was applied
        # Discovery probes the same URL without a runtime; it must be able to
        # authenticate or it would report this healthy serve as unavailable.
        assert serve_process.registered_serve_credentials("http://127.0.0.1:4096") == (
            "opencode",
            "pw",
        )

    asyncio.run(run())


def test_auto_start_reports_401_without_spawning_second_serve(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 401 on the precheck means a foreign serve is up with other credentials;
    spawning a second serve would only die on the shared log-file lock."""
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def denied(**_kwargs: Any) -> dict:
        raise OpenCodeClientError("opencode GET /global/health failed: 401", status_code=401)

    monkeypatch.setattr(client, "health", denied)

    async def no_spawn(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("must not spawn while a 401 serve owns the port")

    _patch_serve(monkeypatch, no_spawn)

    async def run() -> None:
        with pytest.raises(RuntimeError, match="401"):
            await runtime._auto_start_serve("http://127.0.0.1:4096")

    asyncio.run(run())


def test_auto_start_adopts_serve_when_port_has_unlisted_listener(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Production failure: child died with 'ServeError' (no EADDRINUSE marker)
    while a foreign serve already held the port -> must adopt, not give up."""
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    state = {"calls": 0}

    async def booting_health(**_kwargs: Any) -> dict:
        state["calls"] += 1
        if state["calls"] <= 2:  # precheck + adoption poll fail, then serve answers
            raise OpenCodeClientError("connection refused")
        return {"healthy": True, "version": "1.18"}

    monkeypatch.setattr(client, "health", booting_health)

    async def fake_spawn(*args: Any, **kwargs: Any) -> _ExitedProc:
        return _ExitedProc("Error: Unexpected error\nServeError")

    _patch_serve(monkeypatch, fake_spawn)

    async def listening(host_: str, port_: int) -> bool:
        return True

    monkeypatch.setattr(OpenCodeRuntime, "_port_listening", staticmethod(listening))

    async def run() -> None:
        await runtime._auto_start_serve("http://127.0.0.1:4096")
        assert runtime._serve is None

    asyncio.run(run())


def test_auto_start_spawns_despite_the_log_lock_holder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A TUI holding opencode.log must not wedge auto-start.

    Production failure: ``is_serve_log_lock_held`` reported True (the user's
    opencode TUI holds the log file), so the connector never spawned, waited
    17s for a serve that did not exist, and failed ``runtime.start`` three
    times. On serve 1.18.34 a second ``opencode serve`` starts fine while that
    file is held, so the probe may only delay a spawn, never block it.
    """
    from connector.runtimes.opencode import runtime as runtime_module

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    state = {"calls": 0}

    async def down_then_up(**_kwargs: Any) -> dict:
        state["calls"] += 1
        if state["calls"] <= 2:  # precheck + one adoption poll fail
            raise OpenCodeClientError("All connection attempts failed")
        return {"healthy": True, "version": "1.18"}

    monkeypatch.setattr(client, "health", down_then_up)
    monkeypatch.setattr(serve_process, "is_serve_log_lock_held", lambda environment: True)
    # Both windows are shortened; the free-port grace is the one that applies
    # here, and the point of the test is that the holder cannot wedge the spawn.
    monkeypatch.setattr(runtime_module, "PORT_ADOPTION_WAIT_S", 0.01)
    monkeypatch.setattr(runtime_module, "PORT_ADOPTION_GRACE_S", 0.01)
    proc = _FakeProc()

    async def fake_spawn(*args: Any, **kwargs: Any) -> _FakeProc:
        return proc

    _patch_serve(monkeypatch, fake_spawn)

    async def run() -> None:
        await runtime._auto_start_serve("http://127.0.0.1:4096")
        assert runtime._serve is not None and runtime._serve.process is proc

    asyncio.run(run())


async def _never_spawn(*args: Any, **kwargs: Any) -> None:
    raise AssertionError("must adopt the serve instead of spawning")


async def _async_true(host: str, port: int) -> bool:
    return True


async def _async_false(host: str, port: int) -> bool:
    return False


def test_auto_start_waits_longer_for_adoption_when_the_port_is_taken(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The adoption window follows the evidence.

    Something on our port that has not answered yet may be a serve that is
    booting, so it gets the full window. A free port means there is nothing to
    wait for -- and on a machine where some opencode always holds the log (a
    TUI, CherryStudio) that is every restart, which is why the free-port case
    must not pay the full 15s: the runtime was unavailable for 1.5-2.5 minutes
    while the client got ``status='starting'`` for every request.
    """
    from connector.runtimes.opencode import runtime as runtime_module

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def down(**_kwargs: Any) -> dict:
        raise OpenCodeClientError("connection refused")

    monkeypatch.setattr(client, "health", down)
    monkeypatch.setattr(serve_process, "is_serve_log_lock_held", lambda environment: True)
    windows: list[float | None] = []

    async def record_adoption(timeout_s: float | None = None) -> tuple[bool, Any]:
        windows.append(timeout_s)
        return True, None  # adopted; the spawn must not run

    monkeypatch.setattr(runtime, "_adoption_wait", record_adoption)
    # _patch_serve also stubs _port_listening, so it has to come first.
    _patch_serve(monkeypatch, _never_spawn)
    monkeypatch.setattr(OpenCodeRuntime, "_port_listening", staticmethod(_async_true))

    async def taken() -> None:
        await runtime._auto_start_serve("http://127.0.0.1:4096")
        assert windows == [None], windows  # None -> the full PORT_ADOPTION_WAIT_S

    asyncio.run(taken())

    client2, host2 = FakeClient(), FakeHost()
    runtime2 = _make_runtime(client2, host2)
    monkeypatch.setattr(client2, "health", down)
    windows.clear()
    monkeypatch.setattr(runtime2, "_adoption_wait", record_adoption)
    monkeypatch.setattr(OpenCodeRuntime, "_port_listening", staticmethod(_async_false))

    async def free() -> None:
        await runtime2._auto_start_serve("http://127.0.0.1:4096")
        assert windows == [runtime_module.PORT_ADOPTION_GRACE_S], windows
        assert runtime_module.PORT_ADOPTION_GRACE_S < runtime_module.PORT_ADOPTION_WAIT_S

    asyncio.run(free())


def test_auto_start_reports_the_log_holder_when_the_spawn_dies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The hint is still worth surfacing — but only once the spawn really died."""
    from connector.runtimes.opencode import runtime as runtime_module

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def always_down(**_kwargs: Any) -> dict:
        raise OpenCodeClientError("connection refused")

    monkeypatch.setattr(client, "health", always_down)
    monkeypatch.setattr(serve_process, "is_serve_log_lock_held", lambda environment: True)
    monkeypatch.setattr(runtime_module, "PORT_ADOPTION_WAIT_S", 0.01)

    async def fake_spawn(*args: Any, **kwargs: Any) -> _ExitedProc:
        return _ExitedProc("")

    _patch_serve(monkeypatch, fake_spawn)

    async def not_listening(host_: str, port_: int) -> bool:
        return False

    monkeypatch.setattr(OpenCodeRuntime, "_port_listening", staticmethod(not_listening))

    async def run() -> None:
        with pytest.raises(RuntimeError, match="opencode.log"):
            await runtime._auto_start_serve("http://127.0.0.1:4096")
        assert runtime._serve is None

    asyncio.run(run())


def test_auto_start_adopts_a_serve_behind_the_log_holder(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A booting serve is worth adopting before spawning our own."""
    from connector.runtimes.opencode import runtime as runtime_module

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    state = {"calls": 0}

    async def booting_health(**_kwargs: Any) -> dict:
        state["calls"] += 1
        if state["calls"] <= 1:  # precheck fails, then the booting serve answers
            raise OpenCodeClientError("connection refused")
        return {"healthy": True, "version": "1.18"}

    monkeypatch.setattr(client, "health", booting_health)
    monkeypatch.setattr(serve_process, "is_serve_log_lock_held", lambda environment: True)
    monkeypatch.setattr(runtime_module, "PORT_ADOPTION_WAIT_S", 0.01)

    async def no_spawn(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("must adopt the serve that just answered health")

    _patch_serve(monkeypatch, no_spawn)

    async def run() -> None:
        await runtime._auto_start_serve("http://127.0.0.1:4096")
        assert runtime._serve is None

    asyncio.run(run())


def test_auto_start_still_refuses_when_a_serve_answers_401(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A live serve with credentials we do not have is unspawnable-around."""
    from connector.runtimes.opencode import runtime as runtime_module

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def denied(**_kwargs: Any) -> dict:
        raise OpenCodeClientError("opencode GET /global/health failed: 401", status_code=401)

    monkeypatch.setattr(client, "health", denied)
    monkeypatch.setattr(serve_process, "is_serve_log_lock_held", lambda environment: True)
    monkeypatch.setattr(runtime_module, "PORT_ADOPTION_WAIT_S", 0.01)

    async def no_spawn(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("must not spawn while a 401 serve owns the port")

    _patch_serve(monkeypatch, no_spawn)

    async def run() -> None:
        with pytest.raises(RuntimeError, match="401"):
            await runtime._auto_start_serve("http://127.0.0.1:4096")

    asyncio.run(run())


def test_auto_start_adopts_serve_when_only_log_lock_busy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Child died silently (no EADDRINUSE, no listener) while the log lock was
    held by a serve that is still booting -> adoption must still succeed."""
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    state = {"calls": 0}

    async def booting_health(**_kwargs: Any) -> dict:
        state["calls"] += 1
        if state["calls"] <= 2:  # precheck + first adoption poll fail, then serve answers
            raise OpenCodeClientError("connection refused")
        return {"healthy": True, "version": "1.18"}

    monkeypatch.setattr(client, "health", booting_health)
    lock_calls = {"n": 0}

    def lock_probe(environment: Any) -> bool:
        lock_calls["n"] += 1
        return lock_calls["n"] > 1  # free before our spawn, held after the crash

    monkeypatch.setattr(serve_process, "is_serve_log_lock_held", lock_probe)

    async def fake_spawn(*args: Any, **kwargs: Any) -> _ExitedProc:
        return _ExitedProc("Error: Unexpected error\nUnknown: FileSystem.open")

    _patch_serve(monkeypatch, fake_spawn)

    async def run() -> None:
        await runtime._auto_start_serve("http://127.0.0.1:4096")
        assert runtime._serve is None

    asyncio.run(run())


def test_start_auto_starts_local_serve_when_down(monkeypatch: pytest.MonkeyPatch) -> None:
    """The reported bug: connector started while serve was down -> runtime never
    became 'running'. With auto-start, start() spawns serve and recovers."""
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    state = {"calls": 0}

    async def down_then_up(**_kwargs: Any) -> dict:
        state["calls"] += 1
        if state["calls"] < 3:
            raise OpenCodeClientError("All connection attempts failed")
        return {"healthy": True, "version": "1.18"}

    monkeypatch.setattr(client, "health", down_then_up)
    proc = _FakeProc()

    async def fake_spawn(*args: Any, **kwargs: Any) -> _FakeProc:
        return proc

    _patch_serve(monkeypatch, fake_spawn)

    async def run() -> None:
        await runtime.start()  # must not raise
        assert runtime._serve.process is proc
        assert runtime.identity.runtime_version == "1.18"
        await runtime.stop()
        assert proc.terminated is True
        assert runtime._serve is None

    asyncio.run(run())


def test_start_names_the_log_lock_instead_of_retrying(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A spawn killed by opencode.log is reported once, with the real cause.

    ``--print-logs`` does not reliably stop opencode 1.18.34 from opening the
    log file, so a spawn next to a running TUI dies with a bare "Unexpected
    error" -- or through Bun's own crash paths. Retrying cannot help (the holder
    is not leaving), and RuntimeUnavailableError is what ``start`` surfaces
    without another attempt.
    """

    from connector.runtimes.opencode import runtime as runtime_module

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    spawns: list[Any] = []

    async def always_down(**_kwargs: Any) -> dict:
        raise OpenCodeClientError("connection refused")

    monkeypatch.setattr(client, "health", always_down)
    monkeypatch.setattr(serve_process, "is_serve_log_lock_held", lambda environment: False)
    monkeypatch.setattr(runtime_module, "PORT_ADOPTION_WAIT_S", 0.01)
    monkeypatch.setattr(
        serve_process,
        "opencode_log_path",
        lambda environment: r"C:\Users\me\.local\share\opencode\log\opencode.log",
    )

    async def dying_spawn(*args: Any, **kwargs: Any) -> Any:
        spawns.append(args)
        return _ExitedProc(
            "Error: Unexpected error\n"
            r"Unknown: FileSystem.open (C:\Users\me\.local\share\opencode\log\opencode.log)"
        )

    _patch_serve(monkeypatch, dying_spawn)

    async def run() -> None:
        with pytest.raises(RuntimeUnavailableError, match="opencode.log"):
            await runtime.start()
        # One attempt only: the holder is not going away, so two more spawns would
        # just crash two more Bun processes.
        assert len(spawns) == 1, spawns

    asyncio.run(run())


def test_start_reports_the_log_lock_when_bun_fastfails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The same lock reaches us as a Windows fastfail code, with no message."""

    from connector.runtimes.opencode import runtime as runtime_module

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def always_down(**_kwargs: Any) -> dict:
        raise OpenCodeClientError("connection refused")

    monkeypatch.setattr(client, "health", always_down)
    monkeypatch.setattr(serve_process, "is_serve_log_lock_held", lambda environment: False)
    monkeypatch.setattr(runtime_module, "PORT_ADOPTION_WAIT_S", 0.01)

    async def bun_crash(*args: Any, **kwargs: Any) -> Any:
        return _ExitedProc("STATUS_STACK_BUFFER_OVERRUN (Bun 启动 fastfail)")

    _patch_serve(monkeypatch, bun_crash)

    async def run() -> None:
        with pytest.raises(RuntimeUnavailableError):
            await runtime.start()

    asyncio.run(run())


def test_start_remote_url_fails_without_spawn(monkeypatch: pytest.MonkeyPatch) -> None:
    client, host = FakeClient(), FakeHost()
    values = provider_config.default_config_values()
    values["serverUrl"] = "http://10.0.0.5:4096"
    runtime = _make_runtime(client, host, values=values)

    async def always_down(**_kwargs: Any) -> dict:
        raise OpenCodeClientError("connection refused")

    monkeypatch.setattr(client, "health", always_down)

    async def no_spawn(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("must not spawn for a remote serverUrl")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", no_spawn)

    async def run() -> None:
        with pytest.raises(RuntimeUnavailableError):
            await runtime.start()
        assert runtime._serve is None

    asyncio.run(run())


def test_serve_exit_reports_health_and_recovers(monkeypatch: pytest.MonkeyPatch) -> None:
    """An unexpected child exit surfaces as an error health update and the
    recovery pass marks the runtime running again once serve answers."""
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    state = {"calls": 0}

    async def down_twice(**_kwargs: Any) -> dict:
        state["calls"] += 1
        if state["calls"] <= 2:  # start() probe + auto-start pre-check
            raise OpenCodeClientError("connection refused")
        return {"healthy": True, "version": "1.18"}

    monkeypatch.setattr(client, "health", down_twice)
    proc = _FakeProc()

    async def fake_spawn(*args: Any, **kwargs: Any) -> _FakeProc:
        return proc

    _patch_serve(monkeypatch, fake_spawn)

    async def run() -> None:
        await runtime.start()
        assert runtime._serve is not None and runtime._serve.process is proc
        proc.crash(2, "fatal: serve died")
        for _ in range(400):
            if any(h[0] == "running" for h in host.health):
                break
            await asyncio.sleep(0.01)
        assert any(
            h[0] == "error" and (h[1] or {}).get("code") == "opencode_serve_exited"
            for h in host.health
        )
        assert any(h[0] == "running" for h in host.health)
        await runtime.stop()

    asyncio.run(run())


def test_recovery_respawns_child_while_serve_unhealthy(monkeypatch: pytest.MonkeyPatch) -> None:
    """While serve stays unreachable, recovery keeps spawning attempts."""
    from connector.runtimes.opencode import runtime as runtime_module

    host = FakeHost()
    state = {"healthy": False}

    async def down_health(**_kwargs: Any) -> dict:
        if state["healthy"]:
            return {"healthy": True, "version": "1.18"}
        raise OpenCodeClientError("connection refused")

    client = FakeClient()
    monkeypatch.setattr(client, "health", down_health)
    procs: list[_FakeProc] = []

    async def fake_spawn(*args: Any, **kwargs: Any) -> _FakeProc:
        proc = _FakeProc()
        procs.append(proc)
        return proc

    _patch_serve(monkeypatch, fake_spawn)
    monkeypatch.setattr(runtime_module, "SERVE_RESTART_INITIAL_BACKOFF_S", 0.01)

    config = asyncio.run(
        OpenCodeProvider().validate_config({"serverUrl": "http://127.0.0.1:4096"})
    )
    runtime = OpenCodeRuntime(
        config=config, host=host, client=client, auto_start_serve_timeout_s=0.05
    )

    async def run() -> None:
        runtime._schedule_recovery("unit-respawn")
        for _ in range(200):
            if procs:
                break
            await asyncio.sleep(0.01)
        assert procs, "recovery spawned a serve child"
        state["healthy"] = True
        for _ in range(400):
            if any(h[0] == "running" for h in host.health):
                break
            await asyncio.sleep(0.01)
        assert any(h[0] == "running" for h in host.health)
        await runtime.stop()

    asyncio.run(run())


def test_stop_closes_client_and_cancels_events() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime.start()
        assert runtime._event_task is not None
        await runtime.stop()
        assert client.closed is True
        assert runtime._event_task is None

    asyncio.run(run())


def test_model_catalog_from_provider_overview() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        catalog = await runtime.list_model_catalog()
        # Non-chat models (embed-only: no toolcall, image-only: no text output)
        # are filtered out, leaving the single chat-capable model.
        assert len(catalog.models) == 1
        item = catalog.models[0]
        assert item.id == "local/nemotron35-dspark"
        assert "262144" in (item.description or "")
        # Reasoning items are derived from the model's ``variants`` map; the
        # catalog must not report an empty effort list for a reasoning model.
        assert [effort.id for effort in item.reasoning_items] == ["low", "medium", "high"]
        assert [effort.title for effort in item.reasoning_items] == ["Low", "Medium", "High"]
        # With reasoning items present, the model itself has no selection id;
        # each variant carries its own selection id instead.
        assert item.selection_id is None
        assert all(effort.selection_id for effort in item.reasoning_items)
        assert all(
            effort.selection_id.startswith("sel_model_") for effort in item.reasoning_items
        )

    asyncio.run(run())


# --------------------------------------------------------------------------- #
# model selection: the composer sends a selection id, not the model key
# --------------------------------------------------------------------------- #


def test_picked_model_selection_id_reaches_the_prompt() -> None:
    """The reported bug: a picked model never reached the turn.

    The composer's picker is keyed by the model id, but the selection it sends
    over the runtime RPC is the catalog's one-way ``sel_model_*`` id. Only
    ``provider/model`` was understood, so every turn went out without a model,
    opencode used its own default, and the picker still showed the model the
    user had chosen.
    """

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        catalog = await runtime.list_model_catalog()
        item = catalog.models[0]
        # This model has reasoning variants, so the id the client can pick lives
        # on a variant -- exactly what the picker sends.
        reasoning = item.reasoning_items[1]
        selection = reasoning.selection_id
        assert selection and selection.startswith("sel_model_")

        await runtime.start_turn(
            "ses_sel", "ses_x", "hello", selections={"model": selection}
        )
        # The effort is half of what the id encodes, and opencode's ModelRef
        # carries it as ``variant`` on the prompt too -- so the picker's effort
        # choice reaches the turn instead of being logged and dropped.
        assert client.prompted[-1][2] == {
            "providerID": "local",
            "modelID": "nemotron35-dspark",
            "variant": reasoning.metadata["variant"],
        }, client.prompted[-1]

    asyncio.run(run())


def test_model_selection_id_is_mirrored_to_opencode() -> None:
    """Switching the model must also reach opencode's own session record."""

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        catalog = await runtime.list_model_catalog()
        reasoning = catalog.models[0].reasoning_items[0]
        result = await runtime.update_session_selections(
            "ses_sel", "ses_x", {"model": reasoning.selection_id}
        )
        assert result.ok, result.message
        # (session, model, provider, variant, directory)
        assert client.model_switches[-1][:4] == (
            "ses_x",
            "nemotron35-dspark",
            "local",
            reasoning.metadata["variant"],
        ), client.model_switches

    asyncio.run(run())


def test_reported_model_selection_stays_a_resolvable_selection_id() -> None:
    """``session.state.selections`` must round-trip as selection ids.

    The composer resolves ``selections.model`` with ``modelIdsForSelectionId``,
    i.e. it expects the catalog's one-way id -- exactly what it sent. Reporting a
    resolved ``provider/model`` key instead left it matching no option, so the
    picker showed the first catalog entry (MIMO) while the turn itself ran on the
    picked model. Same contract as the permission selection, which always travels
    as ``sel_permission_*``.
    """

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        catalog = await runtime.list_model_catalog()
        selection = catalog.models[0].reasoning_items[1].selection_id
        await runtime.update_session_selections("ses_sel", "ses_x", {"model": selection})
        client.sessions["ses_x"] = {"id": "ses_x"}
        state = await runtime.get_session_state("ses_sel", "ses_x")
        assert state is not None
        assert state.selections["model"] == selection, state.selections
        # And the client can map it straight back to the model it picked.
        assert state.selections["model"] in {
            item.selection_id for item in catalog.models
        } | {effort.selection_id for item in catalog.models for effort in item.reasoning_items}

    asyncio.run(run())


def test_model_fallback_after_restart_reports_a_resolvable_selection_id() -> None:
    """With no in-memory selection the session's own model is reported as an id.

    After a connector restart the picker still has to show the model the session
    is actually on, and it can only do that from an id the catalog contains.
    """

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        catalog = await runtime.list_model_catalog()
        item = catalog.models[0]
        provider_id, _, model_id = item.id.partition("/")
        client.sessions["ses_x"] = {"id": "ses_x", "model": {"providerID": provider_id, "id": model_id}}
        state = await runtime.get_session_state("ses_sel", "ses_x")
        assert state is not None
        reported = state.selections["model"]
        assert reported in {
            effort.selection_id for effort in item.reasoning_items
        } | ({item.selection_id} if item.selection_id else set()), reported

    asyncio.run(run())


def test_unknown_model_selection_sends_no_model() -> None:
    """An id that matches nothing must not silently pick something else."""

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime.start_turn(
            "ses_sel", "ses_x", "hello", selections={"model": "sel_model_nope"}
        )
        assert client.prompted[-1][2] is None, client.prompted[-1]

    asyncio.run(run())


# --------------------------------------------------------------------------- #
# permission catalog (Build / Plan)
# --------------------------------------------------------------------------- #


def test_permission_catalog_exposes_build_and_plan() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        catalog = await runtime.list_permission_catalog()
        # Only user-selectable primary agents become presets: the ``explore``
        # subagent and opencode's internal ``compaction`` agent are not modes.
        assert [item.id for item in catalog.permissions] == ["build", "plan"]
        assert [item.title for item in catalog.permissions] == ["Build", "Plan"]
        # Selection ids are opaque protocol ids (``protocol_selection_id``
        # hashes its identity), and Build is what an unset picker shows.
        assert all(
            item.selection_id.startswith("sel_permission_")
            for item in catalog.permissions
        )
        assert len({item.selection_id for item in catalog.permissions}) == 2
        assert [item.default for item in catalog.permissions] == [True, False]
        assert catalog.permissions[1].metadata["runtimeSettings"] == {"agent": "plan"}
        # Agents are read once per project directory and cached.
        assert client.agent_directories == [None]
        await runtime.list_permission_catalog()
        assert client.agent_directories == [None]

        queried = await runtime.list_permission_catalog(query="plan")
        assert [item.id for item in queried.permissions] == ["plan"]

    asyncio.run(run())


def test_permission_catalog_skips_absent_presets() -> None:
    client, host = FakeClient(), FakeHost()
    # A project without the plan agent must not offer a mode it cannot run.
    client.agents = [{"name": "build", "mode": "primary", "permission": []}]
    runtime = _make_runtime(client, host)

    async def run() -> None:
        catalog = await runtime.list_permission_catalog()
        assert [item.id for item in catalog.permissions] == ["build"]

    asyncio.run(run())


def test_permission_catalog_survives_agent_list_failure() -> None:
    class BrokenAgentClient(FakeClient):
        async def list_agents(self, directory: str | None = None) -> list[dict[str, Any]]:
            raise OpenCodeClientError("opencode GET /agent failed: 500")

    runtime = _make_runtime(BrokenAgentClient(), FakeHost())

    async def run() -> None:
        catalog = await runtime.list_permission_catalog()
        # An unreadable agent list means no known presets: report an empty
        # catalog instead of offering a mode that may not exist.
        assert catalog.permissions == ()

    asyncio.run(run())


def test_capabilities_declare_permission_catalog() -> None:
    runtime = _make_runtime(FakeClient(), FakeHost())

    async def run() -> None:
        runtime_caps = await runtime.get_runtime_capabilities()
        session_caps = await runtime.get_session_capabilities("plat_1")
        assert CAPABILITY_CATALOG_PERMISSION in {
            capability.capability_id for capability in runtime_caps.capabilities
        }
        # The Server projects a session's effective capabilities from the
        # session-scoped set only, so the mirror is what makes the client
        # render the mode selector on an open session.
        session_entries = {
            capability.capability_id: capability
            for capability in session_caps.capabilities
        }
        assert CAPABILITY_CATALOG_PERMISSION in session_entries
        assert session_entries[CAPABILITY_CATALOG_PERMISSION].session_id == "plat_1"

    asyncio.run(run())


async def _permission_selections(runtime: OpenCodeRuntime) -> dict[str, str]:
    catalog = await runtime.list_permission_catalog()
    return {item.id: item.selection_id for item in catalog.permissions}


def test_selected_mode_runs_on_the_next_turn() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        selections = await _permission_selections(runtime)
        await runtime.create_and_start_session("plat_1", "hi")
        native_id = next(iter(client.sessions))

        result = await runtime.update_session_selections(
            "plat_1", native_id, {PERMISSION_SELECTION_KEY: selections["plan"]}
        )
        assert result.ok, result.message
        assert runtime._selections["plat_1"][PERMISSION_SELECTION_KEY] == selections["plan"]

        # opencode switches Build/Plan per prompt: the agent rides on the next
        # prompt (and opencode then records it as ``session["agent"]``).
        await runtime.start_turn("plat_1", native_id, "again")
        assert client.prompt_agents[-1] == (native_id, "plan")

        await runtime.update_session_selections(
            "plat_1", native_id, {PERMISSION_SELECTION_KEY: selections["build"]}
        )
        await runtime.start_turn("plat_1", native_id, "and again")
        assert client.prompt_agents[-1] == (native_id, "build")

    asyncio.run(run())


def test_create_session_applies_the_selected_mode() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        selections = await _permission_selections(runtime)
        await runtime.create_and_start_session(
            "plat_1", "hi", selections={PERMISSION_SELECTION_KEY: selections["plan"]}
        )
        native_id = next(iter(client.sessions))
        # The mode must apply to the very first turn, and be remembered even
        # though the client will not resend the selection.
        assert client.prompt_agents[-1] == (native_id, "plan")
        await runtime.start_turn("plat_1", native_id, "again")
        assert client.prompt_agents[-1] == (native_id, "plan")

    asyncio.run(run())


def test_steer_turn_keeps_the_selected_mode() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        selections = await _permission_selections(runtime)
        await runtime.create_and_start_session(
            "plat_1", "hi", selections={PERMISSION_SELECTION_KEY: selections["plan"]}
        )
        native_id = next(iter(client.sessions))
        await runtime.steer_turn("plat_1", native_id, "wait, do this instead")
        assert client.prompt_agents[-1] == (native_id, "plan")

    asyncio.run(run())


def test_update_selections_rejects_unknown_permission_id() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime.create_and_start_session("plat_1", "hi")
        native_id = next(iter(client.sessions))
        result = await runtime.update_session_selections(
            "plat_1", native_id, {PERMISSION_SELECTION_KEY: "sel_permission_bogus"}
        )
        assert not result.ok
        assert result.code == "opencode_invalid_selection"
        # Nothing was stored: the caller keeps its previous mode.
        assert PERMISSION_SELECTION_KEY not in runtime._selections.get("plat_1", {})

    asyncio.run(run())


def test_turn_without_permission_selection_leaves_the_mode_alone() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime.create_and_start_session(
            "plat_1", "hi", selections={"model": "local/x"}
        )
        native_id = next(iter(client.sessions))
        # No mode was ever picked on this session, so the agent stays unset and
        # opencode keeps whatever mode the user chose in its own UI.
        assert client.prompt_agents[-1] == (native_id, None)
        assert PERMISSION_SELECTION_KEY not in runtime._selections["plat_1"]

    asyncio.run(run())


def test_session_selections_read_back_the_mode_after_restart() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        selections = await _permission_selections(runtime)
        native_id = "ses_native"
        client.sessions[native_id] = {"id": native_id, "agent": "plan"}
        await runtime.update_session_selections(
            "plat_1", native_id, {PERMISSION_SELECTION_KEY: selections["plan"]}
        )

        # Simulate a connector restart: the in-memory selections are gone, so
        # the mode has to come from the agent opencode recorded on the session.
        runtime._selections.clear()
        state = await runtime.get_session_state("plat_1", native_id)
        assert state is not None
        assert state.selections[PERMISSION_SELECTION_KEY] == selections["plan"]

        # Agents that are not user-selectable modes (a subagent, or
        # ``compaction``) report no mode rather than a wrong one.
        for agent in ("explore", "compaction", "", None):
            client.sessions[native_id]["agent"] = agent
            runtime._selections.clear()
            state = await runtime.get_session_state("plat_1", native_id)
            assert state is not None
            assert PERMISSION_SELECTION_KEY not in state.selections

        # In-memory selections win: a freshly picked mode is reported before
        # the next turn has actually run it.
        client.sessions[native_id]["agent"] = "build"
        await runtime.update_session_selections(
            "plat_1", native_id, {PERMISSION_SELECTION_KEY: selections["plan"]}
        )
        state = await runtime.get_session_state("plat_1", native_id)
        assert state is not None
        assert state.selections[PERMISSION_SELECTION_KEY] == selections["plan"]

    asyncio.run(run())


def test_mode_selection_is_dropped_when_the_preset_is_absent() -> None:
    client, host = FakeClient(), FakeHost()
    client.agents = [{"name": "build", "mode": "primary", "permission": []}]
    runtime = _make_runtime(client, host)

    async def run() -> None:
        plan_selection = "sel_permission_plan"
        await runtime.create_and_start_session(
            "plat_1", "hi", selections={PERMISSION_SELECTION_KEY: plan_selection}
        )
        native_id = next(iter(client.sessions))
        # serve accepts an unknown agent name and then runs no turn at all, so
        # a mode that is not installed must not be sent.
        assert client.prompt_agents[-1] == (native_id, None)

    asyncio.run(run())


# --------------------------------------------------------------------------- #
# slash commands (skills are directory-scoped in opencode)
# --------------------------------------------------------------------------- #


def test_session_commands_are_read_from_the_session_directory() -> None:
    client, host = FakeClient(), FakeHost()
    client.skills = [{"name": "init", "description": "guided setup", "template": "..."}]
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime.create_and_start_session("plat_1", "hi", cwd="/work")
        native_id = next(iter(client.sessions))
        commands = await runtime.list_commands("plat_1", native_id)
        assert [command.id for command in commands][-1] == "init"
        # ``GET /command`` answers 503 without ``?directory=``, so the session's
        # own workspace has to be passed or no skill ever shows up.
        assert client.command_directories == ["/work"]

        # The runtime-level list has no session context and falls back to the
        # serve cwd instead of guessing a project.
        await runtime.list_runtime_commands()
        assert client.command_directories[-1] is None

    asyncio.run(run())


def test_command_list_failure_keeps_builtins() -> None:
    class BrokenCommandClient(FakeClient):
        async def list_commands(self, directory: str | None = None) -> list[dict[str, Any]]:
            raise OpenCodeClientError("opencode GET /command failed: 503")

    runtime = _make_runtime(BrokenCommandClient(), FakeHost())

    async def run() -> None:
        commands = await runtime.list_commands("plat_1", "ses_x")
        assert commands, "builtins must survive an unreadable command list"
        assert all(command.metadata.get("builtin") for command in commands)

    asyncio.run(run())


# --------------------------------------------------------------------------- #
# interactions (approvals and questions)
# --------------------------------------------------------------------------- #


def _permission_event(
    session_id: str, permission_id: str = "per_1", action: str = "bash"
) -> dict[str, Any]:
    return {
        "type": "permission.v2.asked",
        "properties": {
            "id": permission_id,
            "sessionID": session_id,
            "action": action,
            "resources": ["rm -rf build"],
        },
    }


def _question_event(session_id: str, question_id: str = "que_1") -> dict[str, Any]:
    return {
        "type": "question.v2.asked",
        "properties": {
            "id": question_id,
            "sessionID": session_id,
            "questions": [
                {
                    "question": "Which database should I use?",
                    "options": [{"label": "PostgreSQL"}, {"label": "SQLite"}],
                }
            ],
        },
    }


async def _drain(runtime: OpenCodeRuntime, events: list[dict[str, Any]]) -> None:
    for event in events:
        await runtime._handle_event(
            {"type": event["type"], "properties": event["properties"]}
        )


def test_permission_approval_resumes_the_tracked_turn() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime.create_and_start_session("plat_1", "hi", cwd="/work")
        native_id = next(iter(client.sessions))
        await _drain(runtime, [_permission_event(native_id)])
        # A blocking approval must take the platform session out of "running".
        assert ("plat_1", "waiting_approval") in host.state_updates

        notices = await runtime.get_session_notices("plat_1", native_id)
        notice_id = next(
            notice.notice_id for notice in notices if notice.interaction_type == "approval"
        )
        result = await runtime.respond_interaction("plat_1", notice_id, "approve")
        assert result.ok, result.message
        assert client.permission_replies == [
            (native_id, "per_1", "once", "/work")
        ]
        # Without this the composer stays blocked until the turn ends.
        assert host.state_updates[-1] == ("plat_1", "running")
        assert await runtime.get_session_notices("plat_1", native_id) == ()

    asyncio.run(run())


def test_question_notice_lists_options_and_blocks_the_turn() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime.create_and_start_session("plat_1", "hi", cwd="/work")
        native_id = next(iter(client.sessions))
        await _drain(runtime, [_question_event(native_id)])
        # A question blocks the turn exactly like a permission request.
        assert ("plat_1", "waiting_approval") in host.state_updates

        notices = await runtime.get_session_notices("plat_1", native_id)
        notice = next(n for n in notices if n.interaction_type == "input_request")
        # The selectable options have to reach the user, otherwise the notice
        # only says "OpenCode 向你提问" and cannot be answered sensibly.
        # "input_request" is the Server's accepted kind; a "question" literal
        # would be rejected by the notice whitelist and never reach the client.
        assert "PostgreSQL" in (notice.message or "")
        assert "SQLite" in (notice.message or "")
        assert notice.context.get("options") == ["PostgreSQL", "SQLite"]

        result = await runtime.respond_interaction(
            "plat_1", notice.notice_id, "reply", {"reply": "PostgreSQL"}
        )
        assert result.ok, result.message
        assert client.question_replies == [
            (native_id, "que_1", "PostgreSQL", "/work")
        ]
        assert host.state_updates[-1] == ("plat_1", "running")

    asyncio.run(run())


def test_question_dismiss_uses_the_reject_route() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime.create_and_start_session("plat_1", "hi", cwd="/work")
        native_id = next(iter(client.sessions))
        await _drain(runtime, [_question_event(native_id)])
        notice = next(
            n
            for n in await runtime.get_session_notices("plat_1", native_id)
            if n.interaction_type == "input_request"
        )
        result = await runtime.respond_interaction(
            "plat_1", notice.notice_id, "reply", {"reply": "cancel"}
        )
        assert result.ok, result.message
        assert client.question_rejects == [(native_id, "que_1", "/work")]
        assert client.question_replies == []

        # An empty answer is rejected by opencode, so refuse it locally.
        await _drain(runtime, [_question_event(native_id, "que_2")])
        notice = next(
            n
            for n in await runtime.get_session_notices("plat_1", native_id)
            if n.context.get("questionId") == "que_2"
        )
        result = await runtime.respond_interaction(
            "plat_1", notice.notice_id, "reply", {"reply": "  "}
        )
        assert not result.ok
        assert result.code == "empty_reply"

    asyncio.run(run())


def test_question_closed_by_opencode_resolves_the_notice() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime.create_and_start_session("plat_1", "hi", cwd="/work")
        native_id = next(iter(client.sessions))
        await _drain(runtime, [_question_event(native_id)])
        assert len(await runtime.get_session_notices("plat_1", native_id)) == 1
        # opencode resolves/rejects questions on its own too; the card must not
        # stay on screen forever in that case.
        await _drain(
            runtime,
            [{"type": "question.v2.replied", "properties": {"id": "que_1", "sessionID": native_id}}],
        )
        assert await runtime.get_session_notices("plat_1", native_id) == ()
        assert host.notices[-1].status == "resolved"

    asyncio.run(run())


def test_question_notice_is_only_recorded_after_a_successful_upload() -> None:
    """A rejected upload must not be deduped forever by ``_notices``.

    The old order (record, then publish with errors suppressed) meant one
    failed notice ingest left the question invisible for the rest of the
    process lifetime: the poll saw the stored notice and skipped it, while the
    Server never had the card to show.
    """
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime.create_and_start_session("plat_1", "hi", cwd="/work")
        native_id = next(iter(client.sessions))
        props = _question_event(native_id)["properties"]

        async def reject(notice: Any) -> None:
            raise RuntimeError("notice rejected")

        original_upsert = host.notice_upsert
        host.notice_upsert = reject
        await runtime._handle_question_asked("plat_1", native_id, props)
        assert runtime._notices == {}
        assert host.notices == []

        host.notice_upsert = original_upsert
        await runtime._handle_question_asked("plat_1", native_id, props)
        assert len(host.notices) == 1
        assert host.notices[0].interaction_type == "input_request"
        assert len(await runtime.get_session_notices("plat_1", native_id)) == 1

    asyncio.run(run())


def test_interaction_poll_surfaces_questions_from_untracked_busy_sessions() -> None:
    """Questions raised outside this process still reach the platform.

    A turn started from the native TUI (or surviving a connector restart) is
    not in ``_active_turns``, so the poll used to never probe it; the busy scan
    over ``/session/status`` is what closes that gap.
    """
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        await runtime.create_and_start_session("plat_1", "hi", cwd="/work")
        native_id = next(iter(client.sessions))
        runtime._active_turns.discard(native_id)
        client.status[native_id] = {"type": "busy"}
        client.pending_forms[native_id] = [
            {
                "id": "frm_1",
                "title": "Which database should I use?",
                "fields": [{"key": "db", "title": "Pick one", "options": [{"label": "PostgreSQL"}]}],
            }
        ]
        await runtime._poll_pending_interactions()
        notices = await runtime.get_session_notices("plat_1", native_id)
        assert len(notices) == 1
        assert notices[0].interaction_type == "input_request"
        assert notices[0].context["questionId"] == "frm_1"

    asyncio.run(run())


def test_reconcile_keeps_the_turn_while_an_interaction_is_pending() -> None:
    """A session waiting on the user is not reconciled away.

    serve drops a blocked session from the active map; finishing the turn then
    would remove the session from the poll's target set before the question
    card was ever raised, and open the composer early.
    """
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.create_and_start_session("plat_r", "hi", selections=None)
        native = result.result["externalSessionId"]
        assert native in runtime._active_turns
        del client.status[native]
        client.pending_forms[native] = [{"id": "frm_1", "title": "Choose", "fields": []}]
        await runtime._reconcile_active_turns()
        assert native in runtime._active_turns
        assert ("plat_r", "completed") not in host.turn_ended

        # once the form is answered, the ordinary recovery path resumes
        client.pending_forms.pop(native)
        await runtime._reconcile_active_turns()
        assert native not in runtime._active_turns
        assert ("plat_r", "completed") in host.turn_ended

    asyncio.run(run())


# --------------------------------------------------------------------------- #
# SDK client request/response contract (verified against serve 1.18.34)
# --------------------------------------------------------------------------- #


def _mock_client(
    handler: Any,
) -> tuple[OpenCodeClient, list[tuple[str, str, str]]]:
    import httpx

    calls: list[tuple[str, str, str]] = []

    def _handle(request: httpx.Request) -> httpx.Response:
        calls.append(
            (request.method, request.url.path, request.content.decode() or "")
        )
        return handler(request)

    client = OpenCodeClient("http://127.0.0.1:4096")
    client._http = httpx.AsyncClient(
        transport=httpx.MockTransport(_handle), base_url=client.base_url
    )
    return client, calls


def test_client_question_reply_answers_the_form_fields() -> None:
    """A V2 question is a form: the reply is keyed by field, not by question.

    ``POST /api/session/{id}/form/{formID}/reply`` takes ``{answer: {key:
    value}}``, so the client reads the form's field keys first and submits the
    reply for each of them; dismissing the question is a DELETE on the form.
    """

    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "data": {
                        "id": "frm_1",
                        "sessionID": "ses_x",
                        "title": "Pick a database",
                        "fields": [
                            {"key": "db", "type": "select", "title": "Database"},
                            {"key": "note", "type": "text", "hidden": True},
                        ],
                    }
                },
            )
        return httpx.Response(204)

    client, calls = _mock_client(handler)

    async def run() -> None:
        await client.reply_question("ses_x", "frm_1", "PostgreSQL", directory="/work")
        method, path, body = calls[0]
        assert (method, path) == ("GET", "/api/session/ses_x/form/frm_1")
        method, path, body = calls[1]
        assert method == "POST"
        assert path == "/api/session/ses_x/form/frm_1/reply"
        assert json.loads(body) == {
            "answer": {"db": "PostgreSQL", "note": "PostgreSQL"}
        }
        await client.reject_question("ses_x", "frm_1", directory="/work")
        assert calls[2][0] == "DELETE"
        assert calls[2][1] == "/api/session/ses_x/form/frm_1"
        await client.close()

    asyncio.run(run())


def test_client_rejects_the_web_ui_fallback() -> None:
    """An unknown opencode route answers 200 + HTML, which must not pass."""

    import httpx

    def spa(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, text="<!doctype html><html><body>opencode</body></html>",
            headers={"content-type": "text/html; charset=utf-8"},
        )

    client, _ = _mock_client(spa)

    async def run() -> None:
        with pytest.raises(OpenCodeClientError, match="web UI"):
            await client.get_session("ses_x")
        await client.close()

    asyncio.run(run())


def test_client_accepts_empty_204_without_content_type() -> None:
    """``prompt_async`` and the model switch answer 204 with no content-type."""

    import httpx

    def no_content(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/prompt_async"):
            return httpx.Response(204)
        return httpx.Response(200, json={"id": "ses_x"})

    client, _ = _mock_client(no_content)

    async def run() -> None:
        await client.prompt_async("ses_x", "hi")
        assert await client.switch_session_model("ses_x", "m", "p") is None
        await client.close()

    asyncio.run(run())


# --------------------------------------------------------------------------- #
# live streaming (payloads captured from serve 1.18.34)
# --------------------------------------------------------------------------- #

USER_MESSAGE_ID = "msg_user_1"
ASSISTANT_MESSAGE_ID = "msg_asst_1"
TEXT_PART_ID = "prt_text_1"
TOOL_PART_ID = "prt_tool_1"


def _user_message_event() -> dict[str, Any]:
    return {
        "type": "message.updated",
        "properties": {
            "sessionID": "ses_x",
            "info": {"id": USER_MESSAGE_ID, "role": "user", "time": {"created": 1_000}},
        },
    }


def _assistant_message_event() -> dict[str, Any]:
    return {
        "type": "message.updated",
        "properties": {
            "sessionID": "ses_x",
            "info": {
                "id": ASSISTANT_MESSAGE_ID,
                "parentID": USER_MESSAGE_ID,
                "role": "assistant",
                "mode": "build",
                "time": {"created": 2_000},
            },
        },
    }


def _text_part_event(text: str = "") -> dict[str, Any]:
    """``message.part.updated`` restates the whole part (no ``delta``)."""

    return {
        "type": "message.part.updated",
        "properties": {
            "sessionID": "ses_x",
            "part": {
                "id": TEXT_PART_ID,
                "messageID": ASSISTANT_MESSAGE_ID,
                "sessionID": "ses_x",
                "type": "text",
                "text": text,
            },
            "time": 2_100,
        },
    }


def _delta_event(delta: str, part_id: str = TEXT_PART_ID) -> dict[str, Any]:
    """``message.part.delta`` has no ``part`` object — ids + field + delta."""

    return {
        "type": "message.part.delta",
        "properties": {
            "sessionID": "ses_x",
            "messageID": ASSISTANT_MESSAGE_ID,
            "partID": part_id,
            "field": "text",
            "delta": delta,
        },
    }


def _tool_part_event(status: str) -> dict[str, Any]:
    return {
        "type": "message.part.updated",
        "properties": {
            "sessionID": "ses_x",
            "part": {
                "id": TOOL_PART_ID,
                "messageID": ASSISTANT_MESSAGE_ID,
                "sessionID": "ses_x",
                "type": "tool",
                "tool": "bash",
                "callID": "call_1",
                "state": {
                    "status": status,
                    "input": {"command": "ls"},
                    "output": "file.txt" if status == "completed" else "",
                    # opencode reports the tool's own start/end; the connector
                    # turns them into the elapsed suffix on a state change.
                    "time": {"start": 2_000, "end": 2_500},
                },
            },
        },
    }


def _texts(host: FakeHost) -> list[str]:
    return [str((item.content or {}).get("text") or "") for item in host.item_upserts]


def test_streaming_deltas_publish_the_answer_as_it_arrives(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The reported bug: reasoning and the answer only appeared at turn end.

    opencode streams ``message.part.delta`` per chunk; the connector ignored
    them and rebuilt the whole timeline from ``session.idle``, so the client
    showed nothing until the turn was already over.
    """
    from connector.runtimes.opencode import runtime as runtime_module

    monkeypatch.setattr(runtime_module, "STREAM_FLUSH_INTERVAL_S", 0.0)
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    runtime._active_turns.add("ses_x")
    # The SSE stream is process-wide; only sessions the platform shows are
    # streamed, so mark this one as owned.
    runtime._remember_directory("ses_x", "/work")

    async def run() -> None:
        await _drain(
            runtime,
            [
                _user_message_event(),
                _assistant_message_event(),
                _text_part_event(),
                _delta_event("Bridge"),
                _delta_event(" between"),
                _delta_event(" machines"),
            ],
        )
        assert _texts(host) == ["Bridge", "Bridge between", "Bridge between machines"]
        item = host.item_upserts[-1]
        assert item.type == "message" and item.role == "assistant"
        assert item.status == "running"
        # The streamed item must carry the id the turn-end snapshot will use for
        # the same part, or the client renders the answer twice.
        assert item.id == TEXT_PART_ID
        assert item.turn_id == USER_MESSAGE_ID
        assert item.revision == 3
        assert len(host.item_upserts) == 3  # one upsert per delta, no extra

        # ``step-finish`` means the model stopped writing: the text flips to
        # done and leaves the buffer, without waiting for the turn to end.
        await _drain(runtime, [{"type": "message.part.updated", "properties": {
            "sessionID": "ses_x",
            "part": {
                "id": "prt_step_finish",
                "messageID": ASSISTANT_MESSAGE_ID,
                "sessionID": "ses_x",
                "type": "step-finish",
            },
        }}])
        assert host.item_upserts[-1].status == "done"
        assert _texts(host)[-1] == "Bridge between machines"

    asyncio.run(run())


def test_streaming_deltas_are_throttled(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 300-chunk answer must not become 300 timeline upserts."""

    from connector.runtimes.opencode import runtime as runtime_module

    monkeypatch.setattr(runtime_module, "STREAM_FLUSH_INTERVAL_S", 60.0)
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    runtime._active_turns.add("ses_x")
    # The SSE stream is process-wide; only sessions the platform shows are
    # streamed, so mark this one as owned.
    runtime._remember_directory("ses_x", "/work")

    async def run() -> None:
        await _drain(
            runtime,
            [
                _user_message_event(),
                _assistant_message_event(),
                _text_part_event(),
                *[_delta_event(f"w{i}") for i in range(20)],
            ],
        )
        # The placeholder part update is not flushable (empty text), and the
        # whole burst stays inside one throttle window.
        assert host.item_upserts == []
        # A part update forces the flush, carrying everything accumulated.
        await _drain(runtime, [_text_part_event("w0w1w2w3")])
        assert len(host.item_upserts) == 1
        assert _texts(host) == ["w0w1w2w3"]

    asyncio.run(run())


def test_streaming_publishes_the_user_prompt_as_its_own_item(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The live timeline must contain the prompt, not just assistant output.

    Only the turn-end snapshot used to carry it, so while a turn was running the
    round showed assistant items with nothing to anchor them to and only settled
    once the snapshot arrived. The item must reuse the snapshot's id (the opencode
    message id) and carry ``source.clientMessageId`` so it merges with the
    client's optimistic echo instead of doubling it.
    """
    from connector.runtimes.opencode import runtime as runtime_module

    monkeypatch.setattr(runtime_module, "STREAM_FLUSH_INTERVAL_S", 0.0)
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    runtime._remember_directory("ses_x", "/work")
    runtime._active_turns.add("ses_x")

    async def run() -> None:
        await runtime._seed_stream_order("ses_x")
        client.sessions["ses_x"] = {"id": "ses_x"}
        client.messages["ses_x"] = []
        runtime._pending_messages.register(
            native_session_id="ses_x", client_message_id="cm_1", text="hello there"
        )
        user_part = _text_part_event("hello there")
        user_part["properties"]["part"]["messageID"] = USER_MESSAGE_ID
        user_part["properties"]["part"]["id"] = "prt_user_1"
        await _drain(
            runtime,
            [
                _user_message_event(),
                user_part,
                _assistant_message_event(),
                _text_part_event(),
                _delta_event("hi"),
            ],
        )
        prompt_items = [item for item in host.item_upserts if item.role == "user"]
        assert len(prompt_items) == 1
        prompt = prompt_items[0]
        assert prompt.id == USER_MESSAGE_ID
        assert prompt.status == "done"
        assert str(prompt.content["text"]) == "hello there"
        # Merges with the optimistic echo rather than duplicating it.
        assert str(prompt.source.get("clientMessageId")) == "cm_1"
        # The prompt takes the slot before the streamed assistant parts, exactly
        # where the turn-end snapshot numbers it.
        assert prompt.order_seq == 0
        assistant = [item for item in host.item_upserts if item.role == "assistant"]
        assert assistant and assistant[0].order_seq > prompt.order_seq

    asyncio.run(run())


def test_streaming_deltas_never_republish_the_user_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A delta for the user's message must not turn into an assistant item."""

    from connector.runtimes.opencode import runtime as runtime_module

    monkeypatch.setattr(runtime_module, "STREAM_FLUSH_INTERVAL_S", 0.0)
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    runtime._remember_directory("ses_x", "/work")
    runtime._active_turns.add("ses_x")

    async def run() -> None:
        await _drain(
            runtime,
            [
                _user_message_event(),
                {
                    "type": "message.part.delta",
                    "properties": {
                        "sessionID": "ses_x",
                        "messageID": USER_MESSAGE_ID,
                        "partID": "prt_user_1",
                        "field": "text",
                        "delta": "hello",
                    },
                },
            ],
        )
        assert [item.role for item in host.item_upserts] == []
        assert runtime._stream_sessions["ses_x"].parts == {}

    asyncio.run(run())


def test_streaming_tool_state_transitions(monkeypatch: pytest.MonkeyPatch) -> None:
    from connector.runtimes.opencode import runtime as runtime_module

    monkeypatch.setattr(runtime_module, "STREAM_FLUSH_INTERVAL_S", 0.0)
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    runtime._active_turns.add("ses_x")
    # The SSE stream is process-wide; only sessions the platform shows are
    # streamed, so mark this one as owned.
    runtime._remember_directory("ses_x", "/work")

    async def run() -> None:
        await _drain(
            runtime,
            [
                _user_message_event(),
                _assistant_message_event(),
                _tool_part_event("running"),
                _tool_part_event("completed"),
                _tool_part_event("error"),
            ],
        )
        statuses = [(item.type, item.status) for item in host.item_upserts]
        assert statuses == [("tool", "running"), ("tool", "done"), ("tool", "failed")]
        assert host.item_upserts[0].id == TOOL_PART_ID
        assert host.item_upserts[-1].content["output"] == ""

    asyncio.run(run())


def test_streamed_parts_finish_as_done_before_the_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Turn end publishes ``done`` items, then the snapshot restates the same ids."""

    from connector.runtimes.opencode import runtime as runtime_module

    monkeypatch.setattr(runtime_module, "STREAM_FLUSH_INTERVAL_S", 0.0)
    client = FakeClient()
    host = FakeHost()
    runtime = _make_runtime(client, host)
    runtime._active_turns.add("ses_x")
    # The SSE stream is process-wide; only sessions the platform shows are
    # streamed, so mark this one as owned.
    runtime._remember_directory("ses_x", "/work")

    async def run() -> None:
        client.sessions["ses_x"] = {"id": "ses_x"}
        client.messages["ses_x"] = [
            {
                "info": {
                    "id": ASSISTANT_MESSAGE_ID,
                    "role": "assistant",
                    "parentID": USER_MESSAGE_ID,
                    "sessionID": "ses_x",
                    "time": {"created": 2_000, "completed": 3_000},
                },
                "parts": [
                    {
                        "id": TEXT_PART_ID,
                        "type": "text",
                        "text": "Bridge between machines",
                    }
                ],
            }
        ]
        await _drain(
            runtime,
            [
                _user_message_event(),
                _assistant_message_event(),
                _text_part_event(),
                _delta_event("Bridge between machines"),
            ],
        )
        assert host.item_upserts[-1].status == "running"
        host.item_upserts.clear()

        await runtime._finish_streaming_parts("ses_x", "ses_x")
        assert [item.status for item in host.item_upserts] == ["done"]
        assert _texts(host) == ["Bridge between machines"]
        # Buffers are dropped but the order bookkeeping survives: opencode sends
        # the final parts *after* session.idle, and the next turn's items must
        # not restart the timeline order.
        session = runtime._stream_sessions["ses_x"]
        assert session.parts == {}
        # The recorded slot (and the counter past it) survive the turn: the
        # next turn continues from here instead of restarting at 1.
        seeded = session.order[TEXT_PART_ID]
        assert seeded >= 1
        assert session.next_order_seq > seeded

        # The snapshot produces the same item id, so it replaces instead of
        # duplicating the streamed item.
        snapshot = await runtime.get_session_snapshot("ses_x", "ses_x")
        assert [item.id for item in snapshot.items] == [TEXT_PART_ID]

    asyncio.run(run())


def test_streaming_order_continues_across_turns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: turn 2's streamed items must not reuse turn 1's orderSeq.

    Reported symptom: the second turn's text was rendered inside the first
    turn and its answer never showed. The platform orders a timeline by
    ``orderSeq``, and the turn-end snapshot numbers items by their position in
    the message list, so a per-turn counter starting at 1 collided with the
    previous turn's stored positions.
    """
    from connector.runtimes.opencode import runtime as runtime_module

    monkeypatch.setattr(runtime_module, "STREAM_FLUSH_INTERVAL_S", 0.0)
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        # Turn 1: one user message already in the session when the turn starts.
        client.sessions["ses_x"] = {"id": "ses_x"}
        client.messages["ses_x"] = [
            {
                "info": {
                    "id": "msg_u0",
                    "role": "user",
                    "sessionID": "ses_x",
                    "time": {"created": 1},
                },
                "parts": [{"id": "prt_u0", "type": "text", "text": "hi"}],
            }
        ]
        runtime._active_turns.add("ses_x")
        # The SSE stream is process-wide; only sessions the platform shows are
        # streamed, so mark this one as owned.
        runtime._remember_directory("ses_x", "/work")
        await runtime._seed_stream_order("ses_x")
        await _drain(
            runtime,
            [
                _user_message_event(),
                _assistant_message_event(),
                _text_part_event(),
                _delta_event("first answer"),
            ],
        )
        first = host.item_upserts[-1]
        # 1 pre-existing item (slot 0) + this turn's user message (slot 1),
        # so the assistant part lands on slot 2 — exactly where the
        # turn-end snapshot will number it.
        assert first.order_seq == 2
        await runtime._finish_streaming_parts("ses_x", "ses_x")
        await runtime._finish_turn("ses_x")
        runtime._active_turns.discard("ses_x")

        # Turn 2: the session now holds turn 1's items; the new turn must
        # continue after them.
        client.messages["ses_x"].append(
            {
                "info": {
                    "id": "msg_u1",
                    "role": "user",
                    "sessionID": "ses_x",
                    "time": {"created": 2},
                },
                "parts": [{"id": "prt_u1", "type": "text", "text": "and now?"}],
            }
        )
        host.item_upserts.clear()
        runtime._active_turns.add("ses_x")
        runtime._remember_directory("ses_x", "/work")
        await runtime._seed_stream_order("ses_x")
        second = _delta_event("second answer", part_id="prt_text_2")
        second["properties"]["messageID"] = ASSISTANT_MESSAGE_ID
        await _drain(runtime, [second])
        assert len(host.item_upserts) == 1
        item = host.item_upserts[-1]
        # Continues after turn 1 instead of colliding with it…
        assert item.order_seq > first.order_seq
        # …and the second turn's text is its own, not appended to the first.
        assert _texts(host) == ["second answer"]
        assert item.id == "prt_text_2"

    asyncio.run(run())


def test_streaming_survives_a_session_without_a_turn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """opencode sends the final message and parts *after* ``session.idle``.

    Buffering them would leave the answer stuck in ``running`` with nobody left
    to finalize it, so a part that arrives with no active turn is published as
    ``done`` straight away.
    """
    from connector.runtimes.opencode import runtime as runtime_module

    monkeypatch.setattr(runtime_module, "STREAM_FLUSH_INTERVAL_S", 0.0)
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    runtime._remember_directory("ses_x", "/work")

    async def run() -> None:
        # No _active_turns entry: the turn already ended.
        await _drain(
            runtime,
            [
                _user_message_event(),
                _assistant_message_event(),
                _text_part_event("the final answer"),
            ],
        )
        assert _texts(host) == ["the final answer"]
        assert host.item_upserts[-1].status == "done"
        # And nothing is left behind to finalize later.
        assert runtime._stream_sessions["ses_x"].parts == {}

    asyncio.run(run())


def test_streaming_skips_sessions_the_platform_does_not_show() -> None:
    """``/global/event`` carries every opencode instance, including the user's TUI.

    Streaming those would spend an ingest notification per throttle window on an
    item the Server cannot resolve, so unowned sessions are ignored entirely.
    """
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    # No _remember_directory / binding: ses_x belongs to the opencode TUI.

    async def run() -> None:
        await _drain(
            runtime,
            [
                _user_message_event(),
                _assistant_message_event(),
                _text_part_event(),
                _delta_event("not ours"),
            ],
        )
        assert host.item_upserts == []
        assert runtime._stream_sessions.get("ses_x") is None or not (
            runtime._stream_sessions["ses_x"].parts
        )

    asyncio.run(run())


def test_stream_event_failure_never_escapes_the_sse_loop() -> None:
    """One malformed payload must cost one update, not a stream reconnect.

    An exception escaping ``_handle_event`` reaches the transport handler, which
    reconnects the SSE stream and can respawn serve.
    """
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    runtime._remember_directory("ses_x", "/work")
    runtime._active_turns.add("ses_x")

    async def run() -> None:
        await _drain(
            runtime,
            [
                # ``state`` is a list, so the tool mapper trips over it.
                {
                    "type": "message.part.updated",
                    "properties": {
                        "sessionID": "ses_x",
                        "part": {
                            "id": TOOL_PART_ID,
                            "messageID": ASSISTANT_MESSAGE_ID,
                            "type": "tool",
                            "tool": "bash",
                            "state": ["not", "a", "dict"],
                        },
                    },
                },
                _delta_event("still streaming"),
            ],
        )
        # The bad event was swallowed; the next one still streams.
        assert _texts(host) == ["still streaming"]

    asyncio.run(run())


def test_stream_order_seed_never_fails_a_send(monkeypatch: pytest.MonkeyPatch) -> None:
    """The ordering hint sits before the prompt: it must not swallow a message."""
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def broken(session_id: str, directory: str | None = None) -> list[dict[str, Any]]:
        raise ValueError("not json")

    monkeypatch.setattr(client, "list_messages", broken)

    async def run() -> None:
        result = await runtime.create_and_start_session("plat_1", "hi")
        # The prompt still went out despite the seed blowing up.
        assert result.ok
        assert client.prompted
        assert client.prompted[-1][1] == "hi"

    asyncio.run(run())


def test_late_delta_appends_to_the_published_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A delta after the buffer was dropped must extend, not replace, the text.

    Otherwise a trailing chunk republishes the answer as a ``running`` fragment
    of just that chunk — the user sees the reply shrink to its last words.
    """
    from connector.runtimes.opencode import runtime as runtime_module

    monkeypatch.setattr(runtime_module, "STREAM_FLUSH_INTERVAL_S", 0.0)
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    runtime._remember_directory("ses_x", "/work")
    runtime._active_turns.add("ses_x")

    async def run() -> None:
        await _drain(
            runtime,
            [
                _user_message_event(),
                _assistant_message_event(),
                _text_part_event(),
                _delta_event("Bridge between"),
            ],
        )
        await runtime._finish_streaming_parts("ses_x", "ses_x")
        assert _texts(host)[-1] == "Bridge between"

        # The turn is over now: the trailing chunk arrives as a delta.
        runtime._active_turns.discard("ses_x")
        host.item_upserts.clear()
        await _drain(runtime, [_delta_event(" machines")])
        assert _texts(host) == ["Bridge between machines"]
        assert host.item_upserts[-1].status == "done"

    asyncio.run(run())


def test_stream_state_is_trimmed_for_long_sessions() -> None:
    from connector.runtimes.opencode.runtime import (
        _STREAM_STATE_MAX_ENTRIES,
        _trim_stream_state,
    )

    session = runtime_module_session = _StreamSession()
    for index in range(_STREAM_STATE_MAX_ENTRIES + 10):
        session.order[f"prt_{index}"] = index
        session.parents[f"msg_{index}"] = "msg_0"
        session.roles[f"msg_{index}"] = "assistant"
        session.published[f"prt_{index}"] = "x"
    _trim_stream_state(session)
    assert len(session.order) == _STREAM_STATE_MAX_ENTRIES
    assert len(session.parents) == _STREAM_STATE_MAX_ENTRIES
    assert len(session.roles) == _STREAM_STATE_MAX_ENTRIES
    assert len(session.published) == _STREAM_STATE_MAX_ENTRIES
    # The newest entries are the ones kept, and the counter is untouched.
    assert "prt_0" not in session.order
    assert f"prt_{_STREAM_STATE_MAX_ENTRIES + 9}" in session.order
    assert runtime_module_session.next_order_seq == 1


def _step_finish_event() -> dict[str, Any]:
    return {
        "type": "message.part.updated",
        "properties": {
            "sessionID": "ses_x",
            "part": {
                "id": "prt_step_finish",
                "messageID": ASSISTANT_MESSAGE_ID,
                "sessionID": "ses_x",
                "type": "step-finish",
            },
        },
    }


def test_streaming_does_not_republish_an_unchanged_final_part() -> None:
    """opencode re-sends the final part after ``session.idle``.

    Once the turn finalized it, the identical restatement must not become
    another (idempotent but pointless) ingest; changed content still goes out.
    """
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    runtime._remember_directory("ses_x", "/work")
    runtime._active_turns.add("ses_x")

    async def run() -> None:
        await _drain(
            runtime,
            [
                _user_message_event(),
                _assistant_message_event(),
                _text_part_event("the answer"),
            ],
        )
        assert [item.status for item in host.item_upserts] == ["running"]

        # step-finish finalizes it.
        await _drain(runtime, [_step_finish_event()])
        assert [item.status for item in host.item_upserts] == ["running", "done"]

        # opencode restates the same final part after session.idle.
        runtime._active_turns.discard("ses_x")
        await _drain(runtime, [_text_part_event("the answer")])
        assert len(host.item_upserts) == 2  # unchanged, deduped

        # Changed content still goes through.
        await _drain(runtime, [_text_part_event("the answer, extended")])
        assert _texts(host)[-1] == "the answer, extended"
        assert len(host.item_upserts) == 3

    asyncio.run(run())


def _tool_snapshot_message(*, status: str, output: str = "file.txt") -> dict[str, Any]:
    """One assistant message whose single tool part carries ``status``."""

    return {
        "info": {
            "id": ASSISTANT_MESSAGE_ID,
            "role": "assistant",
            "parentID": USER_MESSAGE_ID,
            "sessionID": "ses_x",
            "time": {"created": 2_000, "completed": 3_000},
        },
        "parts": [
            {
                "id": TOOL_PART_ID,
                "messageID": ASSISTANT_MESSAGE_ID,
                "sessionID": "ses_x",
                "type": "tool",
                "tool": "bash",
                "callID": "call_1",
                "state": {
                    "status": status,
                    "input": {"command": "ls"},
                    "output": output,
                    "time": {"start": 2_000, "end": 2_500},
                },
            }
        ],
    }


def test_unchanged_tool_restatements_are_not_republished() -> None:
    """opencode restates a running tool several times with identical state.

    Each restatement used to become another upsert (nine ingests in 90ms were
    observed on a real turn, all byte-identical), and each one is a Server write.
    """
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    runtime._remember_directory("ses_x", "/work")
    runtime._active_turns.add("ses_x")

    async def run() -> None:
        await _drain(runtime, [_assistant_message_event(), _tool_part_event("running")])
        assert len(host.item_upserts) == 1
        assert host.item_upserts[0].status == "running"

        # Same state, same content: nothing the client can render changed.
        await _drain(runtime, [_tool_part_event("running")] * 5)
        assert len(host.item_upserts) == 1

        # A real transition still goes out (opencode "completed" -> our "done").
        await _drain(runtime, [_tool_part_event("completed")])
        assert len(host.item_upserts) == 2
        assert host.item_upserts[1].status == "done"

    asyncio.run(run())


def test_turn_end_settles_items_opencode_left_running() -> None:
    """A turn that closes with ``running`` items must not keep the UI spinning.

    opencode has been observed reporting ``outcome=completed`` with tool items
    still ``running`` (the provider stalled, the stream went quiet, the turn
    ended anyway). The snapshot reports them faithfully, so without this the
    client spins forever on a turn that is over.
    """

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    runtime._remember_directory("ses_x", "/work")
    runtime._active_turns.add("ses_x")

    async def run() -> None:
        client.sessions["ses_x"] = {"id": "ses_x"}
        client.messages["ses_x"] = [_tool_snapshot_message(status="running", output="")]
        await runtime._finish_turn("ses_x")

        settled = [item for item in host.item_upserts if item.id == TOOL_PART_ID]
        assert [item.status for item in settled] == ["failed"], (
            "the unfinished tool must be restated as failed, never left running"
        )
        # The correction has to win over the snapshot's revision.
        assert settled[0].revision > 1
        # And the turn itself is still reported as completed.
        assert host.turn_ended[-1][1] == "completed"

    asyncio.run(run())


def test_turn_end_leaves_finished_items_alone() -> None:
    """The settle pass must not touch a clean snapshot."""

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    runtime._remember_directory("ses_x", "/work")
    runtime._active_turns.add("ses_x")

    async def run() -> None:
        client.sessions["ses_x"] = {"id": "ses_x"}
        client.messages["ses_x"] = [_tool_snapshot_message(status="completed")]
        await _drain(runtime, [_assistant_message_event(), _tool_part_event("running")])
        before = len(host.item_upserts)
        await runtime._finish_turn("ses_x")
        # No settle correction: the snapshot says the tool finished.
        assert len(host.item_upserts) == before

    asyncio.run(run())


def test_turn_end_with_empty_snapshot_is_logged_as_warning() -> None:
    """A turn that rendered nothing has to be visible in the log.

    Observed with an upstream model that produced no output: opencode reported the
    turn finished, the snapshot held no items at all, and the platform recorded a
    successful turn with nothing to show. The status poll that drives reconcile
    succeeds in exactly this situation, so it has no error of its own to report -
    the empty snapshot is the only evidence, and it used to pass silently.
    """

    from connector.logging import logger

    messages: list[str] = []
    sink_id = logger.add(
        lambda _message: messages.append(str(_message)), level="INFO", format="{message}"
    )
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    runtime._remember_directory("ses_x", "/work")
    runtime._active_turns.add("ses_x")

    async def run() -> None:
        try:
            client.sessions["ses_x"] = {"id": "ses_x"}
            client.messages["ses_x"] = []
            await runtime._finish_turn("ses_x")
        finally:
            logger.remove(sink_id)

    asyncio.run(run())

    empty = [line for line in messages if "no timeline items" in line]
    assert len(empty) == 1, messages
    assert "platform=ses_x" in empty[0]
    assert "outcome=completed" in empty[0]
    # The outcome deliberately stays "completed": an empty turn is not provably a
    # failure, and the point is to make it diagnosable, not to invent an error.
    assert host.turn_ended[-1][1] == "completed"


def test_info_log_names_every_step_and_item_transition() -> None:
    """The log has to answer "is it still working?" on its own.

    Reported as indistinguishable: a turn that was working and a turn that was
    frozen produced the same client log, because only ``session.status`` changes
    were recorded at INFO. Every assistant step (opencode's unit of work) and
    every status change -- with how long the tool took -- is now one INFO line,
    while the text updates in between stay at DEBUG.
    """

    from connector.logging import logger

    messages: list[str] = []
    sink_id = logger.add(lambda _message: messages.append(str(_message)), level="INFO", format="{message}")
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)
    runtime._remember_directory("ses_x", "/work")
    runtime._active_turns.add("ses_x")

    async def run() -> None:
        try:
            client.sessions["ses_x"] = {"id": "ses_x"}
            client.messages["ses_x"] = [_tool_snapshot_message(status="completed")]
            # The real pre-prompt path: it seeds orderSeq and the turn clock.
            await runtime._seed_stream_order("ses_x")
            await _drain(runtime, [_user_message_event(), _assistant_message_event()])
            await _drain(runtime, [_tool_part_event("running")] * 4)
            # One step per assistant message, not one per part or restatement.
            await _drain(
                runtime,
                [
                    {
                        "type": "message.part.updated",
                        "properties": {
                            "sessionID": "ses_x",
                            "part": {
                                "id": "prt_text_2",
                                "messageID": "msg_assistant_2",
                                "sessionID": "ses_x",
                                "type": "text",
                                "text": "second step",
                            },
                        },
                    }
                ],
            )
            await _drain(runtime, [_tool_part_event("completed")])
            await runtime._finish_turn("ses_x")
        finally:
            logger.remove(sink_id)

    asyncio.run(run())

    steps = [line for line in messages if "opencode step start" in line]
    assert len(steps) == 2, steps
    assert any("step=1/" in line and "first_part=tool" in line for line in steps), steps
    # A restated tool part must not add lines: only transitions are logged.
    transitions = [line for line in messages if "opencode item " in line]
    assert len(transitions) == 4, transitions
    assert any("status=running->done" in line for line in transitions)
    # A finished tool reports how long it took, which is the usual answer to
    # "why is the turn taking so long".
    assert any("after 0.5s" in line for line in transitions), transitions
    turn_end = [line for line in messages if "turn-end delivered" in line]
    assert len(turn_end) == 1, turn_end
    assert "outcome=completed" in turn_end[0]
    assert "elapsed=" in turn_end[0], turn_end[0]


# --------------------------------------------------------------------------- #
# e2e against a live opencode serve (auto-skipped when unreachable)
# --------------------------------------------------------------------------- #


def _server_reachable() -> bool:
    """True when a serve this test can actually talk to answers on 4096.

    opencode 2.x protects ``/api/info`` with HTTP Basic, and a serve the
    connector auto-started has a generated password no test knows, so
    "something is listening" is not enough — the probe has to authenticate with
    the environment's credentials.
    """

    import httpx

    from connector.runtimes.opencode import serve_process

    _user, password = serve_process.environment_server_credentials(dict(os.environ))
    if not password:
        return False
    try:
        r = httpx.get(
            "http://127.0.0.1:4096/api/info",
            auth=httpx.BasicAuth(serve_process.SERVE_BASIC_USER, password),
            timeout=3.0,
        )
        return r.status_code == 200
    except httpx.HTTPError:
        return False


@pytest.mark.skipif(
    not _server_reachable(),
    reason="opencode serve not reachable/authenticable at 127.0.0.1:4096",
)
def test_e2e_full_lifecycle() -> None:
    """create -> turn -> wait -> snapshot -> interrupt against a live server."""

    class CollectingHost:
        connector_id = "e2e"

        def __init__(self) -> None:
            self.timeline_items: list = []
            self.turn_ended: list[str] = []

        async def timeline_sync(self, sid, rt, items, **kw):
            self.timeline_items.extend(items)

        async def session_meta_upsert(self, sid, rt, **kw):
            pass

        async def session_state_update(self, sid, rt, status, **kw):
            pass

        async def session_turn_ended(self, sid, rt, **kw):
            self.turn_ended.append(sid)

        async def runtime_health_update(self, status, detail=None):
            pass

    async def run() -> None:
        provider = OpenCodeProvider()
        config = await provider.validate_config({"serverUrl": "http://127.0.0.1:4096"})
        host = CollectingHost()
        rt = OpenCodeRuntime(config=config, host=host)
        await rt.start()
        try:
            res = await rt.create_and_start_session(
                "e2e-session",
                "只回复两个字:收到",
                selections={"model": "local/nemotron35-dspark"},
            )
            assert res.ok, res.message
            native = res.result["external_session_id"]

            for _ in range(90):
                st = await rt.get_session_state("e2e-session", native)
                if st and st.status == "idle":
                    break
                await asyncio.sleep(1)
            else:
                pytest.fail("turn did not finish within 90s")

            snap = await rt.get_session_snapshot("e2e-session", native)
            assert snap.complete
            roles = [i.role for i in snap.items]
            assert "user" in roles
            assert "assistant" in roles

            ir = await rt.interrupt_session(native)
            assert ir.ok

            # SSE-driven turn end should have been observed
            assert "e2e-session" in host.turn_ended or host.timeline_items
        finally:
            await rt.stop()

    asyncio.run(run())


@pytest.mark.skipif(
    not _server_reachable(),
    reason="opencode serve not reachable at 127.0.0.1:4096",
)
def test_e2e_continue_session_second_turn() -> None:
    """Two consecutive turns on one live session — the user-reported failure.

    Turn 1 goes through create_and_start_session; turn 2 goes through
    start_turn with the server-forwarded external id, then again with the
    platform id alone (connector-restart shape where the mapping is fresh
    but the server still knows the external id).
    """

    class CollectingHost:
        def __init__(self) -> None:
            self.turn_ended: list[str] = []

        async def timeline_sync(self, sid, rt, items, **kw):
            pass

        async def session_meta_upsert(self, sid, rt, **kw):
            pass

        async def session_state_update(self, sid, rt, status, **kw):
            pass

        async def session_turn_ended(self, sid, rt, **kw):
            self.turn_ended.append(sid)

        async def runtime_health_update(self, status, detail=None):
            pass

    async def wait_idle(rt, platform_id, native_id, timeout_s=120) -> None:
        for _ in range(timeout_s):
            st = await rt.get_session_state(platform_id, native_id)
            if st and st.status == "idle":
                return
            await asyncio.sleep(1)
        pytest.fail(f"turn did not finish within {timeout_s}s")

    async def run() -> None:
        provider = OpenCodeProvider()
        config = await provider.validate_config({"serverUrl": "http://127.0.0.1:4096"})
        host = CollectingHost()
        rt = OpenCodeRuntime(config=config, host=host)
        await rt.start()
        try:
            res = await rt.create_and_start_session(
                "e2e-cont",
                "只回复两个字:收到",
                selections={"model": "local/nemotron35-dspark"},
            )
            assert res.ok, res.message
            native = res.result["external_session_id"]
            await wait_idle(rt, "e2e-cont", native)

            # Turn 2: server-shaped call (external id forwarded by the server).
            res2 = await rt.start_turn("e2e-cont", native, "再只回复两个字:明白")
            assert res2.ok, res2.message
            await wait_idle(rt, "e2e-cont", native)

            # Turn 3: platform id only, mapping already bound in this process.
            res3 = await rt.start_turn("e2e-cont", None, "第三轮:好")
            assert res3.ok, res3.message
            await wait_idle(rt, "e2e-cont", native)

            snap = await rt.get_session_snapshot("e2e-cont", native)
            user_texts = [
                i.content.get("text") for i in snap.items
                if i.role == "user" and i.type == "message"
            ]
            assert any("收到" in (t or "") for t in user_texts)
            assert any("明白" in (t or "") for t in user_texts)
            assert any("第三轮" in (t or "") for t in user_texts)
        finally:
            await rt.stop()

    asyncio.run(run())


# --------------------------------------------------------------------------- #
# pending client-message registry (echo dedup)
# --------------------------------------------------------------------------- #


def _user_message(message_id: str, text: str) -> dict[str, Any]:
    return {
        "info": {"id": message_id, "role": "user", "sessionID": "ses_x"},
        "parts": [{"type": "text", "text": text}],
    }


def test_registry_binds_by_text_in_send_order() -> None:
    registry = OpenCodePendingClientMessageRegistry()
    registry.register(native_session_id="ses_x", client_message_id="cm_1", text="你好")
    registry.register(native_session_id="ses_x", client_message_id="cm_2", text="你好")
    matched = registry.resolve(
        "ses_x",
        [_user_message("msg_1", "你好"), _user_message("msg_2", "你好\n")],
    )
    assert matched == {"msg_1": "cm_1", "msg_2": "cm_2"}
    assert registry.resolve("ses_x", [_user_message("msg_1", "你好")]) == {}


def test_registry_keeps_unmatched_until_turn_end() -> None:
    registry = OpenCodePendingClientMessageRegistry()
    registry.register(native_session_id="ses_x", client_message_id="cm_1", text="later")
    assert registry.resolve("ses_x", []) == {}
    assert registry.resolve("ses_x", [_user_message("msg_9", "later")]) == {"msg_9": "cm_1"}
    registry.register(native_session_id="ses_x", client_message_id="cm_2", text="gone")
    registry.unresolve("ses_x")
    assert registry.resolve("ses_x", [_user_message("msg_8", "gone")]) == {}


def test_registry_ignores_empty_ids_and_text() -> None:
    registry = OpenCodePendingClientMessageRegistry()
    registry.register(native_session_id="ses_x", client_message_id=None, text="hi")
    registry.register(native_session_id="ses_x", client_message_id="cm_1", text="")
    assert registry.resolve("ses_x", [_user_message("msg_1", "hi")]) == {}


def test_registry_skips_synthetic_text_when_matching_client_message_id() -> None:
    """opencode auto-injects a synthetic "Called the Read tool..." text part
    right after the user's prompt when a file part is sent. The registry must
    ignore synthetic parts so the platform clientMessageId binding still
    matches the user's original text, otherwise the optimistic echo on the
    client is not merged and the user message renders twice.
    """

    registry = OpenCodePendingClientMessageRegistry()
    registry.register(native_session_id="ses_x", client_message_id="cm_1", text="识别图片")
    message_with_synthetic = {
        "info": {"id": "msg_u", "role": "user", "sessionID": "ses_x"},
        "parts": [
            {"id": "prt_a", "type": "text", "text": "识别图片", "synthetic": False},
            {
                "id": "prt_b",
                "type": "text",
                "text": 'Called the Read tool with the following input: {"filePath":"note.txt"}',
                "synthetic": True,
            },
            {
                "id": "prt_c",
                "type": "text",
                "text": "ATTACHED-CONTENT",
                "synthetic": True,
            },
            {"id": "prt_d", "type": "file", "filename": "file_x__note.txt", "url": "data:text/plain;base64,QQ=="},
        ],
    }
    matched = registry.resolve("ses_x", [message_with_synthetic])
    assert matched == {"msg_u": "cm_1"}


def test_map_messages_sets_client_message_id_on_source() -> None:
    items = timeline.map_messages_to_timeline("ses_x", [USER_MSG], {"msg_user_1": "cm_9"})
    user_items = [item for item in items if item.role == "user"]
    assert user_items[0].source.client_message_id == "cm_9"
    payload = user_items[0].to_platform_item("plat_1", 0).source
    assert payload.get("clientMessageId") == "cm_9"
    other = timeline.map_messages_to_timeline("ses_x", [USER_MSG])
    assert other[0].to_platform_item("plat_1", 0).source.get("clientMessageId") is None


def test_snapshot_user_item_carries_client_message_id_once() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.create_and_start_session(
            "plat_echo", "hello", selections=None, client_message_id="cm_echo"
        )
        assert result.ok is True
        native = result.result["externalSessionId"]
        client.messages[native] = [_user_message("msg_h", "hello")]

        snap = await runtime.get_session_snapshot("plat_echo", native)
        user = next(i for i in snap.items if i.role == "user")
        assert user.source.get("clientMessageId") == "cm_echo"

        # Bindings are one-shot; a rebuild no longer stamps the id (the
        # optimistic echo is already resolved by then).
        snap2 = await runtime.get_session_snapshot("plat_echo", native)
        user2 = next(i for i in snap2.items if i.role == "user")
        assert user2.source.get("clientMessageId") is None

    asyncio.run(run())


# --------------------------------------------------------------------------- #
# workspace directory (serve multiplexes per project directory)
# --------------------------------------------------------------------------- #


def test_append_directory_param() -> None:
    assert (
        append_directory_param("/session", "D:/work space")
        == "/session?directory=D%3A%2Fwork%20space"
    )
    assert append_directory_param("/x?a=1", "/tmp").endswith("?a=1&directory=%2Ftmp")


def test_create_session_uses_selected_workspace_directory() -> None:
    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        result = await runtime.create_and_start_session(
            "plat_ws", "hi", selections=None, cwd="D:/projects/demo"
        )
        assert result.ok is True
        native = result.result["externalSessionId"]
        assert client.created_directories == [(native, "D:/projects/demo")]
        # follow-up traffic for the session keeps the same directory
        await runtime.start_turn("plat_ws", native, "again", cwd=None)
        assert client.prompted[-1] == (native, "again", None, "D:/projects/demo")
        await runtime.interrupt_session("plat_ws")
        assert client.aborted == [native]

    asyncio.run(run())


def test_list_runtime_commands_includes_builtins_before_skills() -> None:
    """Built-in slash commands (model/compact/fork/undo) are injected
    even when ``GET /api/command`` returns no skills, so the platform slash
    menu can offer them — opencode's API only returns user-defined commands.
    ``/share`` is gone with the opencode 2.x share route and must not be
    offered at all."""

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        commands = await runtime.list_runtime_commands(limit=100)
        ids = [c.id for c in commands]
        # All four builtins must be present.
        for name in ("model", "compact", "fork", "undo"):
            assert name in ids, f"builtin {name!r} missing from {ids}"
        assert "share" not in ids
        # Builtins are emitted first, so the leading entries match exactly.
        assert ids[:4] == ["model", "compact", "fork", "undo"]
        # /model must drive the platform selector UI, not an execute round-trip.
        model_cmd = next(c for c in commands if c.id == "model")
        assert model_cmd.accepts_args is False
        assert model_cmd.metadata.get("ui") == {"kind": "selector", "target": "model"}
        # Execute commands carry the platform ui metadata contract too.
        compact_cmd = next(c for c in commands if c.id == "compact")
        assert compact_cmd.accepts_args is False
        ui = compact_cmd.metadata.get("ui")
        assert isinstance(ui, dict)
        assert ui.get("kind") == "execute"
        assert ui.get("allowedStatuses") == ["idle", "error"]
        # Metadata distinguishes builtins from skills.
        assert model_cmd.metadata.get("builtin") is True
        assert model_cmd.category == "builtin"

    asyncio.run(run())


def test_execute_command_dispatches_builtins_to_dedicated_endpoints() -> None:
    """``/model``, ``/compact``, ``/fork``, ``/undo`` must NOT hit
    ``POST /api/session/{id}/command`` (which only runs user skills); each
    routes to its own opencode endpoint. ``/share`` no longer exists in 2.x."""

    client, host = FakeClient(), FakeHost()
    runtime = _make_runtime(client, host)

    async def run() -> None:
        # Bind a session so _adopt_session_binding can resolve it.
        result = await runtime.create_and_start_session(
            "plat_b", "hi", selections=None, cwd=None
        )
        native = result.result["externalSessionId"]
        # opencode records the model on the session; /compact resolves it there.
        client.sessions[native]["model"] = {"id": "qwen3.8-27b", "providerID": "local"}

        # /model local/qwen3.8-27b
        r = await runtime.execute_command(
            "plat_b", "model", raw="local/qwen3.8-27b"
        )
        assert r.ok is True
        # The session's bound directory is forwarded as the ``directory``
        # query param — FakeClient defaults the cwd to ``/work``.
        assert client.model_switches == [
            (native, "qwen3.8-27b", "local", None, "/work")
        ]
        # skills endpoint NOT hit
        assert client.skill_calls == []

        # /compact drives the V1 summarize endpoint with the resolved model.
        r = await runtime.execute_command("plat_b", "compact")
        assert r.ok is True
        assert client.summaries == [(native, "local", "qwen3.8-27b", "/work")]
        assert r.result.get("executionState") == "completed"
        assert client.skill_calls == []

        # /fork reports the new session id in the display text.
        r = await runtime.execute_command("plat_b", "fork")
        assert r.ok is True
        assert client.forks == [(native, None, "/work")]
        assert "ses_forked" in str(r.result.get("text"))

        # /share was dropped in opencode 2.x: reported as unsupported, and it
        # must not fall through to the skills endpoint either.
        r = await runtime.execute_command("plat_b", "share")
        assert r.ok is False
        assert r.code == "unsupported"
        assert client.shares == []
        assert client.skill_calls == []

        # /undo
        r = await runtime.execute_command("plat_b", "undo")
        assert r.ok is True
        assert client.reverts == [(native, None, "/work")]

        # /model with no arg → helpful usage error, no API call.
        r = await runtime.execute_command("plat_b", "model", raw="")
        assert r.ok is False
        assert r.code == "missing_argument"
        assert client.model_switches == [(native, "qwen3.8-27b", "local", None, "/work")]

        # /model with bare model id (no provider) → invalid_argument
        r = await runtime.execute_command("plat_b", "model", raw="qwen3.8-27b")
        assert r.ok is False
        assert r.code == "invalid_argument"

        # A non-builtin command still falls through to the skills endpoint.
        r = await runtime.execute_command("plat_b", "review", raw="main")
        assert r.ok is True
        assert client.skill_calls == [
            (native, "review", "main", "/work")
        ]

    asyncio.run(run())


def test_start_turn_materializes_attachments_as_file_parts(tmp_path) -> None:
    """Platform attachments are downloaded, staged under the connector data
    directory and sent as opencode ``file`` parts with a ``file://`` URL the
    serve can read (opencode inlines the content for text files)."""

    import os

    from connector.runtime_protocol import RuntimeAttachment
    from connector.runtime_protocol.attachments import ATTACHMENTS_ROOT_ENV
    from connector.runtimes.opencode.attachments import path_from_file_url

    previous = os.environ.get(ATTACHMENTS_ROOT_ENV)
    os.environ[ATTACHMENTS_ROOT_ENV] = str(tmp_path)
    try:
        client, host = FakeClient(), FakeHost()
        host.attachment_bytes["file_abc123"] = b"ATTACHED-CONTENT-42"
        runtime = _make_runtime(client, host)

        async def run() -> None:
            result = await runtime.create_and_start_session(
                "plat_att",
                "look at this",
                selections=None,
                cwd=None,
                attachments=(
                    RuntimeAttachment(
                        file_id="file_abc123",
                        name="note.txt",
                        media_type="text/plain",
                    ),
                ),
            )
            assert result.ok is True
            assert host.attachment_downloads == [("plat_att", "file_abc123")]
            _sid, parts = client.prompt_parts[-1]
            assert len(parts) == 1
            part = parts[0]
            assert part["type"] == "file"
            assert part["mime"] == "text/plain"
            # to_part embeds the platform fileId in the filename so the timeline
            # mapper can recover it after opencode inlines the file:// URL.
            assert part["filename"] == "file_abc123__note.txt"
            url = str(part["url"])
            assert url.startswith("file://")
            # The staged path carries the platform file id as the parent dir,
            # which the timeline mapper parses back out.
            staged = path_from_file_url(url)
            assert staged is not None
            assert staged.parent.name == "file_abc123"
            assert staged.read_bytes() == b"ATTACHED-CONTENT-42"

        asyncio.run(run())
    finally:
        if previous is None:
            os.environ.pop(ATTACHMENTS_ROOT_ENV, None)
        else:
            os.environ[ATTACHMENTS_ROOT_ENV] = previous


def test_resolve_media_type_follows_the_payload_not_the_extension() -> None:
    """A generic binary label must not make a text file unusable.

    openai-compatible providers reject an unrecognised file part media type
    outright (AI_UnsupportedFunctionalityError), so the label has to be decided
    by the bytes: extensions cannot be enumerated exhaustively, and the platform
    files every unclassified upload as application/octet-stream.
    """

    from connector.runtimes.opencode.attachments import resolve_media_type

    yaml_bytes = b"name: ci\non: [push]\njobs:\n  build:\n    steps:\n      - run: echo hi\n"
    source_bytes = b"def main():\n    return 0\n"
    png_bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + b"\x00" * 32
    utf16_bytes = "﻿配置说明\n".encode("utf-16-le")

    # Text payloads get a text label whatever they are called, including names
    # no list would contain.
    assert resolve_media_type("ci.yml", "application/octet-stream", yaml_bytes) == "text/plain"
    assert resolve_media_type("notes", "application/octet-stream", yaml_bytes) == "text/plain"
    assert resolve_media_type("weird.unknownext", "application/octet-stream", yaml_bytes) == "text/plain"
    assert resolve_media_type("main.py", "application/octet-stream", source_bytes) == "text/x-python"
    # A UTF-16 document is text too, despite the zero bytes in its encoding.
    assert resolve_media_type("config.ini", "application/octet-stream", utf16_bytes).startswith("text/")

    # Binary payloads keep a binary label whatever they are called.
    for name in ("clip.mp4", "photo.png", "blob", "notes"):
        assert not resolve_media_type(name, "application/octet-stream", png_bytes).startswith("text/")

    # An explicit, specific label is never overridden.
    assert resolve_media_type("report.pdf", "application/pdf", png_bytes) == "application/pdf"
    assert resolve_media_type("x.png", "image/png", png_bytes) == "image/png"


def test_resolve_media_type_without_a_sample_keeps_the_declared_type() -> None:
    """No bytes to sniff means no evidence, so the platform's label stands."""

    from connector.runtimes.opencode.attachments import resolve_media_type

    assert resolve_media_type("mystery", "application/octet-stream", b"") == "application/octet-stream"
    assert resolve_media_type("note.txt", "text/plain", b"") == "text/plain"


def test_oversized_inline_attachment_keeps_the_chip_without_the_data_url() -> None:
    """A data: URL is megabytes of base64; the entry keeps its identity only."""

    from connector.runtimes.opencode.timeline import (
        MAX_INLINE_ATTACHMENT_BYTES,
        _user_attachments,
    )

    small = _user_attachments(
        [{"type": "file", "id": "p1", "filename": "file_abc__note.txt", "mime": "text/plain", "url": "data:text/plain;base64,aGk="}]
    )
    assert small[0]["openUrl"].startswith("data:")

    oversized = "data:video/mp4;base64," + "A" * (MAX_INLINE_ATTACHMENT_BYTES + 10)
    entry = _user_attachments(
        [{"type": "file", "id": "p2", "filename": "file_def__clip.mp4", "mime": "video/mp4", "url": oversized}]
    )[0]
    # No inline bytes, but the fileId/name survive so the chip still renders and
    # the client resolves the content through its own attachment channel.
    assert "openUrl" not in entry
    assert entry["fileId"] == "file_def"
    assert entry["name"] == "clip.mp4"


def test_timeline_maps_user_file_parts_to_attachments() -> None:
    """User file parts surface as timeline attachments (platform fileId
    recovered from the connector-encoded filename); synthetic inline-read
    text is dropped."""

    # opencode inlines file:// URLs as data: URLs when storing the message,
    # so the staged-path recovery no longer works. The connector embeds the
    # platform fileId in the filename (see attachments.to_part), which
    # survives the inlining, and the timeline mapper decodes it back.
    inlined_url = "data:text/plain;base64,QVRUQUNIRUQtQ09OVEVOVC00Mg=="
    messages = [
        {
            "info": {"id": "msg_user", "role": "user"},
            "parts": [
                {"id": "prt_0", "type": "text", "text": "what is this?", "synthetic": False},
                {"id": "prt_1", "type": "text", "text": "Called the Read tool...", "synthetic": True},
                {
                    "id": "prt_2",
                    "type": "file",
                    "mime": "text/plain",
                    "filename": "file_abc123__note.txt",
                    "url": inlined_url,
                },
            ],
        }
    ]
    items = timeline.map_messages_to_timeline("ses_x", messages)
    assert len(items) == 1
    item = items[0]
    assert item.role == "user"
    content = item.content.to_mapping()
    # Synthetic inline text is not part of the user's message.
    assert content["text"] == "what is this?"
    attachments = content["attachments"]
    assert len(attachments) == 1
    assert attachments[0]["fileId"] == "file_abc123"
    assert attachments[0]["name"] == "note.txt"
    assert attachments[0]["mediaType"] == "text/plain"


def test_timeline_user_message_with_only_a_file_still_maps() -> None:
    messages = [
        {
            "info": {"id": "msg_user2", "role": "user"},
            "parts": [
                {
                    "id": "prt_9",
                    "type": "file",
                    "mime": "image/png",
                    "filename": "shot.png",
                    "url": "data:image/png;base64,AAAA",
                }
            ],
        }
    ]
    items = timeline.map_messages_to_timeline("ses_x", messages)
    assert len(items) == 1
    content = items[0].content.to_mapping()
    assert content["text"] == ""
    attachment = content["attachments"][0]
    # Web-UI-originated parts keep an inline open URL and a synthetic id.
    assert attachment["openUrl"] == "data:image/png;base64,AAAA"
    assert attachment["fileId"].startswith("opencode-")
