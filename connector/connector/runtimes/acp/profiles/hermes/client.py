"""Hermes' ACP surface, adapted to AA's session controls."""

from __future__ import annotations

from dataclasses import dataclass

from acp import RequestError

from ...domain.definitions import AcpError, PromptRejectedBeforeDispatch
from ...infrastructure.acp.client import AgentClient

CATEGORIES = {"mode": "permission", "thought_level": "effort"}
EDIT_POLICY_OPTION = "edit_approval_policy"
EXECUTION_UPDATES = {
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
}


@dataclass
class Turn:
    message_id: str
    text: str
    attachments: list
    observed: bool = False


def attachments_of(blocks) -> list:
    return [
        block["_meta"]["aa"]["attachment"]
        for block in blocks or []
        if block.get("_meta", {}).get("aa", {}).get("attachment")
    ]


def user_message(message_id: str, text: str, attachments: list) -> dict:
    return {
        "sessionUpdate": "user_message_chunk",
        "messageId": message_id,
        "aaProjectionVerified": True,
        "content": {"type": "text", "text": text},
        "_meta": {
            "aa": {
                "clientMessageId": message_id,
                "boundary": True,
                "attachments": attachments,
            }
        },
    }


def adapt_options(options: list[dict]) -> list[dict]:
    """Keeps Hermes' own choices and names; only the category vocabulary differs."""
    adapted = []
    for option in options:
        category = CATEGORIES.get(option.get("category"))
        if option.get("category") == "mode" and option.get("id") != EDIT_POLICY_OPTION:
            category = None
        adapted.append({**option, **({"category": category} if category else {})})
    return adapted


class HermesClient(AgentClient):
    def __init__(self, on_update, on_interaction):
        self.commands: dict[str, list] = {}
        self.turns: dict[str, Turn] = {}

        async def update(session_id, value):
            kind = value.get("sessionUpdate")
            if kind in EXECUTION_UPDATES:
                await self.observe(session_id)
            if kind == "available_commands_update":
                self.commands[session_id] = value.get("availableCommands", [])
            if kind == "config_option_update":
                value = {
                    **value,
                    "configOptions": adapt_options(value.get("configOptions", [])),
                }
            await on_update(session_id, value)

        async def interaction(session_id, kind, value):
            if session_id:
                await self.observe(session_id)
            return await on_interaction(session_id, kind, value)

        super().__init__(update, interaction)

    async def observe(self, session_id):
        """Hermes does not echo live prompts, and acts only on ones it accepted."""
        turn = self.turns.get(session_id)
        if turn is None or turn.observed:
            return
        turn.observed = True
        await self.callbacks.on_update(
            session_id, user_message(turn.message_id, turn.text, turn.attachments)
        )
        await self.callbacks.on_update(
            session_id,
            {"sessionUpdate": "aa_execution_observed", "clientMessageId": turn.message_id},
        )

    async def start(self, launch, cwd):
        result = await super().start(launch, cwd)
        aa = self.capabilities.setdefault("_meta", {}).setdefault("aa", {})
        aa["capabilities"] = ["session.commands", "session.steer"]
        if self.capabilities.get("promptCapabilities", {}).get("image"):
            aa["capabilities"].append("runtime.attachment")
        return result

    def adapt_session(self, result: dict) -> dict:
        options = result.get("configOptions")
        if not any(item.get("category") == "model" for item in options or []):
            raise AcpError(
                "hermes_version_unsupported",
                "当前 Hermes 版本没有提供 ACP 模型配置，请升级 Hermes 后重试。",
            )
        return {**result, "configOptions": adapt_options(options)}

    async def open_session(self, cwd, **metadata):
        try:
            result = await super().open_session(cwd, **metadata)
        except RequestError as error:
            raise AcpError(
                "hermes_session_failed",
                "Hermes 无法创建会话。请在本机运行 hermes model 完成模型配置，再运行 hermes acp --check 检查环境。",
            ) from error
        return self.adapt_session(result)

    async def resume(self, session_id, cwd, **metadata):
        # The transcript Hermes replays here arrives before the new connection
        # is bound, so the shared session service does not project it again.
        try:
            result = await super().resume(session_id, cwd, **metadata)
        except RequestError as error:
            raise AcpError(
                "hermes_session_unavailable",
                "Hermes 无法恢复此会话。请确认实例的 Hermes 配置目录没有变化，且原会话仍然存在。",
            ) from error
        return self.adapt_session(result)

    async def configure(self, session_id, key, value):
        result = await super().configure(session_id, key, value)
        return {**result, "configOptions": adapt_options(result.get("configOptions", []))}

    async def prompt(self, session_id, text, operation_id, blocks=None):
        self.turns[session_id] = Turn(operation_id, text, attachments_of(blocks))
        try:
            result = await super().prompt(session_id, text, operation_id, blocks)
            await self.observe(session_id)
            return result
        finally:
            self.turns.pop(session_id, None)

    async def extension(self, method, values):
        session_id = values.get("sessionId")
        if method == "aa/steer":
            return await self.steer(session_id, values)
        if method == "aa/list_commands":
            return {"commands": self.commands.get(session_id, [])}
        if method == "aa/execute_command":
            return await self.execute_command(session_id, values)
        return await super().extension(method, values)

    async def steer(self, session_id, values):
        if values.get("blocks"):
            # Hermes only runs a slash command from a text-only prompt.
            raise PromptRejectedBeforeDispatch(
                "hermes_steer_attachments_unsupported", "Hermes 运行中追加指令暂不支持附件。"
            )
        message_id = values["clientMessageId"]
        result = await AgentClient.prompt(
            self, session_id, "/steer " + values["content"], message_id
        )
        await self.callbacks.on_update(
            session_id, user_message(message_id, values["content"], [])
        )
        return {"outcome": "injected", "result": result}

    async def execute_command(self, session_id, values):
        command = values["command"].removeprefix("/")
        if command not in {item["name"] for item in self.commands.get(session_id, [])}:
            raise PromptRejectedBeforeDispatch("command_unavailable", "命令目录已变化，请刷新。")
        text = "/" + " ".join([command, *values.get("args", ())])
        if values.get("raw") is not None:
            text = values["raw"].lstrip()
        result = await AgentClient.prompt(self, session_id, text, "command")
        return {"ok": True, "result": result}
