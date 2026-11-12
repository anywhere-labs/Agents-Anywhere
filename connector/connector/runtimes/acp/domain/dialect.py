"""Optional per-Agent hooks around the shared ACP session engine.

A dialect interprets what standard ACP leaves to each Agent: configuration
categories, private updates, extra acceptance evidence, error meaning and how
to steer a running turn. It never owns session lifecycle, event identity,
acceptance or history replay; the engine keeps those for every Agent.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any

from .definitions import AcpError

Ask = Callable[[str | None, str, dict], Awaitable[dict]]


@dataclass(frozen=True)
class ExtensionSteer:
    """Steer through an Agent extension method returning ``{outcome: "injected"}``."""

    method: str
    attachments: bool = True


@dataclass(frozen=True)
class SlashSteer:
    """Steer by sending a text command such as ``/steer <guidance>``."""

    command: str
    attachments: bool = False


@dataclass(frozen=True)
class PlanningModeOption:
    config_id: str
    plan: str
    normal: str
    legacy: bool = False


@dataclass(frozen=True)
class PlanReviewRequest:
    native_id: str
    markdown: str
    responses: dict[str, dict]


class AcpDialect:
    """The generic dialect: every hook keeps standard ACP behaviour."""

    #: Whether the Agent echoes the user's prompt live; the engine then skips its own.
    echoes_user_prompt = False
    #: How a running turn accepts more guidance; ``None`` leaves steering unavailable.
    steer: ExtensionSteer | SlashSteer | None = None
    #: AA guarantees this Agent satisfies, such as ``managed_tool_permissions``.
    guarantees: frozenset[str] = frozenset()

    planning_mode: PlanningModeOption | None = None

    def plan_mode_changed(self, update: dict) -> bool:
        return False

    def plan_review(self, kind: str, request: dict) -> PlanReviewRequest | None:
        """Recognize an authoritative plan submission and its native responses."""
        return None

    def capabilities(self, initialized: dict) -> Iterable[str]:
        """Extra AA session capabilities beyond those derived from the handshake."""
        return ()

    def supports_steer(self, initialized: dict) -> bool:
        return self.steer is not None

    def adapt_configuration(self, session_id: str, options: list[dict]) -> list[dict]:
        """Place Agent options in AA categories; choices and names stay the Agent's."""
        return options

    def translate_update(self, session_id: str, update: dict) -> dict | None:
        """Rewrite a private update as a standard one, or ``None`` to drop it."""
        return update

    def acceptance_evidence(self, session_id: str, update: dict) -> bool:
        """Whether a non-execution update proves the Agent started on the current input."""
        return False

    async def interaction(
        self, session_id: str | None, kind: str, request: dict, ask: Ask
    ) -> dict | None:
        """Answer an Agent request itself, or ``None`` to ask the user as usual."""
        return None

    async def before_prompt(
        self, client: Any, session_id: str, text: str, blocks: list | None, purpose: str
    ) -> None:
        """Reject input before dispatch by raising ``PromptRejectedBeforeDispatch``."""

    def verify_session(self, session_id: str, result: dict) -> None:
        """Check a new or resumed session before AA exposes it."""

    async def prepare_resume(self, session_id: str, metadata: dict) -> None:
        """Restore Agent-side state that must exist before resuming."""

    async def configure(
        self, client: Any, session_id: str, key: str, value: Any
    ) -> list[dict] | None:
        """Handle an AA-only option; return the Agent's raw options, or ``None`` to send it."""
        return None

    async def extension(
        self, client: Any, session_id: str | None, method: str, values: dict
    ) -> dict | None:
        """Handle an AA operation the engine does not implement; ``None`` passes it on."""
        return None

    def classify_error(self, error: Exception, phase: str) -> AcpError | None:
        """Map an Agent error during ``open`` or ``resume`` to a stable AA error."""
        return None


GENERIC_DIALECT = AcpDialect()
