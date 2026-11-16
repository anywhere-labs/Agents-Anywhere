"""Plans and goals of a v3 session are the device's (real Router, fake device)."""

from __future__ import annotations

import asyncio
import hashlib

from device_link_helpers import (
    acked,
    eventually,
    offline,
    server,
    summary,
    user_and_device,
)
from mesh_fixtures import RouterProcess

from agent_server.core.device_meshcall import LinkError
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


def test_plans_and_goals_are_read_and_changed_on_the_device(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            base = f"/api/v2/sessions/{SID}"
            try:
                pushed = device.state.push_outbox("session.summary", summary(SID, 0))
                await eventually(lambda: acked(device, pushed.oid))
                assert (await client.post(f"{base}/takeover", headers=headers)).status_code == 200

                device.state.capability_ids = ["session.planning", "session.plan_review", "session.goal"]
                device.state.state_parts[(SID, "planning")] = {"planning": _planning(3)}
                device.state.state_parts[(SID, "goal")] = {
                    "goal": {"sessionId": SID, "runtime": "codex", "revision": 2, "freshness": "fresh"}
                }
                device.state.plans[SID] = [_plan(2, "# Plan\n\n- two"), _plan(1)]

                planning = await client.get(f"{base}/planning", headers=headers)
                assert planning.status_code == 200, planning.text
                assert planning.json()["revision"] == 3 and planning.json()["proposal"]["planId"] == "plan_1"
                goal = await client.get(f"{base}/goal", headers=headers)
                assert goal.status_code == 200, goal.text
                assert goal.json()["revision"] == 2

                plans = await client.get(f"{base}/plans", headers=headers)
                assert [plan["revision"] for plan in plans.json()] == [2, 1]
                one = await client.get(f"{base}/plans/plan_1/2", headers=headers)
                assert one.status_code == 200 and one.json()["markdown"].endswith("two")
                markdown = await client.get(f"{base}/plans/plan_1/2/markdown", headers=headers)
                assert markdown.status_code == 200 and markdown.text.endswith("two")
                missing = await client.get(f"{base}/plans/plan_1/9", headers=headers)
                assert missing.status_code == 404

                def handle(method: str, p: dict):
                    if method == "session.planning":
                        if p["command"] == "dismiss_review":
                            return LinkError(code="plan_review_missing", message="nothing to dismiss")
                        return {"execution": "accepted", "state": _planning(4)}
                    if method == "session.goal":
                        return {"state": {"sessionId": SID, "runtime": "codex", "revision": 3}}
                    return {"ok": True}

                device.state.command_handler = handle
                applied = await client.post(
                    f"{base}/planning",
                    headers=headers,
                    json={"command": "enter_plan", "operationId": "op_plan_1"},
                )
                assert applied.status_code == 200, applied.text
                assert applied.json()["outcome"] == "applied" and applied.json()["state"]["revision"] == 4
                method, payload = device.state.command_log[-1]
                assert method == "session.planning"
                assert payload == {"sessionId": SID, "command": "enter_plan", "operationId": "op_plan_1", "attachments": []}

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

                # The receipt answers the operation lookups; the same id is not sent twice.
                looked = await client.get(f"{base}/planning/operations/op_plan_1", headers=headers)
                assert looked.json()["outcome"] == "applied"
                calls = len(device.state.command_log)
                replay = await client.post(
                    f"{base}/planning", headers=headers, json={"command": "enter_plan", "operationId": "op_plan_1"}
                )
                assert replay.json()["outcome"] == "applied" and len(device.state.command_log) == calls
                assert (await client.get(f"{base}/planning/operations/op_nope", headers=headers)).status_code == 404

                goal_set = await client.post(
                    f"{base}/goal",
                    headers=headers,
                    json={"operationId": "op_goal_1", "expectedRevision": 2, "action": "set", "objective": "ship"},
                )
                assert goal_set.status_code == 200, goal_set.text
                assert goal_set.json()["outcome"] == "applied" and goal_set.json()["state"]["revision"] == 3
                assert device.state.command_log[-1][1]["objective"] == "ship"
                assert (await client.get(f"{base}/goal/operations/op_goal_1", headers=headers)).json()["ok"] is True
                # An operation id belongs to its kind.
                assert (await client.get(f"{base}/goal/operations/op_plan_1", headers=headers)).status_code == 404

                # A malformed answer is the device's fault.
                device.state.state_parts[(SID, "planning")] = {"planning": {"sessionId": SID, "bogus": 1}}
                bad = await client.get(f"{base}/planning", headers=headers)
                assert bad.status_code == 502 and bad.json()["detail"]["code"] == "device_response_invalid"
            finally:
                await device.stop()

            await eventually(lambda: offline(app.state.rpc, device_id))
            stale = await client.get(f"{base}/planning", headers=headers)
            assert stale.status_code == 200
            assert stale.json()["freshness"] == "stale" and stale.json()["sessionId"] == SID
            assert (await client.get(f"{base}/goal", headers=headers)).json()["freshness"] == "stale"
            assert (await client.get(f"{base}/plans", headers=headers)).status_code == 409
            offline_change = await client.post(
                f"{base}/planning", headers=headers, json={"command": "enter_plan", "operationId": "op_plan_3"}
            )
            # Refused before anything is recorded (the capability check already needs the device).
            assert offline_change.status_code == 409
            assert await app.state.store.get_device_command("user_v3", "op_plan_3") is None

    asyncio.run(scenario())
