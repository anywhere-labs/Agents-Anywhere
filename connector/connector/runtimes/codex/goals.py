import asyncio
from datetime import UTC, datetime

from openai_codex import JsonRpcError, MethodNotFoundError
from pydantic import BaseModel, ConfigDict

from connector.goals.service import GoalRejected
from connector.runtimes.codex.sdk.client import codex_low_level_client
from connector.runtimes.codex.sdk.runtime_client import CodexResumeThreadRequest


class GoalReply(BaseModel):
    model_config = ConfigDict(extra="allow")
    goal: dict | None = None


class CodexGoalPort:
    def __init__(self, runtime):
        self.runtime = runtime
        self._checked_client = None
        self._supported = False

    def low(self):
        return codex_low_level_client(getattr(self.runtime.client, "_client", None))

    def followed(self, eid):
        service = self.runtime.ipc_service
        return service.follower.get(eid) if service and eid else None

    async def available(self, sid, eid=None):
        if self.followed(eid) is not None:
            return True
        low = self.low()
        if low is None:
            return False
        if self._checked_client is low:
            return self._supported
        try:
            async with asyncio.timeout(2):
                await self.request(
                    "thread/goal/get", eid or "00000000-0000-0000-0000-000000000000"
                )
            supported = True
        except MethodNotFoundError:
            supported = False
        except JsonRpcError as error:
            supported = error.code != -32601 and not any(
                reason in str(error).lower()
                for reason in ("disabled", "not enabled", "requires experimentalapi")
            )
        except (RuntimeError, TimeoutError):
            return False
        self._checked_client, self._supported = low, supported
        return supported

    async def request(self, method, eid, **values):
        low = self.low()
        if low is None:
            raise RuntimeError("goal_api_unavailable")
        try:
            result = await low.request(
                method, {"threadId": eid, **values}, response_model=GoalReply
            )
        except JsonRpcError as error:
            if method != "thread/goal/get":
                raise GoalRejected(str(error)) from error
            raise
        return result.model_dump() if hasattr(result, "model_dump") else result

    def observe_turns(self, eid):
        # Goal continuations are native background turns. Reuse the SDK router's
        # command-turn observation, which leaves ordinary user-turn streams alone.
        observe = getattr(self.runtime.client, "_observe_command_thread", None)
        if callable(observe):
            observe(eid)

    async def read(self, sid, eid, state):
        if not eid:
            return None
        self.observe_turns(eid)
        followed = self.followed(eid)
        if followed and followed.status != "no_owner":
            if followed.status != "following":
                raise RuntimeError("goal_owner_unavailable")
            native = (followed.state or {}).get("threadGoal")
            actions = []
        else:
            reply = await self.request("thread/goal/get", eid)
            native = reply.get("goal")
            actions = ["set", "edit", "pause", "resume", "clear"]
        if not native:
            return {"empty": True, "actions": actions}

        def iso(value):
            return (
                datetime.fromtimestamp(value, UTC).isoformat()
                if isinstance(value, (int, float))
                else value
            )

        if native["status"] == "complete" and self.runtime._active_turn_ids.get(sid):
            # The native goal tool can complete before the final assistant reply.
            # Publish its outcome only once that reply's native turn has finished.
            return {"deferOutcome": True, "terminal": True, "actions": []}
        goal = {
            "objective": native["objective"],
            "status": native["status"],
            "createdAt": iso(native.get("createdAt"))
            or (state.get("goal") or {}).get("createdAt"),
            "updatedAt": iso(native.get("updatedAt")),
        }
        for key in ("tokensUsed", "tokenBudget", "timeUsedSeconds", "lastReason"):
            if native.get(key) is not None:
                goal[key] = native[key]
        # createdAt is stable on edit and changes when a native target is replaced.
        turn_id = self.runtime._active_turn_ids.get(sid)
        if turn_id:
            state["_lastGoalTurn"] = turn_id
        if state.get("_lastGoalTurn"):
            goal["sourceTurnId"] = state["_lastGoalTurn"]
        goal["nativeIdentity"] = str(native.get("createdAt"))
        if native["status"] in {"budgetLimited", "complete"}:
            actions = [a for a in actions if a != "resume"]
        return {"goal": goal, "actions": actions}

    async def interrupt(self, sid):
        await self.runtime._turns.interrupt_session(session_id=sid, reason="goal_stop")

    async def execute(self, sid, eid, request, state):
        if request["action"] in {"set", "edit", "resume"} and state.get(
            "_stopRequested"
        ):
            raise GoalRejected("goal_stopped")
        if self.followed(eid) and self.followed(eid).status != "no_owner":
            raise RuntimeError("goal_external_owner_read_only")
        await self.runtime.client.ensure_thread_resumed(
            self.low(), CodexResumeThreadRequest(thread_id=eid)
        )
        self.observe_turns(eid)
        if request["action"] in {"set", "edit", "resume"} and state.get(
            "_stopRequested"
        ):
            raise GoalRejected("goal_stopped")
        action = request["action"]
        if action == "clear":
            await self.request("thread/goal/clear", eid)
        elif action in {"set", "edit"}:
            if action == "set" and state.get("goal"):
                await self.request("thread/goal/clear", eid)
            if state.get("_stopRequested"):
                raise GoalRejected("goal_stopped")
            await self.request(
                "thread/goal/set", eid, objective=request["objective"], status="active"
            )
        else:
            await self.request(
                "thread/goal/set",
                eid,
                status="paused" if action == "pause" else "active",
            )
        return True

    async def finalize(self, sid, eid):
        if not self.followed(eid):
            await self.request("thread/goal/clear", eid)
