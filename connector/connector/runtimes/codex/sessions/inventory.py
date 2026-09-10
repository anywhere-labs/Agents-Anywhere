from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.sdk.runtime_client import CodexRuntimeClient


async def list_all_codex_threads(
    client: CodexRuntimeClient,
    *,
    archived: bool,
    page_size: int,
) -> tuple[Mapping[str, Any], ...]:
    threads: list[Mapping[str, Any]] = []
    cursor: str | None = None
    seen_cursors: set[str] = set()
    while True:
        result = await client.list_threads(
            limit=page_size,
            cursor=cursor,
            archived=archived,
        )
        threads.extend(result.threads)
        next_cursor = result.next_cursor
        if next_cursor is None or next_cursor in seen_cursors:
            return tuple(threads)
        seen_cursors.add(next_cursor)
        cursor = next_cursor


async def reconcile_codex_thread_availability(
    client: CodexRuntimeClient,
    thread_id: str,
    *,
    page_size: int = 100,
) -> str:
    active = await list_all_codex_threads(
        client,
        archived=False,
        page_size=page_size,
    )
    if _contains_thread(active, thread_id):
        return "available"
    archived = await list_all_codex_threads(
        client,
        archived=True,
        page_size=page_size,
    )
    return "archived" if _contains_thread(archived, thread_id) else "missing"


def _contains_thread(threads: tuple[Mapping[str, Any], ...], thread_id: str) -> bool:
    return any(
        codex_sessions.thread_id_from_result(dict(thread)) == thread_id
        for thread in threads
    )
