from __future__ import annotations

from connector.planning.infrastructure.submission import submit
from connector.runtime_protocol.planning import NativePlanningResult
from connector.runtimes.claude.domain.approvals import ClaudeApprovalDecision
from connector.runtimes.claude.domain.permissions import (
    _selection_id,
    permission_mode_from_selection_id,
)


class ClaudePlanningPort:
    content_streaming = "native_delta"

    def __init__(self, runtime):
        self.runtime = runtime
        self.previous: dict[str, str | None] = {}
        import os
        from pathlib import Path

        environment = runtime.config.values.get("environment") or {}
        root = environment.get("CLAUDE_CONFIG_DIR") or os.environ.get(
            "CLAUDE_CONFIG_DIR"
        )
        runtime.host.__dict__["_claude_plan_root"] = (
            Path(root).expanduser() if root else Path.home() / ".claude"
        ) / "plans"

    async def available(self, session_id, external_id):
        if not session_id:
            from connector.runtimes.claude.sdk.client import load_sdk

            sdk = load_sdk(self.runtime.sdk_loader)
            return callable(
                getattr(
                    getattr(sdk, "ClaudeSDKClient", None), "set_permission_mode", None
                )
            )
        session = self.runtime._session_store.get(session_id)
        return session is not None

    async def read_mode(self, session_id, external_id):
        session = self.runtime._session_store.get(session_id)
        connection = self.runtime._turns.runner.connections.get(session_id)
        if (
            session is None
            or not session.planning_observed
            or connection is None
            or connection.closing
            or connection.failure is not None
        ):
            return "unknown"
        return (
            "plan"
            if session.planning_mode
            or permission_mode_from_selection_id(session.selections.get("permission"))
            == "plan"
            else "normal"
        )

    async def change_mode(self, session_id, external_id, mode):
        session = self.runtime._session_store.get(session_id)
        if session is None:
            return NativePlanningResult(
                outcome="rejected", code="native_session_required"
            )
        selection = session.selections.get("permission")
        if mode == "plan":
            if permission_mode_from_selection_id(selection) != "plan":
                self.previous[session_id] = selection
            target = selection
            native_mode = "plan"
        else:
            target = (
                (self.previous.get(session_id) or _selection_id("default"))
                if permission_mode_from_selection_id(selection) == "plan"
                else selection
            )
            native_mode = permission_mode_from_selection_id(target) or "default"
        session.planning_observed = False
        connection = self.runtime._turns.runner.connections.get(session_id)
        if connection is None:
            session.planning_mode = mode == "plan"
            from connector.runtimes.claude.sdk.stderr import ClaudeStderrBuffer

            connection = await self.runtime._turns.runner.connection_for(
                session, ClaudeStderrBuffer(session_id)
            )
        if connection:
            await connection.connect()
            setter = getattr(connection.client, "set_permission_mode", None)
            if not callable(setter):
                return NativePlanningResult(
                    outcome="rejected", code="claude_plan_control_unavailable"
                )
            await setter(native_mode)  # Control response ACK, not an SDK query.
            connection.selections["permission"] = target
        session.selections["permission"] = target
        session.planning_mode = mode == "plan"
        session.planning_observed = True
        cached = self.runtime._session_states.get(session_id)
        if cached and cached.selections != session.selections:
            await self.runtime._notifications.session_state.session_state_update(
                session, cached.status, selections=session.selections
            )
        return NativePlanningResult(mode=mode)

    async def submit(self, session_id, external_id, request):
        return await submit(self.runtime, session_id, external_id, request)

    async def review_is_current(self, session_id, external_id, proposal, native):
        future = self.runtime._turns.interactions._interaction_futures.get(
            (native or {}).get("noticeId")
        )
        return future is not None and not future.done()

    async def review(
        self, session_id, external_id, proposal, native, action, feedback, operation_id
    ):
        interactions = self.runtime._turns.interactions
        notice_id = (native or {}).get("noticeId")
        future = interactions._interaction_futures.get(notice_id)
        if future is None or future.done():
            return NativePlanningResult(
                outcome="rejected", code="claude_plan_review_expired"
            )
        approved = action == "approve_and_execute"
        session = self.runtime._session_store.get(session_id)
        target_permission = session.selections.get("permission")
        if permission_mode_from_selection_id(target_permission) == "plan":
            target_permission = self.previous.get(session_id) or _selection_id(
                "default"
            )
        restored_mode = (
            permission_mode_from_selection_id(target_permission) or "default"
        )
        # The user's explicit permission policy remains separate from plan consent.
        decision = ClaudeApprovalDecision(
            allowed=approved,
            action_id=action,
            message=feedback or "用户关闭了计划审阅。",
            updated_permissions=(
                {"type": "setMode", "mode": restored_mode, "destination": "session"},
            )
            if approved
            else (),
            interrupt=action == "dismiss_review",
            updated_input={
                **(native or {}).get("toolInput", {}),
                "plan": proposal["markdown"],
            }
            if approved
            else None,
        )
        if approved:
            from connector.planning.domain.session import content_hash
            from connector.runtime_protocol.planning import PlanningObservation

            body = await native_plan_document(self.runtime.host, session_id)
            if body is None and (native or {}).get("toolInput", {}).get("planFilePath"):
                return NativePlanningResult(
                    outcome="rejected",
                    code="plan_document_unavailable",
                    message="原生计划文件当前不可读，请恢复后重新审阅。",
                )
            if body is not None and content_hash(body) != proposal["contentHash"]:
                await self.runtime.host.observe_planning(
                    PlanningObservation(
                        session_id=session_id,
                        kind="proposal",
                        native_id=str(
                            getattr(self.runtime.host, "_claude_plan_paths", {}).get(
                                session_id
                            )
                        ),
                        text=body,
                        native_review=native,
                    )
                )
                return NativePlanningResult(
                    outcome="rejected",
                    code="plan_document_changed",
                    message="原生计划正文已经变化，请审阅新版本。",
                )
        future.set_result(decision)
        if approved:
            session = self.runtime._session_store.get(session_id)
            session.planning_mode = False
            session.planning_observed = True
            session.selections["permission"] = target_permission
            connection = self.runtime._turns.runner.connections.get(session_id)
            if connection:
                connection.selections["permission"] = session.selections["permission"]
        return NativePlanningResult(
            mode="normal" if approved else "plan",
            execution="accepted" if approved else "not_requested",
        )


async def observe_claude_plan(host, session, turn_id, message):
    from pathlib import Path

    from connector.planning.domain.partial_json import partial_string
    from connector.runtime_protocol.planning import PlanningObservation

    data = getattr(message, "data", None)
    if isinstance(data, dict) and data.get("permissionMode") in {
        "plan",
        "default",
        "acceptEdits",
        "auto",
        "dontAsk",
        "bypassPermissions",
    }:
        session.planning_mode = data["permissionMode"] == "plan"
        session.planning_observed = True
        await host.observe_planning(
            PlanningObservation(
                session_id=session.session_id,
                kind="mode",
                mode="plan" if session.planning_mode else "normal",
                external_session_id=session.external_session_id,
            )
        )
    for block in getattr(message, "content", ()) or ():
        if getattr(block, "name", None) == "Write" and isinstance(
            getattr(block, "input", None), dict
        ):
            remember_native_plan_path(
                host, session.session_id, block.input.get("file_path")
            )
    event = getattr(message, "event", None)
    if (
        isinstance(event, dict)
        and event.get("type") == "content_block_delta"
        and not session.planning_mode
    ):
        await host.observe_planning(
            PlanningObservation(session_id=session.session_id, kind="execution")
        )
    if not isinstance(event, dict):
        return
    streams = host.__dict__.setdefault("_claude_plan_streams", {})
    key = (session.session_id, event.get("index"))
    if event.get("type") == "content_block_start":
        block = event.get("content_block") or {}
        if block.get("type") == "tool_use":
            streams[key] = {
                "id": block.get("id", turn_id),
                "name": block.get("name"),
                "json": "",
            }
    elif (
        event.get("type") == "content_block_delta"
        and (event.get("delta") or {}).get("type") == "input_json_delta"
    ):
        block = streams.get(key)
        if not block:
            return
        block["json"] += event["delta"].get("partial_json", "")
        if len(block["json"]) > 4 * 1024 * 1024:
            streams.pop(key, None)
            await host.observe_planning(
                PlanningObservation(session_id=session.session_id, kind="interrupted")
            )
            return
        text = (
            partial_string(block["json"], "plan")
            if block["name"] == "ExitPlanMode"
            else None
        )
        if block["name"] in {"Write", "write_file"}:
            path = partial_string(block["json"], "file_path")
            if path and Path(path).expanduser().resolve().is_relative_to(
                getattr(
                    host, "_claude_plan_root", Path.home() / ".claude" / "plans"
                ).resolve()
            ):
                text = partial_string(block["json"], "content")
                if text is not None:
                    remember_native_plan_path(host, session.session_id, path)
        if text is not None:
            await host.observe_planning(
                PlanningObservation(
                    session_id=session.session_id,
                    kind="draft",
                    native_id=str(
                        getattr(host, "_claude_plan_paths", {}).get(session.session_id)
                        or block["id"]
                    ),
                    text=text,
                    external_session_id=session.external_session_id,
                    source_turn_id=turn_id,
                )
            )
    elif event.get("type") == "message_stop":
        for current in [key for key in streams if key[0] == session.session_id]:
            streams.pop(current, None)


def remember_native_plan_path(host, session_id, path):
    from pathlib import Path

    if not isinstance(path, str):
        return
    file = Path(path).expanduser().resolve()
    root = getattr(
        host, "_claude_plan_root", Path.home() / ".claude" / "plans"
    ).resolve()
    if file.is_relative_to(root):
        host.__dict__.setdefault("_claude_plan_paths", {})[session_id] = file


async def native_plan_document(host, session_id):
    import asyncio

    path = getattr(host, "_claude_plan_paths", {}).get(session_id)
    if path is None:
        return None

    def read():
        from pathlib import Path

        resolved = path.resolve(strict=True)
        root = getattr(
            host, "_claude_plan_root", Path.home() / ".claude" / "plans"
        ).resolve()
        if not resolved.is_relative_to(root):
            return None
        with resolved.open(encoding="utf-8") as file:
            text = file.read(2 * 1024 * 1024 + 1)
        return text if len(text.encode("utf-8")) <= 2 * 1024 * 1024 else None

    try:
        return await asyncio.to_thread(read)
    except (OSError, UnicodeError):
        return None


async def observe_claude_tool_result(host, session, data):
    from connector.runtime_protocol.planning import PlanningObservation

    if data.get("tool_name") not in {"Write", "Edit", "EnterPlanMode", "ExitPlanMode"}:
        return None
    if data.get("tool_name") == "EnterPlanMode":
        session.planning_mode = True
        session.planning_observed = True
        await host.observe_planning(
            PlanningObservation(session_id=session.session_id, kind="mode", mode="plan")
        )
        return None
    input_data = data.get("tool_input") or {}
    if session.planning_mode:
        remember_native_plan_path(host, session.session_id, input_data.get("file_path"))
    if data.get("tool_name") == "ExitPlanMode":
        output = data.get("tool_response")
        if (
            isinstance(output, dict)
            and not output.get("isAgent")
            and not output.get("awaitingLeaderApproval")
        ):
            actual = output.get("plan")
            if (
                isinstance(actual, str)
                and actual.strip()
                and not await host.validate_planning_document(
                    session.session_id, actual
                )
            ):
                # Stop before another native model step can implement an unseen edit.
                await host.observe_planning(
                    PlanningObservation(
                        session_id=session.session_id,
                        kind="proposal",
                        native_id=str(
                            getattr(host, "_claude_plan_paths", {}).get(
                                session.session_id
                            )
                            or input_data.get("tool_use_id", "external_plan")
                        ),
                        text=actual,
                    )
                )
                await host.observe_planning(
                    PlanningObservation(
                        session_id=session.session_id, kind="review_closed"
                    )
                )
                await host.observe_planning(
                    PlanningObservation(
                        session_id=session.session_id, kind="mode", mode="unknown"
                    )
                )
                return {
                    "continue_": False,
                    "stopReason": "实际原生计划正文与已批准版本不同，请重新规划并审阅。",
                }
        return None
    if session.planning_mode:
        body = await native_plan_document(host, session.session_id)
        if body:
            await host.observe_planning(
                PlanningObservation(
                    session_id=session.session_id,
                    kind="draft",
                    native_id=str(
                        getattr(host, "_claude_plan_paths", {}).get(session.session_id)
                    ),
                    text=body,
                )
            )
    return None
