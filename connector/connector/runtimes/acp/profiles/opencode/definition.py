"""OpenCode's installed ACP CLI."""

from ...domain.agents import AcpAgentDefinition, Executable

OPENCODE = AcpAgentDefinition(
    runtime_type="opencode",
    display_name="OpenCode",
    executable=Executable(
        "opencode",
        candidates=("~/.opencode/bin/opencode", "~/.local/bin/opencode"),
    ),
    arguments=("acp",),
    check=("acp", "--help"),
    version=("--version",),
    native_inventory=False,
)
