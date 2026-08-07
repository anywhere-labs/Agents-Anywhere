from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from openai_codex.generated.v2_all import Thread

from connector.runtimes.codex.sdk.events import CodexSdkEvent

CodexNotificationMessage = CodexSdkEvent | dict[str, Any]
NotificationHandler = Callable[[CodexNotificationMessage], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class CodexTurnInputAttachment:
    name: str
    path: str
    media_type: str

    @property
    def is_image(self) -> bool:
        return self.media_type.startswith("image/")


@dataclass(frozen=True, slots=True)
class CodexStartThreadRequest:
    cwd: str | None = None
    model: str | None = None
    approval_policy: str | None = None
    approvals_reviewer: str | None = None
    sandbox: str | None = None
    ephemeral: bool = False


@dataclass(frozen=True, slots=True)
class CodexStartTurnRequest:
    thread_id: str
    content: str
    client_message_id: str | None = None
    model: str | None = None
    effort: str | None = None
    approval_policy: str | None = None
    approvals_reviewer: str | None = None
    sandbox: str | None = None
    attachments: tuple[CodexTurnInputAttachment, ...] = ()


@dataclass(frozen=True, slots=True)
class CodexResumeThreadRequest:
    thread_id: str
    model: str | None = None
    approval_policy: str | None = None
    approvals_reviewer: str | None = None
    sandbox: str | None = None


@dataclass(frozen=True, slots=True)
class CodexSteerTurnRequest:
    thread_id: str
    turn_id: str
    content: str
    client_message_id: str | None = None


@dataclass(frozen=True, slots=True)
class CodexInterruptTurnRequest:
    thread_id: str
    turn_id: str


@dataclass(frozen=True, slots=True)
class CodexModelListResult:
    models: tuple[Mapping[str, Any], ...]
    next_cursor: str | None = None


@dataclass(frozen=True, slots=True)
class CodexThreadListResult:
    threads: tuple[Mapping[str, Any], ...]
    next_cursor: str | None = None


@dataclass(frozen=True, slots=True)
class CodexThreadReadResult:
    thread: Thread | Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class CodexThreadResult:
    thread_id: str | None
    payload: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class CodexTurnResult:
    turn_id: str | None
    payload: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class CodexCompactResult:
    payload: Mapping[str, Any]


class CodexRuntimeClient(Protocol):
    async def start(self, handler: NotificationHandler) -> None: ...
    async def stop(self) -> None: ...
    async def list_models(self) -> CodexModelListResult: ...
    async def list_threads(
        self,
        limit: int = 100,
        cursor: str | None = None,
    ) -> CodexThreadListResult: ...
    async def read_thread(
        self,
        thread_id: str,
        include_turns: bool = True,
    ) -> CodexThreadReadResult: ...
    async def start_thread(self, request: CodexStartThreadRequest) -> CodexThreadResult: ...
    async def start_turn(self, request: CodexStartTurnRequest) -> CodexTurnResult: ...
    async def steer_turn(self, request: CodexSteerTurnRequest) -> CodexTurnResult: ...
    async def interrupt_turn(
        self,
        request: CodexInterruptTurnRequest,
    ) -> CodexTurnResult: ...
    async def compact_thread(self, thread_id: str) -> CodexCompactResult: ...
    async def respond(
        self,
        request_id: str | int,
        result: Mapping[str, Any] | None = None,
    ) -> None: ...
