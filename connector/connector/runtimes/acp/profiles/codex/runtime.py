"""Continue a Codex App or IDE conversation from the native session list.

The shared runtime lists the adapter's native sessions read-only. Here such a
row also offers ``session.recover``: AA binds the same Codex thread, imports its
saved history once, and resumes it with automatic routing, so a conversation an
owner window still holds is followed rather than taken over.
"""

from __future__ import annotations

from dataclasses import asdict, replace
from pathlib import Path
from uuid import uuid4

from connector.runtime_protocol.models import RuntimeCapability
from connector.runtime_protocol.workflows import RuntimeWorkflowResult

from ...domain.definitions import AcpError, Workspace, fingerprint
from ...domain.operations import require_same_input
from ...domain.sessions import SessionBinding
from ...runtime import AcpRuntime

# Native rows have no AA executor yet; a fixed generation still lets clients
# send the ``expectedGeneration`` the recover request requires.
NATIVE_GENERATION = "codex-native"


class CodexAcpRuntime(AcpRuntime):
    def _native(self, session_id):
        return self.app.store.get("native_inventory", session_id)

    def _native_metadata(self, native):
        return {
            "nativeHistory": True,
            # The owner window keeps running; clients must not ask the user to close it.
            "handoff": "follow",
            "ownerGeneration": NATIVE_GENERATION,
            "sourceRevision": fingerprint(native)[:32],
            "readOnly": True,
        }

    def _session_capabilities(self, session_id):
        value = super()._session_capabilities(session_id)
        native = self._native(session_id)
        if not native:
            return value
        attaching = session_id in self.app.recovery_locks and self.app.recovery_locks[session_id].locked()
        return replace(value, capabilities=(*value.capabilities, RuntimeCapability(
            capability_id="session.recover", scope="session", runtime=self.config.runtime,
            session_id=session_id, available=bool(native.get("cwd")) and not attaching,
            unavailable_reason=None if native.get("cwd") else "codex_workspace_missing",
            metadata=self._native_metadata(native),
        )))

    async def get_session_state(self, session_id, external_session_id=None):
        value = await super().get_session_state(session_id, external_session_id)
        native = self._native(session_id)
        if not native:
            return value
        return replace(value, metadata={**value.metadata, **self._native_metadata(native)})

    async def execute_workflow(self, request):
        values = dict(request.values)
        if request.operation == "recover_session" and (
            self._native(values.get("sessionId", "")) or self._follow_operation(values)
        ):
            try:
                return RuntimeWorkflowResult(self._begin_follow(values))
            except AcpError as error:
                return RuntimeWorkflowResult({
                    "operationId": values.get("operationId"), "phase": "rejected",
                    "failure": {"code": error.code, "message": str(error)},
                })
        return await super().execute_workflow(request)

    def _follow_operation(self, values):
        """A follow keeps answering its own polls after the native row became a binding."""
        key = fingerprint([values.get("sessionId"), values.get("operationId")])
        return self.app.store.get("codex_follow_operation", key)

    def _begin_follow(self, values):
        session_id = values["sessionId"]
        key = fingerprint([session_id, values["operationId"]])
        digest = fingerprint(values)
        previous = self.app.store.get("codex_follow_operation", key)
        if previous:
            require_same_input(previous["digest"], digest)
            return previous["result"]
        if values.get("expectedGeneration") != NATIVE_GENERATION:
            raise AcpError("owner_changed", "会话执行者已变化，请刷新。")
        if session_id in self.app.sessions:
            raise AcpError("codex_session_already_running", "此会话已在 AA 执行。")
        native = self._native(session_id)
        if not native.get("cwd"):
            raise AcpError("codex_workspace_missing", "原会话没有记录工作目录，无法继续。")
        if not self.app.store.get("binding", session_id):
            generation = uuid4().hex
            binding = SessionBinding(
                session_id, self.profile.id, self.launch.release_id,
                Workspace(native["cwd"], str(Path(native["cwd"]).expanduser().resolve())),
                generation, generation, native["sessionId"], attachment="recovery_required",
            )
            with self.app.store.transaction():
                self.app.store.put("binding", session_id, asdict(binding))
        result = {"operationId": values["operationId"], "phase": "running"}
        with self.app.store.transaction():
            self.app.store.put("codex_follow_operation", key, {"digest": digest, "result": result})
        self.app._job(self._follow(session_id, key, digest, values["operationId"]))
        return result

    async def _follow(self, session_id, key, digest, operation_id):
        native = self._native(session_id)
        try:
            await self._import_history(session_id, native["sessionId"])
            state = await self.app.recover(session_id)
            with self.app.store.transaction():
                self.app.store.delete("native_inventory", session_id)
                self._republish_binding(session_id)
            result = {"operationId": operation_id, "phase": "completed", "state": state}
        except Exception as error:  # noqa: BLE001 -- persist a concrete outcome; the native row stays browsable
            context = self.app.sessions.get(session_id)
            if context:
                await self.app._close_context(context)
            result = {"operationId": operation_id, "phase": "rejected", "failure": {
                "code": error.code if isinstance(error, AcpError) else "codex_follow_failed",
                "message": str(error) if isinstance(error, AcpError)
                else "无法继续此 Codex 会话，请确认 Codex 与 codex-acp 可用后重试。",
            }}
        with self.app.store.transaction():
            self.app.store.put("codex_follow_operation", key, {"digest": digest, "result": result})
        self._publish_session_capabilities(session_id)

    async def _import_history(self, session_id, native_id):
        """Saved history becomes the session's Timeline once; resume then sends only new events.

        The epoch is the native identity, so a retried import rewrites the same items.
        """
        if any(row["sessionId"] == session_id for row in self.app.store.values("projection")):
            return
        client = await self.app.inventory_client()
        replay = await client.extension("aa/read_history", {"sessionId": native_id})
        projection = self.app.projection_factory(session_id, "native:" + native_id)
        for update in replay.get("updates", []):
            projection.apply(update)
        projection.finish()
        with self.app.store.transaction():
            for item in sorted(projection.items.values(), key=lambda row: row["orderSeq"]):
                self.app.store.put("projection", item["id"], item)
                self.app._emit("timeline.itemUpsert", {
                    "sessionId": session_id, "externalSessionId": native_id, "item": item,
                })

