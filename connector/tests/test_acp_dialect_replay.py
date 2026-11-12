"""Replay recorded Agent traffic through the shared engine and each dialect."""

import asyncio
import json
from pathlib import Path

import pytest

from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.infrastructure.projection import Projection
from connector.runtimes.acp.profiles.hermes import HERMES

RECORDINGS = Path(__file__).parent / "fixtures" / "acp-recordings"


def load(name):
    return [
        json.loads(line)
        for line in (RECORDINGS / name).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


class Replay:
    """Plays the Agent side of a recording against a live AgentClient."""

    def __init__(self, client, recording):
        self.client = client
        self.messages = recording
        self.position = 0

    def result_of(self, method):
        """The Agent's response to AA's first request of ``method``."""
        request = next(
            row["message"] for row in self.messages
            if row["direction"] == "outgoing" and row["message"].get("method") == method
        )
        return next(
            row["message"]["result"] for row in self.messages
            if row["direction"] == "incoming" and row["message"].get("id") == request["id"]
            and "result" in row["message"]
        )

    async def play_until(self, request_id):
        """Deliver the Agent's messages in order until its response to ``request_id``."""
        while self.position < len(self.messages):
            row = self.messages[self.position]
            message = row["message"]
            if row["direction"] == "incoming" and message.get("method"):
                await self.play_one()
                continue
            self.position += 1
            if row["direction"] == "incoming" and message.get("id") == request_id and "result" in message:
                return message["result"]
        raise AssertionError(f"no recorded response to request {request_id}")

    async def play_to(self, method):
        """Deliver the Agent's messages until AA's next ``method`` request; returns it."""
        while True:
            row = self.messages[self.position]
            if row["direction"] == "outgoing" and row["message"].get("method") == method:
                self.position += 1
                return row["message"]
            if row["direction"] == "incoming" and row["message"].get("method"):
                await self.play_one()
            else:
                self.position += 1

    async def play_one(self):
        row = self.messages[self.position]
        self.position += 1
        message = row["message"]
        params = message.get("params") or {}
        if message.get("method") == "session/update":
            await self.client.callbacks.session_update(params["sessionId"], params["update"])
        elif message.get("method") == "session/request_permission":
            await self.client.callbacks.request_permission(
                params["options"], params["sessionId"], params["toolCall"]
            )


def test_hermes_allow_replay():
    recording = load("hermes-allow.jsonl")
    updates, asked = [], []

    async def on_update(session_id, value):
        updates.append(value)

    async def on_interaction(session_id, kind, value):
        asked.append(value)
        return {"action": "accept", "optionId": "allow_once"}

    client = AgentClient(on_update, on_interaction, dialect=HERMES.dialect(None))
    replay = Replay(client, recording)

    async def scenario():
        client.initialized(replay.result_of("initialize"))
        created = replay.result_of("session/new")
        session_id = created["sessionId"]
        session = client.adapt_session(session_id, created)
        await replay.play_to("session/new")
        request = await replay.play_to("session/prompt")

        class Connection:
            async def prompt(self, **_values):
                return await replay.play_until(request["id"])

        client.connection = Connection()
        result = await client.prompt(session_id, request["params"]["prompt"][0]["text"], "first")
        return session_id, session, result

    session_id, session, result = asyncio.run(scenario())
    assert result["stopReason"] == "end_turn"

    # Capabilities narrowed by Hermes' own handshake and updates.
    declared = set(client.capabilities["_meta"]["aa"]["capabilities"])
    assert {"runtime.attachment", "session.steer", "session.commands"} <= declared
    categories = {item["id"]: item.get("category") for item in session["configOptions"]}
    assert categories["edit_approval_policy"] == "permission"
    assert categories["model"] == "model"

    # Hermes' own approval options reach the user unchanged.
    assert [option["optionId"] for option in asked[0]["options"]] == ["allow_once", "deny"]

    projection = Projection(session_id, "replay", runtime_type="hermes")
    items = [item for update in updates if (item := projection.apply(update))]
    timeline = {item["id"]: item for item in items}.values()
    users = [item for item in timeline if item["role"] == "user"]
    tools = [item for item in timeline if item["type"] == "tool"]
    replies = [item for item in timeline if item["role"] == "assistant"]
    assert [item["content"]["clientMessageId"] for item in users] == ["first"]
    # The approval card's own closing update must not become a second tool.
    assert len(tools) == 1 and tools[0]["status"] == "done"
    assert any("AA_AGENT_OK" in item["content"]["text"] for item in replies)
    # The input is recorded before anything the Agent did with it.
    kinds = [update["sessionUpdate"] for update in updates]
    assert kinds.index("user_message_chunk") < kinds.index("tool_call")
    assert kinds.count("aa_execution_observed") == 1


@pytest.mark.parametrize("name", sorted(path.name for path in RECORDINGS.glob("*.jsonl")))
def test_recordings_carry_no_machine_paths(name):
    text = (RECORDINGS / name).read_text(encoding="utf-8")
    for marker in ("/Users/", "/home/", "/private/", "/var/folders/", "C:\\\\Users"):
        assert marker not in text, marker
