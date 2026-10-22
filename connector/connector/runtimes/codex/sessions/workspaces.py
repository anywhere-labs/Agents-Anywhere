"""Read authoritative experimental Codex projects without inferring from cwd."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from connector.runtime_protocol import RuntimeUnavailableError
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.sessions.inventory import list_all_codex_threads


class CodexWorkspaceInventory:
    def __init__(self, host: RuntimeHostClient, client: Any) -> None:
        self.host = host
        self.client = client
        self._lock = asyncio.Lock()
        self._serialized: str | None = None
        self._snapshot: dict[str, Any] | None = None

    async def read(self) -> dict[str, Any] | None:
        reader = getattr(self.client, "list_native_projects", None)
        if not callable(reader):
            return None
        async with self._lock:
            observed_at = datetime.now(UTC).isoformat()
            before = await reader()
            if before is None:
                return None
            threads: dict[str, Mapping[str, Any]] = {}
            for archived in (False, True):
                for thread in await list_all_codex_threads(
                    self.client, archived=archived, page_size=100,
                    list_page=getattr(self.client, "list_native_project_threads", None),
                    max_threads=50_000,
                ):
                    thread_id = thread.get("id")
                    if not isinstance(thread_id, str) or not thread_id:
                        raise RuntimeUnavailableError("Codex inventory has an invalid thread id")
                    if thread_id in threads:
                        raise RuntimeUnavailableError("Codex threads changed during inventory; retry")
                    if "projectId" not in thread and "project_id" not in thread:
                        return None  # Old SDK stripped the experimental field.
                    threads[thread_id] = thread
                    if len(threads) > 50_000:
                        raise RuntimeUnavailableError("Codex workspace membership exceeds 50000 entries")
            after = await reader()
            if after is None or self._project_signature(before) != self._project_signature(after):
                raise RuntimeUnavailableError("Codex projects changed during inventory; retry")
            state = await self.host.sync_state_read("codex/native-project-membership")
            enabled = isinstance(state, dict) and state.get("enabled") is True
            assignments = {
                thread_id: thread.get("projectId", thread.get("project_id"))
                for thread_id, thread in threads.items()
            }
            if not enabled and not any(assignments.values()):
                # Native projects can coexist with an unmigrated Desktop cwd
                # sidebar. A supported API alone must not ungroup that history.
                return None
            workspaces = []
            project_ids: set[str] = set()
            for project in before:
                project_id = project.get("id")
                title = project.get("name")
                roots = project.get("roots")
                if (
                    not isinstance(project_id, str) or not project_id
                    or project_id in project_ids or not isinstance(title, str)
                    or not isinstance(roots, list) or not roots
                    or any(not isinstance(root, dict) or not isinstance(root.get("path"), str)
                           or not root["path"] for root in roots)
                ):
                    raise RuntimeUnavailableError("Invalid Codex native project inventory")
                project_ids.add(project_id)
                paths = [root["path"] for root in roots]
                workspaces.append({
                    "id": project_id, "title": (title.strip() or paths[0])[:255],
                    "path": paths[0], "roots": paths,
                    "sessionIds": sorted(key for key, value in assignments.items() if value == project_id),
                })
            if any(value is not None and value not in project_ids for value in assignments.values()):
                raise RuntimeUnavailableError("Codex thread references a project outside the inventory; retry")
            workspaces.sort(key=lambda workspace: workspace["id"])
            serialized = json.dumps(workspaces, sort_keys=True, ensure_ascii=True)
            if serialized != self._serialized:
                self._snapshot = {
                    "version": 1, "complete": True, "membershipScope": "tracked",
                    "snapshotId": str(uuid4()),
                    "observedAt": observed_at, "workspaces": workspaces,
                }
                self._serialized = serialized
            if not enabled:
                await self.host.sync_state_write("codex/native-project-membership", {"enabled": True})
            return self._snapshot

    @staticmethod
    def _project_signature(projects: tuple[dict[str, Any], ...]) -> str:
        return json.dumps(sorted(projects, key=lambda value: str(value.get("id"))), sort_keys=True)
