"""Antigravity ACP Bridge — bridges Antigravity CLI into ACP (Agent Client Protocol)."""

from __future__ import annotations

import asyncio
import os
import re
import subprocess
import sys
import tempfile
import uuid
from typing import Any

import acp
from acp.schema import (
    AgentCapabilities,
    ClientCapabilities,
    Implementation,
    InitializeResponse,
    NewSessionResponse,
    PromptResponse,
    ResumeSessionResponse,
    SessionCapabilities,
    SessionMode,
    SessionModeState,
)

from .discovery import discover_antigravity


class AntigravityAgent:
    def __init__(self) -> None:
        self.client: acp.Client | None = None
        self.sessions: dict[str, dict[str, Any]] = {}
        self.current_proc: subprocess.Popen | None = None

    def on_connect(self, conn: acp.Client) -> None:
        self.client = conn

    async def initialize(
        self,
        protocol_version: int,
        client_capabilities: ClientCapabilities | None = None,
        client_info: Implementation | None = None,
        **kwargs: Any,
    ) -> InitializeResponse:
        caps = AgentCapabilities(
            session_capabilities=SessionCapabilities(
                list={},
                resume={},
                close={},
            ),
        )
        return InitializeResponse(
            protocol_version=1,
            agent_capabilities=caps,
            agent_info=Implementation(name="Antigravity", version="1.2.10"),
        )

    async def new_session(
        self,
        cwd: str,
        additional_directories: list[str] | None = None,
        mcp_servers: list[Any] | None = None,
        **kwargs: Any,
    ) -> NewSessionResponse:
        session_id = str(uuid.uuid4())
        self.sessions[session_id] = {
            "cwd": cwd or os.getcwd(),
            "conversation_id": None,
        }
        modes = SessionModeState(
            current_mode_id="bypassPermissions",
            available_modes=[
                SessionMode(
                    id="bypassPermissions",
                    name="完全访问",
                    description="不受限制地使用工具",
                ),
                SessionMode(
                    id="default",
                    name="变更前确认",
                    description="修改前确认",
                ),
            ],
        )
        return NewSessionResponse(session_id=session_id, modes=modes)

    async def resume_session(
        self,
        session_id: str,
        cwd: str,
        additional_directories: list[str] | None = None,
        mcp_servers: list[Any] | None = None,
        **kwargs: Any,
    ) -> ResumeSessionResponse:
        if session_id not in self.sessions:
            self.sessions[session_id] = {
                "cwd": cwd or os.getcwd(),
                "conversation_id": None,
            }
        return ResumeSessionResponse(session_id=session_id)

    async def prompt(
        self,
        session_id: str,
        prompt: list[Any],
        **kwargs: Any,
    ) -> PromptResponse:
        session = self.sessions.get(session_id)
        if not session:
            session = {"cwd": os.getcwd(), "conversation_id": None}
            self.sessions[session_id] = session

        text_parts = []
        for block in prompt:
            if hasattr(block, "text") and block.text:
                text_parts.append(block.text)
            elif isinstance(block, dict) and block.get("text"):
                text_parts.append(block["text"])
            elif isinstance(block, str):
                text_parts.append(block)

        user_text = "\n".join(text_parts).strip() or "Hello"

        launch = discover_antigravity()
        if not launch:
            if self.client:
                await self.client.session_update(
                    session_id=session_id,
                    update=acp.update_agent_message_text("未找到 Antigravity CLI 安装。"),
                )
            return PromptResponse(stop_reason="end_turn")

        # Create temp log file to track created conversation ID
        with tempfile.NamedTemporaryFile(prefix="antigravity_cli_", suffix=".log", delete=False) as tf:
            log_path = tf.name

        cmd = [launch.executable, "--dangerously-skip-permissions", "--log-file", log_path]
        if session.get("conversation_id"):
            cmd.extend(["--conversation", session["conversation_id"]])
        if session.get("cwd"):
            cmd.extend(["--add-dir", session["cwd"]])
        cmd.extend(["--print", user_text])

        try:
            loop = asyncio.get_running_loop()
            proc = await loop.run_in_executor(
                None,
                lambda: subprocess.Popen(
                    cmd,
                    cwd=session.get("cwd") or None,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    bufsize=1,
                ),
            )
            self.current_proc = proc

            def read_output():
                lines = []
                for line in proc.stdout:
                    lines.append(line)
                proc.wait()
                return "".join(lines)

            output_text = await loop.run_in_executor(None, read_output)

            # Send output message chunk to client
            if self.client and output_text:
                await self.client.session_update(
                    session_id=session_id,
                    update=acp.update_agent_message_text(output_text),
                )

            # Extract created conversation ID from log file
            if os.path.exists(log_path):
                try:
                    with open(log_path, "r", encoding="utf-8", errors="ignore") as f:
                        log_content = f.read()
                    match = re.search(r"Created conversation ([0-9a-fA-F-]+)", log_content)
                    if match:
                        session["conversation_id"] = match.group(1)
                except Exception:
                    pass
                try:
                    os.unlink(log_path)
                except Exception:
                    pass

        except Exception as e:
            if self.client:
                await self.client.session_update(
                    session_id=session_id,
                    update=acp.update_agent_message_text(f"执行出错: {e}"),
                )
        finally:
            self.current_proc = None

        return PromptResponse(stop_reason="end_turn")

    async def cancel(self, session_id: str, **kwargs: Any) -> None:
        if self.current_proc and self.current_proc.poll() is None:
            try:
                self.current_proc.terminate()
            except Exception:
                pass


async def main() -> None:
    agent = AntigravityAgent()
    await acp.run_agent(agent, use_unstable_protocol=True)


if __name__ == "__main__":
    asyncio.run(main())
