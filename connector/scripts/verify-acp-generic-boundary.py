"""Non-Pi ACP integration scenario; authored but not executed in this task."""
from __future__ import annotations

import asyncio
from pathlib import Path
import sys
import tempfile

from connector.runtimes.acp.application.sessions import SessionService
from connector.runtimes.acp.domain.definitions import AgentProfile, LaunchDefinition
from connector.runtimes.acp.domain.capabilities import verified_release
from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.infrastructure.persistence import Store
from connector.runtimes.acp.infrastructure.projection import Projection
from connector.runtimes.acp.provider import AcpProvider


async def wait_for(predicate):
    async with asyncio.timeout(20):
        while not predicate():
            await asyncio.sleep(0.02)


def answer_pending(app, scope):
    for request in app.interactions.views(scope):
        if request["status"] != "open":
            continue
        app.interactions.respond(scope, {
            "interactionId": request["interactionId"], "ownerGeneration": request["ownerGeneration"],
            "requestRevision": request["requestRevision"], "responseOperationId": "answer-" + request["interactionId"],
            "actionId": "allow",
        })


async def main():
    profile = AgentProfile("controlled-other-agent", "Controlled Agent")
    provider = AcpProvider(profile)
    schema = await provider.get_config_schema()
    assert "agentDir" not in schema.schema["properties"]
    assert "agentProfileId" not in schema.schema["properties"]
    assert verified_release(profile, {"profileId": profile.id, "guarantees": [], "acceptance": {}})
    assert (await provider.discover()).display_name == profile.title
    with tempfile.TemporaryDirectory(prefix="aa-nonpi-acp-") as directory:
        root = Path(directory)
        marker = root / "received.txt"
        store = Store(root / "coordination.sqlite")
        app = SessionService(store, profile, LaunchDefinition(sys.executable,
            (str(Path(__file__).with_name("acp-controlled-agent.py")), str(marker)), "controlled"),
            AgentClient, Projection, root)
        try:
            app.prepare({"preparationId": "prepare", "clientPreparationId": "client", "cwd": str(root)})
            await wait_for(lambda: app.interactions.views("prepare"))
            answer_pending(app, "prepare")
            await wait_for(lambda: app.preparation_view("prepare")["phase"] == "ready")
            prepared = app.preparation_view("prepare")
            assert app.reserve({"preparationId": "prepare", "createOperationId": "create", "platformSessionId": "session",
                "expectedRevision": prepared["revision"], "catalogRevision": prepared["catalogRevision"],
                "selections": {"model": "fixture"}})["reserved"]
            app.begin({"preparationId": "prepare", "createOperationId": "create", "sessionId": "session",
                "clientMessageId": "first", "content": "controlled non-Pi input", "selections": {"model": "fixture"}})
            await wait_for(lambda: any(row["status"] == "open" for row in app.interactions.views("create")))
            answer_pending(app, "create")
            await wait_for(lambda: app.creation_view("create")["messageAccepted"] is True)
            assert marker.read_text() == "controlled non-Pi input\n"
            assert store.pending()
        finally:
            await app.stop()
            store.close()


if __name__ == "__main__":
    asyncio.run(main())
