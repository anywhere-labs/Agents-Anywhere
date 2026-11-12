"""Google Antigravity's installed CLI, using its native ACP entry point."""

from ...domain.agents import AcpAgentDefinition, Executable

ANTIGRAVITY = AcpAgentDefinition(
    runtime_type="antigravity",
    display_name="Google Antigravity",
    executable=Executable(
        "agy",
        candidates=("~/.local/bin/agy", "%LOCALAPPDATA%/agy/bin/agy.exe"),
    ),
    arguments=("acp",),
    check=("acp", "--help"),
    version=("--version",),
    native_inventory=False,
)
