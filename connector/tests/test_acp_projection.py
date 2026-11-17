from connector.runtimes.acp.domain.definitions import fingerprint
from connector.runtimes.acp.infrastructure.projection import Projection


def thought(text, *, message_id=None, verified=False):
    update = {
        "sessionUpdate": "agent_thought_chunk",
        "content": {"type": "text", "text": text},
    }
    if message_id is not None:
        update["messageId"] = message_id
    if verified:
        update["aaProjectionVerified"] = True
    return update


def test_thought_chunks_project_as_reasoning_system_items_and_finish_cleanly():
    projection = Projection("session", "epoch", runtime_type="pi")

    first = projection.apply(thought("considering ", message_id="thought-1", verified=True))
    second = projection.apply(thought("the answer", message_id="thought-1", verified=True))

    assert first["type"] == "system"
    assert first["role"] == "system"
    assert first["content"] == {
        "kind": "reasoning",
        "format": "markdown",
        "text": "considering ",
    }
    assert second["id"] == first["id"]
    assert second["content"]["text"] == "considering the answer"
    assert second["status"] == "running"
    assert second["revision"] == first["revision"] + 1
    second_revision = second["revision"]

    finished = projection.finish()

    assert len(finished) == 1
    assert finished[0]["status"] == "done"
    assert finished[0]["revision"] == second_revision + 1
    assert finished[0]["contentHash"] == "sha256:" + fingerprint(
        {
            key: finished[0][key]
            for key in ("type", "status", "role", "content", "source")
        }
    )


def test_empty_thought_text_does_not_create_an_item():
    projection = Projection("session", "epoch", runtime_type="hermes")

    assert projection.apply(thought("")) is None
    assert projection.items == {}


def test_first_verified_pi_thought_keeps_the_legacy_identity():
    projection = Projection("session", "epoch", runtime_type="pi")

    item = projection.apply(thought("reasoning", message_id="thought-1", verified=True))

    assert item["id"] == fingerprint(
        ["session", "agent_thought_chunk", "thought-1"]
    )


def test_thought_boundary_marks_the_reasoning_item_done():
    projection = Projection("session", "epoch", runtime_type="pi")

    item = projection.apply(
        {
            **thought("complete", message_id="thought-1", verified=True),
            "_meta": {"aa": {"boundary": True}},
        }
    )

    assert item["status"] == "done"


def test_repeated_verified_thought_id_after_assistant_text_starts_a_new_item():
    projection = Projection("session", "epoch", runtime_type="pi")

    first = projection.apply(thought("first", message_id="thought-1", verified=True))
    projection.apply(
        {
            "sessionUpdate": "agent_message_chunk",
            "messageId": "reply-1",
            "aaProjectionVerified": True,
            "content": {"type": "text", "text": "answer"},
        }
    )
    second = projection.apply(thought("second", message_id="thought-1", verified=True))

    assert second["id"] != first["id"]
    assert first["content"]["text"] == "first"
    assert second["content"]["text"] == "second"


def test_native_update_between_thought_deltas_keeps_the_active_thought_identity():
    projection = Projection("session", "epoch", runtime_type="pi")

    first = projection.apply(thought("first", message_id="thought-1", verified=True))
    projection.apply(
        {
            "aaProjectionVerified": True,
            "_meta": {
                "aa": {
                    "timelineItem": {
                        "id": "native-item",
                        "type": "message",
                        "revision": 1,
                        "status": "done",
                        "role": "assistant",
                        "content": {"kind": "markdown", "text": "native"},
                        "source": {},
                    }
                }
            },
        }
    )
    second = projection.apply(thought(" second", message_id="thought-1", verified=True))

    assert second["id"] == first["id"]
    assert second["content"]["text"] == "first second"


def test_unverified_message_ids_still_split_thought_runs():
    projection = Projection("session", "epoch", runtime_type="hermes")

    first = projection.apply(thought("a", message_id="untrusted-1"))
    first_delta = projection.apply(thought("b", message_id="untrusted-1"))
    second = projection.apply(thought("c", message_id="untrusted-2"))

    # ACP v1: one messageId per message, and a change starts a new one. An ID
    # that is merely unverified for replay still carries that boundary.
    assert first_delta["id"] == first["id"]
    assert first_delta["content"]["text"] == "ab"
    assert second["id"] != first["id"]
    assert second["content"]["text"] == "c"


def test_unverified_thought_keys_stay_on_epoch_and_message_index():
    projection = Projection("session", "epoch", runtime_type="hermes")

    item = projection.apply(thought("a", message_id="untrusted-1"))

    # Boundary identity may use the connection-local ID, but the persisted key
    # must not: it has to survive a replay where the ID may differ.
    assert item["id"] == fingerprint(
        ["session", "epoch", "agent_thought_chunk", 1]
    )


def test_missing_message_id_keeps_the_existing_fallback_grouping():
    projection = Projection("session", "epoch", runtime_type="hermes")

    first = projection.apply(thought("a"))
    second = projection.apply(thought("b"))

    assert second["id"] == first["id"]
    assert second["content"]["text"] == "ab"


def test_assistant_text_projection_keeps_its_existing_shape():
    projection = Projection("session", "epoch", runtime_type="pi")

    item = projection.apply(
        {
            "sessionUpdate": "agent_message_chunk",
            "messageId": "reply-1",
            "aaProjectionVerified": True,
            "content": {"type": "text", "text": "answer"},
        }
    )

    assert item["type"] == "message"
    assert item["role"] == "assistant"
    assert item["content"] == {
        "kind": "markdown",
        "format": "markdown",
        "text": "answer",
    }


def test_attachment_only_user_message_is_still_projected():
    projection = Projection("session", "epoch", runtime_type="pi")

    item = projection.apply(
        {
            "sessionUpdate": "user_message_chunk",
            "messageId": "m1",
            "aaProjectionVerified": True,
            "content": {"type": "text", "text": ""},
            "_meta": {
                "aa": {
                    "clientMessageId": "m1",
                    "boundary": True,
                    "attachments": [{"id": "a1"}],
                }
            },
        }
    )

    assert item["role"] == "user"
    assert item["status"] == "done"
    assert item["content"]["attachments"] == [{"id": "a1"}]
    assert item["content"]["clientMessageId"] == "m1"


def test_empty_assistant_chunk_with_boundary_still_ends_the_message():
    projection = Projection("session", "epoch", runtime_type="pi")

    item = projection.apply(
        {
            "sessionUpdate": "agent_message_chunk",
            "messageId": "r1",
            "aaProjectionVerified": True,
            "content": {"type": "text", "text": ""},
            "_meta": {"aa": {"boundary": True}},
        }
    )

    assert item["status"] == "done"


def test_replay_reproduces_live_keys_regardless_of_earlier_messages():
    def sequence():
        first = thought("one", message_id="X", verified=True)
        answer = {
            "sessionUpdate": "agent_message_chunk",
            "messageId": "reply-1",
            "aaProjectionVerified": True,
            "content": {"type": "text", "text": "answer"},
        }
        second = thought("two", message_id="X", verified=True)
        return first, answer, second

    live = Projection("session", "epoch", runtime_type="pi")
    live_items = [live.apply(update) for update in sequence()]

    replayed = Projection("session", "epoch", runtime_type="pi")
    replayed.apply(
        {
            "sessionUpdate": "agent_message_chunk",
            "messageId": "earlier",
            "aaProjectionVerified": True,
            "content": {"type": "text", "text": "unrelated"},
        }
    )
    replayed_items = [replayed.apply(update) for update in sequence()]

    assert replayed_items[0]["id"] == live_items[0]["id"]
    assert replayed_items[2]["id"] == live_items[2]["id"]
    assert replayed_items[0]["id"] != replayed_items[2]["id"]


def test_recovered_projection_continues_instead_of_reappending():
    live = Projection("session", "e1", runtime_type="pi")
    first = live.apply(thought("first", message_id="Y", verified=True))
    live.apply(
        {
            "sessionUpdate": "agent_message_chunk",
            "messageId": "reply",
            "aaProjectionVerified": True,
            "content": {"type": "text", "text": "answer"},
        }
    )
    second = live.apply(thought("second", message_id="Y", verified=True))

    # Recover starts a new projection on a new epoch and only restores items.
    # Both segments come back, so the next one must continue past them rather
    # than landing on an existing segment and appending to finished text.
    recovered = Projection("session", "e2", runtime_type="pi")
    recovered.items.update({first["id"]: first, second["id"]: second})
    third = recovered.apply(thought("third", message_id="Y", verified=True))

    assert third["id"] not in {first["id"], second["id"]}
    assert recovered.items[first["id"]]["content"]["text"] == "first"
    assert recovered.items[second["id"]]["content"]["text"] == "second"
    assert third["content"]["text"] == "third"
