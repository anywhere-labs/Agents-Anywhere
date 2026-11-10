"""Command Code's ACP surface, mapped onto AA's session controls."""

from __future__ import annotations

from acp import RequestError

from ...domain.definitions import AcpError
from ...infrastructure.acp.client import AgentClient
from .profile import COMMAND_CODE_PERMISSION_MODES

PERMISSION_OPTION_ID = "aa-permission"
_SELECTION_CATEGORIES = {"model": "model", "thought_level": "effort"}


class CommandCodeClient(AgentClient):
    def __init__(self, on_update, on_interaction):
        self.configuration: dict[str, list[dict]] = {}
        self.modes: dict[str, str] = {}
        self.active_messages: dict[str, str] = {}
        self.message_text: dict[str, str] = {}
        self.message_attachments: dict[str, list] = {}
        self.observed: set[tuple[str, str]] = set()

        async def observed(session_id: str) -> None:
            message_id = self.active_messages.get(session_id)
            if not message_id or (session_id, message_id) in self.observed:
                return
            self.observed.add((session_id, message_id))
            await on_update(
                session_id,
                {
                    "sessionUpdate": "user_message_chunk",
                    "messageId": message_id,
                    "aaProjectionVerified": True,
                    "content": {
                        "type": "text",
                        "text": self.message_text.get(session_id, ""),
                    },
                    "_meta": {
                        "aa": {
                            "clientMessageId": message_id,
                            "boundary": True,
                            "attachments": self.message_attachments.get(
                                session_id, []
                            ),
                        }
                    },
                },
            )
            await on_update(
                session_id,
                {
                    "sessionUpdate": "aa_execution_observed",
                    "clientMessageId": message_id,
                },
            )

        async def update(session_id: str, value: dict) -> None:
            kind = value.get("sessionUpdate")
            if kind in {
                "agent_message_chunk",
                "agent_thought_chunk",
                "tool_call",
                "tool_call_update",
            }:
                await observed(session_id)
            if kind == "config_option_update":
                options = value.get("configOptions", [])
                self.configuration[session_id] = options
                value = {
                    **value,
                    "configOptions": self.options(session_id, options),
                }
            await on_update(session_id, value)

        super().__init__(update, on_interaction)

    def options(self, session_id: str, options: list[dict]) -> list[dict]:
        mapped = []
        for option in options:
            selection = _SELECTION_CATEGORIES.get(option.get("category", ""))
            if selection is None:
                mapped.append(option)
                continue
            metadata = dict(option.get("_meta") or {})
            aa = dict(metadata.get("aa") or {})
            aa["selectionCategory"] = selection
            metadata["aa"] = aa
            mapped.append({**option, "_meta": metadata})
        if self._mode_supported():
            mapped.append(self._permission_option(session_id))
        return mapped

    def _permission_option(self, session_id: str) -> dict:
        return {
            "id": PERMISSION_OPTION_ID,
            "name": "权限",
            "description": "写入与命令的审批方式",
            "category": "permission",
            "type": "select",
            "currentValue": self.modes.get(session_id, "default"),
            "options": [
                {"value": value, "name": name}
                for value, name in COMMAND_CODE_PERMISSION_MODES
            ],
        }

    def _mode_supported(self) -> bool:
        return bool(
            getattr(self.connection, "set_session_mode", None)
            or getattr(self.connection, "set_mode", None)
        )

    async def _set_mode(self, session_id: str, mode_id: str) -> None:
        setter = getattr(self.connection, "set_session_mode", None) or getattr(
            self.connection, "set_mode", None
        )
        if setter is None:
            raise AcpError(
                "commandcode_mode_unsupported", "当前 ACP SDK 不支持切换会话模式。"
            )
        await setter(session_id, mode_id)

    async def start(self, launch, cwd):
        result = await super().start(launch, cwd)
        aa = self.capabilities.setdefault("_meta", {}).setdefault("aa", {})
        prompt = self.capabilities.get("promptCapabilities") or {}
        aa["capabilities"] = (
            ["runtime.attachment"]
            if prompt.get("image") or prompt.get("embeddedContext")
            else []
        )
        return result

    async def open_session(self, cwd, **metadata):
        try:
            result = await super().open_session(cwd, **metadata)
        except RequestError as error:
            mapped = _request_error(error)
            if mapped is error:
                raise
            raise mapped from error
        session_id = result["sessionId"]
        self._remember(session_id, result)
        result["configOptions"] = self.options(
            session_id, result.get("configOptions", [])
        )
        return result

    async def resume(self, session_id, cwd, **metadata):
        try:
            result = await super().resume(session_id, cwd, **metadata)
        except RequestError as error:
            mapped = _request_error(error)
            if mapped is error:
                raise
            raise mapped from error
        self._remember(session_id, result)
        result["configOptions"] = self.options(
            session_id, result.get("configOptions", [])
        )
        return result

    def _remember(self, session_id: str, result: dict) -> None:
        self.configuration[session_id] = result.get("configOptions", [])
        current = (result.get("modes") or {}).get("currentModeId")
        if isinstance(current, str) and current:
            self.modes[session_id] = current

    async def configure(self, session_id, key, value):
        if key == PERMISSION_OPTION_ID:
            allowed = {mode for mode, _ in COMMAND_CODE_PERMISSION_MODES}
            if value not in allowed:
                raise AcpError("invalid_permission", "权限选项无效。")
            try:
                await self._set_mode(session_id, value)
            except RequestError as error:
                mapped = _request_error(error)
                if mapped is error:
                    raise
                raise mapped from error
            self.modes[session_id] = value
            return {
                "configOptions": self.options(
                    session_id, self.configuration.get(session_id, [])
                )
            }
        try:
            result = await super().configure(session_id, key, value)
        except RequestError as error:
            mapped = _request_error(error)
            if mapped is error:
                raise
            raise mapped from error
        self.configuration[session_id] = result.get("configOptions", [])
        result["configOptions"] = self.options(
            session_id, result.get("configOptions", [])
        )
        return result

    async def prompt(self, session_id, text, operation_id, blocks=None):
        self.active_messages[session_id] = operation_id
        self.message_text[session_id] = text
        self.message_attachments[session_id] = [
            block["_meta"]["aa"]["attachment"]
            for block in blocks or []
            if block.get("_meta", {}).get("aa", {}).get("attachment")
        ]
        try:
            return await super().prompt(session_id, text, operation_id, blocks)
        finally:
            self.active_messages.pop(session_id, None)
            self.message_text.pop(session_id, None)
            self.message_attachments.pop(session_id, None)
            self.observed.discard((session_id, operation_id))


def _request_error(error: RequestError) -> Exception:
    detail = f"{error} {getattr(error, 'data', '')}".lower()
    if "acp mod is disabled" in detail or "acp module is disabled" in detail:
        return AcpError(
            "commandcode_acp_disabled",
            "Command Code 的 ACP 模块被禁用：请从 settings.json 的 "
            "mods.disabled 中移除 acp。",
        )
    if (
        "auth_required" in detail
        or "not authenticated" in detail
        or "cmd login" in detail
    ):
        return AcpError(
            "commandcode_authentication_required",
            "Command Code 未登录：请先在终端运行 cmdc login，或设置 "
            "COMMAND_CODE_API_KEY。",
        )
    return error
