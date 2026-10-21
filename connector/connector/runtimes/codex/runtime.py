from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from connector.core.json_kv import JsonKeyValueStore
from connector.logging import logger
from connector.runtime_protocol import (
    AgentRuntime,
    PreparedSessionTimelineSync,
    RuntimeAttachment,
    RuntimeCapabilitySet,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeSessionSourceStateCache,
    RuntimeSessionStateCache,
    RuntimeTimelineSnapshot,
    RuntimeUnsupportedError,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.catalogs.reader import CodexCatalogReader
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.domain.capabilities import (
    codex_capability_context,
    codex_runtime_capabilities,
    codex_session_capabilities,
)
from connector.runtimes.codex.domain.commands import (
    KILL_CHATGPT,
    OPEN_IN_CODEX_APP,
    filter_commands,
    kill_chatgpt_command,
    open_in_codex_app_command,
)
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.domain.pending_messages import (
    PendingClientMessageRegistry,
)
from connector.runtimes.codex.ipc import (
    CodexIpcClient,
    CodexIpcOwnerService,
    CodexIpcService,
    CodexIpcSessionProjector,
    CodexIpcTurnController,
    FollowedThread,
    thread_snapshot_from_conversation_state,
)
from connector.runtimes.codex.ipc import deeplink as ipc_deeplink
from connector.runtimes.codex.ipc import desktop_app
from connector.runtimes.codex.lifecycle.runtime_lifecycle import CodexRuntimeLifecycle
from connector.runtimes.codex.notifications import CodexNotificationProjector
from connector.runtimes.codex.notifications.projector import notification_event
from connector.runtimes.codex.sdk.runtime_client import (
    CodexModelListResult,
    CodexRuntimeClient,
)
from connector.runtimes.codex.sessions.reader import CodexSessionReader
from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator
from connector.runtimes.codex.turns.command_input import command_input
from connector.runtimes.codex.turns.controller import CodexTurnController


@dataclass(slots=True)
class CodexRuntime(AgentRuntime):
    config: RuntimeConfig
    host: RuntimeHostClient
    client: CodexRuntimeClient | None = None
    client_message_kv: JsonKeyValueStore | None = None
    runtime_version: str = "native-0"
    ipc: CodexIpcClient | None = None
    ipc_enabled: bool = False
    ipc_service: CodexIpcService | None = None
    ipc_turns: CodexIpcTurnController | None = None
    ipc_owner: CodexIpcOwnerService | None = None
    ipc_deeplink_handoff: bool = True
    ipc_handoff_timeout_ms: int = 5000

    def __post_init__(self) -> None:
        self._active_turn_ids: dict[str, str] = {}
        self._session_states = RuntimeSessionStateCache(
            "codex",
            self.host,
            on_state_updated=self.publish_session_capabilities_for_state,
        )
        self._source_states = RuntimeSessionSourceStateCache("codex", self.host)
        self._notices = CodexNoticeRegistry()
        self._pending_messages = PendingClientMessageRegistry(
            connector_id=getattr(
                self.host,
                "session_namespace",
                self.host.connector_id,
            ),
            kv_store=self.client_message_kv,
        )
        self._timeline = CodexTimelineAccumulator(
            pending_messages=self._pending_messages,
        )
        self._notifications = CodexNotificationProjector(
            host=self.host,
            session_states=self._session_states,
            source_states=self._source_states,
            active_turn_ids=self._active_turn_ids,
            timeline=self._timeline,
            notices=self._notices,
        )
        self._lifecycle = CodexRuntimeLifecycle(
            client=self.client,
            notifications=self._notifications,
            on_handled=self._after_notification,
        )
        self._catalogs = CodexCatalogReader(
            config=self.config,
            ensure_started=self.start,
            get_model_list_result=self._get_model_list_result,
        )
        self._session_reader = CodexSessionReader(
            host=self.host,
            client=self.client,
            session_states=self._session_states,
            source_states=self._source_states,
            ensure_started=self.start,
            list_model_catalog=self._catalogs.list_model_catalog,
            list_permission_catalog=self._catalogs.list_permission_catalog,
            pending_messages=self._pending_messages,
            timeline=self._timeline,
        )
        self._turns = CodexTurnController(
            host=self.host,
            client=self.client,
            session_states=self._session_states,
            source_states=self._source_states,
            active_turn_ids=self._active_turn_ids,
            notices=self._notices,
            ensure_started=self.start,
            list_model_catalog=self._catalogs.list_model_catalog,
            list_permission_catalog=self._catalogs.list_permission_catalog,
            pending_messages=self._pending_messages,
            timeline=self._timeline,
        )

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime="codex",
            runtime_version=self.runtime_version,
            display_name="Codex",
        )

    async def start(self) -> None:
        await self._lifecycle.start()
        await self._start_ipc()

    async def stop(self) -> None:
        if self.ipc_owner is not None:
            self.ipc_owner.detach()
        if self.ipc_service is not None:
            await self.ipc_service.stop()
        if self.ipc is not None:
            await self.ipc.stop()
        await self._lifecycle.stop()

    async def _start_ipc(self) -> None:
        """Connect to the Codex IDE/desktop IPC router in the background.

        Side effects:
        - creates ``$CODEX_HOME/ipc`` and may bind the router socket when no
          Codex IDE extension or desktop app is running
        - starts following threads owned by IDE / desktop windows and mirrors
          them into session meta, state and notices
        """

        if not self.ipc_enabled:
            return
        codex_home = self.config.values.get("codexHome")
        if self.ipc is None:
            if not isinstance(codex_home, str) or not codex_home:
                return
            self.ipc = CodexIpcClient(codex_home=Path(codex_home))
        await self.ipc.start()
        if self.ipc_service is None and isinstance(codex_home, str) and codex_home:
            projector = CodexIpcSessionProjector(
                host=self.host,
                session_states=self._session_states,
                notices=self._notices,
                active_turn_ids=self._active_turn_ids,
                timeline=self._timeline,
                read_model_catalog=self._ipc_model_catalog,
                read_permission_catalog=self._ipc_permission_catalog,
            )
            self.ipc_service = CodexIpcService(
                client=self.ipc,
                codex_home=Path(codex_home),
                on_event=projector.handle,
            )
        if self.ipc_service is not None:
            await self.ipc_service.start()
        if self.ipc_owner is None and self.client is not None:
            follower = getattr(self.ipc_service, "follower", None)
            self.ipc_owner = CodexIpcOwnerService(
                client=self.ipc,
                sdk=self.client,
                session_states=self._session_states,
                notices=self._notices,
                active_turn_ids=self._active_turn_ids,
                session_id_for=self._ipc_session_id_for,
                is_followed_elsewhere=(
                    (lambda thread_id: _followed(follower, thread_id))
                    if follower is not None
                    else (lambda thread_id: False)
                ),
                host=self.host,
                read_model_catalog=self._ipc_model_catalog,
                read_permission_catalog=self._ipc_permission_catalog,
                apply_selections=self._turns.update_session_selections,
            )
        if self.ipc_owner is not None:
            self.ipc_owner.attach()

    def _ipc_session_id_for(self, thread_id: str) -> str:
        cached = self._session_states.get_by_external_session_id(thread_id)
        if cached is not None:
            return cached.session_id
        return codex_sessions.stable_session_id(
            getattr(self.host, "session_namespace", self.host.connector_id),
            thread_id,
        )

    def _ipc_controller(self) -> CodexIpcTurnController | None:
        """Return the IPC turn controller once a follower service exists."""

        if self.ipc_turns is not None:
            return self.ipc_turns
        follower = getattr(self.ipc_service, "follower", None)
        if follower is None or self.ipc is None:
            return None
        self.ipc_turns = CodexIpcTurnController(
            client=self.ipc,
            follower=follower,
            host=self.host,
            session_states=self._session_states,
            active_turn_ids=self._active_turn_ids,
            notices=self._notices,
            pending_messages=self._pending_messages,
            read_model_catalog=self._ipc_model_catalog,
            read_permission_catalog=self._ipc_permission_catalog,
        )
        return self.ipc_turns

    async def _ipc_model_catalog(self) -> RuntimeModelCatalog:
        return await self._catalogs.list_model_catalog(None, 100)

    async def _ipc_permission_catalog(self) -> RuntimePermissionCatalog:
        return await self._catalogs.list_permission_catalog(None, 100)

    def _ipc_attached_thread(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> FollowedThread | None:
        """Return the followed thread when this session is operated via IPC."""

        controller = self._ipc_controller()
        if controller is None:
            return None
        thread_id = external_session_id
        if thread_id is None:
            state = self._session_states.get(session_id)
            thread_id = state.external_session_id if state is not None else None
        return controller.attached_thread(thread_id)

    async def _ipc_attach_for_write(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> FollowedThread | None:
        """Like ``_ipc_attached_thread`` but probes once when a window may hold it.

        A thread opened in a Codex window seconds ago may not be followed yet;
        resuming it in our own app-server would fail on the writer lock, so a
        quick owner discovery (owners answer in milliseconds) runs first.
        """

        thread = self._ipc_attached_thread(session_id, external_session_id)
        if thread is not None:
            return thread
        controller = self._ipc_controller()
        service = self.ipc_service
        if controller is None or service is None:
            return None
        thread_id = external_session_id
        if thread_id is None:
            state = self._session_states.get(session_id)
            thread_id = state.external_session_id if state is not None else None
        if not thread_id or not getattr(service, "thread_is_held", lambda _: False)(thread_id):
            return None
        try:
            await controller.follower.follow(thread_id, discovery_timeout_ms=3000)
        except Exception as exc:  # noqa: BLE001 - fall back to the SDK path
            logger.debug("codex ipc attach-for-write failed thread={} error={}", thread_id, exc)
            return None
        thread = controller.attached_thread(thread_id)
        if thread is not None or not self.ipc_deeplink_handoff:
            return thread
        # The lock is held but no window answers for the thread: typically the
        # desktop app's app-server still has it loaded without a page showing
        # it. Asking the running desktop app to open the thread makes it the
        # owner within a fraction of a second, so AA can follow instead of
        # fighting over the writer lock.
        if await ipc_deeplink.desktop_app_running() is not True:
            return None
        return await self._ipc_handoff_to_desktop(thread_id)

    def _ipc_handoff_supported(self) -> bool:
        return (self.ipc is not None or self.ipc_enabled) and ipc_deeplink.deeplink_supported()

    async def _ipc_handoff_to_desktop(self, thread_id: str) -> FollowedThread | None:
        """Open ``codex://threads/<id>`` in the desktop app and follow the result.

        Side effects: the running Codex desktop app navigates to the thread (in
        the background, without taking focus) and resumes it in its app-server.
        """

        controller = self._ipc_controller()
        if controller is None:
            return None
        try:
            url = ipc_deeplink.thread_deeplink(thread_id)
        except ValueError:
            return None
        if not await ipc_deeplink.open_deeplink(url):
            return None
        logger.info("codex ipc handed thread={} to the desktop app via deeplink", thread_id)
        try:
            await controller.follower.follow(
                thread_id, discovery_timeout_ms=self.ipc_handoff_timeout_ms
            )
        except Exception as exc:  # noqa: BLE001 - the window may still be resuming
            logger.debug("codex ipc follow after handoff failed thread={} error={}", thread_id, exc)
        return controller.attached_thread(thread_id)

    async def _execute_kill_chatgpt(
        self,
        session_id: str,
        external_session_id: str | None,
    ) -> RuntimeCommandResult:
        """Stop the desktop app so the thread can run in our own app-server.

        Side effects: the ChatGPT / Codex desktop app exits; every thread it
        owned loses its IPC owner and its writer lock, so the next message
        resumes the thread in the connector's app-server.
        """

        if not desktop_app.supported():
            return RuntimeCommandResult(
                command=KILL_CHATGPT,
                ok=False,
                code="command_unavailable",
                message="platform_unsupported",
            )
        shutdown = await desktop_app.quit_desktop_app()
        if not shutdown.found:
            return RuntimeCommandResult(
                command=KILL_CHATGPT,
                ok=False,
                code="command_unavailable",
                message="codex_app_not_running",
                result={"executionState": "completed"},
            )
        thread_id = external_session_id
        if thread_id is None:
            state = self._session_states.get(session_id)
            thread_id = state.external_session_id if state is not None else None
        controller = self._ipc_controller()
        if thread_id and controller is not None and controller.attached_thread(thread_id):
            # Forget the dead owner right away instead of waiting for the
            # router's disconnect broadcast, so the next message goes native.
            try:
                await controller.follower.unfollow(thread_id)
            except Exception as exc:  # noqa: BLE001 - best effort
                logger.debug("codex ipc unfollow after kill failed thread={} error={}", thread_id, exc)
        result = {
            "terminated": list(shutdown.terminated),
            "killed": list(shutdown.killed),
            "survivors": list(shutdown.survivors),
            "executionState": "completed",
        }
        if not shutdown.ok:
            return RuntimeCommandResult(
                command=KILL_CHATGPT,
                ok=False,
                code="command_error",
                message="Some Codex desktop app processes are still running.",
                result=result,
            )
        return RuntimeCommandResult(command=KILL_CHATGPT, result=result)

    async def _execute_open_in_codex_app(
        self,
        session_id: str,
        external_session_id: str | None,
    ) -> RuntimeCommandResult:
        thread_id = external_session_id
        if thread_id is None:
            state = self._session_states.get(session_id)
            thread_id = state.external_session_id if state is not None else None
        source = self._source_states.get(session_id)
        descriptor = open_in_codex_app_command(
            thread_id,
            supported=self._ipc_handoff_supported(),
            source_availability=source.state.availability if source else None,
        )
        if not descriptor.enabled or not thread_id:
            return RuntimeCommandResult(
                command=OPEN_IN_CODEX_APP,
                ok=False,
                code="command_unavailable",
                message=descriptor.disabled_reason,
            )
        try:
            url = ipc_deeplink.thread_deeplink(thread_id)
        except ValueError as exc:
            return RuntimeCommandResult(
                command=OPEN_IN_CODEX_APP,
                ok=False,
                code="invalid_command",
                message=str(exc),
            )
        running = await ipc_deeplink.desktop_app_running()
        if running is False:
            return RuntimeCommandResult(
                command=OPEN_IN_CODEX_APP,
                ok=False,
                code="command_unavailable",
                message="codex_app_not_running",
                result={"deeplink": url, "executionState": "completed"},
            )
        thread = await self._ipc_handoff_to_desktop(thread_id)
        if thread is None and not await ipc_deeplink.open_deeplink(url):
            return RuntimeCommandResult(
                command=OPEN_IN_CODEX_APP,
                ok=False,
                code="command_error",
                message="Could not open the Codex deep link.",
                result={"deeplink": url, "executionState": "completed"},
            )
        return RuntimeCommandResult(
            command=OPEN_IN_CODEX_APP,
            result={
                "deeplink": url,
                "attached": thread is not None,
                "ownerClientId": thread.owner_client_id if thread is not None else None,
                "executionState": "completed",
            },
        )

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        context = codex_capability_context(
            connector_id=self.host.connector_id,
            revision=self.config.revision,
            client_available=self.client is not None,
        )
        return codex_runtime_capabilities(context)

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        return await self._catalogs.list_model_catalog(query=query, limit=limit)

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        return await self._catalogs.list_permission_catalog(query=query, limit=limit)

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        return await self._session_reader.list_sessions(limit, cursor, force)

    async def list_complete_session_inventory(
        self,
        page_size: int = 100,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        return await self._session_reader.list_complete_session_inventory(
            page_size,
            force,
        )

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        return await self._session_reader.get_session_state(
            session_id,
            external_session_id,
        )

    async def get_session_notices(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        _ = external_session_id
        return self._notices.current_for_session(session_id)

    async def get_session_capabilities(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> RuntimeCapabilitySet:
        """Report session capabilities from facts already known to this process.

        Availability depends on the cached session status, the active-turn fact and
        the native thread binding. A cold thread read here would fetch selections
        this set never uses, so the cache is the only state source.
        """

        state = self._session_states.get(session_id)
        if state is None and external_session_id is not None:
            state = self._session_states.get_by_external_session_id(
                external_session_id
            )
        context = codex_capability_context(
            connector_id=self.host.connector_id,
            revision=self.config.revision,
            client_available=self.client is not None,
            session_id=session_id,
            external_session_id=external_session_id,
            state=state,
            has_active_turn=session_id in self._active_turn_ids,
        )
        return codex_session_capabilities(context)

    async def publish_runtime_capabilities(self) -> None:
        """Publish current runtime-scoped capabilities.

        Side effects:
        - sends a runtime capability update through the host client
        """

        await self.host.runtime_capabilities_update(
            await self.get_runtime_capabilities()
        )

    async def publish_session_capabilities_for_state(
        self,
        state: SessionState,
    ) -> None:
        """Publish session-scoped capabilities after a state transition.

        Side effects:
        - sends a session capability update through the host client
        """

        context = codex_capability_context(
            connector_id=self.host.connector_id,
            revision=self.config.revision,
            client_available=self.client is not None,
            session_id=state.session_id,
            external_session_id=state.external_session_id,
            state=state,
            has_active_turn=state.session_id in self._active_turn_ids,
        )
        await self.host.session_capabilities_update(codex_session_capabilities(context))
        if self.ipc_owner is not None:
            self.ipc_owner.notify_state(state)

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        thread = self._ipc_attached_thread(session_id, external_session_id)
        if thread is not None and thread.state is not None:
            items = self._timeline.items_from_thread_snapshot(
                session_id=session_id,
                external_session_id=thread.thread_id,
                thread=thread_snapshot_from_conversation_state(thread.state),
                limit=limit,
            )
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=thread.thread_id,
                runtime="codex",
                items=items,
                complete=True,
                metadata={
                    "source": "codex.ipc.snapshot",
                    "revision": thread.revision,
                    "ownerClientId": thread.owner_client_id,
                },
            )
        return await self._session_reader.get_session_snapshot(
            session_id,
            external_session_id,
            limit,
        )

    async def prepare_session_timeline_sync(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> PreparedSessionTimelineSync | None:
        return await self._session_reader.prepare_session_timeline_sync(
            session_id,
            external_session_id,
        )

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
        *,
        runtime_options: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        if runtime_options:
            raise RuntimeUnsupportedError("runtimeOptions")
        return await self._turns.create_and_start_session(
            session_id=session_id,
            content=content,
            title=title,
            cwd=cwd,
            selections=selections,
            attachments=attachments,
            client_message_id=client_message_id,
        )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
        cwd: str | None = None,
    ) -> RuntimeOperationResult:
        _ = cwd
        thread = await self._ipc_attach_for_write(session_id, external_session_id)
        if thread is not None:
            controller = self._ipc_controller()
            assert controller is not None
            return await controller.start_turn(
                session_id=session_id,
                thread=thread,
                content=content,
                attachments=attachments,
                client_message_id=client_message_id,
            )
        return await self._turns.start_turn(
            session_id=session_id,
            external_session_id=external_session_id,
            content=content,
            selections=selections,
            attachments=attachments,
            client_message_id=client_message_id,
        )

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        thread = await self._ipc_attach_for_write(session_id, external_session_id)
        if thread is not None:
            controller = self._ipc_controller()
            assert controller is not None
            return await controller.steer_turn(
                session_id=session_id,
                thread=thread,
                content=content,
                attachments=attachments,
                client_message_id=client_message_id,
            )
        return await self._turns.steer_turn(
            session_id=session_id,
            external_session_id=external_session_id,
            content=content,
            attachments=attachments,
            client_message_id=client_message_id,
        )

    async def interrupt_session(
        self,
        session_id: str,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        thread = self._ipc_attached_thread(session_id)
        if thread is not None:
            controller = self._ipc_controller()
            assert controller is not None
            return await controller.interrupt_session(session_id=session_id, thread=thread)
        return await self._turns.interrupt_session(
            session_id=session_id,
            reason=reason,
        )

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        thread = await self._ipc_attach_for_write(session_id, external_session_id)
        if thread is not None:
            controller = self._ipc_controller()
            assert controller is not None
            return await controller.update_selections(
                session_id=session_id, thread=thread, selections=selections
            )
        return await self._turns.update_session_selections(
            session_id=session_id,
            external_session_id=external_session_id,
            selections=selections,
        )

    async def list_commands(
        self,
        session_id: str,
        external_session_id: str | None = None,
        query: str | None = None,
        limit: int = 50,
    ) -> tuple[RuntimeCommand, ...]:
        commands = self._turns.commands.catalog(session_id, external_session_id, None, 1000)
        if self.ipc is not None or self.ipc_enabled or desktop_app.supported():
            commands = (*commands, kill_chatgpt_command(supported=desktop_app.supported()))
        if self._ipc_handoff_supported() or self.ipc is not None:
            source = self._source_states.get(session_id)
            commands = (
                *commands,
                open_in_codex_app_command(
                    external_session_id,
                    supported=self._ipc_handoff_supported(),
                    source_availability=source.state.availability if source else None,
                ),
            )
        return filter_commands(commands, query, limit)

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        if isinstance(command, str):
            try:
                name, text = command_input(command, raw, args)
            except (ValueError, TypeError):
                name, text = "", ""
            if name in {OPEN_IN_CODEX_APP, KILL_CHATGPT} and text.strip():
                return RuntimeCommandResult(
                    command=name,
                    ok=False,
                    code="invalid_command",
                    message="This command takes no arguments",
                )
            if name == OPEN_IN_CODEX_APP and (
                self._ipc_handoff_supported() or self.ipc is not None
            ):
                return await self._execute_open_in_codex_app(session_id, external_session_id)
            if name == KILL_CHATGPT and (
                self.ipc is not None or self.ipc_enabled or desktop_app.supported()
            ):
                return await self._execute_kill_chatgpt(session_id, external_session_id)
        return await self._turns.execute_command(
            session_id=session_id,
            command=command,
            external_session_id=external_session_id,
            raw=raw,
            args=args,
        )

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        controller = self._ipc_controller()
        thread = controller.ipc_notice_thread(notice_id) if controller is not None else None
        if thread is not None and controller is not None:
            return await controller.respond_interaction(
                session_id=session_id,
                thread=thread,
                notice_id=notice_id,
                action_id=action_id,
                input_data=input_data,
            )
        return await self._turns.respond_interaction(
            session_id=session_id,
            notice_id=notice_id,
            action_id=action_id,
            input_data=input_data,
        )

    async def _handle_notification(self, message: Any) -> None:
        await self._lifecycle.handle_notification(message)

    async def _after_notification(self, message: Any) -> None:
        """Let the IPC owner republish after a native notification was projected."""

        if self.ipc_owner is not None:
            try:
                thread_id = notification_event(message).thread_id
            except Exception:  # noqa: BLE001 - best effort republish trigger
                thread_id = None
            if thread_id:
                self.ipc_owner.notify_thread(thread_id)

    def _get_model_list_result(self) -> CodexModelListResult | None:
        return self._lifecycle.model_list_result


def _followed(follower: Any, thread_id: str) -> bool:
    thread = follower.get(thread_id)
    return thread is not None and thread.status == "following"
