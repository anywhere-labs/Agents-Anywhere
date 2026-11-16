"""Tencent CodeBuddy Code's installed ACP CLI."""

from ...domain.agents import AcpAgentDefinition, Executable

CODEBUDDY = AcpAgentDefinition(
    runtime_type="codebuddy",
    display_name="CodeBuddy Code",
    executable=Executable(
        "codebuddy",
        candidates=("~/.local/bin/codebuddy",),
        windows_npm_entry="@tencent-ai/codebuddy-code/bin/codebuddy",
    ),
    arguments=("--acp",),
    check=("--acp", "--help"),
    version=("--version",),
    native_inventory=False,
)
