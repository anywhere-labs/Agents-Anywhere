"""Strict, bounded metadata reads; SDK list APIs intentionally hide I/O errors."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any
from uuid import UUID

from connector.runtime_protocol import RuntimeUnavailableError

METADATA_BYTES = 1024 * 1024


class ClaudeWorkspaceInventory:
    def __init__(self, config_dir: str | None = None) -> None:
        self._root = (
            Path(
                config_dir
                or os.environ.get("CLAUDE_CONFIG_DIR")
                or Path.home() / ".claude"
            )
            / "projects"
        )
        self._cache: dict[str, tuple[tuple[int, int, int], dict[str, Any] | None]] = {}
        self._lock = asyncio.Lock()
        self._scan_task: asyncio.Task[dict[str, Any]] | None = None

    @staticmethod
    def _enumerate(root: Path) -> dict[Path, tuple[int, int, int]]:
        # Explicit scandir/stat propagate errors, including disappearance mid-scan.
        files = {}
        with os.scandir(root) as projects:
            for project in projects:
                if not project.is_dir(follow_symlinks=False):
                    continue
                with os.scandir(project.path) as sessions:
                    for session in sessions:
                        if not session.name.endswith(".jsonl"):
                            continue
                        try:
                            UUID(session.name[:-6])
                        except ValueError:
                            continue  # Native auxiliary files are not main sessions.
                        info = session.stat(follow_symlinks=False)
                        files[Path(session.path)] = (
                            info.st_ino,
                            info.st_size,
                            info.st_mtime_ns,
                        )
                        if len(files) > 50_000:
                            raise RuntimeUnavailableError(
                                "Claude metadata inventory exceeds limit"
                            )
        return files

    @staticmethod
    def _read(path: Path) -> dict[str, Any] | None:
        with path.open("rb") as stream:
            head = stream.read(METADATA_BYTES + 1)
        if not head:
            raise RuntimeUnavailableError("Claude candidate metadata is empty")
        truncated = len(head) > METADATA_BYTES
        if truncated:
            head = head[:METADATA_BYTES].rsplit(b"\n", 1)[0]
        cwd, main = None, False
        for line in head.splitlines():
            if not line.strip():
                continue
            item = json.loads(line)  # Malformed candidates invalidate this collection.
            if not isinstance(item, dict):
                raise RuntimeUnavailableError("Invalid Claude metadata record")
            if item.get("isSidechain") is True:
                return None
            if isinstance(item.get("cwd"), str) and os.path.isabs(item["cwd"]):
                cwd = item["cwd"]
            if item.get("type") in {"user", "assistant"}:
                main = True
        if not main:
            if truncated:
                raise RuntimeUnavailableError(
                    "Claude metadata header exceeds read limit"
                )
            return None
        if cwd is None:
            raise RuntimeUnavailableError(
                "Claude main session has no directory identity"
            )
        project_id = "directory:" + hashlib.sha256(cwd.encode()).hexdigest()
        return {"sessionId": path.stem, "projectId": project_id, "cwd": cwd}

    def _scan(self, full: bool) -> dict[str, Any]:
        root = self._root
        try:
            before = self._enumerate(root)
        except FileNotFoundError as exc:
            if str(exc.filename) != str(root) or not root.parent.is_dir():
                raise
            time.sleep(0.2)
            try:
                before = self._enumerate(root)
            except FileNotFoundError as second:
                if str(second.filename) != str(root) or not root.parent.is_dir():
                    raise
                self._cache.clear()
                return {
                    "catalogComplete": True,
                    "membersComplete": True,
                    "workspaces": [],
                    "members": [],
                }
        updated = {}
        members = []
        for path, signature in before.items():
            cached = self._cache.get(str(path))
            member = (
                cached[1]
                if not full and cached and cached[0] == signature
                else self._read(path)
            )
            updated[str(path)] = (signature, member)
            if member is not None:
                members.append(member)
        if before != self._enumerate(root):
            raise RuntimeUnavailableError(
                "Claude storage changed during metadata collection"
            )
        self._cache = updated
        projects = {
            m["projectId"]: {
                "id": m["projectId"],
                "title": Path(m["cwd"]).name or m["cwd"],
                "path": m["cwd"],
                "roots": [m["cwd"]],
                "identityKind": "directory",
            }
            for m in members
        }
        return {
            "catalogComplete": True,
            "membersComplete": True,
            "workspaces": sorted(projects.values(), key=lambda p: p["id"]),
            "members": sorted(members, key=lambda m: m["sessionId"]),
        }

    async def read(self, *, full: bool = True) -> dict[str, Any]:
        async with self._lock:
            if self._scan_task is None:
                self._scan_task = asyncio.create_task(
                    asyncio.to_thread(self._scan, full)
                )
            task = self._scan_task
            try:
                return await asyncio.wait_for(asyncio.shield(task), timeout=60)
            finally:
                # Cancellation/timeout cannot stop an OS read. Keep ownership
                # until it exits so retries/reconnects do not start another scan.
                if task.done():
                    self._scan_task = None
