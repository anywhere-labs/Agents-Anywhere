"""Native Pi history browsing and explicit, sequential CLI ↔ AA handoff."""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import asdict, replace
from pathlib import Path
from uuid import uuid4

from connector.runtime_protocol.models import (
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionState,
)
from connector.runtime_protocol.workflows import RuntimeWorkflowResult

from ...domain.definitions import AcpError, Workspace, fingerprint
from ...domain.operations import require_same_input
from ...domain.sessions import SessionBinding
from ...runtime import AcpRuntime
from .history import discover_history_files, read_history, timeline


class NativePiRuntime(AcpRuntime):
    def __init__(self, *args, prepare_launch, history_roots, **kwargs):
        super().__init__(*args, **kwargs)
        self.prepare_launch = prepare_launch
        self.history_roots = history_roots
        self.environment_lock = asyncio.Lock()
        self.scan_lock = asyncio.Lock()
        self.environment_ready = False
        self.environment_error = None
        self.leases = {}
        self.app.launch_for_session = self._session_launch
        self.app.launch_for_preparation = self._preparation_launch
        self.app.on_context_closed = self._release
        self.app.on_binding_changed = self._publish_native_state

    async def start(self):
        # Starting this Runtime is strictly a read-only history operation.
        await super().start()
        for key, row in self.app.store.items("pi_recovery_operation"):
            if row["result"].get("phase") == "running":
                row["result"] = {
                    "phase": "rejected",
                    "failure": {
                        "code": "pi_recovery_interrupted",
                        "message": "Connector 重启中断了恢复，请查看最新历史并重新确认继续。",
                    },
                }
                self.app.store.put("pi_recovery_operation", key, row)
        await self.scan()
        self.app._job(self._scan_loop())

    async def wait_ready(self, *, revalidate=False):
        async with self.environment_lock:
            if self.environment_ready and not revalidate:
                return
            try:
                self.launch = await self.prepare_launch()
                self.app.launch = self.launch
                self.environment_ready = True
                self.environment_error = None
            except Exception as error:
                self.environment_error = {
                    "code": getattr(error, "code", "pi_environment_failed"),
                    "message": str(error)
                    if isinstance(error, AcpError)
                    else "Pi 执行环境准备失败，请检查安装与网络。",
                }
                raise

    async def _preparation_launch(self):
        await self.wait_ready(revalidate=True)
        return self.launch

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
                await self._check_live_sources()
                await self.scan()
            except Exception as error:  # noqa: BLE001 -- keep browsing when one source becomes unreadable
                self.app.store.put(
                    "pi_scan_error",
                    "latest",
                    {"code": getattr(error, "code", "pi_scan_failed")},
                )
            await asyncio.sleep(1)

    def _source(self, session_id):
        return self.app.store.get("pi_native_source", session_id)

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
            inventory, errors = await asyncio.to_thread(
                discover_history_files, self.history_roots
            )
            duplicates = {}
            for path, entry in inventory.items():
                duplicates.setdefault(entry["id"], []).append(path)
            bound = {
                row["agent_session_id"]: row["session_id"]
                for row in self.app.store.values("binding")
            }
            for path, entry in inventory.items():
                bound_id = bound.get(entry["id"])
                if (
                    bound_id
                    and (known := self._source(bound_id))
                    and known["path"] != str(path)
                ):
                    bound_id = None
                session_id = (
                    bound_id
                    or "pi_native_"
                    + fingerprint([self.config.runtime_id, str(path), entry["id"]])[:40]
                )
                previous = self._source(session_id)
                ambiguous = len(duplicates[entry["id"]]) > 1
                if session_id in self.app.sessions:
                    continue
                if (
                    not force
                    and previous
                    and previous.get("signature") == entry["signature"]
                    and previous.get("publishedRevision") == previous["revision"]
                    and previous.get("ambiguous") == ambiguous
                ):
                    continue
                try:
                    history = await asyncio.to_thread(
                        read_history, path, self.history_roots
                    )
                except (OSError, RuntimeError) as error:
                    errors.append(
                        {
                            "path": str(path),
                            "code": getattr(error, "code", "pi_history_unreadable"),
                        }
                    )
                    continue
                source = history.source()
                source["signature"] = entry["signature"]
                source["publishedRevision"] = (previous or {}).get("publishedRevision")
                source["platformSessionId"] = session_id
                source["ambiguous"] = ambiguous
                self.app.store.put("pi_native_source", session_id, source)
                if source["ambiguous"]:
                    self.app.store.put(
                        "pi_native_failure",
                        session_id,
                        {
                            "code": "pi_source_ambiguous",
                            "message": "多个历史文件具有相同会话身份，请先确认来源。",
                        },
                    )
                else:
                    try:
                        history.require_resumable()
                    except AcpError as error:
                        self.app.store.put(
                            "pi_native_failure",
                            session_id,
                            {"code": error.code, "message": str(error)},
                        )
                    else:
                        old_failure = (
                            self.app.store.get("pi_native_failure", session_id) or {}
                        )
                        if old_failure.get("code") in {
                            "pi_source_missing",
                            "pi_source_unreadable",
                            "pi_source_ambiguous",
                            "pi_history_incomplete",
                            "pi_history_migration_required",
                            "pi_workspace_missing",
                        }:
                            self.app.store.delete("pi_native_failure", session_id)
                if (
                    force
                    or not previous
                    or previous.get("publishedRevision") != source["revision"]
                    or previous.get("ambiguous") != source["ambiguous"]
                ):
                    self._publish_history(
                        session_id, history, reset=force or not previous
                    )
            # Missing/failed roots never imply deletion of other known history.
            for row in self.app.store.values("pi_native_source"):
                known_path = Path(row["path"])
                if (
                    known_path in inventory
                    and inventory[known_path]["id"] != row["sessionId"]
                ):
                    self._failure(
                        row["platformSessionId"],
                        "pi_source_identity_changed",
                        "原位置已是另一原生会话，旧历史仍保留但不能继续原绑定。",
                    )
                if (
                    Path(row["path"]) not in inventory
                    and not Path(row["path"]).exists()
                ):
                    session_id = next(
                        (
                            key
                            for key, value in self._source_rows()
                            if value["path"] == row["path"]
                        ),
                        None,
                    )
                    if session_id:
                        self._failure(
                            session_id,
                            "pi_source_missing",
                            "原生历史来源暂时不可用，已保留浏览内容。",
                        )
                elif known_path not in inventory and any(
                    error.get("path") == str(known_path)
                    or (
                        error.get("root")
                        and known_path.is_relative_to(Path(error["root"]))
                    )
                    for error in errors
                ):
                    self._failure(
                        row["platformSessionId"],
                        "pi_source_unreadable",
                        "原生历史来源当前无法读取，已保留浏览内容。",
                    )
            self.app.store.put("pi_scan_error", "latest", {"errors": errors})

    def _source_rows(self):
        for source in self.app.store.values("pi_native_source"):
            yield source["platformSessionId"], source

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
                        "origin": "pi_native_history",
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
                    # A truncated read cannot downgrade already persisted content.
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
            self.app.store.put("pi_native_source", session_id, source)

    def _failure(self, session_id, code, message):
        failure = {"code": code, "message": message}
        if self.app.store.get("pi_native_failure", session_id) == failure:
            return
        self.app.store.put("pi_native_failure", session_id, failure)
        self._publish_native_state(session_id)

    def _publish_native_state(self, session_id):
        source = self._source(session_id)
        if not source:
            return
        binding = self.app.store.get("binding", session_id)
        state = (
            self.app.state(session_id)
            if binding
            else {
                "sessionId": session_id,
                "externalSessionId": source["sessionId"],
                "status": "blocked",
                "statusReason": "pi_continue_required",
                "selections": {},
                "metadata": {},
            }
        )
        failure = self.app.store.get("pi_native_failure", session_id)
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
                metadata={"origin": "pi_native_history", **self._metadata(key, source)},
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
        state = (
            await super().get_session_state(session_id, external_session_id)
            if row
            else SessionState(
                session_id=session_id,
                external_session_id=source["sessionId"],
                runtime=self.config.runtime,
                status="blocked",
                status_reason="pi_continue_required",
            )
        )
        failure = self.app.store.get("pi_native_failure", session_id)
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
        failure = self.app.store.get("pi_native_failure", session_id)
        metadata = self._metadata(session_id, source)
        if failure:
            metadata["reasonMessage"] = failure["message"]
        blocked_source = failure and failure["code"] in {
            "pi_source_missing",
            "pi_source_unreadable",
            "pi_source_identity_changed",
            "pi_source_ambiguous",
            "pi_history_incomplete",
            "pi_history_migration_required",
            "pi_workspace_missing",
        }
        caps = [cap for cap in caps if cap.capability_id != "session.recover"]
        if not row:
            caps.append(
                RuntimeCapability(
                    capability_id="session.send_message",
                    scope="session",
                    runtime=self.config.runtime,
                    session_id=session_id,
                    available=False,
                    unavailable_reason="pi_continue_required",
                )
            )
        caps.append(
            RuntimeCapability(
                capability_id="session.recover",
                scope="session",
                runtime=self.config.runtime,
                session_id=session_id,
                available=not ready
                and not source.get("ambiguous")
                and not blocked_source,
                unavailable_reason=failure["code"]
                if failure
                else "pi_continue_required",
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
        for key, _source in self._source_rows():
            if not session_id or key == session_id:
                self._publish_native_state(key)
        await self.sync.flush()

    async def execute_workflow(self, request):
        values = dict(request.values)
        if request.operation == "recover_session" and self._source(values["sessionId"]):
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
        if request.operation == "close_session" and self._source(values["sessionId"]):
            await self._refresh_source(values["sessionId"])
        return result

    async def _begin_resume(self, values):
        session_id = values["sessionId"]
        key = fingerprint([session_id, values["operationId"]])
        digest = fingerprint(values)
        previous = self.app.store.get("pi_recovery_operation", key)
        if previous:
            require_same_input(previous["digest"], digest)
            return previous["result"]
        source = self._source(session_id)
        if values.get("cliExited") is not True:
            raise AcpError(
                "pi_cli_exit_required", "请先退出 CLI 中对应会话，并确认后继续。"
            )
        if (
            values.get("expectedGeneration")
            != self._metadata(session_id, source)["ownerGeneration"]
        ):
            raise AcpError("owner_changed", "会话执行者已变化，请刷新。")
        if session_id in self.app.sessions:
            raise AcpError("pi_session_already_running", "此会话已在 AA 执行。")
        if source.get("ambiguous"):
            raise AcpError(
                "pi_source_ambiguous", "多个历史文件具有相同会话身份，请先确认来源。"
            )
        history = await asyncio.to_thread(
            read_history, Path(source["path"]), self.history_roots
        )
        history.require_resumable()
        if (
            values.get("sourceRevision") != source["revision"]
            or history.revision != source["revision"]
        ):
            await self._refresh_source(session_id)
            raise AcpError(
                "pi_source_changed", "历史已变化，请查看最新内容后重新继续。"
            )
        self._acquire(session_id, history.path)
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
                    history.native_id,
                    attachment="recovery_required",
                )
            )
            self.app.store.put("binding", session_id, binding)
        result = {"operationId": values["operationId"], "phase": "running"}
        self.app.store.put(
            "pi_recovery_operation", key, {"digest": digest, "result": result}
        )
        self.app.store.delete("pi_native_failure", session_id)
        self.app._job(self._resume_job(session_id, key, digest))
        return result

    async def _resume_job(self, session_id, key, digest):
        try:
            state = await self.app.recover(session_id)
            client = self.app.sessions[session_id]["client"]
            file = client.native_files.get(self._source(session_id)["sessionId"])
            if (
                not file
                or Path(file).resolve()
                != Path(self._source(session_id)["path"]).resolve()
            ):
                raise AcpError(
                    "pi_source_mismatch", "恢复返回的原生历史位置不匹配，已停止执行。"
                )
            result = {
                "operationId": self.app.store.require("pi_recovery_operation", key)[
                    "result"
                ]["operationId"],
                "phase": "completed",
                "state": state,
            }
        except Exception as error:  # noqa: BLE001 -- persist a concrete recovery failure without source secrets
            context = self.app.sessions.get(session_id)
            if context:
                await self.app._close_context(context)
            self._release(session_id)
            failure = self.environment_error or {
                "code": error.code
                if isinstance(error, AcpError)
                else "pi_resume_failed",
                "message": str(error)
                if isinstance(error, AcpError)
                else "Pi 恢复失败，请检查原生模型、认证与扩展兼容性。",
            }
            self._failure(session_id, **failure)
            result = {"phase": "rejected", "failure": failure}
        self.app.store.put(
            "pi_recovery_operation", key, {"digest": digest, "result": result}
        )
        self._publish_native_state(session_id)

    async def _session_launch(self, session_id):
        await self.wait_ready(revalidate=True)
        source = self._source(session_id)
        if not source:
            return self.launch
        history = await asyncio.to_thread(
            read_history, Path(source["path"]), self.history_roots
        )
        history.require_resumable()
        if history.revision != source["revision"]:
            raise AcpError(
                "pi_source_changed", "恢复准备期间原生历史已变化，请重新校准。"
            )
        env = dict(self.launch.environment)
        state_file = self.app.root / ("pi-writes-" + fingerprint(session_id) + ".json")
        state_file.unlink(missing_ok=True)
        env.update(
            AA_PI_SESSION_FILE=str(history.path),
            AA_PI_SESSION_ID=history.native_id,
            AA_PI_SOURCE_REVISION=history.revision,
            AA_PI_WRITE_STATE=str(state_file),
        )
        return replace(self.launch, environment=tuple(env.items()))

    def _acquire(self, session_id, path):
        directory = Path.home() / ".cache/agents-anywhere/pi-native-locks"
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(
            directory / fingerprint(str(path.resolve())), os.O_RDWR | os.O_CREAT, 0o600
        )
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
                "pi_source_busy", "另一 AA 执行实例正在使用此原生会话。"
            ) from error
        self.leases[session_id] = descriptor

    def _release(self, session_id):
        descriptor = self.leases.pop(session_id, None)
        if descriptor is not None:
            os.close(descriptor)

    async def _check_live_sources(self):
        for session_id in list(self.app.sessions):
            if not self._source(session_id):
                continue
            try:
                await self._check_source(session_id)
                if session_id not in self.app.active_runs:
                    history = await asyncio.to_thread(
                        read_history,
                        Path(self._source(session_id)["path"]),
                        self.history_roots,
                    )
                    if history.revision != self._source(session_id)["revision"]:
                        await self._refresh_source(session_id)
                        context = self.app.sessions.get(session_id)
                        if context:
                            context["projection"].items = {
                                item["id"]: item
                                for item in self.app.store.values("projection")
                                if item["sessionId"] == session_id
                            }
            except (AcpError, OSError):
                self._failure(
                    session_id,
                    "pi_source_conflict",
                    "检测到原生历史来源变化，已停止 AA 执行；请退出并发 CLI 后重新校准。",
                )
                context = self.app.sessions.get(session_id)
                if context:
                    await self.app._close_context(context)
                await self._refresh_source(session_id)

    async def _check_source(self, session_id):
        source = self._source(session_id)
        state_file = self.app.root / ("pi-writes-" + fingerprint(session_id) + ".json")
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise AcpError(
                "pi_writer_unavailable", "原生历史写入校验尚未就绪。"
            ) from error
        history = await asyncio.to_thread(
            read_history, Path(source["path"]), self.history_roots
        )
        if (
            state.get("conflict")
            or state.get("revision") != history.revision
            or history.native_id != source["sessionId"]
        ):
            # Own write and atomic sidecar replacement may straddle this read.
            await asyncio.sleep(0.05)
            state = json.loads(state_file.read_text(encoding="utf-8"))
            history = await asyncio.to_thread(
                read_history, Path(source["path"]), self.history_roots
            )
            if (
                state.get("conflict")
                or state.get("revision") != history.revision
                or history.native_id != source["sessionId"]
            ):
                raise AcpError("pi_source_conflict", "原生历史已被外部修改。")

    async def _refresh_source(self, session_id):
        source = self._source(session_id)
        history = await asyncio.to_thread(
            read_history, Path(source["path"]), self.history_roots
        )
        if history.native_id != source["sessionId"] or (
            self.app.store.get("binding", session_id) and history.cwd != source["cwd"]
        ):
            raise AcpError(
                "pi_source_identity_changed",
                "原生历史身份或工作目录已变化，不能继续原绑定。",
            )
        self.app.store.put(
            "pi_native_source",
            session_id,
            {
                **history.source(),
                "platformSessionId": session_id,
                "ambiguous": source.get("ambiguous", False),
            },
        )
        self._publish_history(session_id, history)

    async def start_turn(self, session_id, *args, **kwargs):
        if self._source(session_id):
            await self._check_source(session_id)
        return await super().start_turn(session_id, *args, **kwargs)

    async def execute_command(self, session_id, *args, **kwargs):
        if self._source(session_id):
            await self._check_source(session_id)
        return await super().execute_command(session_id, *args, **kwargs)
