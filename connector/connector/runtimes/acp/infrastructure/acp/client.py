from __future__ import annotations

import asyncio

from acp import connect_to_agent
from acp.schema import (
    ClientCapabilities,
    ImageContentBlock,
    Implementation,
    ResourceContentBlock,
    TextContentBlock,
)

from ...domain.definitions import AcpError, LaunchDefinition
from ..processes import AgentProcess
from .callbacks import Callbacks
from .v1 import require_version, wire


class AgentClient:
    def __init__(self, on_update, on_interaction):
        self.process = AgentProcess()
        self.callbacks = Callbacks(on_update, on_interaction)
        self.connection = None
        self.capabilities = {}

    async def start(self, launch: LaunchDefinition, cwd: str) -> dict:
        proc = await self.process.start(launch, cwd)
        # SDK 0.12 labels v1 elicitation/config options as optional unstable
        # methods. This enables that surface, not ACP protocol version 2.
        self.connection = connect_to_agent(
            self.callbacks, proc.stdin, proc.stdout, use_unstable_protocol=True
        )
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
            self.capabilities = result.get("agentCapabilities", {})
            self.callbacks.guarantees = frozenset(
                self.capabilities.get("_meta", {}).get("aa", {}).get("guarantees", [])
            )
            return result
        except BaseException:
            await self.close()
            raise

    async def open_session(self, cwd: str, **metadata) -> dict:
        return wire(
            await self.connection.new_session(cwd=cwd, mcp_servers=[], **metadata)
        )

    async def prompt(
        self, session_id: str, text: str, operation_id: str, blocks=None
    ) -> dict:
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

    async def configure(self, session_id: str, key: str, value: str | bool) -> dict:
        return wire(
            await self.connection.set_config_option(
                session_id=session_id, config_id=key, value=value
            )
        )

    async def list_sessions(self, cwd=None, cursor=None) -> dict:
        return wire(await self.connection.list_sessions(cwd=cwd, cursor=cursor))

    async def resume(self, session_id: str, cwd: str, **metadata) -> dict:
        if self.capabilities.get("sessionCapabilities", {}).get("resume") is not None:
            return wire(
                await self.connection.resume_session(
                    session_id=session_id, cwd=cwd, mcp_servers=[], **metadata
                )
            )
        if self.capabilities.get("loadSession") is True:
            return wire(
                await self.connection.load_session(
                    session_id=session_id, cwd=cwd, mcp_servers=[], **metadata
                )
            )
        raise AcpError("agent_resume_unsupported", "Agent 未提供会话恢复能力。")

    async def interrupt(self, session_id: str):
        await self.connection.cancel(session_id=session_id)

    async def close_session(self, session_id: str):
        if self.capabilities.get("sessionCapabilities", {}).get("close") is not None:
            await asyncio.wait_for(
                self.connection.close_session(session_id=session_id), 15
            )

    async def extension(self, method: str, values: dict):
        return await self.connection.ext_method(method.removeprefix("_"), values)

    async def close(self):
        try:
            if self.connection:
                await self.connection.close()
        finally:
            await self.process.close()
