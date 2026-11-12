"""MiniMax Code's installed ACP CLI."""

from ...domain.agents import AcpAgentDefinition, Executable
from ...domain.dialect import AcpDialect


class MiniMaxDialect(AcpDialect):
    def adapt_configuration(self, session_id, options):
        # MiniMax exposes this as a vendor-defined ACP category.
        return [
            {**option, "category": "permission"}
            if option.get("id") == "permissionMode"
            else option
            for option in options
        ]

MINIMAX = AcpAgentDefinition(
    runtime_type="minimax",
    display_name="MiniMax Code",
    executable=Executable(
        "mcode",
        candidates=("~/.local/bin/mcode",),
        windows_npm_entry="@minimax-ai/code/cli.js",
    ),
    arguments=("acp",),
    check=("acp", "--help"),
    version=("--version",),
    native_inventory=False,
    dialect=lambda _context: MiniMaxDialect(),
)
