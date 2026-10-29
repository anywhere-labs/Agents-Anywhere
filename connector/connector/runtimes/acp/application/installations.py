from __future__ import annotations

from ..domain.definitions import AcpError


class InstallationService:
    def __init__(self, store, artifacts):
        self.store, self.artifacts = store, artifacts

    def install(self, archive, manifest: dict, signature: dict) -> dict:
        installation = self.artifacts.install(archive, manifest, signature)
        with self.store.transaction():
            old = self.store.get("installation", installation["releaseId"])
            if old and old != installation:
                raise AcpError(
                    "component_identity_conflict", "组件身份对应不同的安装信息。"
                )
            self.store.put("installation", installation["releaseId"], installation)
        return installation

    def activate(self, profile_id: str, release_id: str) -> dict:
        row = self.store.require("installation", release_id)
        if row["profileId"] != profile_id or row["status"] != "ready":
            raise AcpError("component_not_ready", "组件尚未安装或不属于该 Agent。")
        # Reverify immutable files before selecting them, not only at download.
        self.artifacts.verify_installed(row)
        with self.store.transaction():
            previous = self.store.get("active_component", profile_id)
            if previous and previous["releaseId"] == release_id:
                return {
                    "releaseId": release_id,
                    "appliesTo": "new_sessions",
                    "activeSessionsChanged": False,
                }
            self.store.put(
                "active_component",
                profile_id,
                {
                    "profileId": profile_id,
                    "releaseId": release_id,
                    "previousReleaseId": previous["releaseId"] if previous else None,
                },
            )
        return {
            "releaseId": release_id,
            "appliesTo": "new_sessions",
            "activeSessionsChanged": False,
        }

    def rollback(self, profile_id: str) -> dict:
        current = self.store.require("active_component", profile_id)
        previous = current.get("previousReleaseId")
        if not previous:
            raise AcpError("rollback_unavailable", "没有可回退的组件。")
        return self.activate(profile_id, previous)

    def remove(self, release_id: str):
        if (
            any(
                row.get("release_id") == release_id
                for row in self.store.values("binding")
            )
            or any(
                row["releaseId"] == release_id
                or row.get("previousReleaseId") == release_id
                for row in self.store.values("active_component")
            )
            or any(
                row["releaseId"] == release_id
                for row in self.store.values("executor_reference")
            )
            or any(
                row.get("releaseId") == release_id
                and row["phase"] in {"installing", "outcome_unknown"}
                and row["action"] != "remove"
                for row in self.store.values("component_operation")
            )
        ):
            raise AcpError("component_in_use", "组件仍由会话或当前安装引用。")
        self.artifacts.remove(self.store.require("installation", release_id))
        with self.store.transaction():
            self.store.delete("installation", release_id)
