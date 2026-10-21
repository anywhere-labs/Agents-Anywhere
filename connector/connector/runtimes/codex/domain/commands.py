"""Commands supported by AA's native Codex runtime."""

from collections.abc import Iterable

from connector.runtime_protocol import RuntimeCommand

IDLE = ("idle", "error")
ALL_STATUSES = (
    "idle",
    "error",
    "running",
    "waiting",
    "waiting_approval",
    "blocked",
    "unknown",
)
OPEN_IN_CODEX_APP = "open-in-codex-app"
KILL_CHATGPT = "kill-chatgpt"
ALIASES = {
    "compact-thread": "compact",
    "open-in-codex": OPEN_IN_CODEX_APP,
    "codex-app": OPEN_IN_CODEX_APP,
    "kill-codex-app": KILL_CHATGPT,
    "quit-chatgpt": KILL_CHATGPT,
}
UNAVAILABLE_SOURCES = {"archived", "unavailable", "deleted", "missing"}


def filter_commands(
    commands: Iterable[RuntimeCommand],
    query: str | None = None,
    limit: int = 50,
) -> tuple[RuntimeCommand, ...]:
    needle = (query or "").strip().casefold()
    return tuple(
        c
        for c in commands
        if not needle
        or needle
        in " ".join((c.id, c.title, c.description or "", *c.aliases)).casefold()
    )[: max(0, min(limit, 1000))]


def list_codex_commands(
    external_session_id: str | None,
    client_available: bool,
    query: str | None = None,
    limit: int = 50,
    *,
    status: str = "idle",
    source_availability: str | None = None,
) -> tuple[RuntimeCommand, ...]:
    reason = None
    if not client_available:
        reason = "codex_unavailable"
    elif not external_session_id:
        reason = "session_unloaded"
    elif source_availability in UNAVAILABLE_SOURCES:
        reason = f"session_{source_availability}"
    elif status not in IDLE:
        reason = f"session_{status}"
    command = RuntimeCommand(
        id="compact",
        title="Compact",
        description="Compact the session context.",
        aliases=tuple(alias for alias, target in ALIASES.items() if target == "compact"),
        enabled=reason is None,
        disabled_reason=reason,
        metadata={
            "ui": {
                "kind": "execute",
                "allowedStatuses": list(IDLE),
                "acceptsMultiline": False,
            }
        },
    )
    return filter_commands((command,), query, limit)


def kill_chatgpt_command(*, supported: bool) -> RuntimeCommand:
    """Describe the command that stops the Codex / ChatGPT desktop app.

    Stopping the app releases every thread writer lock it holds, so the
    connector can run those threads in its own app-server even when IPC is
    off or the app is unreachable.
    """

    return RuntimeCommand(
        id=KILL_CHATGPT,
        title="Kill ChatGPT",
        description=(
            "Stop the ChatGPT / Codex desktop app so its threads can run in "
            "the connector's own app-server."
        ),
        aliases=tuple(alias for alias, target in ALIASES.items() if target == KILL_CHATGPT),
        enabled=supported,
        disabled_reason=None if supported else "platform_unsupported",
        metadata={
            "ui": {
                "kind": "execute",
                "allowedStatuses": list(ALL_STATUSES),
                "acceptsMultiline": False,
            }
        },
    )


def open_in_codex_app_command(
    external_session_id: str | None,
    *,
    supported: bool,
    source_availability: str | None = None,
) -> RuntimeCommand:
    """Describe the deep-link handoff to the Codex desktop app.

    The command is offered whenever the runtime talks to the Codex IPC router;
    it opens ``codex://threads/<id>`` in the running desktop app, which then
    resumes the thread and becomes the IPC owner the Connector follows.
    """

    reason = None
    if not supported:
        reason = "platform_unsupported"
    elif not external_session_id:
        reason = "session_unloaded"
    elif source_availability in UNAVAILABLE_SOURCES:
        reason = f"session_{source_availability}"
    return RuntimeCommand(
        id=OPEN_IN_CODEX_APP,
        title="Open in Codex App",
        description=(
            "Open this thread in the running Codex desktop app and follow it "
            "from there."
        ),
        aliases=tuple(
            alias for alias, target in ALIASES.items() if target == OPEN_IN_CODEX_APP
        ),
        enabled=reason is None,
        disabled_reason=reason,
        metadata={
            "ui": {
                "kind": "execute",
                "allowedStatuses": list(ALL_STATUSES),
                "acceptsMultiline": False,
            }
        },
    )
