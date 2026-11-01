"""Antigravity ACP Bridge — bridges Antigravity CLI into ACP (Agent Client Protocol)."""

from __future__ import annotations

import asyncio
import os
import re
import subprocess
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
    SessionConfigOptionSelect,
    SessionMode,
    SessionModeState,
    SetSessionConfigOptionResponse,
)

from .catalogs import (
    ANTIGRAVITY_PERMISSION_OPTIONS,
    ANTIGRAVITY_REASONING_LEVELS,
    load_antigravity_model_catalog,
)
from .discovery import discover_antigravity

# 配置项 id ↔ 桥接内部状态；selectionCategory 经 _meta 让上层把 legacy
# 选择（model/effort/permission）唯一映射到配置项（与 zcode bridge 同机制）。
PERMISSION_BYPASS = "bypassPermissions"
PERMISSION_DEFAULT = "default"
DEFAULT_EFFORT = "medium"


LOCAL_PROXY_PORTS = (7897, 7890, 1087, 8118, 9090)
PROXY_ENV_KEYS = ("ANTIGRAVITY_CLI_PROXY", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")


def resolve_proxy() -> str | None:
    """Antigravity 云端点在国内直连不可达，CLI 是 Go 程序、不走 macOS 系统代理。

    优先用显式环境变量；否则探测本机常见代理端口（Clash 混合端口等）。
    """
    for key in PROXY_ENV_KEYS:
        value = os.environ.get(key, "").strip()
        if value:
            return value
    import socket

    for port in LOCAL_PROXY_PORTS:
        with socket.socket() as probe:
            probe.settimeout(0.15)
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return f"http://127.0.0.1:{port}"
    return None


def cli_environment() -> dict[str, str]:
    env = dict(os.environ)
    proxy = resolve_proxy()
    if proxy:
        for key in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
                    "https_proxy", "http_proxy", "all_proxy"):
            env.setdefault(key, proxy)
    return env


def _model_options() -> list[dict[str, str]]:
    """模型目录与 App 端选择器同源，保证 selectionId 可直接校验。"""
    catalog = load_antigravity_model_catalog("antigravity")
    return [{"value": model.id, "name": model.title or model.id} for model in catalog.models]


def _config_options(
    model: str | None = None,
    effort: str | None = None,
    permission: str | None = None,
) -> list[SessionConfigOptionSelect]:
    models = _model_options()
    current_model = model or (models[0]["value"] if models else None)
    efforts = [{"value": eid, "name": etitle} for eid, etitle in ANTIGRAVITY_REASONING_LEVELS]
    current_effort = effort if effort in {item["value"] for item in efforts} else DEFAULT_EFFORT
    permissions = [{"value": pid, "name": pname} for pid, pname in ANTIGRAVITY_PERMISSION_OPTIONS]
    current_permission = (
        permission
        if permission in {item["value"] for item in permissions}
        else PERMISSION_BYPASS
    )
    options = []
    if models and current_model:
        options.append(
            SessionConfigOptionSelect(
                id="model",
                name="模型",
                type="select",
                options=models,
                currentValue=current_model,
                field_meta={"aa": {"selectionCategory": "model"}},
            )
        )
    options.append(
        SessionConfigOptionSelect(
            id="reasoning_effort",
            name="推理强度",
            type="select",
            options=efforts,
            currentValue=current_effort,
            field_meta={"aa": {"selectionCategory": "effort"}},
        )
    )
    options.append(
        SessionConfigOptionSelect(
            id="permission",
            name="权限模式",
            type="select",
            options=permissions,
            currentValue=current_permission,
            field_meta={"aa": {"selectionCategory": "permission"}},
        )
    )
    return options


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
            agent_info=Implementation(name="Antigravity", version="1.3.0"),
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
            "config": {
                "model": None,
                "reasoning_effort": DEFAULT_EFFORT,
                "permission": PERMISSION_BYPASS,
            },
        }
        modes = SessionModeState(
            current_mode_id=PERMISSION_BYPASS,
            available_modes=[
                SessionMode(
                    id=PERMISSION_BYPASS,
                    name="完全访问",
                    description="不受限制地使用工具",
                ),
                SessionMode(
                    id=PERMISSION_DEFAULT,
                    name="变更前确认",
                    description="修改前确认",
                ),
            ],
        )
        return NewSessionResponse(
            session_id=session_id,
            modes=modes,
            config_options=_config_options(),
        )

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
                "config": {
                    "model": None,
                    "reasoning_effort": DEFAULT_EFFORT,
                    "permission": PERMISSION_BYPASS,
                },
            }
        session = self.sessions[session_id]
        # "ag-<conversation id>" = AA 导入的桌面原生会话，直接绑定引擎对话。
        if session.get("conversation_id") is None and session_id.startswith("ag-"):
            session["conversation_id"] = session_id[len("ag-"):]
        return ResumeSessionResponse(session_id=session_id)

    async def set_config_option(
        self, config_id: str, session_id: str, value: str | bool, **kwargs: Any
    ) -> SetSessionConfigOptionResponse | None:
        session = self.sessions.get(session_id)
        if not session:
            session = {
                "cwd": os.getcwd(),
                "conversation_id": None,
                "config": {
                    "model": None,
                    "reasoning_effort": DEFAULT_EFFORT,
                    "permission": PERMISSION_BYPASS,
                },
            }
            self.sessions[session_id] = session
        config = session["config"]
        if config_id not in config or not isinstance(value, str):
            return None
        config[config_id] = value
        return SetSessionConfigOptionResponse(
            config_options=_config_options(
                model=config.get("model"),
                effort=config.get("reasoning_effort"),
                permission=config.get("permission"),
            )
        )

    async def prompt(
        self,
        session_id: str,
        prompt: list[Any],
        **kwargs: Any,
    ) -> PromptResponse:
        session = self.sessions.get(session_id)
        if not session:
            session = {
                "cwd": os.getcwd(),
                "conversation_id": None,
                "config": {
                    "model": None,
                    "reasoning_effort": DEFAULT_EFFORT,
                    "permission": PERMISSION_BYPASS,
                },
            }
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

        config = session.get("config") or {}

        # Create temp log file to track created conversation ID
        with tempfile.NamedTemporaryFile(prefix="antigravity_cli_", suffix=".log", delete=False) as tf:
            log_path = tf.name

        cmd = [launch.executable]
        if config.get("permission") == PERMISSION_BYPASS:
            cmd.append("--dangerously-skip-permissions")
        if config.get("model"):
            cmd.extend(["--model", str(config["model"])])
        if config.get("reasoning_effort"):
            cmd.extend(["--effort", str(config["reasoning_effort"])])
        cmd.extend(["--log-file", log_path])
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
                    env=cli_environment(),
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
