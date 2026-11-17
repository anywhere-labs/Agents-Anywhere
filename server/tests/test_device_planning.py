"""Plans and goals of a v3 session are the device's (real Router, fake device)."""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any

from device_link_helpers import (
    acked,
    eventually,
    offline,
    server,
    summary,
    user_and_device,
)
from mesh_fixtures import RouterProcess

from agent_server.core.auth import create_user_access_token
from scripts.v3_fake_device import connect_device

SID = "sess_p1"


def _plan(revision: int, markdown: str = "# Plan\n\n- step") -> dict:
    return {
        "planId": "plan_1",
        "revision": revision,
        "contentHash": "sha256:" + hashlib.sha256(markdown.encode()).hexdigest(),
        "title": "Plan",
        "markdown": markdown,
    }


def _planning(revision: int) -> dict:
    return {
        "sessionId": SID,
        "runtime": "codex",
        "runtimeId": "codex",
        "effectiveMode": "plan",
        "freshness": "fresh",
        "revision": revision,
        "proposal": _plan(1),
    }


def _goal(revision: int) -> dict:
    return {"sessionId": SID, "runtime": "codex", "revision": revision, "freshness": "fresh"}


def test_plans_and_goals_are_read_and_changed_on_the_device(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            state = device.state
            base = f"/api/v2/sessions/{SID}"
            documents = [_plan(2, "# Plan\n\n- two"), _plan(1)]
            current = {"planning": _planning(3), "goal": _goal(2)}

            def handle(request: dict[str, Any]) -> Any:
                route, body = request["route"], request["body"]
                if route == "session.planning.get":
                    return 200, current["planning"]
                if route == "session.goal.get":
                    return 200, current["goal"]
                if route == "session.plans.list":
                    return 200, documents
                if route in ("session.plans.get", "session.plans.markdown"):
                    *_, plan_id, revision = request["path"].removesuffix("/markdown").split("/")
                    found = [d for d in documents if d["planId"] == plan_id and str(d["revision"]) == revision]
                    if not found:
                        return 404, {"detail": "plan not found"}
                    if route == "session.plans.get":
                        return 200, found[0]
                    return {"status": 200, "body": found[0]["markdown"], "contentType": "text/markdown; charset=utf-8"}
                if route == "session.planning.execute":
                    operation = body["operationId"]
                    if body["command"] == "dismiss_review":
                        return {
                            "status": 200,
                            "body": {"operationId": operation, "outcome": "rejected", "ok": False,
                                     "code": "plan_review_missing", "message": "nothing to dismiss"},
                            "command": {"outcome": "rejected",
                                        "e": {"code": "plan_review_missing", "message": "nothing to dismiss"}},
                        }
                    current["planning"] = _planning(4)
                    return 200, {"operationId": operation, "outcome": "applied", "ok": True, "state": _planning(4)}
                if route == "session.goal.execute":
                    current["goal"] = _goal(3)
                    return 200, {"operationId": body["operationId"], "outcome": "applied", "ok": True, "state": _goal(3)}
                return 404, {"detail": {"code": "route_not_found", "message": route}}

            state.client_handler = handle
            try:
                pushed = state.push_outbox("session.summary", summary(SID, 0))
                await eventually(lambda: acked(device, pushed.oid))
                assert (await client.post(f"{base}/takeover", headers=headers)).status_code == 200

                planning = await client.get(f"{base}/planning", headers=headers)
                assert planning.status_code == 200, planning.text
                assert planning.json()["revision"] == 3 and planning.json()["proposal"]["planId"] == "plan_1"
                assert state.client_calls[-1]["route"] == "session.planning.get"
                goal = await client.get(f"{base}/goal", headers=headers)
                assert goal.status_code == 200, goal.text
                assert goal.json()["revision"] == 2

                plans = await client.get(f"{base}/plans", headers=headers)
                assert [plan["revision"] for plan in plans.json()] == [2, 1]
                one = await client.get(f"{base}/plans/plan_1/2", headers=headers)
                assert one.status_code == 200 and one.json()["markdown"].endswith("two")
                assert state.client_calls[-1]["path"] == f"{base}/plans/plan_1/2"
                markdown = await client.get(f"{base}/plans/plan_1/2/markdown", headers=headers)
                assert markdown.status_code == 200 and markdown.text.endswith("two")
                assert markdown.headers["content-type"].startswith("text/markdown")
                assert markdown.headers["content-disposition"] == 'attachment; filename="PLAN.md"'
                missing = await client.get(f"{base}/plans/plan_1/9", headers=headers)
                assert missing.status_code == 404

                # A planning command carries its operation id as the receipt identity.
                applied = await client.post(
                    f"{base}/planning", headers=headers, json={"command": "enter_plan", "operationId": "op_plan_1"}
                )
                assert applied.status_code == 200, applied.text
                assert applied.json()["outcome"] == "applied" and applied.json()["state"]["revision"] == 4
                request = state.client_calls[-1]
                assert request["route"] == "session.planning.execute" and request["command"]["commandId"] == "op_plan_1"
                assert request["body"] == {"command": "enter_plan", "operationId": "op_plan_1"}

                rejected = await client.post(
                    f"{base}/planning", headers=headers, json={
                        "command": "dismiss_review",
                        "operationId": "op_plan_2",
                        "reviewId": "rev_1",
                        "planId": "plan_1",
                        "planRevision": 1,
                        "contentHash": _plan(1)["contentHash"],
                        "epoch": "ep_1",
                    }
                )
                assert rejected.status_code == 200
                assert rejected.json()["outcome"] == "rejected" and rejected.json()["code"] == "plan_review_missing"

                # The receipts answer the operation lookups; an applied one reads the current state from the device.
                looked = await client.get(f"{base}/planning/operations/op_plan_1", headers=headers)
                assert looked.status_code == 200, looked.text
                assert looked.json()["outcome"] == "applied" and looked.json()["state"]["revision"] == 4
                assert state.client_calls[-1]["route"] == "session.planning.get"
                looked = await client.get(f"{base}/planning/operations/op_plan_2", headers=headers)
                assert looked.json()["outcome"] == "rejected" and looked.json()["code"] == "plan_review_missing"
                assert (await client.get(f"{base}/planning/operations/op_nope", headers=headers)).status_code == 404

                # The same operation again is answered by the device's inbox; nothing runs twice.
                runs = len(state.client_runs)
                replay = await client.post(
                    f"{base}/planning", headers=headers, json={"command": "enter_plan", "operationId": "op_plan_1"}
                )
                assert replay.json()["outcome"] == "applied" and len(state.client_runs) == runs

                goal_set = await client.post(
                    f"{base}/goal",
                    headers=headers,
                    json={"operationId": "op_goal_1", "expectedRevision": 2, "action": "set", "objective": "ship"},
                )
                assert goal_set.status_code == 200, goal_set.text
                assert goal_set.json()["outcome"] == "applied" and goal_set.json()["state"]["revision"] == 3
                request = state.client_calls[-1]
                assert request["route"] == "session.goal.execute" and request["body"]["objective"] == "ship"
                assert request["command"]["commandId"] == "op_goal_1"
                assert (await client.get(f"{base}/goal/operations/op_goal_1", headers=headers)).json()["ok"] is True
                # An operation id belongs to its kind.
                assert (await client.get(f"{base}/goal/operations/op_plan_1", headers=headers)).status_code == 404

                # A malformed answer is the device's fault.
                current["planning"] = {"sessionId": SID, "bogus": 1}
                bad = await client.get(f"{base}/planning", headers=headers)
                assert bad.status_code == 502 and bad.json()["detail"]["code"] == "device_response_invalid"

                # Another user's request never reaches the device.
                other = await app.state.store.create_user(user_id="user_other", password="password-other")
                stranger = {"Authorization": f"Bearer {create_user_access_token(other.userId)}"}
                calls = len(state.client_calls)
                assert (await client.get(f"{base}/planning", headers=stranger)).status_code == 404
                assert (await client.get(f"{base}/planning/operations/op_plan_1", headers=stranger)).status_code == 404
                assert len(state.client_calls) == calls
            finally:
                await device.stop()

            await eventually(lambda: offline(app.state.rpc, device_id))
            calls = len(state.client_calls)
            # Offline, the state reads answer a stale state from the directory; documents need the device.
            stale = await client.get(f"{base}/planning", headers=headers)
            assert stale.status_code == 200, stale.text
            assert stale.json()["freshness"] == "stale" and stale.json()["sessionId"] == SID
            stale_goal = await client.get(f"{base}/goal", headers=headers)
            assert stale_goal.status_code == 200 and stale_goal.json()["freshness"] == "stale"
            unreachable = await client.get(f"{base}/plans", headers=headers)
            assert unreachable.status_code == 409, unreachable.text
            assert unreachable.json()["detail"]["code"] == "connector_offline"
            offline_change = await client.post(
                f"{base}/planning", headers=headers, json={"command": "enter_plan", "operationId": "op_plan_3"}
            )
            # Refused before anything is recorded.
            assert offline_change.status_code == 409
            assert await app.state.store.get_device_command("user_v3", "op_plan_3") is None
            assert len(state.client_calls) == calls

    asyncio.run(scenario())
