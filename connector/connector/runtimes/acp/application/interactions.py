from __future__ import annotations

import asyncio
import time
from dataclasses import asdict
from uuid import uuid4

from jsonschema import Draft202012Validator, SchemaError, ValidationError

from ..domain.definitions import AcpError
from ..domain.interactions import Interaction


def parse_interaction(row: dict) -> Interaction:
    return Interaction(**row)


class InteractionService:
    def __init__(self, store, publish_notice):
        self.store, self.publish_notice = store, publish_notice
        self.waiters: dict[str, asyncio.Future] = {}
        self.contexts: dict[str, dict] = {}

    async def open(
        self, context: dict, agent_session_id: str | None, kind: str, request: dict
    ) -> dict:
        if context.get("closing"):
            return {"action": "cancel"}
        known = context.get("agentSessionId") or context.get(
            "provisionalAgentSessionId"
        )
        if known and agent_session_id and known != agent_session_id:
            raise AcpError("agent_session_mismatch", "Agent 交互来自其他会话。")
        if agent_session_id:
            context["provisionalAgentSessionId"] = agent_session_id
        if len(self.waiters) >= 128:
            raise AcpError("interaction_capacity", "待回答请求已达到上限。")
        if kind == "form":
            schema = request.get("schema")
            if not isinstance(schema, dict) or schema.get("type") != "object":
                raise AcpError("invalid_form_schema", "Agent 表单缺少对象结构。")
            try:
                Draft202012Validator.check_schema(schema)
            except SchemaError as error:
                raise AcpError("invalid_form_schema", "Agent 表单结构无效。") from error
        item = Interaction(
            uuid4().hex,
            context["scopeId"],
            context["generation"],
            kind,
            request,
            time.time() + 300,
        )
        waiter = asyncio.get_running_loop().create_future()
        self.waiters[item.interaction_id] = waiter
        self.contexts[item.interaction_id] = context
        with self.store.transaction():
            self.store.put("interaction", item.interaction_id, asdict(item))
            self.publish_notice(context, item)
        try:
            return await asyncio.wait_for(asyncio.shield(waiter), 300)
        except (TimeoutError, asyncio.CancelledError):
            with self.store.transaction():
                row = self.store.require("interaction", item.interaction_id)
                if row["status"] == "open":
                    row.update(
                        status="expired" if not waiter.cancelled() else "cancelled",
                        revision=row["revision"] + 1,
                    )
                    self.store.put("interaction", item.interaction_id, row)
                    self.publish_notice(context, parse_interaction(row))
            return {"action": "cancel"}
        finally:
            self.waiters.pop(item.interaction_id, None)
            self.contexts.pop(item.interaction_id, None)

    def respond(self, scope_id: str, values: dict) -> dict:
        item = parse_interaction(
            self.store.require("interaction", values["interactionId"])
        )
        if item.scope_id != scope_id:
            raise AcpError("interaction_scope_mismatch", "回答不属于该操作。")
        if item.status == "open" and item.interaction_id not in self.waiters:
            raise AcpError("interaction_closed", "原交互连接已失效。")
        action = values["actionId"]
        if item.kind == "permission":
            options = {entry["optionId"] for entry in item.request["options"]}
            if action not in options and action != "dismiss":
                raise AcpError("invalid_permission_choice", "审批选项已变化。")
            response = (
                {"action": "accept", "optionId": action}
                if action in options
                else {"action": "cancel"}
            )
        else:
            if action not in {"accept", "decline", "cancel"}:
                raise AcpError("invalid_form_action", "表单操作无效。")
            response = {"action": action}
            if action == "accept":
                content = values.get("input")
                if isinstance(content, dict) and content.get("kind") == "form":
                    content = content.get("values")
                try:
                    Draft202012Validator(item.request["schema"]).validate(content)
                except ValidationError as error:
                    raise AcpError(
                        "invalid_form_response", "表单回答不符合请求要求。"
                    ) from error
                response["content"] = content
        answered = item.answer(
            generation=values["ownerGeneration"],
            revision=values["requestRevision"],
            operation_id=values["responseOperationId"],
            response=response,
            now=time.time(),
        )
        with self.store.transaction():
            self.store.put("interaction", item.interaction_id, asdict(answered))
            if item != answered and item.interaction_id in self.contexts:
                self.publish_notice(self.contexts[item.interaction_id], answered)
        waiter = self.waiters.get(item.interaction_id)
        if waiter and not waiter.done():
            waiter.set_result(response)
        return {
            "disposition": "already_applied" if item == answered else "applied",
            "responseOperationId": answered.response_operation_id,
        }

    def close_scope(self, scope_id: str) -> None:
        for row in self.store.values("interaction"):
            if row["scope_id"] == scope_id and row["status"] == "open":
                row.update(status="cancelled", revision=row["revision"] + 1)
                self.store.put("interaction", row["interaction_id"], row)
                if row["interaction_id"] in self.contexts:
                    self.publish_notice(
                        self.contexts[row["interaction_id"]], parse_interaction(row)
                    )
                waiter = self.waiters.get(row["interaction_id"])
                if waiter and not waiter.done():
                    waiter.set_result({"action": "cancel"})

    def views(self, scope_id: str) -> list[dict]:
        result = []
        for row in self.store.values("interaction"):
            if row["scope_id"] != scope_id:
                continue
            request = row["request"]
            actions = (
                [
                    {
                        "actionId": option["optionId"],
                        "label": option["name"],
                        "style": "danger"
                        if option["kind"].startswith("reject")
                        else "primary",
                    }
                    for option in request.get("options", [])
                ]
                if row["kind"] == "permission"
                else [
                    {
                        "actionId": key,
                        "label": label,
                        "style": "primary" if key == "accept" else "secondary",
                    }
                    for key, label in (
                        ("accept", "提交"),
                        ("decline", "拒绝"),
                        ("cancel", "取消"),
                    )
                ]
            )
            result.append(
                {
                    "interactionId": row["interaction_id"],
                    "ownerGeneration": row["owner_generation"],
                    "requestRevision": row["revision"],
                    "kind": "approval" if row["kind"] == "permission" else "form",
                    "status": row["status"],
                    "title": request.get("toolCall", {}).get(
                        "title", request.get("message", "Agent 请求")
                    ),
                    "actions": actions,
                    "metadata": {
                        "formSchema": request.get("schema"),
                        "toolCall": request.get("toolCall"),
                    },
                    "expiresAt": row["expires_at"],
                }
            )
        return result
