from ...domain.definitions import AgentProfile

HERMES_PROFILE = AgentProfile(
    id="hermes",
    title="Hermes",
    runtime_capabilities=("runtime.attachment",),
    # Hermes' own edit approval policies, with the names it gives them. Command
    # approvals are decided by Hermes and reach AA as permission requests.
    permission_options=(
        ("ask", "Default"),
        ("workspace_session", "Accept Edits"),
        ("session", "Don't Ask"),
    ),
)
