from ...domain.definitions import AgentProfile

PI_PROFILE = AgentProfile(
    id="pi",
    title="Pi",
    runtime_capabilities=("runtime.attachment",),
    permission_options=(
        ("ask", "写入与命令审批"),
        ("ask_all", "全部工具审批"),
        ("readonly", "只读"),
    ),
    # Managed npm installation uses the published ACP executable. The client
    # verifies AA's permission extension before exposing a writable session.
    required_guarantees=frozenset({"managed_tool_permissions"}),
    release_ready=True,
    unavailable_reason="pi_environment_not_ready",
)
