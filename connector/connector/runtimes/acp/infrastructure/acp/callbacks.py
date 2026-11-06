from __future__ import annotations

from acp import RequestError
from acp.schema import (
    AllowedOutcome,
    CreateElicitationResponse,
    DeniedOutcome,
    ElicitationFormRequestMode,
    ElicitationFormSessionMode,
    RequestPermissionResponse,
)
from pydantic import TypeAdapter

from .v1 import wire


class Callbacks:
    def __init__(self, on_update, on_interaction):
        self.on_update = on_update
        self.on_interaction = on_interaction
        self.failure = None
        self.guarantees = frozenset()

    def on_connect(self, conn):
        self.connection = conn

    async def session_update(self, session_id, update, **kwargs):
        try:
            value = wire(update)
            if "stable_native_identity" in self.guarantees:
                value["aaProjectionVerified"] = True
            await self.on_update(session_id, value)
        except Exception as error:  # noqa: BLE001 -- SDK otherwise logs and ignores projection failures
            self.failure = error

    async def request_permission(self, options, session_id, tool_call, **kwargs):
        answer = await self.on_interaction(
            session_id,
            "permission",
            {"options": wire(options), "toolCall": wire(tool_call)},
        )
        outcome = (
            AllowedOutcome(outcome="selected", optionId=answer["optionId"])
            if answer.get("action") == "accept"
            else DeniedOutcome(outcome="cancelled")
        )
        return RequestPermissionResponse(outcome=outcome)

    async def create_elicitation(self, message, mode, **kwargs):
        mode_data = wire(mode)
        data = {**(mode_data if isinstance(mode_data, dict) else {}), **wire(kwargs)}
        mode_type = (
            "form"
            if isinstance(
                mode, (ElicitationFormSessionMode, ElicitationFormRequestMode)
            )
            else mode
        )
        if mode_type != "form":
            # URL authentication is not advertised until reachable-device flows
            # and explicit user navigation are integrated across all clients.
            raise RequestError.method_not_found("elicitation/create:url")
        schema = data.get("requested_schema", data.get("requestedSchema"))
        answer = await self.on_interaction(
            data.get("session_id", data.get("sessionId")),
            "form",
            {
                "message": message,
                "schema": schema,
                "requestId": data.get("request_id", data.get("requestId")),
            },
        )
        return TypeAdapter(CreateElicitationResponse).validate_python(answer)

    async def complete_elicitation(self, elicitation_id, **kwargs):
        return None

    async def ext_method(self, method, params):
        raise RequestError.method_not_found(method)

    async def ext_notification(self, method, params):
        if (
            method.removeprefix("_") == "aa/operation_update"
            and "durable_prompt_receipts" in self.guarantees
        ):
            try:
                await self.on_update(
                    params["agentSessionId"],
                    {"sessionUpdate": "aa_operation_update", "receipt": params},
                )
            except Exception as error:  # noqa: BLE001 -- same durable projection boundary as standard updates
                self.failure = error

    def __getattr__(self, name):
        async def unsupported(*args, **kwargs):
            raise RequestError.method_not_found(name)

        return unsupported
