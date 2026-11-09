"""Hermes Agent through its own ``hermes acp`` server."""

from __future__ import annotations

from ...domain.agents import AcpAgentDefinition, Executable, PathSetting
from ...domain.definitions import AcpError
from ...domain.dialect import AcpDialect, SlashSteer

EDIT_POLICY_OPTION = "edit_approval_policy"


class HermesDialect(AcpDialect):
    # Hermes runs registered slash commands, including /steer, from text-only prompts.
    steer = SlashSteer("/steer", attachments=False)

    def __init__(self):
        self.approval_cards: set[tuple[str | None, str | None]] = set()

    def adapt_configuration(self, session_id, options):
        # Hermes files its edit approval policy under ACP's ``mode`` category.
        return [
            {**option, "category": "permission"}
            if option.get("id") == EDIT_POLICY_OPTION and option.get("category") == "mode"
            else option
            for option in options
        ]

    async def interaction(self, session_id, kind, request, ask):
        if kind == "permission":
            self.approval_cards.add((session_id, request.get("toolCall", {}).get("toolCallId")))

    def translate_update(self, session_id, update):
        # An answered approval closes the card with an update to the card's own
        # id, which is not a tool call and would show as an extra Timeline item.
        card = (session_id, update.get("toolCallId"))
        if update.get("sessionUpdate") == "tool_call_update" and card in self.approval_cards:
            self.approval_cards.discard(card)
            return None
        return update

    def verify_session(self, session_id, result):
        if not any(item.get("category") == "model" for item in result.get("configOptions") or []):
            raise AcpError(
                "agent_version_unsupported",
                "当前 Hermes 版本没有提供 ACP 模型配置，请升级 Hermes 后重试。",
            )


HERMES = AcpAgentDefinition(
    runtime_type="hermes",
    display_name="Hermes",
    executable=Executable(
        "hermes",
        candidates=("~/.local/bin/hermes", "~/.hermes/hermes-agent/venv/bin/hermes"),
    ),
    arguments=("acp",),
    check=("acp", "--check"),
    version=("acp", "--version"),
    settings=(PathSetting("hermesHome", "Hermes 配置目录（可选）", "HERMES_HOME"),),
    # Hermes' own edit approval policies, with the names it gives them. Command
    # approvals are decided by Hermes and reach AA as permission requests.
    permission_options=(
        ("ask", "Default"),
        ("workspace_session", "Accept Edits"),
        ("session", "Don't Ask"),
    ),
    metadata={"localInstallation": True, "nativeHistory": False},
    dialect=lambda _context: HermesDialect(),
)
