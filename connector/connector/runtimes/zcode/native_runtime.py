"""Native ZCode history browsing and explicit desktop ↔ AA handoff.

Mirrors ``runtimes/acp/profiles/pi/native_runtime.py``: conversations found in
ZCode's local database are published as browsable platform sessions, and the
``session.recover`` workflow attaches the bridge to the engine conversation so
the user can continue it from any client.

Concurrency stance: the ZCode engine database is shared with the desktop app,
so continuing requires the user to confirm the conversation is inactive there
(``cliExited``), and a cross-process file lock keeps two AA instances from
attaching the same conversation. Live-write conflict detection while attached
is not attempted: the AA bridge process is the sole writer of its own engine
session, and external desktop writes surface as source revisions on the next
scan.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import asdict, replace
from pathlib import Path
from uuid import uuid4

from connector.runtime_protocol.errors import RuntimeInvalidRequestError
from connector.runtime_protocol.models import (
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeOperationResult,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionState,
)
from connector.runtime_protocol.workflows import RuntimeWorkflowResult
from connector.runtimes.acp.domain.definitions import AcpError, Workspace, fingerprint
from connector.runtimes.acp.domain.operations import require_same_input
from connector.runtimes.acp.domain.sessions import SessionBinding
from connector.runtimes.acp.runtime import AcpRuntime

from .native_history import discover_sessions, read_history, timeline

# v3: native continue-required sessions publish as idle (green) instead of
# blocked (red); failures alone stay blocked.
PROJECTION_REVISION = 4
SCAN_INTERVAL_SECONDS = 5.0

RESUME_BLOCKING_FAILURES = {
    "zcode_source_missing",
    "zcode_source_unreadable",
    "zcode_history_invalid",
    "zcode_history_incomplete",
    "zcode_workspace_missing",
}


class NativeZcodeRuntime(AcpRuntime):
    def __init__(self, *args, history_db_path, **kwargs):
        super().__init__(*args, **kwargs)
        self.history_db_path = Path(history_db_path)
        self.scan_lock = asyncio.Lock()
        # How long start_turn waits for an early accept/reject before
        # reporting "turn in progress". Keep this small: the server's
        # send-message RPC budget is 30s and the first attach already costs
        # several seconds; real turns run for minutes regardless.
        self.turn_wait_seconds = 6.0
        self.leases: dict[str, int] = {}
        self.app.launch_for_session = self._session_launch
        self.app.on_context_closed = self._release
        self.app.on_binding_changed = self._publish_native_state

    async def start(self):
        await super().start()
        for key, row in self.app.store.items("zcode_recovery_operation"):
            if row["result"].get("phase") == "running":
                row["result"] = {
                    "phase": "rejected",
                    "failure": {
                        "code": "zcode_recovery_interrupted",
                        "message": "Connector 重启中断了恢复，请查看最新历史并重新确认继续。",
                    },
                }
                self.app.store.put("zcode_recovery_operation", key, row)
        await self.scan()
        self.app._job(self._scan_loop())

    async def stop(self):
        self.app.stopping = True
        for task in list(self.app.tasks):
            task.cancel()
        await super().stop()
        for session_id in list(self.leases):
            self._release(session_id)

    async def _scan_loop(self):
        while not self.app.stopping:
            try:
                await self.scan()
            except Exception as error:  # noqa: BLE001 -- keep browsing when one read fails
                self.app.store.put(
                    "zcode_scan_error",
                    "latest",
                    {"code": getattr(error, "code", "zcode_scan_failed")},
                )
            await asyncio.sleep(SCAN_INTERVAL_SECONDS)

    def _source(self, session_id):
        return self.app.store.get("zcode_native_source", session_id)

    def _source_rows(self):
        for source in self.app.store.values("zcode_native_source"):
            yield source["platformSessionId"], source

    def _metadata(self, session_id, source):
        row = self.app.store.get("binding", session_id)
        return {
            "nativeHistory": True,
            "sourceRevision": source["revision"],
            "requiresCliExitConfirmation": True,
            "ownerGeneration": row["owner_generation"]
            if row
            else "browse:" + session_id[-40:],
            "stateRevision": row["revision"] if row else 1,
        }

    async def scan(self, *, force=False):
        async with self.scan_lock:
            errors: list[dict] = []
            try:
                inventory = await asyncio.to_thread(
                    discover_sessions, self.history_db_path
                )
            except AcpError as error:
                inventory, errors = {}, [{"code": error.code, "message": str(error)}]
            # Bindings created by a previous recovery pin their platform id even
            # if the deterministic fingerprint changes with the runtime id.
            bound: dict[str, str] = {}
            for row in self.app.store.values("binding"):
                agent_id = row["agent_session_id"]
                if not isinstance(agent_id, str):
                    continue
                bound[agent_id] = row["session_id"]
                if agent_id.startswith("zc-"):
                    bound[agent_id[3:]] = row["session_id"]
            for native_id, entry in inventory.items():
                session_id = bound.get(native_id) or (
                    "zcode_native_"
                    + fingerprint([self.config.runtime_id, native_id])[:40]
                )
                if session_id in self.app.sessions:
                    continue
                previous = self._source(session_id)
                if (
                    not force
                    and previous
                    and previous.get("signature") == entry["signature"]
                    and previous.get("publishedRevision") == previous["revision"]
                    and previous.get("projectionRevision") == PROJECTION_REVISION
                ):
                    continue
                try:
                    history = await asyncio.to_thread(
                        read_history, self.history_db_path, native_id
                    )
                except AcpError as error:
                    errors.append({"code": error.code, "message": str(error)})
                    self._failure(session_id, error.code, str(error))
                    continue
                source = history.source()
                source["signature"] = entry["signature"]
                source["platformSessionId"] = session_id
                self.app.store.put("zcode_native_source", session_id, source)
                try:
                    history.require_resumable()
                except AcpError as error:
                    self._failure(session_id, error.code, str(error))
                else:
                    old_failure = (
                        self.app.store.get("zcode_native_failure", session_id) or {}
                    )
                    if old_failure.get("code") in RESUME_BLOCKING_FAILURES:
                        self.app.store.delete("zcode_native_failure", session_id)
                if (
                    force
                    or not previous
                    or previous.get("publishedRevision") != source["revision"]
                    or previous.get("projectionRevision") != PROJECTION_REVISION
                ):
                    self._publish_history(
                        session_id, history, reset=force or not previous
                    )
            # Conversations deleted in ZCode keep their browsable content but
            # lose resume until the source reappears.
            for platform_id, source in self._source_rows():
                if source["sessionId"] not in inventory:
                    self._failure(
                        platform_id,
                        "zcode_source_missing",
                        "原生会话已从 ZCode 数据库中消失，已保留浏览内容。",
                    )
            if errors:
                self.app.store.put("zcode_scan_error", "latest", {"errors": errors})

    def _publish_history(self, session_id, history, *, reset=False):
        source = self._source(session_id)
        with self.app.store.transaction():
            self.app._emit(
                "session.meta.upsert",
                {
                    "sessionId": session_id,
                    "externalSessionId": history.native_id,
                    "cwd": history.cwd,
                    "title": history.title,
                    "orderingTime": source.get("updatedAt"),
                    "metadata": {
                        "origin": "zcode_native_history",
                        **self._metadata(session_id, source),
                    },
                },
            )
            items = timeline(history, session_id, self.config.runtime)
            previous = {
                item["id"]: item
                for item in self.app.store.values("projection")
                if item["sessionId"] == session_id
            }
            changed = []
            for item in items:
                old = previous.get(item["id"])
                if old and not history.complete:
                    # A torn read cannot downgrade already persisted content.
                    continue
                item["revision"] = (
                    old["revision"] + (old["contentHash"] != item["contentHash"])
                    if old
                    else 1
                )
                if (
                    not old
                    or old["contentHash"] != item["contentHash"]
                    or old["orderSeq"] != item["orderSeq"]
                ):
                    changed.append(item)
                self.app.store.put("projection", item["id"], item)
            if history.complete:
                keep = {item["id"] for item in items}
                removed = set(previous) - keep
                reset = (
                    reset
                    or bool(removed)
                    or any(
                        previous[item["id"]]["orderSeq"] != item["orderSeq"]
                        for item in items
                        if item["id"] in previous
                    )
                )
                for key in removed:
                    self.app.store.delete("projection", key)
            if history.complete and reset:
                self.app._emit(
                    "timeline.sync",
                    {
                        "sessionId": session_id,
                        "externalSessionId": history.native_id,
                        "items": items,
                        "complete": True,
                    },
                )
            else:
                for item in changed:
                    self.app._emit(
                        "timeline.itemUpsert",
                        {
                            "sessionId": session_id,
                            "externalSessionId": history.native_id,
                            "item": item,
                        },
                    )
            self._publish_native_state(session_id)
            source["publishedRevision"] = history.revision
            source["projectionRevision"] = PROJECTION_REVISION
            self.app.store.put("zcode_native_source", session_id, source)

    def _failure(self, session_id, code, message):
        failure = {"code": code, "message": message}
        if self.app.store.get("zcode_native_failure", session_id) == failure:
            return
        self.app.store.put("zcode_native_failure", session_id, failure)
        self._publish_native_state(session_id)

    def _publish_native_state(self, session_id):
        source = self._source(session_id)
        if not source:
            # Newly created AA sessions have not yet entered the native index,
            # but their idle/model changes still update effective input.
            self._publish_session_capabilities(session_id)
            return
        binding = self.app.store.get("binding", session_id)
        live = self.app.sessions.get(session_id)
        state = (
            self.app.state(session_id)
            if binding and live and not live["closing"]
            else {
                "sessionId": session_id,
                "externalSessionId": source["sessionId"],
                # Browsing imported history is a normal resting state, not a
                # blockage: clients render it green, red stays for failures.
                "status": "idle",
                "statusReason": "zcode_continue_required",
                "selections": {},
                "metadata": {},
            }
        )
        failure = self.app.store.get("zcode_native_failure", session_id)
        state["metadata"].update(self._metadata(session_id, source))
        if failure:
            state.update(status="blocked", statusReason=failure["code"], error=failure)
        self.app._emit("session.state.updated", state)
        self._publish_session_capabilities(session_id)

    async def list_sessions(self, limit=100, cursor=None, force=False):
        await self.scan(force=force)
        rows = [
            SessionMeta(
                session_id=key,
                external_session_id=source["sessionId"],
                runtime=self.config.runtime,
                cwd=source["cwd"],
                title=source.get("title"),
                ordering_time=source.get("updatedAt"),
                metadata={
                    "origin": "zcode_native_history",
                    **self._metadata(key, source),
                },
            )
            for key, source in self._source_rows()
        ]
        known = {row.session_id for row in rows}
        rows.extend(
            SessionMeta(
                session_id=row["session_id"],
                external_session_id=row["agent_session_id"],
                runtime=self.config.runtime,
                cwd=row["workspace"]["registered_path"],
            )
            for row in self.app.store.values("binding")
            if row["session_id"] not in known
        )
        rows.sort(
            key=lambda row: (row.ordering_time or "", row.session_id), reverse=True
        )
        offset = int(cursor) if cursor and cursor.isdecimal() else 0
        return tuple(rows[offset : offset + limit])

    async def get_session_state(self, session_id, external_session_id=None):
        source = self._source(session_id)
        if not source:
            return await super().get_session_state(session_id, external_session_id)
        row = self.app.store.get("binding", session_id)
        live = self.app.sessions.get(session_id)
        state = (
            await super().get_session_state(session_id, external_session_id)
            if row and live and not live["closing"]
            else SessionState(
                session_id=session_id,
                external_session_id=source["sessionId"],
                runtime=self.config.runtime,
                # Normal resting state for imported history (and for dropped
                # links: the next message reattaches); failures below still
                # surface as blocked.
                status="idle",
                status_reason="zcode_continue_required",
            )
        )
        failure = self.app.store.get("zcode_native_failure", session_id)
        return replace(
            state,
            metadata={**state.metadata, **self._metadata(session_id, source)},
            **(
                {
                    "status": "blocked",
                    "status_reason": failure["code"],
                    "error": failure,
                }
                if failure
                else {}
            ),
        )

    def _session_capabilities(self, session_id):
        source = self._source(session_id)
        if not source:
            return super()._session_capabilities(session_id)
        row = self.app.store.get("binding", session_id)
        caps = (
            list(super()._session_capabilities(session_id).capabilities) if row else []
        )
        live = self.app.sessions.get(session_id)
        ready = bool(live and not live["closing"])
        failure = self.app.store.get("zcode_native_failure", session_id)
        metadata = self._metadata(session_id, source)
        if failure:
            metadata["reasonMessage"] = failure["message"]
        blocked_source = bool(failure and failure["code"] in RESUME_BLOCKING_FAILURES)
        caps = [cap for cap in caps if cap.capability_id != "session.recover"]
        if not ready:
            # Takeover parity with other agents + self-healing: the composer
            # enables as soon as the user flips takeover, and the first message
            # (re)attaches lazily — whether browsing or after a dropped link.
            caps = [cap for cap in caps if cap.capability_id != "session.send_message"]
            caps.append(
                RuntimeCapability(
                    capability_id="session.send_message",
                    scope="session",
                    runtime=self.config.runtime,
                    session_id=session_id,
                    available=True,
                )
            )
        caps.append(
            RuntimeCapability(
                capability_id="session.recover",
                scope="session",
                runtime=self.config.runtime,
                session_id=session_id,
                available=not ready and not blocked_source,
                unavailable_reason=failure["code"]
                if failure
                else "zcode_continue_required",
                metadata=metadata,
            )
        )
        if failure:
            caps = [
                replace(cap, available=False, unavailable_reason=failure["message"])
                if cap.capability_id
                in {"session.send_message", "session.steer", "session.commands"}
                else cap
                for cap in caps
            ]
        return RuntimeCapabilitySet(
            runtime=self.config.runtime,
            session_id=session_id,
            revision=row["revision"] if row else 1,
            capabilities=tuple(caps),
        )

    async def get_session_snapshot(
        self, session_id, external_session_id=None, limit=None
    ):
        if not self._source(session_id):
            return await super().get_session_snapshot(
                session_id, external_session_id, limit
            )
        items = [
            row
            for row in self.app.store.values("projection")
            if row["sessionId"] == session_id
        ]
        items.sort(key=lambda item: item["orderSeq"])
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=self._source(session_id)["sessionId"],
            runtime=self.config.runtime,
            complete=False,
            items=tuple(
                RuntimeTimelineItem(
                    id=item["id"],
                    session_id=session_id,
                    type=item["type"],
                    role=item.get("role"),
                    status=item["status"],
                    order_seq=item["orderSeq"],
                    revision=item["revision"],
                    content_hash=item["contentHash"],
                    content=item["content"],
                    source=item["source"],
                )
                for item in items[-(limit or 1000) :]
            ),
        )

    async def resynchronize(self, session_id=None, external_session_id=None):
        await self.scan(force=True)
        sources = {key for key, _source in self._source_rows()}
        for key in sources:
            if not session_id or key == session_id:
                self._publish_native_state(key)
        # Live AA-created sessions enter the native index only after release;
        # until then they keep the ordinary ACP projection.
        with self.app.store.transaction():
            for row in self.app.store.values("binding"):
                key = row["session_id"]
                if key not in sources and (not session_id or key == session_id):
                    self._republish_binding(key)
        await self.sync.flush()

    async def execute_workflow(self, request):
        values = dict(request.values)
        if request.operation == "recover_session" and self._source(
            values.get("sessionId")
        ):
            try:
                return RuntimeWorkflowResult(await self._begin_resume(values))
            except AcpError as error:
                return RuntimeWorkflowResult(
                    {
                        "operationId": values.get("operationId"),
                        "phase": "rejected",
                        "failure": {"code": error.code, "message": str(error)},
                    }
                )
        result = await super().execute_workflow(request)
        if request.operation == "close_session" and self._source(
            values.get("sessionId")
        ):
            await self._refresh_source(values["sessionId"])
        return result

    async def _begin_resume(self, values):
        session_id = values["sessionId"]
        key = fingerprint([session_id, values["operationId"]])
        digest = fingerprint(values)
        previous = self.app.store.get("zcode_recovery_operation", key)
        if previous:
            require_same_input(previous["digest"], digest)
            return previous["result"]
        source = self._source(session_id)
        if values.get("cliExited") is not True:
            raise AcpError(
                "zcode_cli_exit_required",
                "请先在 ZCode 桌面端关闭该会话，并确认后继续。",
            )
        if (
            values.get("expectedGeneration")
            != self._metadata(session_id, source)["ownerGeneration"]
        ):
            raise AcpError("owner_changed", "会话执行者已变化，请刷新。")
        if session_id in self.app.sessions:
            raise AcpError("zcode_session_already_running", "此会话已在 AA 执行。")
        history = await asyncio.to_thread(
            read_history, self.history_db_path, source["sessionId"]
        )
        history.require_resumable()
        if (
            values.get("sourceRevision") != source["revision"]
            or history.revision != source["revision"]
        ):
            await self._refresh_source(session_id)
            raise AcpError(
                "zcode_source_changed", "历史已变化，请查看最新内容后重新继续。"
            )
        self._acquire(session_id)
        binding = self.app.store.get("binding", session_id)
        if not binding:
            generation = uuid4().hex
            binding = asdict(
                SessionBinding(
                    session_id,
                    self.profile.id,
                    self.launch.release_id,
                    Workspace(history.cwd, str(Path(history.cwd).resolve())),
                    generation,
                    generation,
                    # The bridge exposes engine conversations as "zc-<zsid>".
                    "zc-" + history.native_id,
                    attachment="recovery_required",
                )
            )
            self.app.store.put("binding", session_id, binding)
        result = {"operationId": values["operationId"], "phase": "running"}
        self.app.store.put(
            "zcode_recovery_operation", key, {"digest": digest, "result": result}
        )
        self.app.store.delete("zcode_native_failure", session_id)
        self.app._job(self._resume_job(session_id, key, digest))
        return result

    async def _resume_job(self, session_id, key, digest):
        try:
            state = await self.app.recover(session_id)
            result = {
                "operationId": self.app.store.require(
                    "zcode_recovery_operation", key
                )["result"]["operationId"],
                "phase": "completed",
                "state": state,
            }
        except Exception as error:  # noqa: BLE001 -- persist a concrete recovery failure
            context = self.app.sessions.get(session_id)
            if context:
                await self.app._close_context(context)
            self._release(session_id)
            failure = {
                "code": error.code
                if isinstance(error, AcpError)
                else "zcode_resume_failed",
                "message": str(error)
                if isinstance(error, AcpError)
                else "ZCode 恢复失败，请检查桌面端安装与会话状态。",
            }
            self._failure(session_id, **failure)
            result = {"phase": "rejected", "failure": failure}
        self.app.store.put(
            "zcode_recovery_operation", key, {"digest": digest, "result": result}
        )
        self._publish_native_state(session_id)

    async def _session_launch(self, session_id):
        source = self._source(session_id)
        if not source:
            return self.launch
        history = await asyncio.to_thread(
            read_history, self.history_db_path, source["sessionId"]
        )
        history.require_resumable()
        if history.revision != source["revision"]:
            raise AcpError(
                "zcode_source_changed", "恢复准备期间原生历史已变化，请重新校准。"
            )
        return self.launch

    async def _preattach_checks(self, session_id):
        source = self._source(session_id)
        history = await asyncio.to_thread(
            read_history, self.history_db_path, source["sessionId"]
        )
        history.require_resumable()
        if history.revision != source["revision"]:
            await self._refresh_source(session_id)
            raise AcpError(
                "zcode_source_changed", "历史已变化，请查看最新内容后重新继续。"
            )
        return history

    async def _attach_native(self, session_id):
        """Attach the bridge to an imported conversation on demand (takeover)."""
        history = await self._preattach_checks(session_id)
        self._acquire(session_id)
        binding = self.app.store.get("binding", session_id)
        if not binding:
            generation = uuid4().hex
            binding = asdict(
                SessionBinding(
                    session_id,
                    self.profile.id,
                    self.launch.release_id,
                    Workspace(history.cwd, str(Path(history.cwd).resolve())),
                    generation,
                    generation,
                    # The bridge exposes engine conversations as "zc-<zsid>".
                    "zc-" + history.native_id,
                    attachment="recovery_required",
                )
            )
            self.app.store.put("binding", session_id, binding)
            self.app.store.delete("zcode_native_failure", session_id)
            self._publish_native_state(session_id)
        try:
            await self.app.recover(session_id)
        except Exception:
            context = self.app.sessions.get(session_id)
            if context:
                await self.app._close_context(context)
            self._release(session_id)
            # Roll back to a clean browsable state: a half-recovered binding
            # keeps the session blocked (409) for every later message.
            self.app.store.delete("binding", session_id)
            self._publish_native_state(session_id)
            raise

    async def start_turn(
        self,
        session_id,
        external_session_id,
        content,
        selections=None,
        attachments=(),
        client_message_id=None,
        cwd=None,
    ):
        if not self._source(session_id):
            return await super().start_turn(
                session_id,
                external_session_id,
                content,
                selections=selections,
                attachments=attachments,
                client_message_id=client_message_id,
                cwd=cwd,
            )
        if external_session_id != self._source(session_id)["sessionId"]:
            raise RuntimeInvalidRequestError("原生会话身份不匹配。")
        if session_id not in self.app.sessions:
            await self._attach_native(session_id)
        current = self.app.state(session_id)["selections"]
        changes = {
            key: value
            for key, value in (selections or {}).items()
            if value is not None and current.get(key) != value
        }
        if changes:
            updated = await self.update_session_selections(
                session_id, external_session_id, changes
            )
            if not updated.ok:
                return updated
        blocks = None
        if attachments:
            from connector.runtimes.acp.infrastructure.attachments import materialize

            if not self.agent_capabilities.supported(session_id, "runtime.attachment"):
                raise RuntimeInvalidRequestError("当前 Agent 不支持附件。")
            blocks = await materialize(
                self.host, session_id, attachments, self.app.root / "attachments"
            )
        result = await self.app.submit(session_id, client_message_id, content, blocks=blocks)
        if result.get("messageAccepted") is None:
            try:
                async with asyncio.timeout(self.turn_wait_seconds):
                    while True:
                        row = self.app.store.require(
                            "prompt", fingerprint([session_id, client_message_id])
                        )
                        if row["message_accepted"] is not None:
                            result = {
                                "ok": row["message_accepted"],
                                "messageAccepted": row["message_accepted"],
                                "phase": row["phase"],
                                "clientMessageId": client_message_id,
                            }
                            if row["message_accepted"] is False:
                                result.update(
                                    row.get("failure")
                                    or {"code": "message_rejected", "message": "当前权限或用户审批未允许此消息。"}
                                )
                            break
                        if row["phase"] == "outcome_unknown":
                            break
                        await asyncio.sleep(0.01)
            except TimeoutError:
                pass
            if result.get("messageAccepted") is None:
                row = self.app.store.get(
                    "prompt", fingerprint([session_id, client_message_id])
                ) or {}
                if row.get("phase") == "dispatching":
                    # The agent accepted the message and the turn is simply
                    # still running; long turns outlive this call by design.
                    result = {
                        **result,
                        "ok": True,
                        "code": "turn_in_progress",
                        "messageAccepted": True,
                        "message": "消息已送达，回合仍在执行，结果稍后出现在时间线。",
                    }
                else:
                    failure_message = (row.get("failure") or {}).get("message")
                    result = {
                        **result,
                        "ok": False,
                        "code": "operation_outcome_unknown",
                        "message": failure_message
                        or "消息已提交但 Agent 未确认接收：会话可能被模型配额、网络或桌面端中断，请稍后重试。",
                    }
        return RuntimeOperationResult(
            ok=result["ok"], code=result.get("code"), message=result.get("message"), result=result
        )

    def _acquire(self, session_id):
        if session_id in self.leases:
            return  # Already holding the cross-process lease for this session.
        source = self._source(session_id)
        directory = Path.home() / ".cache/agents-anywhere/zcode-native-locks"
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        digest = fingerprint(
            [str(self.history_db_path.resolve()), source["sessionId"]]
        )
        descriptor = os.open(directory / digest, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            if os.name == "nt":
                import msvcrt

                os.write(descriptor, b"0")
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            os.close(descriptor)
            raise AcpError(
                "zcode_source_busy", "另一 AA 执行实例正在使用此原生会话。"
            ) from error
        self.leases[session_id] = descriptor

    def _release(self, session_id):
        descriptor = self.leases.pop(session_id, None)
        if descriptor is not None:
            os.close(descriptor)

    async def _refresh_source(self, session_id):
        source = self._source(session_id)
        history = await asyncio.to_thread(
            read_history, self.history_db_path, source["sessionId"]
        )
        if history.native_id != source["sessionId"] or (
            self.app.store.get("binding", session_id) and history.cwd != source["cwd"]
        ):
            raise AcpError(
                "zcode_source_identity_changed",
                "原生历史身份或工作目录已变化，不能继续原绑定。",
            )
        self.app.store.put(
            "zcode_native_source",
            session_id,
            {
                **history.source(),
                "signature": source.get("signature"),
                "platformSessionId": session_id,
            },
        )
        self._publish_history(session_id, history)
