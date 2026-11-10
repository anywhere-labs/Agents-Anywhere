"""Command Code through its own ``cmdc acp`` server."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from ...domain.agents import AcpAgentDefinition, ConfigSchema, Executable
from ...domain.definitions import AcpError, LaunchDefinition
from ...domain.dialect import AcpDialect
from .installation import resolve_command_code

PERMISSION_OPTION = "aa-permission"
COMMAND_CODE_PERMISSION_MODES = (
    ("default", "标准（写入与命令审批）"),
    ("auto-accept", "自动接受编辑"),
    ("plan", "计划模式（只读）"),
    ("dont-ask", "不询问（保留安全限制）"),
    ("bypass", "跳过所有权限检查"),
)
PERMISSIONS = frozenset(value for value, _ in COMMAND_CODE_PERMISSION_MODES)

CONFIG_SCHEMA = ConfigSchema(
    schema={
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "cliPath": {
                "type": "string",
                "title": "Command Code CLI path",
                "description": (
                    "Optional path to cmdc, command-code, or the package's "
                    "dist/index.mjs. Leave empty to detect the CLI."
                ),
                "metadata": {
                    "i18n": {
                        "labelKey": (
                            "dashboard.device.runtimeConfigFields."
                            "commandCodeCliPath.label"
                        ),
                        "descriptionKey": (
                            "dashboard.device.runtimeConfigFields."
                            "commandCodeCliPath.description"
                        ),
                    }
                },
                "maxLength": 4096,
            },
        },
    },
    ui_schema={
        "order": ["cliPath"],
        "fields": {"cliPath": {"component": "path"}},
    },
    defaults={"cliPath": ""},
)


class CommandCodeDialect(AcpDialect):
    """Command Code's permission modes and stable error meanings."""

    def __init__(self):
        self.modes: dict[str, str] = {}

    def adapt_configuration(self, session_id, options):
        if any(item.get("id") == PERMISSION_OPTION for item in options):
            return options
        return [
            *options,
            {
                "id": PERMISSION_OPTION,
                "name": "权限",
                "description": "写入与命令的审批方式",
                "category": "permission",
                "type": "select",
                "currentValue": self.modes.get(session_id, "default"),
                "options": [
                    {"value": value, "name": name}
                    for value, name in COMMAND_CODE_PERMISSION_MODES
                ],
            },
        ]

    def verify_session(self, session_id, result):
        current = (result.get("modes") or {}).get("currentModeId")
        if isinstance(current, str) and current in PERMISSIONS:
            self.modes[session_id] = current

    async def configure(self, client, session_id, key, value):
        if key != PERMISSION_OPTION:
            return None
        if value not in PERMISSIONS:
            raise AcpError("invalid_permission", "权限选项无效。")
        setter = getattr(client.connection, "set_session_mode", None) or getattr(
            client.connection, "set_mode", None
        )
        if setter is None:
            raise AcpError(
                "commandcode_mode_unsupported", "当前 ACP SDK 不支持切换会话模式。"
            )
        await setter(session_id, value)
        self.modes[session_id] = value
        return client.configuration.get(session_id, [])

    def classify_error(self, error, phase):
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
        return None


def normalize_config(values: Mapping[str, Any], normalized: dict) -> dict:
    """Reject an unusable CLI at add time instead of on the first session."""
    resolve_command_code(dict(values))
    return normalized


def prepare_launch(context):
    async def prepare() -> LaunchDefinition:
        installation = await asyncio.to_thread(
            resolve_command_code, dict(context.config.values)
        )
        return LaunchDefinition(
            installation.executable,
            (*installation.arguments, "--no-auto-update", "acp"),
            f"command-code-{installation.version}",
            environment=installation.environment,
        )

    return prepare


COMMAND_CODE = AcpAgentDefinition(
    runtime_type="commandcode",
    display_name="Command Code",
    description="Command Code coding agent (ACP over stdio)",
    executable=Executable("cmdc"),
    arguments=("--no-auto-update", "acp"),
    config_schema=CONFIG_SCHEMA,
    normalize_config=normalize_config,
    permission_options=COMMAND_CODE_PERMISSION_MODES,
    runtime_capabilities=("runtime.attachment",),
    metadata={"localInstallation": True, "nativeHistory": False},
    dialect=lambda _context: CommandCodeDialect(),
    prepare_launch=prepare_launch,
)
