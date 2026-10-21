from __future__ import annotations

import json
from dataclasses import asdict

from connector.core.unicode import (
    UTF8_REPLACE_LONE_SURROGATES,
    escape_lone_surrogates,
    replace_lone_surrogates,
)
from connector.runtime_protocol import timeline_content_hash
from connector.runtimes.dsh.bridge.models import timeline_item
from connector.server.runtime_rpc_payloads import server_payload_without_turn_data
from connector.server.snapshot_body import snapshot_body

# Digests computed with Node over the plugin's canonical JSON of
# {"content": {"text": ...}, "role": "assistant", "status": "done", "type": "message"}.
LONE = "a\udc47b\ud83dc"
LONE_DIGEST = "sha256:1f7225c4e7582008d7c1cc12e25b030b89d2dff3bc96c42e9e447b931c818f22"
WELL_FORMED = "a👇b 中文"
WELL_FORMED_DIGEST = "sha256:3eb87e69d00155d99a798cfabc947b72cfe5ce6af12bfeff753c708d69e3adca"
REPLACED = "a�b�c"


def test_content_hash_matches_the_plugin_for_well_formed_and_lone_surrogate_text():
    assert timeline_content_hash("message", "done", "assistant", {"text": WELL_FORMED}) == WELL_FORMED_DIGEST
    assert timeline_content_hash("message", "done", "assistant", {"text": LONE}) == LONE_DIGEST


def test_escape_matches_json_stringify():
    assert escape_lone_surrogates(LONE) == "a\\udc47b\\ud83dc"
    assert escape_lone_surrogates(WELL_FORMED) == WELL_FORMED


def _raw_item(text: str) -> dict:
    content = {"text": text}
    return {
        "id": "reply", "sessionId": "session", "type": "message", "role": "assistant", "status": "done",
        "orderSeq": 1, "revision": 1, "content": content, "source": {"runtime": "dsh", "note": text},
        "metadata": {"title": text},
        "contentHash": timeline_content_hash("message", "done", "assistant", content),
    }


def test_items_from_older_plugins_keep_their_hash_but_store_well_formed_text():
    item = timeline_item(_raw_item(LONE))
    assert item.content_hash == LONE_DIGEST
    assert item.content == {"text": REPLACED}
    assert item.source["note"] == REPLACED
    assert item.metadata["title"] == REPLACED
    json.dumps(asdict(item), ensure_ascii=False).encode("utf-8")


def test_items_without_lone_surrogates_are_untouched():
    item = timeline_item(_raw_item(WELL_FORMED))
    assert item.content == {"text": WELL_FORMED}
    assert item.content_hash == WELL_FORMED_DIGEST


def test_server_payload_walk_replaces_lone_surrogates_everywhere():
    payload = {"title": LONE, "nested": [{"turnId": "t", "text": LONE, LONE: 1}], "ok": "中文"}
    assert server_payload_without_turn_data(payload) == {
        "title": REPLACED, "nested": [{"text": REPLACED, REPLACED: 1}], "ok": "中文",
    }


def test_replace_lone_surrogates_keeps_well_formed_values():
    value = {"text": WELL_FORMED, "list": [1, None, WELL_FORMED, {"k": True}]}
    assert replace_lone_surrogates(value) == value


def test_snapshot_body_and_batch_encoding_never_raise_on_lone_surrogates():
    assert LONE.encode("utf-8", UTF8_REPLACE_LONE_SURROGATES) == REPLACED.encode("utf-8")
    body = snapshot_body(
        "dsh", "rti", "session", {"externalSessionId": "ext", "title": LONE}, [{"id": "i", "content": {"text": LONE}}],
    )
    try:
        parsed = json.loads(body.read().decode("utf-8"))
    finally:
        body.close()
    assert parsed["notifications"][0]["params"]["title"] == REPLACED
    assert parsed["notifications"][1]["params"]["items"][0]["content"]["text"] == REPLACED
