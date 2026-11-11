from __future__ import annotations

from connector.runtimes.claude.timeline.inline_media import (
    omitted_media_summary,
    without_inline_media,
)

_DATA = "A" * 2048


def test_without_inline_media_keeps_values_without_media() -> None:
    value = {"type": "text", "text": "hello", "nested": [{"base64": "c2hvcnQ="}]}

    assert without_inline_media(value) is value
    assert without_inline_media("plain") == "plain"


def test_without_inline_media_replaces_base64_sources() -> None:
    document = {
        "type": "document",
        "title": "report",
        "source": {"type": "base64", "media_type": "application/pdf", "data": _DATA[:-2] + "=="},
    }
    kept = {"type": "text", "text": "summary"}
    content = [kept, {"type": "tool_reference", "content": [document]}]

    cleaned = without_inline_media(content)

    assert cleaned[0] is kept
    assert cleaned[1]["content"][0] == {
        "type": "document",
        "title": "report",
        "source": {"type": "omitted", "byteSize": 1534, "media_type": "application/pdf"},
    }
    assert content[1]["content"][0]["source"]["type"] == "base64"


def test_without_inline_media_drops_long_base64_fields() -> None:
    cleaned = without_inline_media({"type": "image", "file": {"base64": _DATA, "type": "image/png"}})

    assert cleaned == {"type": "image", "file": {"omittedBase64Bytes": 1536, "type": "image/png"}}


def test_omitted_media_summary_describes_each_block() -> None:
    content = without_inline_media([
        {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "A" * 4 * 1024 * 1024}},
        {"type": "document", "source": {"type": "base64", "data": "AAAA"}},
    ])

    assert omitted_media_summary(content) == "[Image omitted: image/jpeg, 3.0 MB]\n[File omitted: 3 B]"
    assert omitted_media_summary([{"type": "text", "text": "x"}]) is None
    assert omitted_media_summary("text") is None
