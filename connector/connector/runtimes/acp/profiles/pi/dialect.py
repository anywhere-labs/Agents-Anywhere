"""Pi's differences from standard ACP, as hooks around the shared engine."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

from acp import RequestError

from ...domain.definitions import AcpError, PromptRejectedBeforeDispatch
from ...domain.dialect import AcpDialect, ExtensionSteer
from .settings import private_json

GUARD = Path(__file__).with_name("permissions.mjs").resolve()
PERMISSIONS = {"ask", "ask_all", "readonly"}
PERMISSION_OPTION = "aa-permission"


def model_unavailable(error: RequestError) -> bool:
    return "pi_model_unavailable" in str(error.data)


class PiDialect(AcpDialect):
    # AA loads its own approval guard into Pi, so tool permissions are AA-managed.
    guarantees = frozenset({"managed_tool_permissions"})
    steer = ExtensionSteer("session/steering")

    def __init__(self, *, agent_dir: Path, permission_file: Path | None = None):
        self.agent_dir = agent_dir
        self.permission_file = permission_file or agent_dir / "aa-permissions.json"
        self.permissions: dict[str, str] = {}
        self.native_files: dict[str, str | None] = {}

    # Capabilities

    def capabilities(self, initialized):
        return (
            "session.commands",
            "runtime.attachment",
            "session.resources.read",
            "session.authentication.read",
        )

    def supports_steer(self, initialized):
        return bool(initialized.get("_meta", {}).get("steering", {}).get("supported"))

    # Configuration and permissions

    def adapt_configuration(self, session_id, options):
        return [
            *options,
            {
                "id": PERMISSION_OPTION,
                "name": "权限",
                "category": "permission",
                "type": "select",
                "currentValue": self.permissions.get(session_id, "ask"),
                "options": [
                    {"value": "ask", "name": "写入与命令审批"},
                    {"value": "ask_all", "name": "全部工具审批"},
                    {"value": "readonly", "name": "只读"},
                ],
            },
        ]

    def save_permission(self, session_id, value):
        path = self.permission_file
        current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        current[session_id] = value
        private_json(path, current)
        self.permissions[session_id] = value

    async def configure(self, client, session_id, key, value):
        if key != PERMISSION_OPTION:
            return None
        if value not in PERMISSIONS:
            raise AcpError("invalid_permission", "权限选项无效。")
        self.save_permission(session_id, value)
        return client.configuration.get(session_id, [])

    async def prepare_resume(self, session_id, metadata):
        permission = metadata.get("aa", {}).get("permission")
        if permission in PERMISSIONS:
            self.save_permission(session_id, permission)

    def verify_session(self, session_id, result):
        metadata = result.get("_meta", {}).get("pi", {})
        extensions = metadata.get("extensions", [])
        if (
            not extensions
            or extensions[0].get("path") != str(GUARD)
            or not metadata.get("aaLoadingReport", {}).get("mandatoryGuard")
        ):
            raise AcpError(
                "pi_permissions_unavailable", "Pi 工具审批扩展未能加载，已阻止执行。"
            )
        if self.permission_file.exists():
            self.permissions.update(json.loads(self.permission_file.read_text(encoding="utf-8")))
        self.native_files[session_id] = metadata.get("sessionFile")

    # Updates and interactions

    def translate_update(self, session_id, update):
        # Pi's message and tool ids are stable across replays.
        if update.get("messageId") or update.get("toolCallId"):
            update = {**update, "aaProjectionVerified": True}
        metadata = update.get("_meta", {}).get("pi", {})
        if (
            update.get("sessionUpdate") == "session_info_update"
            and metadata.get("event") == "extension_error"
            and metadata.get("extensionPath") == str(GUARD)
        ):
            raise AcpError("pi_permissions_failed", "Pi 审批守卫异常，执行已停止。")
        return update

    def acceptance_evidence(self, session_id, update):
        # The guard marks Pi's agent start before any model output.
        metadata = update.get("_meta", {}).get("pi", {})
        return (
            update.get("sessionUpdate") == "session_info_update"
            and metadata.get("event") == "status"
            and metadata.get("key") == "aa-prompt-started"
        )

    async def interaction(self, session_id, kind, request, ask):
        message = request.get("message", "")
        if kind != "form" or not message.startswith("AA_TOOL_PERMISSION\n"):
            return None
        tool = json.loads(message.split("\n", 1)[1])
        answer = await ask(
            session_id,
            "permission",
            {
                "toolCall": {
                    "toolCallId": tool["id"],
                    "title": tool["name"],
                    "kind": "other",
                    "status": "pending",
                    "rawInput": tool["input"],
                },
                "options": [
                    {"optionId": "allow", "name": "允许本次", "kind": "allow_once"},
                    {"optionId": "deny", "name": "拒绝", "kind": "reject_once"},
                ],
            },
        )
        return {
            "action": "accept",
            "content": {
                "confirmed": answer.get("action") == "accept" and answer.get("optionId") == "allow"
            },
        }

    # Input

    async def before_prompt(self, client, session_id, text, blocks, purpose):
        # Pi's native /bash runs outside the tool guard; check it the same way.
        if purpose == "steer" or text.lstrip().split(maxsplit=1)[0:1] != ["/bash"]:
            return
        if not await self.authorize_bash(client, session_id, text.lstrip()[5:].strip()):
            raise PromptRejectedBeforeDispatch(
                "permission_denied", "当前权限或用户审批未允许此命令。"
            )

    async def authorize_bash(self, client, session_id, command):
        if self.permissions.get(session_id, "ask") == "readonly":
            return False
        answer = await client.request_interaction(
            session_id,
            "permission",
            {
                "toolCall": {
                    "toolCallId": "bash-" + uuid4().hex,
                    "title": "bash",
                    "kind": "execute",
                    "status": "pending",
                    "rawInput": {"command": command},
                },
                "options": [
                    {"optionId": "allow", "name": "允许本次", "kind": "allow_once"},
                    {"optionId": "deny", "name": "拒绝", "kind": "reject_once"},
                ],
            },
        )
        return answer.get("action") == "accept" and answer.get("optionId") == "allow"

    async def extension(self, client, session_id, method, values):
        if method != "aa/operate":
            return None
        operation = values["operation"]
        if operation == "authentication.status":
            result = {"message": "模型认证来自此 Pi 执行来源的原生配置与环境。"}
        elif operation == "resources.get":
            result = {"commands": client.commands.get(session_id, [])}
        else:
            raise AcpError("unsupported_operation", "Pi 尚未提供此操作。")
        return {"operationId": values["operationId"], "phase": "completed", "result": result}

    # Errors

    def classify_error(self, error, phase):
        if not isinstance(error, RequestError):
            return None
        if phase == "open" and (error.code == -32000 or model_unavailable(error)):
            return AcpError(
                "pi_authentication_required",
                "Pi 没有可用的模型或认证：本机模式请先运行 pi 完成登录或模型配置，受管环境请检查模型网关。",
            )
        if phase == "resume" and error.code == -32000:
            return AcpError(
                "pi_authentication_required",
                "原生 Pi 的模型或认证不可用，请先在本机 pi 中完成配置和登录。",
            )
        if phase == "resume" and model_unavailable(error):
            return AcpError("pi_model_unavailable", "原会话模型不可用，请先恢复对应原生模型配置。")
        return None
