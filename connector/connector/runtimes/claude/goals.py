"""Claude native goal commands plus read-only structured transcript projection."""

import asyncio
import copy
import json
import os
import re
from pathlib import Path

from connector.goals.service import GoalRejected, now
from connector.runtimes.claude.sdk.stderr import ClaudeStderrBuffer


class ClaudeGoalPort:
    def __init__(self, runtime):
        self.runtime = runtime
        self.errors = {}
        self.paths = {}
        self.unavailable = {}
        self.limits = {}

    def is_control_message(self, message):
        if getattr(message, "model", None) != "<synthetic>":
            return False
        text = "\n".join(
            getattr(block, "text", "") for block in getattr(message, "content", [])
        ).strip()
        return text.startswith(("Goal set:", "Goal cleared", "No active goal"))

    def rejection(self, sid):
        return self.errors.pop(sid, None)

    def observe_message(self, sid, message):
        subtype = getattr(message, "subtype", None)
        if subtype in {"error_max_budget_usd", "error_max_turns"}:
            state = self.runtime.goals.states.get(sid, {}) if self.runtime.goals else {}
            self.limits[sid] = (
                state.get("_nativeIdentity"),
                "budgetLimited" if subtype == "error_max_budget_usd" else "blocked",
                subtype,
            )
        if getattr(message, "model", None) != "<synthetic>":
            return
        for block in getattr(message, "content", []):
            text = getattr(block, "text", "")
            if "goal" in text.lower() and any(
                word in text.lower()
                for word in (
                    "can't run",
                    "cannot",
                    "not available",
                    "restricted",
                    "too long",
                    "disabled",
                    "unknown",
                )
            ):
                self.errors[sid] = text
                self.unavailable[sid] = text

    async def available(self, sid, eid=None):
        return bool(self.runtime.sdk_loader) and sid not in self.unavailable

    def path(self, sid, eid):
        if not eid or not re.fullmatch(r"[a-zA-Z0-9_-]+", eid):
            return None
        env = self.runtime.config.values.get("environment") or {}
        root = (
            Path(
                env.get("CLAUDE_CONFIG_DIR")
                or os.environ.get("CLAUDE_CONFIG_DIR")
                or Path.home() / ".claude"
            )
            / "projects"
        )
        existing = self.paths.get(eid)
        if existing and existing.is_file():
            return existing
        session = self.runtime._session_store.get(sid)
        if session and session.cwd:
            slug = re.sub(r"[^a-zA-Z0-9]", "-", str(Path(session.cwd).resolve()))
            candidate = root / slug / (eid + ".jsonl")
            if candidate.is_file():
                self.paths[eid] = candidate
                return candidate
        matches = list(root.glob("*/" + eid + ".jsonl"))
        if len(matches) == 1:
            self.paths[eid] = matches[0]
            return matches[0]
        return None

    def read_log(self, sid, eid, state):
        path = self.path(sid, eid)
        if path is None:
            return None
        store = self.runtime.goals.store
        cursor = store.cursor(sid) or {}
        stat = path.stat()
        identity = f"{stat.st_dev}:{stat.st_ino}"
        offset = (
            cursor.get("offset", 0)
            if cursor.get("file") == identity
            and stat.st_size >= cursor.get("offset", 0)
            else 0
        )
        if offset and offset == stat.st_size:
            return copy.deepcopy(cursor.get("projection", {"empty": True}))
        nodes = cursor.get("nodes", {}) if offset else {}
        anchor = cursor.get("branchAnchor") if offset else None
        with path.open("rb") as stream:
            stream.seek(offset)
            while True:
                start = stream.tell()
                line = stream.readline()
                if not line:
                    break
                if not line.endswith(b"\n"):
                    stream.seek(start)
                    break
                try:
                    entry = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    raise RuntimeError("goal_log_invalid") from None
                if entry.get("isSidechain") or not entry.get("uuid"):
                    continue
                uid = entry["uuid"]
                node = {"parent": entry.get("parentUuid")}
                attachment = entry.get("attachment") or {}
                if attachment.get("type") == "goal_status":
                    if not isinstance(
                        attachment.get("condition"), str
                    ) or not isinstance(attachment.get("met"), bool):
                        raise TypeError("goal_log_format_unsupported")
                    node.update(
                        attachment=attachment, timestamp=entry.get("timestamp") or now()
                    )
                if uid in nodes:
                    if nodes[uid] != node:
                        raise ValueError("goal_log_event_identity_conflict")
                    continue
                nodes[uid] = node
                anchor = uid
            offset = stream.tell()
        # Reconstruct only the current ancestry. Appended fork/rewind records must not
        # inherit a goal from an abandoned branch; UUIDs also deduplicate log replay.
        ancestry, seen = [], set()
        uid = anchor
        while uid and uid in nodes:
            if uid in seen:
                raise ValueError("goal_log_branch_cycle")
            seen.add(uid)
            node = nodes[uid]
            if "attachment" in node:
                ancestry.append((uid, node))
            uid = node["parent"]
        result = {"empty": True}
        for uid, node in reversed(ancestry):
            attachment, stamp = node["attachment"], node["timestamp"]
            if attachment.get("sentinel") and attachment["met"]:
                result = {"empty": True}
                continue
            previous = result.get("goal") or {}
            goal = {
                "objective": attachment["condition"],
                "status": "failed"
                if attachment.get("failed")
                else "complete"
                if attachment["met"]
                else "active",
                "createdAt": stamp
                if attachment.get("sentinel")
                else previous.get("createdAt", stamp),
                "updatedAt": stamp,
                "nativeIdentity": uid
                if attachment.get("sentinel")
                else previous.get("nativeIdentity"),
            }
            for source, target in [
                ("reason", "lastReason"),
                ("iterations", "iterations"),
                ("tokens", "tokensUsed"),
            ]:
                if attachment.get(source) is not None:
                    goal[target] = attachment[source]
            if attachment.get("durationMs") is not None:
                goal["timeUsedSeconds"] = max(0, int(attachment["durationMs"] // 1000))
            if goal["status"] in {"complete", "failed"}:
                goal["endedAt"] = stamp
            result = {"goal": goal}
        return {
            **result,
            "cursor": {
                "file": identity,
                "offset": offset,
                "branchAnchor": anchor,
                "nodes": nodes,
                "projection": copy.deepcopy(result),
            },
        }

    async def read(self, sid, eid, state):
        session = self.runtime._session_store.get(sid)
        if session and session.external_session_id:
            eid = session.external_session_id
            state["externalSessionId"] = eid
        result = await asyncio.to_thread(self.read_log, sid, eid, state)
        if result is None:
            if eid:
                return None
            return {"empty": True, "actions": ["set"]}
        if session and session.execution:
            state["_lastGoalTurn"] = session.execution.turn_id
        if result.get("goal") and state.get("_lastGoalTurn"):
            result["goal"]["sourceTurnId"] = state["_lastGoalTurn"]
        result["actions"] = (
            []
            if sid in self.unavailable
            else ["set", "edit", "pause", "resume", "clear"]
        )
        if sid in self.unavailable:
            result["reason"] = self.unavailable[sid]
        goal = result.get("goal")
        limit = self.limits.get(sid)
        if (
            goal
            and limit
            and goal.get("nativeIdentity") == limit[0]
            and goal["status"] == "active"
        ):
            goal["status"], goal["lastReason"] = limit[1], limit[2]
            if limit[1] == "budgetLimited":
                result["actions"] = [
                    action for action in result["actions"] if action != "resume"
                ]
        return result

    async def finalize(self, sid, eid):
        await self.clear_native(sid, eid)

    async def clear_native(self, sid, eid):
        session = self.runtime._turns.actions.session_for(sid, eid, None)
        connection = await self.runtime._turns.runner.connection_for(
            session, ClaudeStderrBuffer(sid)
        )
        await connection.connect()
        for _ in range(100):
            if connection.current is None:
                break
            await asyncio.sleep(0.02)
        if connection.current is not None:
            raise RuntimeError("goal_execution_not_quiescent")
        response = connection.response_for(None)
        response.maintenance = True
        # Local slash commands do not consistently echo the caller-supplied user UUID.
        # Select the pending maintenance response on their first SDK output.
        response.user_id = None
        try:
            await response.query("/goal clear")
            async with asyncio.timeout(15):
                async for message in response.receive_response():
                    self.observe_message(sid, message)
            if sid in self.errors:
                raise RuntimeError(self.errors[sid])
        finally:
            response.release()

    def validate(self, request, state):
        if request.get("objective") is not None and len(request["objective"]) > 4000:
            raise ValueError("claude_goal_objective_too_long")

    async def interrupt(self, sid):
        await self.runtime._turns.interrupt_session(session_id=sid, reason="goal_stop")

    async def execute(self, sid, eid, request, state):
        if request["action"] in {"set", "edit", "resume"} and state.get(
            "_stopRequested"
        ):
            raise GoalRejected("goal_stopped")
        action = request["action"]
        self.errors.pop(sid, None)
        self.limits.pop(sid, None)
        current = await self.read(sid, eid, state)
        if action in {"pause", "clear"} and current and current.get("empty"):
            return True
        if action in {"pause", "clear", "edit"} or (
            action == "set" and state.get("goal")
        ):
            await self.runtime._turns.interrupt_session(
                session_id=sid, reason="goal_control"
            )
            # Let the shared stream release the interrupted response first.
            connection = self.runtime._turns.runner.connections.get(sid)
            for _ in range(100):
                if connection is None or connection.current is None:
                    break
                await asyncio.sleep(0.02)
            if not (current and current.get("empty")):
                await self.clear_native(sid, eid)
            if action in {"pause", "clear"}:
                return True
        if state.get("_stopRequested"):
            raise GoalRejected("goal_stopped")
        objective = (
            request.get("objective")
            or state.get("_submittedObjective")
            or state["goal"]["objective"]
        )
        if len(objective) > 4000:
            raise ValueError("claude_goal_objective_too_long")
        result = await self.runtime.start_turn(
            sid, eid, "/goal " + objective, client_message_id=request["operationId"]
        )
        if not result.ok:
            raise GoalRejected(result.message or result.code or "goal_native_rejected")
        return False  # Only a goal_status record confirms acceptance.
