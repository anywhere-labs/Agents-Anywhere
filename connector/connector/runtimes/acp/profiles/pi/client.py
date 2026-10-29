"""Pi's public ACP surface, adapted to AA's existing session controls."""
from __future__ import annotations

import json
import re
from pathlib import Path
from uuid import uuid4

from ...domain.definitions import AcpError, PromptRejectedBeforeDispatch
from ...infrastructure.acp.client import AgentClient
from .settings import private_json


class PiClient(AgentClient):
    def __init__(self, on_update, on_interaction, *, agent_dir: Path):
        self.agent_dir = agent_dir
        self.commands = {}
        self.configuration = {}
        self.permissions = {}
        self.active_messages = {}
        self.message_text = {}
        self.message_attachments = {}
        self.observed = set()

        async def observed(session_id):
            message_id = self.active_messages.get(session_id)
            if message_id and (session_id, message_id) not in self.observed:
                self.observed.add((session_id, message_id))
                await on_update(session_id, {"sessionUpdate": "user_message_chunk", "messageId": message_id,
                    "aaProjectionVerified": True,
                    "content": {"type": "text", "text": self.message_text[session_id]},
                    "_meta": {"aa": {"clientMessageId": message_id, "boundary": True,
                                      "attachments": self.message_attachments.get(session_id, [])}}})
                await on_update(session_id, {"sessionUpdate": "aa_execution_observed", "clientMessageId": message_id})

        async def update(session_id, value):
            kind = value.get("sessionUpdate")
            if value.get("messageId") or value.get("toolCallId"):
                value = {**value, "aaProjectionVerified": True}
            if kind in {"agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"}:
                await observed(session_id)
            metadata = value.get("_meta", {}).get("pi", {})
            if kind == "session_info_update" and metadata.get("event") == "status" and metadata.get("key") == "aa-prompt-started":
                await observed(session_id)
            if kind == "available_commands_update":
                self.commands[session_id] = value.get("availableCommands", [])
            if kind == "config_option_update":
                self.configuration[session_id] = value.get("configOptions", [])
                value = {**value, "configOptions": self.options(session_id, value.get("configOptions", []))}
            await on_update(session_id, value)

        async def interaction(session_id, kind, value):
            if session_id:
                await observed(session_id)
            message = value.get("message", "")
            if kind == "form" and message.startswith("AA_TOOL_PERMISSION\n"):
                tool = json.loads(message.split("\n", 1)[1])
                answer = await on_interaction(session_id, "permission", {
                    "toolCall": {"toolCallId": tool["id"], "title": tool["name"], "kind": "other", "status": "pending", "rawInput": tool["input"]},
                    "options": [{"optionId": "allow", "name": "允许本次", "kind": "allow_once"}, {"optionId": "deny", "name": "拒绝", "kind": "reject_once"}],
                })
                return {"action": "accept", "content": {"confirmed": answer.get("action") == "accept" and answer.get("optionId") == "allow"}}
            return await on_interaction(session_id, kind, value)

        super().__init__(update, interaction)
        self.observe_execution = observed

    def options(self, session_id, options):
        options = [{**option, **({"category": "effort"} if option.get("category") == "thought_level" else {})} for option in options]
        return [*options, {"id": "aa-permission", "name": "权限", "category": "permission", "type": "select",
            "currentValue": self.permissions.get(session_id, "ask"), "options": [
                {"value": "ask", "name": "写入与命令审批"}, {"value": "ask_all", "name": "全部工具审批"}, {"value": "readonly", "name": "只读"}]}]

    def verify_session(self, result):
        extension = str(Path(__file__).with_name("permissions.mjs").resolve())
        if not any(item.get("path") == extension for item in result.get("_meta", {}).get("pi", {}).get("extensions", [])):
            raise AcpError("pi_permissions_unavailable", "Pi 工具审批扩展未能加载，已阻止执行。")
        path = self.agent_dir / "aa-permissions.json"
        if path.exists():
            self.permissions.update(json.loads(path.read_text()))

    async def start(self, launch, cwd):
        result = await super().start(launch, cwd)
        aa = self.capabilities.setdefault("_meta", {}).setdefault("aa", {})
        aa["capabilities"] = ["session.commands", "runtime.attachment", "session.resources.read", "session.authentication.read"]
        if result.get("_meta", {}).get("steering", {}).get("supported"):
            aa["capabilities"].append("session.steer")
        aa["guarantees"] = ["managed_tool_permissions"]
        return result

    async def open_session(self, cwd, **metadata):
        result = await super().open_session(cwd, **metadata)
        self.verify_session(result)
        self.configuration[result["sessionId"]] = result.get("configOptions", [])
        result["configOptions"] = self.options(result["sessionId"], result.get("configOptions", []))
        return result

    async def resume(self, session_id, cwd, **metadata):
        permission = metadata.get("aa", {}).get("permission")
        if permission in {"ask", "ask_all", "readonly"}:
            self.save_permission(session_id, permission)
        result = await super().resume(session_id, cwd, **metadata)
        self.verify_session(result)
        self.configuration[session_id] = result.get("configOptions", [])
        result["configOptions"] = self.options(session_id, result.get("configOptions", []))
        return result

    def save_permission(self, session_id, value):
        path = self.agent_dir / "aa-permissions.json"
        current = json.loads(path.read_text()) if path.exists() else {}
        current[session_id] = value
        private_json(path, current)
        self.permissions[session_id] = value

    async def configure(self, session_id, key, value):
        if key == "aa-permission":
            if value not in {"ask", "ask_all", "readonly"}:
                raise AcpError("invalid_permission", "权限选项无效。")
            self.save_permission(session_id, value)
            # Query through a no-op assignment of the current model is unnecessary.
            return {"configOptions": self.options(session_id, self.configuration[session_id])}
        result = await super().configure(session_id, key, value)
        self.configuration[session_id] = result.get("configOptions", [])
        result["configOptions"] = self.options(session_id, result.get("configOptions", []))
        return result

    async def prompt(self, session_id, text, operation_id, blocks=None):
        if text.lstrip().split(maxsplit=1)[0:1] == ["/bash"] and not await self.authorize_bash(session_id, text.lstrip()[5:].strip()):
            raise PromptRejectedBeforeDispatch("permission_denied", "当前权限或用户审批未允许此命令。")
        self.active_messages[session_id] = operation_id
        self.message_text[session_id] = text
        self.message_attachments[session_id] = [block["_meta"]["aa"]["attachment"] for block in blocks or [] if block.get("_meta", {}).get("aa", {}).get("attachment")]
        try:
            result = await super().prompt(session_id, text, operation_id, blocks)
            await self.observe_execution(session_id)
            return result
        finally:
            self.active_messages.pop(session_id, None)
            self.message_text.pop(session_id, None)
            self.message_attachments.pop(session_id, None)
            self.observed.discard((session_id, operation_id))

    async def authorize_bash(self, session_id, command):
        if self.permissions.get(session_id, "ask") == "readonly":
            return False
        answer = await self.callbacks.on_interaction(session_id, "permission", {
            "toolCall": {"toolCallId": "bash-" + uuid4().hex, "title": "bash", "kind": "execute",
                         "status": "pending", "rawInput": {"command": command}},
            "options": [{"optionId": "allow", "name": "允许本次", "kind": "allow_once"},
                        {"optionId": "deny", "name": "拒绝", "kind": "reject_once"}],
        })
        return answer.get("action") == "accept" and answer.get("optionId") == "allow"

    async def extension(self, method, values):
        session_id = values.get("sessionId")
        if method == "aa/steer":
            result = await super().extension("session/steering", {
                "sessionId": session_id, "prompt": [{"type": "text", "text": values["content"]}, *values.get("blocks", [])],
            })
            if result.get("outcome") == "injected":
                await self.callbacks.on_update(session_id, {
                    "sessionUpdate": "user_message_chunk", "messageId": values["clientMessageId"],
                    "aaProjectionVerified": True, "content": {"type": "text", "text": values["content"]},
                    "_meta": {"aa": {"clientMessageId": values["clientMessageId"], "boundary": True,
                        "attachments": [block["_meta"]["aa"]["attachment"] for block in values.get("blocks", []) if block.get("_meta", {}).get("aa", {}).get("attachment")] }},
                })
            return result
        if method == "aa/list_commands":
            return {"commands": self.commands.get(session_id, [])}
        if method == "aa/execute_command":
            command = values["command"].removeprefix("/")
            if command not in {item["name"] for item in self.commands.get(session_id, [])}:
                raise PromptRejectedBeforeDispatch("command_unavailable", "命令目录已变化，请刷新。")
            text = "/" + command + (" " + " ".join(values["args"]) if values.get("args") else "")
            if values.get("raw") is not None:
                match = re.fullmatch(r"\s*/([^\s]+)([\s\S]*)", values["raw"])
                if not match or match[1].casefold() != command.casefold():
                    raise PromptRejectedBeforeDispatch("invalid_command", "命令与原始输入不一致。")
                text = "/" + command + match[2]
            if command == "bash" and not await self.authorize_bash(session_id, text[5:].strip()):
                return {"ok": False, "executionStarted": False, "code": "permission_denied", "message": "当前权限或用户审批未允许此命令。"}
            result = await super().prompt(session_id, text, "command")
            return {"ok": True, "result": result}
        if method == "aa/operate":
            operation = values["operation"]
            if operation == "authentication.status":
                result = {"message": "模型认证由此 Pi 实例的模型网关配置提供。"}
            elif operation == "resources.get":
                result = {"commands": self.commands.get(session_id, [])}
            else:
                raise AcpError("unsupported_operation", "Pi 尚未提供此操作。")
            return {"operationId": values["operationId"], "phase": "completed", "result": result}
        return await super().extension(method, values)
