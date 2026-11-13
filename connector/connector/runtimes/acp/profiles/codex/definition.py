"""Codex through the extended ``codex-acp`` adapter.

The adapter serves ordinary Codex sessions from its own App Server and, with
``CODEX_ACP_IPC_SOCKET`` set, follows conversations a Codex App or IDE window
already owns. Everything below is opt-in ``_meta`` the adapter documents in its
``docs/ipc-following.md`` and ``docs/steering.md``; nothing here changes how
the shared engine owns sessions, acceptance or history.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
from collections import deque
from dataclasses import replace
from pathlib import Path

from acp import RequestError

from ...domain.agents import AcpAgentDefinition, ConfigSchema, Executable, PathSetting
from ...domain.definitions import AcpError
from ...domain.dialect import AcpDialect, ExtensionSteer
from ...infrastructure.launch import local_launch

# codex-acp's approval and sandbox preset; AA calls that a permission.
MODE_OPTION = "mode"
# The adapter rejects any other message identity on followed sessions.
CLIENT_MESSAGE_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
# AA input identities remembered per session to recognize the owner's echo.
REMEMBERED_MESSAGES = 256
IPC_SOCKET = "CODEX_ACP_IPC_SOCKET"


def ipc_capabilities(initialized: dict) -> dict:
    value = (initialized.get("_meta") or {}).get("codexIpc")
    return value if isinstance(value, dict) else {}


def owner_unavailable(error: RequestError) -> bool:
    return "codex_owner_unavailable" in str(error.data)


class CodexDialect(AcpDialect):
    """codex-acp's differences from standard ACP, as hooks around the shared engine."""

    steer = ExtensionSteer("session/steering")

    def __init__(self):
        self.sent: dict[str, deque[str]] = {}
        self.followed: set[str] = set()

    # Handshake and routing

    def initialize_meta(self):
        # Without this opt-in the adapter leaves approvals, questions and
        # settings of a followed conversation with its owner window.
        return {"codexIpc": {"approvals": True, "settings": True}}

    def request_meta(self, initialized, method, session_id, message_id=None):
        meta: dict = {}
        if method in {"session/resume", "session/load"}:
            # ``auto`` follows a live owner window, resumes an unheld thread on the
            # adapter's App Server and refuses when neither path is verified.
            if ipc_capabilities(initialized).get("automaticRouting"):
                meta["codexIpc"] = {"mode": "auto"}
        elif method in {"session/prompt", "steer"} and message_id:
            if CLIENT_MESSAGE_ID.fullmatch(message_id):
                self.remember(session_id, message_id)
                meta["codexIpc"] = {"clientMessageId": message_id}
            if method == "steer":
                # Keep AA's prompt lifecycle: an idle steer is refused, not turned into a turn.
                meta["steering"] = {"idleBehavior": "promptRequired"}
        return meta

    def remember(self, session_id, message_id):
        sent = self.sent.setdefault(session_id, deque(maxlen=REMEMBERED_MESSAGES))
        if message_id not in sent:
            sent.append(message_id)

    async def after_open(self, client, session_id, result):
        # The resume response does not say which route the adapter chose; only
        # followed conversations have the owner's queue.
        self.followed.discard(session_id)
        if not ipc_capabilities(client.handshake).get("queue"):
            return
        try:
            route = await client.connection.ext_method("codex/session/inspect", {"sessionId": session_id})
        except Exception:  # noqa: BLE001 -- an unknown route keeps the queue unavailable
            return
        if route.get("route") == "follow":
            self.followed.add(session_id)
            client.declare("session.queue.read")
            client.declare("session.queue.update")

    # Capabilities and configuration

    def capabilities(self, initialized):
        return ("session.commands", "session.resources.read", "session.authentication.read")

    def supports_steer(self, initialized):
        return bool((initialized.get("_meta") or {}).get("steering", {}).get("supported"))

    def adapt_configuration(self, session_id, options):
        return [
            {**option, "category": "permission"}
            if option.get("id") == MODE_OPTION and option.get("category") == "mode"
            else option
            for option in options
        ]

    # Updates

    def translate_update(self, session_id, update):
        if update.get("sessionUpdate") != "user_message_chunk":
            return update
        metadata = update.get("_meta") or {}
        native = metadata.get("codexIpc") or {}
        if native.get("clientMessageId") in self.sent.get(session_id, ()):
            # The owner's echo of AA's own input: AA already recorded that message.
            return None
        if not native.get("messageId"):
            return update
        # Input typed in the owner window: one complete message with a stable id.
        return {
            **update,
            "messageId": native["messageId"],
            "aaProjectionVerified": True,
            "_meta": {**metadata, "aa": {**metadata.get("aa", {}), "boundary": True}},
        }

    # Operations

    async def extension(self, client, session_id, method, values):
        if method == "aa/read_history":
            return await client.connection.ext_method("codex/session/read", {"sessionId": session_id})
        if method != "aa/operate":
            return None
        operation = values["operation"]
        if operation == "authentication.status":
            result = {"message": "Codex 的登录与模型配置来自本机 Codex。"}
        elif operation == "resources.get":
            result = {"commands": client.commands.get(session_id, [])}
        elif operation in {"queue.get", "queue.clear"}:
            if session_id not in self.followed:
                raise AcpError("agent_capability_unsupported", "只有跟随 Codex App 或 IDE 的会话才有原窗口队列。")
            result = await client.connection.ext_method(
                "codex/session/queue",
                {"sessionId": session_id, "action": "read" if operation == "queue.get" else "clear"},
            )
        else:
            raise AcpError("unsupported_operation", "Codex 尚未提供此操作。")
        return {"operationId": values["operationId"], "phase": "completed", "result": result}

    # Errors

    def classify_error(self, error, phase):
        if isinstance(error, RequestError) and phase == "resume" and owner_unavailable(error):
            return AcpError(
                "codex_owner_unavailable",
                "原会话正被其他 Codex 窗口或进程占用，但当前连不上它。请保持原窗口打开并恢复连接后重试。",
            )
        return None


def default_ipc_socket(values: dict) -> str:
    """Where a Codex App or IDE window listens; the adapter connects lazily."""
    if sys.platform == "win32":
        return r"\\.\pipe\codex-ipc"
    home = values.get("codexHome") or os.environ.get("CODEX_HOME") or "~/.codex"
    return str(Path(home).expanduser() / "ipc" / "ipc.sock")


def prepare_launch(context):
    async def prepare():
        values = dict(context.config.values)
        launch = await asyncio.to_thread(local_launch, context.definition, values)
        # Kept verbatim: a Windows named pipe is not a filesystem path.
        socket = values.get("ipcSocket") or default_ipc_socket(values)
        return replace(launch, environment=(*launch.environment, (IPC_SOCKET, socket)))

    return prepare


def codex_runtime(context, client_factory):
    from ...provider import validated_runtime
    from .runtime import CodexAcpRuntime

    return validated_runtime(context, client_factory, runtime_class=CodexAcpRuntime)


SETTINGS = (
    PathSetting("codexHome", "Codex 配置目录（可选）", "CODEX_HOME"),
    PathSetting("codexPath", "本机 codex 路径（可选）", "CODEX_PATH"),
)
CONFIG_SCHEMA = ConfigSchema(
    schema={
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "cliPath": {"type": "string", "title": "本机 codex-acp 路径（可选）", "maxLength": 4096},
            **{
                setting.key: {"type": "string", "title": setting.title, "maxLength": 4096}
                for setting in SETTINGS
            },
            "ipcSocket": {"type": "string", "title": "Codex App IPC 地址（可选）", "maxLength": 4096},
        },
    },
    ui_schema={"order": ["cliPath", "codexHome", "codexPath", "ipcSocket"], "fields": {}},
)

CODEX = AcpAgentDefinition(
    runtime_type="codex-acp",
    display_name="Codex (ACP)",
    description="通过 codex-acp 运行 Codex，并可继续 Codex App 或 IDE 中已打开的会话。",
    executable=Executable("codex-acp", candidates=("~/.local/bin/codex-acp",)),
    version=("--version",),
    settings=SETTINGS,
    config_schema=CONFIG_SCHEMA,
    maturity="experimental",
    metadata={"localInstallation": True, "nativeHistory": True},
    dialect=lambda _context: CodexDialect(),
    prepare_launch=prepare_launch,
    runtime=codex_runtime,
)
