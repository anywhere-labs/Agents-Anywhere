"""Unified goal lifecycle. Runtime-specific behavior is confined to ports."""

import asyncio
import copy
import hashlib
import json
from datetime import UTC, datetime
from uuid import uuid4

from connector.logging import logger

ACTIONS = ["set", "edit", "pause", "resume", "clear"]
TERMINAL = {"complete", "failed", "cleared", "replaced"}


def now():
    return datetime.now(UTC).isoformat()


def public(state):
    return {k: copy.deepcopy(v) for k, v in state.items() if not k.startswith("_")}


class GoalRejected(RuntimeError):
    """The native peer explicitly rejected a write; its outcome is known."""


class GoalService:
    def __init__(self, runtime, port, store, publish):
        self.runtime, self.port, self.store, self.publish = (
            runtime,
            port,
            store,
            publish,
        )
        self.states = {}
        self.locks = {}
        self.task = None
        self.closed = False
        self.wake = asyncio.Event()

    def state(self, sid, external_id=None):
        if sid not in self.states:
            value = self.store.load(sid) or {
                "sessionId": sid,
                "runtime": self.runtime,
                "revision": 0,
                "bindingGeneration": 0,
                "sourceEpoch": str(uuid4()),
                "sourceRevision": 0,
                "goal": None,
                "lastOutcome": None,
                "freshness": "unknown",
                "capabilities": {"supported": False, "actions": []},
            }
            if value.get("_deleted"):
                raise ValueError("goal_session_deleted")
            value["freshness"] = "unknown"
            if value.get("_pauseIntent"):
                value["_recoverPause"] = True
            self.store.save(value)
            self.states[sid] = value
        s = self.states[sid]
        if external_id:
            s["externalSessionId"] = external_id
        if self.task is None and not self.closed:
            self.task = asyncio.create_task(self.watch())
        return s

    def lock(self, sid):
        return self.locks.setdefault(sid, asyncio.Lock())

    async def recover(self):
        # Observations and durable pause completion never authorize a new model run.
        for stored in self.store.sessions():
            if stored.get("_deleted") or not (
                stored.get("goal")
                or stored.get("_pending")
                or stored.get("_needsFinalize")
            ):
                continue
            state = self.state(stored["sessionId"], stored.get("externalSessionId"))
            async with self.lock(state["sessionId"]):
                await self.observe(state)

        if self.store.pending() and self.task is None and not self.closed:
            self.task = asyncio.create_task(self.watch())

    def notify(self, sid, external_id=None):
        self.state(sid, external_id)["_observeRequested"] = True
        self.wake.set()

    async def forget(self, sid):
        import shutil

        async with self.lock(sid):
            self.store.delete(sid, tombstone=True)
            self.states.pop(sid, None)
            path = (
                self.store.path.parent
                / "goal-assets"
                / hashlib.sha256(sid.encode()).hexdigest()
            )
            if path.is_dir():
                shutil.rmtree(path)

    async def close(self):
        self.closed = True
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)

    async def snapshot(self, sid, external_id=None, *, allow_control=False):
        state = self.state(sid, external_id)
        async with self.lock(sid):
            await self.observe(state)
            result = public(state)
            if not allow_control:
                result["capabilities"]["actions"] = []
            return result

    async def operation(self, sid, oid):
        row = self.store.operation(sid, oid)
        if row and row[1]["outcome"] in {"pending", "unknown"}:
            s = self.state(sid)
            async with self.lock(sid):
                await self.observe(s)
                await self.settle(s)
            row = self.store.operation(sid, oid)
        return {"operation": row[1] if row else None}

    async def commit(self, s, operation=None, cursor=None):
        s["sourceRevision"] += 1
        s["revision"] = s["sourceRevision"]
        if operation and "state" in operation[2]:
            operation[2]["state"] = public(s)
        try:
            self.store.save(s, operation, cursor)
        except Exception:
            s["_uncommitted"] = {"operation": operation, "cursor": cursor}
            raise

    async def observe(self, s):
        if s.get("_uncommitted"):
            pending = s.pop("_uncommitted")
            try:
                self.store.save(s, pending["operation"], pending["cursor"])
            except Exception:
                s["_uncommitted"] = pending
                raise
        if s.get("_recoverPause"):
            native = await self.port.read(s["sessionId"], s.get("externalSessionId"), s)
            identity = ((native or {}).get("goal") or {}).get("nativeIdentity")
            if (
                identity
                and s.get("_nativeIdentity")
                and identity != s["_nativeIdentity"]
            ):
                s["_pauseIntent"] = False
            else:
                terminal = (native or {}).get("terminal") or (
                    (native or {}).get("goal") or {}
                ).get("status") in TERMINAL
                confirmed = bool(
                    (native or {}).get("empty") or terminal
                ) or await self.port.execute(
                    s["sessionId"],
                    s.get("externalSessionId"),
                    {"action": "pause", "operationId": str(uuid4())},
                    s,
                )
                if not confirmed:
                    raise RuntimeError("goal_pause_unconfirmed")
                if s.get("goal"):
                    s["goal"]["status"] = "paused"
                if s.get("_pending", {}).get("request", {}).get("action") == "pause":
                    s["_pending"]["nativeConfirmed"] = True
            s.pop("_recoverPause", None)
            await self.commit(s)
        try:
            observed = await self.port.read(
                s["sessionId"], s.get("externalSessionId"), s
            )
        except Exception as e:  # noqa: BLE001 - contain native failures at the reconciliation boundary
            s["freshness"] = "stale"
            s["capabilities"] = {"supported": True, "actions": [], "reason": str(e)}
            return
        if observed is None:
            s["freshness"] = "unknown"
            s["capabilities"] = {"supported": False, "actions": []}
            return
        if observed.get("deferOutcome"):
            s["freshness"] = "stale"
            s["capabilities"] = {
                "supported": True,
                "actions": [],
                "reason": "goal_finishing_reply",
            }
            return
        actions = observed.pop("actions", ACTIONS)
        s["capabilities"] = {"supported": True, "actions": actions}
        if observed.get("reason"):
            s["capabilities"]["reason"] = observed["reason"]
        s["freshness"] = "fresh"
        native = copy.deepcopy(observed.get("goal"))
        previous = copy.deepcopy(s.get("goal"))
        outcome = copy.deepcopy(s.get("lastOutcome"))
        if native:
            if s.get("_submittedObjective") == native.get("objective"):
                native["objective"] = s.get("_displayObjective", native["objective"])
            identity = native.pop("nativeIdentity", None)
            old = s.get("goal")
            if old is None and native["status"] in TERMINAL:
                last = s.get("lastOutcome")
                if (
                    last
                    and last["objective"] == native["objective"]
                    and (not identity or identity == s.get("_nativeIdentity"))
                ):
                    old = last
            # A new native target supersedes an AA-paused target.
            same = old and (
                (identity is not None and identity == s.get("_nativeIdentity"))
                or (identity is None and old["objective"] == native["objective"])
                or s.get("_pendingAction") in {"edit", "resume"}
            )
            if s.get("_pendingAction") == "set" and s.get("_pending", {}).get(
                "nativeConfirmed"
            ):
                same = False
            if (
                identity
                and s.get("_nativeIdentity")
                and identity != s["_nativeIdentity"]
                and s.get("_pendingAction") not in {"edit", "resume"}
            ):
                same = False
            if not same:
                if not (s.get("_stopRequested") and s.get("_pending")):
                    s["_pauseIntent"] = False
                    s["_stopRequested"] = False
                s["_elapsedCarry"] = 0
                s["_elapsedIncomplete"] = False
                if s.get("_pendingAction") not in {"set", "edit", "resume"}:
                    s.pop("_attachmentSuffix", None)
                    s.pop("_submittedObjective", None)
                    s.pop("_displayObjective", None)
                if old:
                    s["lastOutcome"] = {
                        **old,
                        "status": "replaced",
                        "endedAt": now(),
                        "updatedAt": now(),
                    }
                old = {"id": str(uuid4()), "createdAt": now()}
            if (
                self.runtime == "claude"
                and same
                and old.get("status") in {"blocked", "budgetLimited", "usageLimited"}
                and native["status"] == "active"
                and native.get("updatedAt") == old.get("updatedAt")
                and not s.get("_pendingAction")
            ):
                native["status"] = old["status"]
                native["lastReason"] = old.get("lastReason")
            s["goal"] = {
                **old,
                **native,
                "createdAt": old["createdAt"]
                if same
                else (native.get("createdAt") or old["createdAt"]),
                "updatedAt": native.get("updatedAt")
                or (old or {}).get("updatedAt")
                or now(),
            }
            if self.runtime == "claude" and same and s.get("_elapsedIncomplete"):
                s["goal"].pop("timeUsedSeconds", None)
            elif (
                self.runtime == "claude"
                and same
                and native.get("timeUsedSeconds") is not None
            ):
                s["goal"]["timeUsedSeconds"] = native["timeUsedSeconds"] + s.get(
                    "_elapsedCarry", 0
                )
            if identity:
                s["_nativeIdentity"] = identity
            if native["status"] in TERMINAL:
                s["lastOutcome"] = {
                    **s["goal"],
                    "endedAt": native.get("endedAt")
                    or (old.get("endedAt") if old.get("status") in TERMINAL else None)
                    or now(),
                }
                s["goal"] = None
        elif (
            observed.get("empty")
            and s.get("goal")
            and not s.get("_pauseIntent")
            and s.get("_pendingAction") not in {"set", "edit", "resume"}
        ):
            s["lastOutcome"] = {
                **s["goal"],
                "status": observed.get("outcome", "cleared"),
                "endedAt": now(),
                "updatedAt": now(),
            }
            s["goal"] = None
        if s.get("_pauseIntent") and s.get("goal") and not native:
            s["goal"]["status"] = "paused"
        cursor = observed.get("cursor")
        if previous != s.get("goal") or outcome != s.get("lastOutcome"):
            await self.commit(s, cursor=cursor)
            if (
                native
                and native["status"] == "complete"
                and hasattr(self.port, "finalize")
            ):
                try:
                    await self.port.finalize(s["sessionId"], s.get("externalSessionId"))
                except Exception as error:  # noqa: BLE001 - retain completed result after cleanup failure
                    # The durable completion is authoritative even if native cleanup is unavailable.
                    logger.warning(
                        "completed goal cleanup deferred session={} error={}",
                        s["sessionId"],
                        str(error),
                    )
                    s["_needsFinalize"] = True
                    self.store.save(s)
        elif cursor and cursor != self.store.cursor(s["sessionId"]):
            self.store.save(s, cursor=cursor)
        if s.get("_needsFinalize"):
            if observed.get("empty") or (native and native["status"] not in TERMINAL):
                s.pop("_needsFinalize", None)
                self.store.save(s)
            elif (
                native
                and native["status"] == "complete"
                and previous == s.get("goal")
                and outcome == s.get("lastOutcome")
            ):
                try:
                    await self.port.finalize(s["sessionId"], s.get("externalSessionId"))
                    s.pop("_needsFinalize", None)
                    self.store.save(s)
                except Exception as error:  # noqa: BLE001 - retry only idempotent cleanup of this completed native goal
                    logger.debug("completed goal cleanup still unavailable: {}", error)
        await self.settle(s)

    async def settle(self, s):
        pending = s.get("_pending")
        if not pending:
            return
        request = pending["request"]
        a = request["action"]
        g = s.get("goal")
        last = s.get("lastOutcome")
        applied = (
            (
                a in {"set", "edit", "resume"}
                and (
                    (
                        g
                        and g["objective"]
                        == request.get("objective", pending.get("objective"))
                        and (
                            g["status"] == "active"
                            or (
                                g["status"] == "paused"
                                and s.get("_stopRequested")
                                and (
                                    pending.get("nativeConfirmed")
                                    or pending.get("beforeIdentity")
                                    != s.get("_nativeIdentity")
                                )
                            )
                        )
                    )
                    or (
                        last
                        and last["status"] == "complete"
                        and last["objective"]
                        == request.get("objective", pending.get("objective"))
                    )
                )
            )
            or (
                a == "pause"
                and g
                and g["status"] == "paused"
                and pending.get("nativeConfirmed")
            )
            or (a == "clear" and g is None)
        )
        if (
            a in {"set", "edit", "resume"}
            and self.runtime == "claude"
            and pending.get("beforeIdentity") == s.get("_nativeIdentity")
        ):
            applied = False
        rejection = getattr(self.port, "rejection", lambda sid: None)(s["sessionId"])
        if applied or rejection:
            result = {
                "operationId": request["operationId"],
                "outcome": "applied" if applied else "rejected",
                "ok": bool(applied),
                "state": public(s),
            }
            if rejection and not applied:
                result.update(code="goal_native_rejected", message=rejection)
            s.pop("_pending", None)
            s.pop("_pendingAction", None)
            await self.commit(
                s, (request["operationId"], pending["fingerprint"], result)
            )

    async def execute(self, sid, external_id, request):
        s = self.state(sid, external_id)
        oid = request["operationId"]
        fp = hashlib.sha256(
            json.dumps(
                request, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode()
        ).hexdigest()
        async with self.lock(sid):
            row = self.store.operation(sid, oid)
            if row:
                if row[0] != fp:
                    raise ValueError("goal_operation_identity_conflict")
                return row[1]
            if s.get("_pending"):
                raise ValueError("goal_operation_pending")
            await self.observe(s)
            if (
                request.get("sourceEpoch") != s["sourceEpoch"]
                or request.get("sourceRevision") != s["sourceRevision"]
            ):
                raise ValueError("goal_revision_conflict")
            a = request["action"]
            if a not in s["capabilities"]["actions"]:
                raise ValueError("goal_action_unavailable")
            validate = getattr(self.port, "validate", None)
            if validate:
                validate(request, s)
            if a != "set" and not s.get("goal"):
                raise ValueError("goal_not_found")
            if a in {"set", "edit"} and not str(request.get("objective") or "").strip():
                raise ValueError("goal_objective_required")
            if a in {"set", "edit", "resume"}:
                s["_stopRequested"] = False
            native_request = dict(request)
            if a in {"set", "edit"}:
                from connector.goals.attachments import materialize

                native_request["objective"] = await materialize(
                    self.port.runtime.host, self.store.path.parent, sid, request
                )
                if (
                    a == "edit"
                    and not request.get("attachments")
                    and s.get("_attachmentSuffix")
                ):
                    native_request["objective"] += s["_attachmentSuffix"]
                s["_attachmentSuffix"] = native_request["objective"][
                    len(request["objective"]) :
                ]
                s["_submittedObjective"] = native_request["objective"]
                s["_displayObjective"] = request["objective"]
            if validate:
                validate(native_request, s)
            g = s.get("goal")
            if a == "resume" and g["status"] not in {
                "paused",
                "blocked",
                "usageLimited",
            }:
                raise ValueError("goal_resume_unavailable")
            if a == "pause" and g["status"] != "active":
                raise ValueError("goal_pause_unavailable")
            if a in {"edit", "resume"} and self.runtime == "claude":
                if (g or {}).get("timeUsedSeconds") is None:
                    s["_elapsedIncomplete"] = True
                else:
                    s["_elapsedCarry"] = g["timeUsedSeconds"]
            if a in {"set", "edit", "resume"}:
                s["_pauseIntent"] = False
            if a == "pause":
                s["_pauseIntent"] = True
            pending = {
                "request": request,
                "fingerprint": fp,
                "objective": (g or {}).get("objective"),
                "beforeIdentity": s.get("_nativeIdentity"),
            }
            s["_pending"] = pending
            s["_pendingAction"] = a
            result = {
                "operationId": oid,
                "outcome": "unknown",
                "ok": False,
                "code": "goal_outcome_unknown",
            }
            await self.commit(s, (oid, fp, result))
            try:
                confirmed = await self.port.execute(sid, external_id, native_request, s)
                pending["nativeConfirmed"] = bool(confirmed)
                if a == "pause" and confirmed and s.get("goal"):
                    s["goal"]["status"] = "paused"
                if a == "clear" and confirmed and s.get("goal"):
                    s["lastOutcome"] = {
                        **s["goal"],
                        "status": "cleared",
                        "endedAt": now(),
                        "updatedAt": now(),
                    }
                    s["goal"] = None
                    s["_pauseIntent"] = False
                await self.observe(s)
                await self.settle(s)
                self.store.save(s)
            except GoalRejected as error:
                if (s.get("goal") or {}).get("status") == "paused":
                    s["_pauseIntent"] = True
                s.pop("_pending", None)
                s.pop("_pendingAction", None)
                await self.observe(s)
                result = {
                    "operationId": oid,
                    "ok": False,
                    "outcome": "rejected",
                    "code": "goal_native_rejected",
                    "message": str(error),
                    "state": public(s),
                }
                await self.commit(s, (oid, fp, result))
            except Exception as e:  # noqa: BLE001 - contain native failures at the reconciliation boundary
                # A dispatched native write is not automatically safe to repeat.
                logger.warning(
                    "goal operation requires reconciliation session={} error={}",
                    sid,
                    str(e),
                )
                self.store.save(s)
            row = self.store.operation(sid, oid)
            return row[1]

    async def pause_before_stop(self, sid):
        s = self.state(sid)
        lock = self.lock(sid)
        if lock.locked():
            # Safety stop fences a native write already awaiting I/O before waiting
            # for the coordinator. It never replays that write.
            s["_stopRequested"] = True
            s["_pauseIntent"] = True
            await self.commit(s)
            interrupt = getattr(self.port, "interrupt", None)
            if interrupt is not None:
                await interrupt(sid)
        async with lock:
            await self.observe(s)
            if not s.get("goal"):
                s["_pauseIntent"] = False
                s["_stopRequested"] = False
                self.store.save(s)
                return
            if s["goal"]["status"] == "paused":
                await self.settle(s)
                return
            s["_stopRequested"] = True
            s["_pauseIntent"] = True
            s["_recoverPause"] = True
            await self.commit(s)
            confirmed = await self.port.execute(
                sid,
                s.get("externalSessionId"),
                {"action": "pause", "operationId": str(uuid4())},
                s,
            )
            if not confirmed:
                raise RuntimeError("goal_pause_unconfirmed")
            s["goal"]["status"] = "paused"
            s.pop("_recoverPause", None)
            await self.commit(s)
            await self.settle(s)

    async def watch(self):
        while not self.closed:
            self.wake.clear()
            try:
                for sid, s in list(self.states.items()):
                    if not (
                        s.get("goal")
                        or s.get("_pending")
                        or s.get("_needsFinalize")
                        or s.pop("_observeRequested", False)
                    ):
                        continue
                    async with self.lock(sid):
                        await self.observe(s)
                for sid, rev, s in self.store.pending():
                    try:
                        await self.publish(public(s), durable=True)
                        self.store.acknowledged(sid, rev)
                    except Exception:  # noqa: BLE001 - retain outbox work on transport failure
                        break
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - contain native failures at the reconciliation boundary
                logger.debug("goal reconciliation deferred: {}", e)
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=2)
            except TimeoutError:
                pass

    async def prepare_creation(self, sid, eid, content, attachments, operation_id):
        from connector.runtime_protocol import RuntimeOperationResult

        state = self.state(sid, eid)
        request = {
            "operationId": operation_id,
            "action": "set",
            "objective": content,
            "attachments": [
                {"fileId": a.file_id, "name": a.name, "mediaType": a.media_type}
                for a in attachments
            ],
            "sourceEpoch": state["sourceEpoch"],
            "sourceRevision": state["sourceRevision"],
        }
        async with self.lock(sid):
            await self.observe(state)
            request["sourceRevision"] = state["sourceRevision"]
        result = await self.execute(sid, eid, request)
        for _ in range(25):
            if result["outcome"] not in {"unknown", "pending"}:
                break
            await asyncio.sleep(0.2)
            result = (await self.operation(sid, operation_id))["operation"]
        return RuntimeOperationResult(
            ok=result["ok"],
            code=result.get("code"),
            message=result.get("message"),
            result={
                "externalSessionId": state.get("externalSessionId"),
                "goal": result,
                "messageAccepted": result["ok"],
            },
        )
