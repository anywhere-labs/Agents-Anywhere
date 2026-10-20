from __future__ import annotations

import json

from connector.runtime_protocol.size_budget import (
    MAX_TIMELINE_TEXT_BYTES,
    TRUNCATION_NOTICE,
    bound_content_field,
)
from connector.runtime_protocol.timeline import ToolCallContent


def encoded_size(value: object) -> int:
    return len(json.dumps(value, ensure_ascii=False, default=str).encode("utf-8"))


def test_small_output_is_returned_unchanged():
    output = {"stdout": "ok", "exitCode": 0}
    assert bound_content_field(output) is output


def test_oversized_string_is_truncated_under_the_budget():
    oversized = "x" * (MAX_TIMELINE_TEXT_BYTES * 4)
    result = bound_content_field(oversized)
    assert isinstance(result, str)
    assert encoded_size(result) <= MAX_TIMELINE_TEXT_BYTES
    assert TRUNCATION_NOTICE.strip() in result
    assert result.startswith("x")


def test_oversized_output_becomes_small_again():
    oversized = {"stdout": "y" * (MAX_TIMELINE_TEXT_BYTES * 6), "exitCode": 1}
    result = bound_content_field(oversized)
    assert encoded_size(result) <= MAX_TIMELINE_TEXT_BYTES
    assert result["exitCode"] == 1


def test_multibyte_cut_stays_valid_utf8():
    oversized = "中" * (MAX_TIMELINE_TEXT_BYTES)
    result = bound_content_field(oversized)
    assert isinstance(result, str)
    assert result.encode("utf-8").decode("utf-8") == result
    assert encoded_size(result) <= MAX_TIMELINE_TEXT_BYTES


def test_nested_oversize_is_bounded_without_changing_structure():
    oversized = {"items": [{"text": "z" * (MAX_TIMELINE_TEXT_BYTES * 3)} for _ in range(5)]}
    result = bound_content_field(oversized)
    assert len(result["items"]) == 5
    assert encoded_size(result) <= MAX_TIMELINE_TEXT_BYTES


def test_tool_call_content_bounds_output_for_every_runtime():
    """The budget lives in the protocol layer, so no adapter can bypass it."""
    huge = "q" * (MAX_TIMELINE_TEXT_BYTES * 8)
    payload = ToolCallContent(title="read", output=huge).to_mapping()
    assert encoded_size(payload["output"]) <= MAX_TIMELINE_TEXT_BYTES
    assert payload["title"] == "read"


def test_tool_call_content_keeps_small_output_intact():
    payload = ToolCallContent(title="read", output="short").to_mapping()
    assert payload["output"] == "short"