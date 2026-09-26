from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from connector.logging import logger
from connector.runtimes.claude.domain.session import ClaudeExecution
from connector.runtimes.claude.sdk.background import ClaudeBackgroundTasks
from connector.runtimes.claude.sdk.client import (
    connect_client,
    disconnect_client,
    interrupt_client,
    query_client,
    receive_response_messages,
)
from connector.runtimes.claude.sdk.events import (
    is_result_message,
    terminal_event_from_message,
)
from connector.runtimes.claude.timeline.messages import message_id, message_role
from connector.runtimes.claude.timeline.stream import is_stream_event

RECONCILE_DONE_MARKER = "AA_MAINTENANCE_DONE"
LEGACY_RECONCILE_PROMPT = (
    "AA connection maintenance: call CronList exactly once to report the current "
    "scheduled task list, then stop. If needed, use ToolSearch to find CronList. "
    "Do not create, delete, execute or modify tasks or perform any other work."
)
RECONCILE_PROMPT = (
    f"{LEGACY_RECONCILE_PROMPT} End with exactly {RECONCILE_DONE_MARKER}."
)


@dataclass(slots=True)
class ClaudeResponse:
    connection: ClaudeConnection
    execution: ClaudeExecution | None = None
    user_id: str | None = None
    messages: asyncio.Queue[Any] = field(default_factory=asyncio.Queue)
    released: asyncio.Event = field(default_factory=asyncio.Event)
    terminal_received: bool = False
    discard: bool = False
    maintenance: bool = False
    task_snapshot: set[str] | None = None

    async def connect(self) -> None:
        await self.connection.connect()

    async def query(self, content: str) -> None:
        if self.user_id is None:
            await query_client(self.connection.client, content)
        else:

            async def prompt():
                yield {
                    "type": "user",
                    "uuid": self.user_id,
                    "message": {"role": "user", "content": content},
                    "parent_tool_use_id": None,
                    "priority": "later",
                }

            await self.connection.client.query(prompt())
        self.connection.queried.set()

    async def receive_response(self):
        while True:
            message = await self.messages.get()
            if message is None:
                if self.connection.failure is not None:
                    raise self.connection.failure
                return
            yield message
            if is_result_message(message):
                return

    async def interrupt(self) -> None:
        if self.connection.current is None and self.connection.pending is self:
            await self.connection.select_response(self)
        await interrupt_client(self.connection.client)
        current = self.connection.current
        if (
            current is not None
            and current is not self
            and not current.terminal_received
        ):
            # A submitted native prompt cannot be individually retracted.
            await self.connection.close()

    def release(self, *, interrupted: bool = False) -> None:
        if interrupted:
            while not self.messages.empty():
                self.messages.get_nowait()
        self.discard = interrupted and not self.terminal_received
        self.released.set()


@dataclass(slots=True)
class ClaudeConnection:
    """Own the SDK's task-scoped transport independently of a single reply."""

    client: Any
    on_activity: Callable[[ClaudeResponse], Awaitable[None]]
    on_idle: Callable[[ClaudeConnection], Awaitable[None]]
    on_background_done: Callable[[ClaudeConnection], Awaitable[None]]
    cleanup: Callable[[], None]
    idle_timeout_seconds: float = 600.0
    task: asyncio.Task[None] | None = None
    idle_task: asyncio.Task[None] | None = None
    background_done_task: asyncio.Task[None] | None = None
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    queried: asyncio.Event = field(default_factory=asyncio.Event)
    selected: asyncio.Event = field(default_factory=asyncio.Event)
    pending: ClaudeResponse | None = None
    current: ClaudeResponse | None = None
    failure: BaseException | None = None
    closing: bool = False
    task_ids: set[str] = field(default_factory=set)
    background: ClaudeBackgroundTasks = field(default_factory=ClaudeBackgroundTasks)
    selections: dict[str, str | None] = field(default_factory=dict)
    reconcile_needed: bool = False
    reconciling: bool = False

    @property
    def retained(self) -> bool:
        return bool(self.task_ids)

    @property
    def streaming(self) -> bool:
        return callable(getattr(self.client, "receive_messages", None))

    def cancel_idle(self) -> None:
        timer = self.idle_task
        self.idle_task = None
        if timer is not None and timer is not asyncio.current_task():
            timer.cancel()

    def arm_idle(self) -> None:
        if (
            self.closing
            or not self.streaming
            or self.task_ids
            or self.background.active_ids
            or self.current is not None
            or self.pending is not None
        ):
            return
        self.cancel_idle()

        async def expire() -> None:
            await asyncio.sleep(self.idle_timeout_seconds)
            await self.on_idle(self)

        self.idle_task = asyncio.create_task(expire())

    def response_for(self, execution: ClaudeExecution | None) -> ClaudeResponse:
        self.cancel_idle()
        response = ClaudeResponse(
            self,
            execution=execution,
            user_id=str(uuid4()) if self.retained or self.queried.is_set() else None,
        )
        self.pending = response
        return response

    async def select_response(self, response: ClaudeResponse) -> None:
        self.cancel_idle()
        self.current = response
        if self.pending is response:
            self.pending = None
        if not response.maintenance:
            await self.on_activity(response)
        self.selected.set()

    async def prepare_approval(self) -> None:
        if self.current is None:
            if self.pending is None:
                await self.select_response(ClaudeResponse(self))
            elif self.pending.user_id is None:
                await self.select_response(self.pending)
            else:
                await self.selected.wait()

    async def tool_result(self, data: Any, *_args: Any) -> dict[str, Any]:
        response = data.get("tool_response")
        name = data.get("tool_name")
        if isinstance(response, dict):
            task_id = response.get("id")
            if name == "CronCreate" and isinstance(task_id, str):
                self.task_ids.add(task_id)
            elif name == "CronDelete" and isinstance(task_id, str):
                self.task_ids.discard(task_id)
            elif name == "CronList" and isinstance(response.get("jobs"), list):
                jobs = response["jobs"]
                if any(
                    not isinstance(job, dict) or not isinstance(job.get("id"), str)
                    for job in jobs
                ):
                    return {}
                ids = {job["id"] for job in jobs}
                if self.current is not None and self.current.maintenance:
                    self.current.task_snapshot = ids
                else:
                    self.task_ids = ids
            return {}
        return {}

    async def before_tool(self, data: Any) -> dict[str, Any]:
        if self.reconciling:
            await self.prepare_approval()
        if self.current is not None and self.current.maintenance:
            allowed = data.get("tool_name") in {"CronList", "ToolSearch"}
            return {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "allow" if allowed else "deny",
                    "permissionDecisionReason": "AA maintenance only reads the scheduled task list.",
                }
            }
        return {}

    async def reconcile_tasks(self, response: ClaudeResponse | None = None) -> bool:
        self.reconcile_needed = False
        self.reconciling = True
        check = self.response_for(response.execution if response is not None else None)
        check.maintenance = True
        if response is not None:
            if response.execution is not None:
                response.execution.client = check
            response.release()
        try:
            async with asyncio.timeout(30):
                await check.query(RECONCILE_PROMPT)
                async for message in check.receive_response():
                    terminal = terminal_event_from_message(message)
                    if terminal is not None:
                        if (
                            terminal.status == "completed"
                            and check.task_snapshot is not None
                        ):
                            self.task_ids = check.task_snapshot
                            return True
                        break
            logger.warning(
                "Claude task reconciliation did not return a valid task list"
            )
            return False
        except Exception as exc:  # noqa: BLE001
            logger.warning("Claude task reconciliation failed: {}", exc)
            return False
        finally:
            try:
                if not check.terminal_received and not self.closing:
                    await check.interrupt()
            finally:
                check.release(interrupted=not check.terminal_received)
                self.reconciling = False

    async def connect(self) -> None:
        if self.task is None:
            self.task = asyncio.create_task(self._run())
        await self.ready.wait()
        if self.failure is not None:
            raise self.failure

    async def _run(self) -> None:
        try:
            await connect_client(self.client)
            self.ready.set()
            await self.queried.wait()
            preamble = []
            async for message in receive_response_messages(self.client):
                had_background = bool(self.background.active_ids)
                task_event = self.background.observe(message)
                if task_event:
                    if self.background.active_ids:
                        self.cancel_idle()
                    else:
                        self.arm_idle()
                        if had_background and self.current is None:
                            self.background_done_task = asyncio.create_task(
                                self.on_background_done(self)
                            )
                if self.current is None:
                    if task_event:
                        continue
                    terminal_event = terminal_event_from_message(message)
                    if self.pending is not None and (
                        self.pending.user_id is None
                        or (
                            message_role(message) == "user"
                            and message_id(message) == self.pending.user_id
                        )
                        or (
                            terminal_event is not None
                            and terminal_event.status == "failed"
                        )
                    ):
                        await self.select_response(self.pending)
                    elif message_role(message) == "system":
                        preamble.append(message)
                        continue
                    elif (
                        message_role(message) in {"assistant", "user"}
                        or is_stream_event(message)
                        or terminal_event is not None
                    ):
                        await self.select_response(ClaudeResponse(self))
                    else:
                        continue
                response = self.current
                if not response.discard:
                    for buffered in preamble:
                        await response.messages.put(buffered)
                preamble.clear()
                terminal = is_result_message(message)
                response.terminal_received = terminal
                if not response.discard:
                    await response.messages.put(message)
                if terminal:
                    await response.released.wait()
                    self.current = None
                    self.selected.clear()
                    self.arm_idle()
                    if (
                        not self.streaming
                        and not self.retained
                        and self.pending is None
                    ) or self.closing:
                        break
            if (
                self.streaming or self.retained or self.background.active_ids
            ) and not self.closing:
                raise RuntimeError(
                    "Claude session transport ended unexpectedly"
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            self.failure = exc
            if self.current is None and self.pending is None:
                await self.select_response(ClaudeResponse(self))
        finally:
            self.closing = True
            self.cancel_idle()
            if self.background_done_task is not None:
                self.background_done_task.cancel()
            self.ready.set()
            try:
                await disconnect_client(self.client)
            finally:
                self.cleanup()
                for response in (self.current, self.pending):
                    if response is not None:
                        await response.messages.put(None)

    async def close(self) -> None:
        self.closing = True
        if self.task is not None:
            if not self.task.done():
                self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
