"""Experimental native project metadata, never inferred from historical cwd."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from connector.runtime_protocol import RuntimeUnavailableError
from connector.runtimes.codex.sessions.inventory import list_all_codex_threads


class CodexWorkspaceInventory:
    def __init__(self, host: Any, client: Any) -> None:
        self.client = client
        self._lock = asyncio.Lock()
        self._candidate_threads: dict[bool, tuple] = {}
        self._confirmed_threads: dict[bool, tuple] | None = None
        self._confirmed_at = 0.0
        self._created_threads: dict[str, str | None] = {}

    def confirm_created_thread(self, thread_id: str, project_id: str | None) -> None:
        # Temporary read-back work only. Entries disappear once native list catches up.
        self._created_threads[thread_id] = project_id

    async def _members(self) -> list[dict[str, Any]]:
        members: dict[str, dict[str, Any]] = {}
        for archived in (False, True):
            threads = await list_all_codex_threads(
                self.client,
                archived=archived,
                page_size=100,
                list_page=getattr(self.client, "list_native_project_threads", None),
                max_threads=50_000,
            )
            self._candidate_threads[archived] = threads
            for thread in threads:
                key = thread.get("id")
                if not isinstance(key, str) or not key or key in members:
                    raise RuntimeUnavailableError(
                        "invalid or changing native thread inventory"
                    )
                if "projectId" not in thread:
                    raise RuntimeUnavailableError(
                        "native thread project identity capability unavailable"
                    )
                members[key] = {
                    "sessionId": key,
                    "projectId": thread["projectId"],
                    "cwd": thread.get("cwd"),
                }
                if len(members) > 50_000:
                    raise RuntimeUnavailableError(
                        "native membership inventory exceeds limit"
                    )
        for thread_id in tuple(self._created_threads):
            if (
                thread_id in members
                and members[thread_id]["projectId"] == self._created_threads[thread_id]
            ):
                self._created_threads.pop(thread_id, None)
                continue
            thread = await self.client.read_native_project_thread(thread_id)
            if (
                "projectId" not in thread
                or thread["projectId"] != self._created_threads[thread_id]
            ):
                raise RuntimeUnavailableError(
                    "created thread project identity is unconfirmed"
                )
            members[thread_id] = {
                "sessionId": thread_id,
                "projectId": thread["projectId"],
                "cwd": thread.get("cwd"),
            }
        return sorted(members.values(), key=lambda m: m["sessionId"])

    async def read(self, *, full: bool = True) -> dict[str, Any] | None:
        async with self._lock:
            reader = getattr(self.client, "list_native_projects", None)
            if not callable(reader):
                return None
            before = await reader()
            if before is None:
                return None
            projects = []
            for project in before:
                roots = project.get("roots")
                if (
                    not isinstance(project.get("id"), str)
                    or not project["id"]
                    or not isinstance(project.get("name"), str)
                    or not isinstance(roots, list)
                    or not roots
                    or any(
                        not isinstance(r, dict)
                        or not isinstance(r.get("path"), str)
                        or not r["path"]
                        for r in roots
                    )
                ):
                    raise RuntimeUnavailableError("invalid native project inventory")
                projects.append(
                    {
                        "id": project["id"],
                        "title": project["name"],
                        "path": roots[0]["path"],
                        "roots": [r["path"] for r in roots],
                        "identityKind": "native",
                    }
                )
            members: list[dict[str, Any]] = []
            members_complete = False
            if full:
                try:
                    members = await self._members()
                    # This API has no consistent snapshot token. Confirm the entire
                    # membership projection before applying destructive differences.
                    if members != await self._members():
                        raise RuntimeUnavailableError(
                            "native memberships changed during collection"
                        )
                    ids = {p["id"] for p in projects}
                    if any(
                        m["projectId"] is not None and m["projectId"] not in ids
                        for m in members
                    ):
                        raise RuntimeUnavailableError(
                            "native membership references an unread project"
                        )
                    members_complete = True
                except Exception:  # noqa: BLE001 -- retain confirmed state; never publish a failed read as empty
                    members = []
            after = await reader()
            if after is None or self._signature(before) != self._signature(after):
                raise RuntimeUnavailableError(
                    "native project catalog changed during collection"
                )
            if members_complete:
                self._confirmed_threads = dict(self._candidate_threads)
                self._confirmed_at = time.monotonic()
            return {
                "catalogComplete": True,
                "membersComplete": members_complete,
                "workspaces": projects,
                "members": members,
            }

    async def history_inventory(self) -> dict[bool, tuple] | None:
        if (
            self._confirmed_threads is None
            or time.monotonic() - self._confirmed_at >= 300
        ):
            try:
                current = await self.read(full=True)
                if current is None or not current.get("membersComplete"):
                    return None
            except Exception:  # noqa: BLE001 -- retain confirmed state; never publish a failed read as empty
                return None
        if self._confirmed_threads is None:
            return None

        # Match the native interactive allowlist, without importing exec/subagents.
        # https://github.com/openai/codex/blob/main/codex-rs/rollout/src/lib.rs
        def visible(thread: dict[str, Any]) -> bool:
            source = thread.get("source")
            return (
                source in ("cli", "vscode")
                if isinstance(source, str)
                else (
                    isinstance(source, dict)
                    and source.get("custom") in {"atlas", "chatgpt"}
                )
            )

        return {
            archived: tuple(thread for thread in threads if visible(thread))
            for archived, threads in self._confirmed_threads.items()
        }

    @staticmethod
    def _signature(projects: Any) -> str:
        return json.dumps(sorted(projects, key=lambda p: p["id"]), sort_keys=True)
