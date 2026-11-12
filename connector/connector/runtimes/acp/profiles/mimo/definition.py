"""Xiaomi MiMo Code's installed ACP CLI."""

from ...domain.agents import AcpAgentDefinition, Executable

MIMO = AcpAgentDefinition(
    runtime_type="mimo",
    display_name="MiMo Code",
    executable=Executable(
        "mimo",
        candidates=("~/.local/bin/mimo",),
        windows_npm_entry="@mimo-ai/cli/mimo.js",
    ),
    arguments=("acp",),
    check=("acp", "--help"),
    version=("--version",),
    # MiMo's ACP server only accepts directories under its process cwd.
    launch_in_workspace=True,
    native_inventory=False,
)
