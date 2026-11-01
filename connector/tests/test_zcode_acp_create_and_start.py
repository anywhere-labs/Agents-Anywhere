import asyncio
import os
import sys
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.acp.domain.definitions import (
    AgentProfile,
    LaunchDefinition,
    Workspace,
)
from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.runtime import AcpRuntime
from connector.runtimes.providers import default_runtime_providers
from connector.runtimes.zcode.discovery import ZCodeLaunch
from connector.runtimes.zcode.provider import ZCodeClient, ZCodeProvider

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def test_zcode_provider_registered_in_default_providers():
    providers = default_runtime_providers()
    types = [p.runtime_type for p in providers]
    assert "zcode" in types
    zcode_provider = next(p for p in providers if p.runtime_type == "zcode")
    assert isinstance(zcode_provider, ZCodeProvider)


def test_zcode_provider_discovery_capabilities(monkeypatch, tmp_path):
    async def run():
        entry = tmp_path / "zcode.cjs"
        entry.write_text("", encoding="utf-8")
        monkeypatch.setattr(
            "connector.runtimes.zcode.provider.discover_zcode",
            lambda: ZCodeLaunch("/usr/bin/node", (str(entry), "app-server")),
        )
        provider = ZCodeProvider()
        desc = await provider.discover()
        assert desc.runtime_type == "zcode"
        assert desc.available is True
        assert desc.capabilities.get("createAndStartSession") is True
        assert desc.capabilities.get("modelCatalog") is True
        assert desc.capabilities.get("permissionCatalog") is True
        assert desc.capabilities.get("workspacePreparation") is not True
        assert desc.capabilities.get("asyncCreation") is True
        assert desc.capabilities.get("startTurn") is True

    asyncio.run(run())


def test_zcode_provider_environment_security(monkeypatch, tmp_path):
    async def run():
        entry = tmp_path / "zcode.cjs"
        entry.write_text("", encoding="utf-8")
        monkeypatch.setattr(
            "connector.runtimes.zcode.provider.discover_zcode",
            lambda: ZCodeLaunch("/usr/bin/node", (str(entry), "app-server")),
        )
        provider = ZCodeProvider()
        config = replace(
            await provider.validate_config({}),
            runtime_id="zcode",
        )
        host = SimpleNamespace(
            session_namespace="test",
            runtime_kv=SimpleNamespace(path=tmp_path / "kv/runtime.json"),
            publish_runtime_notifications=lambda *args, **kwargs: None,
        )
        runtime = await provider.create_runtime(config, host)
        assert isinstance(runtime, AcpRuntime)
        assert runtime.profile.id == "zcode"
        env_dict = dict(runtime.launch.environment)
        assert env_dict.get("ZCODE_ACP_TRACE") == "0"
        assert env_dict.get("ZCODE_ACP_APPROVAL_BRIDGE") == "0"
        assert env_dict.get("ZCODE_ACP_ENGINE_LOG") == os.devnull
        assert env_dict.get("ZCODE_CJS") == str(entry)

    asyncio.run(run())


def test_acp_runtime_create_and_start_session_lifecycle(tmp_path):
    async def run():
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        marker = tmp_path / "writes.txt"

        # Auto-allow permission interactions from the fixture agent
        class AutoAllowClient(AgentClient):
            def __init__(self, on_update, on_interaction):
                async def auto_interaction(session_id, kind, request):
                    await on_interaction(session_id, kind, request)
                    return {"action": "accept", "optionId": "allow"}

                super().__init__(on_update, auto_interaction)

        launch = LaunchDefinition(
            sys.executable,
            (str(SCRIPTS / "acp-controlled-agent.py"), str(marker)),
            "controlled-fixture",
        )
        notifications = []
        host = SimpleNamespace(
            session_namespace="test-acp",
            runtime_kv=SimpleNamespace(path=tmp_path / "kv/runtime.json"),
            publish_runtime_notifications=lambda rt, notifs, **kw: notifications.extend(notifs),
        )
        config = RuntimeConfig(runtime="controlled", revision=1, values={}, schema={})
        runtime = AcpRuntime(
            config,
            host,
            AgentProfile("controlled", "Controlled ACP"),
            launch,
            client_factory=AutoAllowClient,
        )
        await runtime.start()

        responder_running = True

        async def auto_respond():
            while responder_running:
                await asyncio.sleep(0.02)
                for session_id in ("sess-1",):
                    for row in runtime.app.interactions.views(session_id):
                        if row.get("status") == "open":
                            runtime.app.interactions.respond(
                                session_id,
                                {
                                    "interactionId": row["interactionId"],
                                    "ownerGeneration": row["ownerGeneration"],
                                    "requestRevision": row["requestRevision"],
                                    "responseOperationId": f"auto-{row['interactionId']}",
                                    "actionId": "allow",
                                },
                            )

        responder_task = asyncio.create_task(auto_respond())

        try:
            # 1. Invalid cwd rejected safely
            bad_result = await runtime.create_and_start_session(
                session_id="bad-sess",
                content="test",
                cwd=str(tmp_path / "non-existent"),
            )
            assert bad_result.ok is False
            assert bad_result.result["created"] is False

            # 2. Successful create_and_start_session
            result = await runtime.create_and_start_session(
                session_id="sess-1",
                content="hello from test",
                cwd=str(workspace),
                client_message_id="msg-1",
            )
            assert result.ok is True
            assert result.result["sessionId"] == "sess-1"
            assert result.result["created"] is True
            assert result.result["runtime"] == "controlled"
            assert "externalSessionId" in result.result

            # Verify state stored in DB
            binding = runtime.app.store.get("binding", "sess-1")
            assert binding is not None
            assert binding["attachment"] == "attached"
            assert binding["agent_session_id"] == result.result["externalSessionId"]

            # Verify initial turn executed
            assert marker.read_text(encoding="utf-8") == "hello from test\n"

            # 3. Idempotent call with same session_id returns existing session binding
            idempotent_result = await runtime.create_and_start_session(
                session_id="sess-1",
                content="second message",
                cwd=str(workspace),
                client_message_id="msg-2",
            )
            assert idempotent_result.ok is True
            assert idempotent_result.result["sessionId"] == "sess-1"
            assert idempotent_result.result["externalSessionId"] == result.result["externalSessionId"]
            assert marker.read_text(encoding="utf-8") == "hello from test\nsecond message\n"

        finally:
            responder_running = False
            responder_task.cancel()
            await asyncio.gather(responder_task, return_exceptions=True)
            await runtime.stop()

    asyncio.run(run())
