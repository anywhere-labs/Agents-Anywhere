"""Repository-level session fixtures that now require a project.

Sessions gained a mandatory ``project_id`` (and projects a mandatory
workspace), so tests that seed a session through ``Store`` need to create the
owning project first.  Connector rows do not require a user row, but project
rows do, so the user is created on demand too.
"""

from __future__ import annotations

from typing import Any

from agent_server.infra.repositories.facade import Store

DEFAULT_TEST_USER = "user_1"
DEFAULT_TEST_WORKSPACE = "/repo"


async def ensure_user(store: Store, user_id: str = DEFAULT_TEST_USER) -> None:
    if not await store.user_exists(user_id):
        await store.create_user(user_id=user_id, password="test-password")


async def create_session_with_project(
    store: Store,
    *,
    connector_id: str,
    user_id: str = DEFAULT_TEST_USER,
    runtime: str = "codex",
    external_session_id: str | None = "thread_1",
    title: str | None = "Timeline",
    project_name: str | None = None,
    cwd: str = DEFAULT_TEST_WORKSPACE,
    **session_kwargs: Any,
):
    """Create the project a session requires, then the session itself."""

    await ensure_user(store, user_id)
    project = await store.create_project(
        user_id=user_id,
        connector_id=connector_id,
        name=project_name or title or "Timeline",
        workspace_path=cwd,
    )
    return await store.create_session(
        connector_id=connector_id,
        project_id=project.id,
        user_id=user_id,
        runtime=runtime,
        external_session_id=external_session_id,
        title=title,
        cwd=cwd,
        **session_kwargs,
    )
