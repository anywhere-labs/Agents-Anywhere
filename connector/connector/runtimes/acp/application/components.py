from __future__ import annotations

import asyncio
from pathlib import Path
from uuid import uuid4

from ..domain.definitions import AcpError, fingerprint
from ..domain.operations import require_same_input
from .installations import InstallationService


class ComponentService:
    """Durable update operations are independent of a running Agent process."""

    def __init__(self, store, artifacts, feed, *, profile_ids):
        self.store, self.artifacts, self.feed = store, artifacts, feed
        self.profile_ids = frozenset(profile_ids)
        self.installations = InstallationService(store, artifacts)
        self.tasks = set()
        with store.transaction():
            for row in store.values("component_operation"):
                if row["phase"] == "installing":
                    row["phase"] = "outcome_unknown"
                    store.put("component_operation", row["operationId"], row)

    async def execute(self, values: dict) -> dict:
        action = values["operation"]
        if action == "list":
            return {
                "installations": self.store.values("installation"),
                "active": self.store.values("active_component"),
                "operations": self.store.values("component_operation"),
            }
        if action == "get_operation":
            return self.store.require("component_operation", values["operationId"])
        key = values["operationId"]
        digest = fingerprint(values)
        previous = self.store.get("component_operation", key)
        if previous:
            require_same_input(previous["inputDigest"], digest)
            return previous
        profile_id = values["profileId"]
        if profile_id not in self.profile_ids:
            raise AcpError("unknown_agent_profile", "Agent 类型未登记。")
        if action not in {"install", "activate", "rollback", "remove"}:
            raise AcpError("unsupported_component_operation", "组件操作不受支持。")
        row = {
            "operationId": key,
            "inputDigest": digest,
            "phase": "installing" if action == "install" else "outcome_unknown",
            "action": action,
            "profileId": profile_id,
            "releaseId": values.get("releaseId"),
            "result": None,
        }
        with self.store.transaction():
            self.store.put("component_operation", key, row)
        if action == "install":
            task = asyncio.create_task(self._install(row))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
        else:
            with self.store.transaction():
                try:
                    if action == "activate":
                        result = self.installations.activate(
                            profile_id, values["releaseId"]
                        )
                    elif action == "rollback":
                        result = self.installations.rollback(profile_id)
                    else:
                        self.installations.remove(values["releaseId"])
                        result = {"removed": True}
                    row.update(phase="completed", result=result)
                except AcpError as error:
                    row.update(
                        phase="failed",
                        failure={"code": error.code, "message": str(error)},
                    )
                self.store.put("component_operation", key, row)
        return row

    async def _install(self, row):
        archive: Path = self.artifacts.root / (".download-" + uuid4().hex + ".zip")
        try:
            entry = await asyncio.to_thread(
                self.feed.download, row["releaseId"], archive
            )
            if entry["manifest"]["profileId"] != row["profileId"]:
                raise AcpError("component_profile_mismatch", "组件不属于请求的 Agent。")
            installed = await asyncio.to_thread(
                self.artifacts.install, archive, entry["manifest"], entry["signature"]
            )
            with self.store.transaction():
                self.store.put("installation", installed["releaseId"], installed)
                row.update(
                    phase="completed", result={"releaseId": installed["releaseId"]}
                )
                self.store.put("component_operation", row["operationId"], row)
        except Exception as error:  # noqa: BLE001 -- retain durable install failure, without raw network payload
            row.update(
                phase="failed",
                failure={
                    "code": getattr(error, "code", "component_install_failed"),
                    "message": "组件安装未完成，当前组件保持不变。",
                },
            )
            with self.store.transaction():
                self.store.put("component_operation", row["operationId"], row)
        finally:
            archive.unlink(missing_ok=True)
