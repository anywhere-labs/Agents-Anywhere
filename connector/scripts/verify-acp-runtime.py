"""Actual official-SDK/stdio/SQLite/process checks, without provider traffic."""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path

from connector.runtimes.acp.application.sessions import SessionService
from connector.runtimes.acp.application.synchronization import SynchronizationService
from connector.runtimes.acp.domain.definitions import (
    AcpError,
    AgentProfile,
    LaunchDefinition,
    fingerprint,
)
from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.infrastructure.persistence import Store
from connector.runtimes.acp.infrastructure.projection import Projection
from connector.runtimes.acp.profiles.pi.provider import pi_acp_provider


async def until(predicate, message):
    async with asyncio.timeout(15):
        while not predicate():
            await asyncio.sleep(0.02)
    assert predicate(), message


async def main():
    with tempfile.TemporaryDirectory(prefix="aa-acp-runtime-") as directory:
        root = Path(directory)
        workspace = root / "workspace"
        workspace.mkdir()
        marker = root / "writes.txt"
        store = Store(root / "state.sqlite")
        launch = LaunchDefinition(
            sys.executable,
            (str(Path(__file__).with_name("acp-controlled-agent.py")), str(marker)),
            "controlled-fixture",
        )
        app = SessionService(
            store,
            AgentProfile("controlled", "Controlled"),
            launch,
            AgentClient,
            Projection,
            root,
        )
        received = []
        failed_delivery = True

        async def publish(batch):
            if failed_delivery:
                raise ConnectionError("controlled ACK loss")
            received.extend(batch)

        sync = SynchronizationService(store, publish)
        try:
            app.restore()
            view = app.prepare(
                {
                    "preparationId": "prep",
                    "clientPreparationId": "client-prep",
                    "cwd": str(workspace),
                }
            )
            assert view["phase"] == "opening"
            await until(lambda: app.interactions.views("prep"), "initialization dialog")
            request = app.interactions.views("prep")[0]
            answer = {
                "interactionId": request["interactionId"],
                "ownerGeneration": request["ownerGeneration"],
                "requestRevision": request["requestRevision"],
                "responseOperationId": "init-answer",
                "actionId": "allow",
            }
            assert app.interactions.respond("prep", answer)["disposition"] == "applied"
            assert (
                app.interactions.respond("prep", answer)["disposition"]
                == "already_applied"
            )
            await until(
                lambda: app.preparation_view("prep")["phase"] == "ready",
                "ready preparation",
            )
            view = app.preparation_view("prep")
            reserve = {
                "preparationId": "prep",
                "createOperationId": "create",
                "platformSessionId": "session",
                "expectedRevision": view["revision"],
                "catalogRevision": view["catalogRevision"],
                "selections": {"model": "fixture"},
            }
            assert app.reserve(reserve) == {"reserved": True}
            result = app.begin(
                {
                    "preparationId": "prep",
                    "createOperationId": "create",
                    "sessionId": "session",
                    "clientMessageId": "first",
                    "content": "first message",
                    "selections": {"model": "fixture"},
                }
            )
            assert result["messageAccepted"] is None
            await until(
                lambda: any(
                    row["status"] == "open" for row in app.interactions.views("create")
                ),
                "tool permission",
            )
            request = next(
                row
                for row in app.interactions.views("create")
                if row["status"] == "open"
            )
            app.interactions.respond(
                "create",
                {
                    "interactionId": request["interactionId"],
                    "ownerGeneration": request["ownerGeneration"],
                    "requestRevision": request["requestRevision"],
                    "responseOperationId": "tool-answer",
                    "actionId": "allow",
                },
            )
            await until(
                lambda: app.creation_view("create")["messageAccepted"] is True,
                "accepted creation",
            )
            assert marker.read_text() == "first message\n"
            result = await app.submit("session", "first", "first message")
            assert result["messageAccepted"] is True
            assert marker.read_text() == "first message\n"
            try:
                await app.submit("session", "first", "changed")
                raise AssertionError("different content reused message identity")
            except AcpError as error:
                assert error.code == "operation_input_conflict"
            items = list(app.sessions["session"]["projection"].items.values())
            assert (
                len(items) == 1
                and items[0]["content"]["text"] == "受控 输出\u2028完成"
                and items[0]["status"] == "done"
            )
            assert store.pending()
            try:
                await sync.flush()
            except ConnectionError:
                pass
            assert store.pending(), "unacknowledged outbox lost"
            failed_delivery = False
            await sync.flush()
            assert not store.pending() and received
            await app.submit("session", "form-message", "form")
            await until(
                lambda: any(
                    row["status"] == "open" and row["kind"] == "form"
                    for row in app.interactions.views("session")
                ),
                "structured form",
            )
            request = next(
                row
                for row in app.interactions.views("session")
                if row["status"] == "open"
            )
            form = {
                "empty": "",
                "enabled": False,
                "count": 7.5,
                "lines": "first\nsecond",
            }
            app.interactions.respond(
                "session",
                {
                    "interactionId": request["interactionId"],
                    "ownerGeneration": request["ownerGeneration"],
                    "requestRevision": request["requestRevision"],
                    "responseOperationId": "form-answer",
                    "actionId": "accept",
                    "input": {"kind": "form", "values": form},
                },
            )
            await until(
                lambda: any(
                    row["status"] == "open" and row["kind"] == "approval"
                    for row in app.interactions.views("session")
                ),
                "form turn tool permission",
            )
            request = next(
                row
                for row in app.interactions.views("session")
                if row["status"] == "open"
            )
            app.interactions.respond(
                "session",
                {
                    "interactionId": request["interactionId"],
                    "ownerGeneration": request["ownerGeneration"],
                    "requestRevision": request["requestRevision"],
                    "responseOperationId": "form-tool-answer",
                    "actionId": "allow",
                },
            )
            await until(
                lambda: (
                    store.require("prompt", fingerprint(["session", "form-message"]))[
                        "message_accepted"
                    ]
                    is True
                ),
                "form turn completion",
            )
            assert json.loads(marker.read_text().splitlines()[1]) == form
            await app.submit("session", "hang", "hang")
            await until(
                lambda: any(
                    row["status"] == "open" for row in app.interactions.views("session")
                ),
                "pending before crash",
            )
            await app.sessions["session"]["client"].process.close()
            await until(
                lambda: (
                    app.state("session")["status"] == "blocked" and not app.sessions
                ),
                "crash convergence",
            )
            assert all(
                row["status"] != "open" for row in app.interactions.views("session")
            )
            provider = await pi_acp_provider().discover()
            assert (
                provider.available is True
                and provider.runtime_type == "pi"
                and provider.metadata["managedInstallation"] is True
            )
            print(
                "ACP SDK stdio, startup interaction, approval, streaming, stable submission, ACK retention, crash convergence and managed Pi availability: passed"
            )
        finally:
            await app.stop()
            await sync.close()
            store.close()


if __name__ == "__main__":
    asyncio.run(main())
