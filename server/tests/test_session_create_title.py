from __future__ import annotations

import asyncio

from session_fixtures import create_session_with_project

from agent_server.infra.repositories.facade import Store
from agent_server.infra.repositories.store_support import (
    DERIVED_SESSION_TITLE_MAX_CHARS,
)


def _create_titles(tmp_path, titles: list[str | None]) -> list[str | None]:
    async def exercise() -> list[str | None]:
        store = Store()
        try:
            connector, _token, _prefix = await store.create_connector(
                name="dev",
                user_id="user-1",
            )
            stored: list[str | None] = []
            for index, title in enumerate(titles):
                session = await create_session_with_project(
                    store,
                    connector_id=connector.id,
                    user_id="user-1",
                    external_session_id=None,
                    title=title,
                    project_name=f"p{index}",
                    cwd=f"/repo/{index}",
                )
                stored.append((await store.get_session(session.id)).title)
            return stored
        finally:
            await store.close()

    return asyncio.run(exercise())


def test_create_session_caps_prompt_sized_client_title(tmp_path) -> None:
    pasted = "请帮我分析下面这份文档\n\n" + "这是一段很长的正文。" * 400
    long_ascii = "word " * 200

    stored = _create_titles(
        tmp_path,
        [
            pasted,
            long_ascii,
            "  fix   the\n\tlogin  bug  ",
            "Short title",
            "   \n\t  ",
            None,
        ],
    )

    collapsed = " ".join(pasted.split())
    assert stored[0] == f"{collapsed[:DERIVED_SESSION_TITLE_MAX_CHARS].rstrip()}..."
    assert stored[1] == f"{('word ' * 200)[:DERIVED_SESSION_TITLE_MAX_CHARS].rstrip()}..."
    assert all(len(title) <= DERIVED_SESSION_TITLE_MAX_CHARS + 3 for title in stored[:2])
    assert stored[2] == "fix the login bug"
    assert stored[3] == "Short title"
    assert stored[4] is None
    assert stored[5] is None
