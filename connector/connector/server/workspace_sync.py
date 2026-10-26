"""Source-serial metadata reconciliation, independent of history import."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import random
import secrets
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from connector.logging import logger
from connector.runtime_protocol.workspace_paths import DirectoryObserver


class WorkspaceSyncRunner:
    def __init__(
        self,
        config: Any,
        supervisor: Any,
        publish: Callable[[list[dict[str, Any]]], Awaitable[None]],
    ) -> None:
        self.config, self.supervisor, self.publish = config, supervisor, publish
        self._sequences: dict[str, int] = {}
        self._events: dict[str, asyncio.Event] = {}
        self._first_event: dict[str, float] = {}
        self._last_event: dict[str, float] = {}
        self.metrics: dict[str, dict[str, Any]] = {}

    def request(self, runtime_id: str) -> None:
        now = time.monotonic()
        self._first_event.setdefault(runtime_id, now)
        self._last_event[runtime_id] = now
        self._events.setdefault(runtime_id, asyncio.Event()).set()

    async def run(self, epoch: str) -> None:
        if not self.config.workspace_sync_enabled:
            return
        self._sequences.clear()
        tasks: dict[str, asyncio.Task[None]] = {}
        try:
            while True:
                # Discovery and runtime activation may finish after the socket opens.
                sources = set(self.supervisor.runtimes)
                for runtime_id in sources - tasks.keys():
                    tasks[runtime_id] = asyncio.create_task(
                        self._source(runtime_id, epoch)
                    )
                for runtime_id in tasks.keys() - sources:
                    task = tasks.pop(runtime_id)
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                await asyncio.sleep(1)
        finally:
            for task in tasks.values():
                task.cancel()
            await asyncio.gather(*tasks.values(), return_exceptions=True)

    async def _publish_inventory(self, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, ensure_ascii=True).encode()
        page_bytes = 512 * 1024
        count = (len(raw) + page_bytes - 1) // page_bytes
        if count <= 1:
            await self.publish(
                [{"method": "runtime.workspaces.updated", "params": payload}]
            )
            return
        if count > 256:
            raise ValueError("workspace inventory exceeds transport limit")
        envelope = {
            key: payload[key]
            for key in ("epoch", "sequence", "snapshotId", "runtime", "runtimeId")
        }
        envelope.update(count=count, digest=hashlib.sha256(raw).hexdigest())
        for index in range(count):
            await self.publish(
                [
                    {
                        "method": "runtime.workspaces.chunk",
                        "params": {
                            **envelope,
                            "index": index,
                            "data": base64.b64encode(
                                raw[index * page_bytes : (index + 1) * page_bytes]
                            ).decode(),
                        },
                    }
                ]
            )

    async def _source(self, runtime_id: str, epoch: str) -> None:
        event = self._events.setdefault(runtime_id, asyncio.Event())
        failures, next_full = 0, 0.0
        directory_observer = DirectoryObserver()
        known_paths: set[str] = set()
        last_members: list[dict[str, Any]] = []
        while True:
            started = time.monotonic()
            full = event.is_set() or started >= next_full
            if event.is_set():
                # A burst is bounded even when notifications never stop.
                while True:
                    deadline = min(
                        self._first_event[runtime_id] + 1,
                        self._last_event[runtime_id] + 0.3,
                    )
                    if time.monotonic() >= deadline:
                        break
                    await asyncio.sleep(deadline - time.monotonic())
                event.clear()
                self._first_event.pop(runtime_id, None)
            delay = self.config.workspace_interval_seconds
            try:
                runtime = self.supervisor.resolve_runtime(runtime_id)
                inventory = await runtime.workspace_inventory(full=full)
                if inventory is None:
                    entry = self.supervisor.entry(runtime_id)
                    await self.publish([{"method": "runtime.workspaces.unavailable", "params": {
                        "runtime": entry.runtime_type, "runtimeId": runtime_id, "epoch": epoch,
                    }}])
                    self.metrics[runtime_id] = {"capability": "unsupported", "retries": 0}
                    # Unsupported is permanent for this binary; explicit refresh or
                    # Runtime restart invalidation permits another capability probe.
                    await event.wait()
                    continue
                if inventory.get("membersComplete"):
                    last_members = inventory["members"]
                if inventory.get("catalogComplete"):
                    known_paths = {
                        root
                        for project in inventory["workspaces"]
                        for root in project["roots"]
                    }
                paths = known_paths | {m["cwd"] for m in last_members if m.get("cwd")}
                directories = await directory_observer.read(paths)
                sequence = self._sequences.get(runtime_id, 0) + 1
                self._sequences[runtime_id] = sequence
                entry = self.supervisor.entry(runtime_id)
                payload = {
                    **inventory,
                    "version": 2,
                    "epoch": epoch,
                    "sequence": sequence,
                    "snapshotId": secrets.token_hex(16),
                    "observedAt": datetime.now(UTC).isoformat(),
                    "directories": directories,
                    "runtime": entry.runtime_type,
                    "runtimeId": entry.runtime_id,
                }
                await self._publish_inventory(payload)
                if full and not inventory.get("membersComplete"):
                    next_full = 0
                    raise RuntimeError(
                        "native membership read incomplete; catalog applied independently"
                    )
                if inventory.get("membersComplete"):
                    next_full = (
                        time.monotonic()
                        + self.config.workspace_members_interval_seconds
                    )
                failures = 0
                self.metrics[runtime_id] = {
                    "lastSuccessAt": payload["observedAt"],
                    "scanSeconds": time.monotonic() - started,
                    "members": len(last_members),
                    "unknownDirectories": sum(
                        d["state"] == "unknown" for d in directories
                    ),
                    "retries": 0,
                }
                logger.info(
                    "workspace reconciliation runtime={} members={} unknown={} elapsed_ms={:.1f}",
                    runtime_id,
                    len(last_members),
                    self.metrics[runtime_id]["unknownDirectories"],
                    (time.monotonic() - started) * 1000,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 -- isolate an unavailable native source
                failures += 1
                delay = min(
                    30,
                    (1, 2, 5, 10, 30)[min(failures - 1, 4)]
                    * random.uniform(0.85, 1.15),
                )
                self.metrics.setdefault(runtime_id, {})["retries"] = failures
                if failures == 1:
                    try:
                        entry = self.supervisor.entry(runtime_id)
                        await self.publish(
                            [
                                {
                                    "method": "runtime.workspaces.unavailable",
                                    "params": {
                                        "runtime": entry.runtime_type,
                                        "runtimeId": runtime_id,
                                        "epoch": epoch,
                                    },
                                }
                            ]
                        )
                    except Exception:  # noqa: BLE001 -- outage reporting must not stop the retry loop
                        logger.debug(
                            "workspace source status delivery deferred runtime={}",
                            runtime_id,
                        )
                logger.warning(
                    "workspace reconciliation deferred runtime={} error_type={}",
                    runtime_id,
                    type(exc).__name__,
                )
            try:
                await asyncio.wait_for(event.wait(), timeout=max(0.1, delay))
            except TimeoutError:
                pass
