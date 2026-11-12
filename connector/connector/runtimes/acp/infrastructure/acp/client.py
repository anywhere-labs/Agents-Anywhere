from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass

from acp import RequestError, connect_to_agent
from acp.schema import (
    ClientCapabilities,
    ImageContentBlock,
    Implementation,
    ResourceContentBlock,
    TextContentBlock,
)

from ...domain.definitions import (
    AcpError,
    LaunchDefinition,
    PromptRejectedBeforeDispatch,
)
from ...domain.dialect import GENERIC_DIALECT, AcpDialect, ExtensionSteer
from ..processes import AgentProcess
from .callbacks import Callbacks
from .v1 import require_version, wire

# Updates that show the Agent is working on the current input.
EXECUTION_UPDATES = frozenset(
    {"agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"}
)
# ACP's ``auth_required`` JSON-RPC error.
AUTH_REQUIRED = -32000


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


def standard_options(options: list[dict]) -> list[dict]:
    """ACP calls reasoning effort ``thought_level``; AA calls it ``effort``."""
    return [
        {**option, "category": "effort"} if option.get("category") == "thought_level" else option
        for option in options
    ]


def generic_error(error: Exception, phase: str) -> AcpError:
    if isinstance(error, RequestError) and error.code == AUTH_REQUIRED:
        return AcpError(
            "agent_authentication_required",
            "Agent 需要先在本机完成登录或模型配置。",
        )
    if phase == "resume":
        return AcpError(
            "agent_session_unavailable",
            "Agent 无法恢复此会话：原会话可能已不存在，或 Agent 配置已变化。",
        )
    return AcpError(
        "agent_session_failed",
        "Agent 无法创建会话，请在本机检查它的模型与认证配置。",
    )


class AgentClient:
    """One ACP connection; the engine side every Agent shares.

    It owns acceptance evidence and the user message written for each input,
    derives session capabilities from the handshake, and serves commands and
    steering. Agent differences go through the dialect.
    """

    #: Raw JSON-RPC observers, used only to record verification traffic.
    stream_observers: tuple = ()

    def __init__(self, on_update, on_interaction, *, dialect: AcpDialect | None = None):
        self.dialect = dialect or GENERIC_DIALECT
        self.process = AgentProcess()
        self.emit = on_update
        self.ask = on_interaction
        self.callbacks = Callbacks(self.receive_update, self.request_interaction)
        self.connection = None
        self.capabilities = {}
        self.turns: dict[str, Turn] = {}
        self.commands: dict[str, list] = {}
        self.configuration: dict[str, list] = {}
        self.session_modes: dict[str, dict] = {}

    # Agent → AA

    async def receive_update(self, session_id, value):
        value = self.dialect.translate_update(session_id, value)
        if value is None:
            return
        kind = value.get("sessionUpdate")
        if kind in EXECUTION_UPDATES or self.dialect.acceptance_evidence(session_id, value):
            await self.observe(session_id)
        if kind == "available_commands_update":
            self.commands[session_id] = value.get("availableCommands", [])
            self.declare("session.commands")
        if kind == "current_mode_update" and self.uses_legacy_mode(session_id):
            self.session_modes[session_id]["currentModeId"] = value.get("currentModeId")
            await self.emit(session_id, {
                "sessionUpdate": "config_option_update",
                "configOptions": self.adapt(session_id, self.configuration.get(session_id, [])),
            })
            return
        if kind == "config_option_update":
            self.configuration[session_id] = value.get("configOptions", [])
            value = {**value, "configOptions": self.adapt(session_id, value.get("configOptions", []))}
        await self.emit(session_id, value)

    async def request_interaction(self, session_id, kind, request):
        if session_id:
            await self.observe(session_id)
        answer = await self.dialect.interaction(session_id, kind, request, self.ask)
        return answer if answer is not None else await self.ask(session_id, kind, request)

    async def observe(self, session_id):
        """Record that the Agent started on the current input, once per input."""
        turn = self.turns.get(session_id)
        if turn is None or turn.observed:
            return
        turn.observed = True
        # AA's own records go straight to the engine, never through the dialect.
        if not self.dialect.echoes_user_prompt:
            await self.emit(
                session_id, user_message(turn.message_id, turn.text, turn.attachments)
            )
        await self.emit(
            session_id,
            {"sessionUpdate": "aa_execution_observed", "clientMessageId": turn.message_id},
        )

    # Capabilities and configuration

    def declare(self, capability_id: str):
        aa = self.capabilities.setdefault("_meta", {}).setdefault("aa", {})
        declared = aa.setdefault("capabilities", [])
        if capability_id not in declared:
            declared.append(capability_id)

    def uses_legacy_mode(self, session_id: str) -> bool:
        mode = self.dialect.planning_mode
        return bool(
            mode and mode.legacy and session_id in self.session_modes
            and all(item.get("id") != mode.config_id for item in self.configuration.get(session_id, []))
        )

    def adapt(self, session_id: str, options: list[dict]) -> list[dict]:
        adapted = self.dialect.adapt_configuration(session_id, standard_options(options))
        mode = self.dialect.planning_mode
        if mode is not None:
            if self.uses_legacy_mode(session_id):
                legacy = self.session_modes[session_id]
                adapted = [*adapted, {
                    "id": mode.config_id, "category": "mode", "type": "select", "name": "Mode",
                    "currentValue": legacy.get("currentModeId"),
                    "options": [
                        {"value": item["id"], "name": item["name"]}
                        for item in legacy.get("availableModes", [])
                    ],
                }]
            return [
                {
                    **item,
                    "_meta": {
                        **(item.get("_meta") or {}),
                        "aa": {**((item.get("_meta") or {}).get("aa") or {}), "planningControl": True},
                    },
                }
                if item.get("id") == mode.config_id else item
                for item in adapted
            ]
        return adapted

    def adapt_session(self, session_id: str, result: dict) -> dict:
        self.configuration[session_id] = result.get("configOptions", [])
        if result.get("modes"):
            self.session_modes[session_id] = result["modes"]
        self.dialect.verify_session(session_id, result)
        return {**result, "configOptions": self.adapt(session_id, result.get("configOptions", []))}

    def attachment_metadata(self, session_id: str) -> dict:
        """Input modalities the current model declares in ``_meta.aa``, if any."""
        option = next(
            (item for item in self.configuration.get(session_id, []) if item.get("category") == "model"),
            {},
        )
        inputs = (option.get("_meta") or {}).get("aa", {}).get("modelInputModalities", {})
        current = inputs.get(option.get("currentValue")) if isinstance(inputs, dict) else None
        return {"inputModalities": current} if isinstance(current, list) else {}

    def check_input(self, session_id: str, blocks) -> None:
        modalities = self.attachment_metadata(session_id).get("inputModalities")
        if isinstance(modalities, list) and "image" not in modalities and any(
            block.get("type") == "image" for block in blocks or []
        ):
            raise PromptRejectedBeforeDispatch(
                "image_input_unsupported", "当前模型声明不支持图片输入，请移除图片或切换支持图片的模型。"
            )

    def classify(self, error: Exception, phase: str) -> AcpError:
        return self.dialect.classify_error(error, phase) or generic_error(error, phase)

    # Lifecycle

    async def start(self, launch: LaunchDefinition, cwd: str) -> dict:
        proc = await self.process.start(launch, cwd)
        # SDK 0.12 labels v1 elicitation/config options as optional unstable
        # methods. This enables that surface, not ACP protocol version 2.
        self.connection = connect_to_agent(
            self.callbacks, proc.stdin, proc.stdout, use_unstable_protocol=True
        )
        for observer in self.stream_observers:
            self.connection._conn.add_observer(observer)
        try:
            result = wire(
                await asyncio.wait_for(
                    self.connection.initialize(
                        protocol_version=1,
                        client_capabilities=ClientCapabilities.model_validate(
                            {
                                "elicitation": {"form": {}},
                                "session": {"configOptions": {"boolean": {}}},
                            }
                        ),
                        client_info=Implementation(name="agents-anywhere", version="1"),
                    ),
                    20,
                )
            )
            require_version(result)
            self.initialized(result)
            return result
        except BaseException:
            await self.close()
            raise

    def initialized(self, result: dict):
        """Narrow the dialect's ceiling to what the Agent declared in its handshake."""
        self.capabilities = result.get("agentCapabilities", {})
        aa = self.capabilities.setdefault("_meta", {}).setdefault("aa", {})
        aa.setdefault("capabilities", [])
        if self.capabilities.get("promptCapabilities", {}).get("image"):
            self.declare("runtime.attachment")
        if self.dialect.steer is not None and self.dialect.supports_steer(result):
            self.declare("session.steer")
        for capability_id in self.dialect.capabilities(result):
            self.declare(capability_id)
        aa["guarantees"] = sorted(set(aa.get("guarantees", [])) | set(self.dialect.guarantees))
        self.callbacks.guarantees = frozenset(aa["guarantees"])

    async def open_session(self, cwd: str, **metadata) -> dict:
        try:
            result = wire(
                await self.connection.new_session(cwd=cwd, mcp_servers=[], **metadata)
            )
        except RequestError as error:
            raise self.classify(error, "open") from error
        return self.adapt_session(result["sessionId"], result)

    async def resume(self, session_id: str, cwd: str, **metadata) -> dict:
        await self.dialect.prepare_resume(session_id, metadata)
        try:
            if self.capabilities.get("sessionCapabilities", {}).get("resume") is not None:
                result = wire(
                    await self.connection.resume_session(
                        session_id=session_id, cwd=cwd, mcp_servers=[], **metadata
                    )
                )
            elif self.capabilities.get("loadSession") is True:
                result = wire(
                    await self.connection.load_session(
                        session_id=session_id, cwd=cwd, mcp_servers=[], **metadata
                    )
                )
            else:
                raise AcpError("agent_resume_unsupported", "Agent 未提供会话恢复能力。")
        except RequestError as error:
            raise self.classify(error, "resume") from error
        return self.adapt_session(session_id, result)

    # Input

    async def prompt(self, session_id: str, text: str, operation_id: str, blocks=None) -> dict:
        self.check_input(session_id, blocks)
        await self.dialect.before_prompt(self, session_id, text, blocks, "prompt")
        self.turns[session_id] = Turn(operation_id, text, attachments_of(blocks))
        try:
            try:
                result = await self.send_prompt(session_id, text, operation_id, blocks)
            except RequestError as error:
                if self.callbacks.failure is not None or not self.dialect.prompt_cancelled(session_id, error):
                    raise
                result = {"stopReason": "cancelled"}
            await self.observe(session_id)
            return result
        finally:
            self.turns.pop(session_id, None)

    async def send_prompt(self, session_id: str, text: str, operation_id: str, blocks=None) -> dict:
        """One ``session/prompt`` without turn bookkeeping (commands and steering)."""
        result = wire(
            await self.connection.prompt(
                session_id=session_id,
                prompt=[TextContentBlock(type="text", text=text)]
                + [
                    (
                        ImageContentBlock
                        if block["type"] == "image"
                        else ResourceContentBlock
                    ).model_validate(block)
                    for block in (blocks or [])
                ],
                aa={"clientMessageId": operation_id},
            )
        )
        if self.callbacks.failure is not None:
            raise AcpError(
                "agent_projection_failed", "Agent 更新未能可靠保存，需要恢复校准。"
            ) from self.callbacks.failure
        return result

    async def steer(self, session_id: str, values: dict) -> dict:
        method = self.dialect.steer
        if method is None:
            raise AcpError("agent_capability_unsupported", "Agent 未提供此能力。")
        blocks = values.get("blocks") or []
        if blocks and not method.attachments:
            raise PromptRejectedBeforeDispatch(
                "agent_steer_attachments_unsupported", "当前 Agent 运行中追加指令暂不支持附件。"
            )
        self.check_input(session_id, blocks)
        await self.dialect.before_prompt(self, session_id, values["content"], blocks, "steer")
        message_id = values["clientMessageId"]
        if isinstance(method, ExtensionSteer):
            result = await self.connection.ext_method(
                method.method.removeprefix("_"),
                {
                    "sessionId": session_id,
                    "aa": {"clientMessageId": message_id},
                    "prompt": [{"type": "text", "text": values["content"]}, *blocks],
                },
            )
        else:
            result = {
                "outcome": "injected",
                "result": await self.send_prompt(
                    session_id, f"{method.command} {values['content']}", message_id
                ),
            }
        if result.get("outcome") == "injected":
            await self.emit(
                session_id, user_message(message_id, values["content"], attachments_of(blocks))
            )
        return result

    async def execute_command(self, session_id: str, values: dict) -> dict:
        command = values["command"].removeprefix("/")
        if command not in {item["name"] for item in self.commands.get(session_id, [])}:
            raise PromptRejectedBeforeDispatch("command_unavailable", "命令目录已变化，请刷新。")
        text = "/" + command + (" " + " ".join(values["args"]) if values.get("args") else "")
        if values.get("raw") is not None:
            # Keep the user's own quoting and line breaks.
            match = re.fullmatch(r"\s*/([^\s]+)([\s\S]*)", values["raw"])
            if not match or match[1].casefold() != command.casefold():
                raise PromptRejectedBeforeDispatch("invalid_command", "命令与原始输入不一致。")
            text = "/" + command + match[2]
        try:
            await self.dialect.before_prompt(self, session_id, text, None, "command")
        except PromptRejectedBeforeDispatch as error:
            return {
                "ok": False,
                "executionStarted": False,
                "code": error.code,
                "message": str(error),
            }
        return {"ok": True, "result": await self.send_prompt(session_id, text, "command")}

    async def configure(self, session_id: str, key: str, value: str | bool) -> dict:
        mode = self.dialect.planning_mode
        if mode is not None and key == mode.config_id and self.uses_legacy_mode(session_id):
            await self.connection.set_session_mode(session_id=session_id, mode_id=value)
            self.session_modes[session_id]["currentModeId"] = value
            return {"configOptions": self.adapt(session_id, self.configuration.get(session_id, []))}
        options = await self.dialect.configure(self, session_id, key, value)
        if options is None:
            result = wire(
                await self.connection.set_config_option(
                    session_id=session_id, config_id=key, value=value
                )
            )
            options = result.get("configOptions", [])
            self.configuration[session_id] = options
        return {"configOptions": self.adapt(session_id, options)}

    async def list_sessions(self, cwd=None, cursor=None) -> dict:
        return wire(await self.connection.list_sessions(cwd=cwd, cursor=cursor))

    async def interrupt(self, session_id: str):
        await self.connection.cancel(session_id=session_id)

    async def close_session(self, session_id: str):
        if self.capabilities.get("sessionCapabilities", {}).get("close") is not None:
            await asyncio.wait_for(
                self.connection.close_session(session_id=session_id), 15
            )

    async def extension(self, method: str, values: dict):
        session_id = values.get("sessionId")
        handled = await self.dialect.extension(self, session_id, method, values)
        if handled is not None:
            return handled
        if method == "aa/steer":
            return await self.steer(session_id, values)
        if method == "aa/list_commands":
            return {"commands": self.commands.get(session_id, [])}
        if method == "aa/execute_command":
            return await self.execute_command(session_id, values)
        return await self.connection.ext_method(method.removeprefix("_"), values)

    async def close(self):
        try:
            if self.connection:
                await self.connection.close()
        finally:
            await self.process.close()
