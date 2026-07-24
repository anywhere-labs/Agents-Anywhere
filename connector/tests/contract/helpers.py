from __future__ import annotations

from typing import Any


TIMELINE_TYPES = {
    "turn.start",
    "turn.end",
    "message",
    "tool",
    "artifact",
    "system",
}
TIMELINE_STATUSES = {
    "pending",
    "running",
    "waiting_approval",
    "done",
    "failed",
    "cancelled",
    "interrupted",
}
TIMELINE_ROLES = {"user", "assistant", "system", "tool"}
APPROVAL_CHOICES = {"approve", "approve_for_session", "reject", "cancel"}


def collect_item_upserts(notifications: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    return [params["item"] for method, params in notifications if method == "timeline.itemUpsert" and isinstance(params.get("item"), dict)]


def assert_timeline_item_schema(item: dict[str, Any], *, runtime: str | None = None) -> None:
    """Lightweight mirror of server TimelineItemIn required fields."""
    assert isinstance(item.get("id"), str) and item["id"]
    assert isinstance(item.get("sessionId"), str) and item["sessionId"]
    assert item.get("type") in TIMELINE_TYPES, item.get("type")
    assert item.get("status") in TIMELINE_STATUSES, item.get("status")
    assert isinstance(item.get("orderSeq"), int)
    assert isinstance(item.get("contentHash"), str) and item["contentHash"]
    source = item.get("source")
    assert isinstance(source, dict)
    assert isinstance(source.get("runtime"), str) and source["runtime"]
    if runtime is not None:
        assert source["runtime"] == runtime
    if item.get("role") is not None:
        assert item["role"] in TIMELINE_ROLES
    assert isinstance(item.get("content"), dict) or item.get("content") is None
    revision = item.get("revision", 1)
    assert isinstance(revision, int) and revision >= 1


def assert_turn_lifecycle(items: list[dict[str, Any]]) -> None:
    types = [item["type"] for item in items]
    assert "turn.start" in types, types
    assert "turn.end" in types, types
    assert types.index("turn.start") < types.index("turn.end")


def assert_approval_schema(approval: dict[str, Any], *, runtime: str | None = None) -> None:
    assert isinstance(approval.get("id"), str) and approval["id"]
    assert isinstance(approval.get("sessionId"), str) and approval["sessionId"]
    assert isinstance(approval.get("title"), str) and approval["title"]
    choices = approval.get("choices")
    assert isinstance(choices, list) and choices
    assert set(choices) <= APPROVAL_CHOICES
    source = approval.get("source")
    assert isinstance(source, dict)
    assert isinstance(source.get("runtime"), str)
    assert source.get("requestId") is not None
    if runtime is not None:
        assert source["runtime"] == runtime
