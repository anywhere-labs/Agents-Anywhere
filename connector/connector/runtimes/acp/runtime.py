from __future__ import annotations

from connector.runtime_protocol import AgentRuntime
from connector.runtime_protocol.errors import (
    RuntimeInvalidRequestError,
    RuntimeUnsupportedError,
    RuntimeUpstreamError,
)
from connector.runtime_protocol.models import (
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeIdentity,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimePermissionItem,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.workflows import RuntimeWorkflowResult

from .application.agent_capabilities import AgentCapabilities
from .composition import build_services
from .domain.definitions import AcpError


class AcpRuntime(AgentRuntime):
    def __init__(self, config, host, profile, launch, *, preparation_driver=None, client_factory=None):
        self.config, self.host, self.profile, self.launch = (
            config,
            host,
            profile,
            launch,
        )
        self.app, self.sync = build_services(
            config, host, profile, launch, preparation_driver=preparation_driver,
            **({"client_factory": client_factory} if client_factory else {}),
        )

        self.agent_capabilities = AgentCapabilities(self.app)
        self.app.on_binding_changed = self._publish_session_capabilities
        self.app.materialize_attachments = self._materialize_creation_attachments

    async def _materialize_creation_attachments(self, session_id, values):
        from connector.runtime_protocol.models import RuntimeAttachment

        from .infrastructure.attachments import materialize
        if not self.agent_capabilities.supported(session_id, "runtime.attachment"):
            raise RuntimeInvalidRequestError("当前 Agent 不支持附件。")
        references = tuple(RuntimeAttachment(
            file_id=item["fileId"], name=item.get("name"), media_type=item.get("mediaType"),
            size=item.get("size"), sha256=item.get("sha256")) for item in values)
        return await materialize(self.host, session_id, references, self.app.root / "attachments")

    @property
    def identity(self):
        return RuntimeIdentity(
            runtime=self.config.runtime,
            runtime_version=self.launch.release_id,
            display_name=self.profile.title,
            runtime_id=self.config.runtime_id,
        )

    @property
    def sync_mode(self):
        return "events"

    async def start(self):
        self.app.restore()
        self.app.start_background()
        self.sync.start()

    async def stop(self):
        await self.app.stop()
        await self.sync.close()
        self.app.store.close()

    async def get_config(self):
        return self.config

    async def get_session_configuration(self, session_id):
        return self._configuration_view(session_id)

    def _configuration_view(self, session_id):
        self.app.store.require("binding", session_id)
        snapshot = self.app.configurations.snapshot(session_id)
        row = self.app.store.require("binding", session_id)
        actions = [
            {"operation": operation, "title": title}
            for operation, title, capability in (
                ("authentication.status", "认证状态", "session.authentication.read"),
                ("resources.get", "资源状态", "session.resources.read"),
                ("queue.get", "排队消息", "session.queue.read"),
            ) if self.agent_capabilities.supported(session_id, capability)
        ]
        return {
            "configuration": {"revision": snapshot.revision, "options": list(snapshot.options)},
            "ownerGeneration": row["owner_generation"], "actions": actions,
        }

    async def update_session_configuration(self, session_id, values):
        from .domain.definitions import fingerprint
        from .domain.operations import require_same_input

        key = fingerprint([session_id, values["operationId"]])
        digest = fingerprint(
            {"revision": values["expectedRevision"], "values": values["values"]}
        )
        previous = self.app.store.get("configuration_operation", key)
        if previous:
            require_same_input(previous["digest"], digest)
            return previous["result"]
        binding = self.app._binding(self.app.store.require("binding", session_id))
        binding.require_writable()
        snapshot = self.app.configurations.snapshot(session_id)
        if snapshot.revision != values["expectedRevision"]:
            raise RuntimeInvalidRequestError("配置已变化，请刷新后重新确认。")
        snapshot.validate(values["values"])
        context = self.app.sessions.get(session_id)
        if not context or context["closing"]:
            raise RuntimeInvalidRequestError("执行者已断开。")
        row = {
            "digest": digest,
            "result": {
                "operationId": values["operationId"],
                "phase": "outcome_unknown",
                **await self.get_session_configuration(session_id),
            },
        }
        with self.app.store.transaction():
            self.app.store.put("configuration_operation", key, row)
            self.app._save_binding(
                binding.observe(binding.connection_generation, foreground="running")
            )
        try:
            configuration = await self.app.configurations.update(
                session_id,
                context["agentSessionId"],
                context["client"],
                values["values"],
            )
            row["result"] = {
                "operationId": values["operationId"],
                "phase": "completed",
                "configuration": configuration,
            }
        finally:
            with self.app.store.transaction():
                row["result"].update(self._configuration_view(session_id))
                self.app.store.put("configuration_operation", key, row)
                current = self.app._binding(
                    self.app.store.require("binding", session_id)
                )
                if (
                    current.connection_generation == binding.connection_generation
                    and not context["closing"]
                ):
                    self.app._save_binding(
                        current.observe(
                            current.connection_generation,
                            foreground="idle"
                            if row["result"]["phase"] == "completed"
                            else "unknown",
                            attachment="attached"
                            if row["result"]["phase"] == "completed"
                            else "recovery_required",
                        )
                    )
        return row["result"]

    async def get_runtime_capabilities(self):
        return RuntimeCapabilitySet(
            runtime=self.config.runtime,
            runtime_id=self.config.runtime_id,
            revision=1,
            capabilities=tuple(
                RuntimeCapability(
                    capability_id=key,
                    scope="runtime",
                    runtime=self.config.runtime,
                    metadata={"maxFiles": 10, "maxBytes": 33554432} if key == "runtime.attachment" else {"workflowVersion": "1.2"},
                )
                for key in ("runtime.workspace.prepare", "runtime.session.async_create", *self.profile.runtime_capabilities)
            ),
        )

    def _publish_session_capabilities(self, session_id):
        value = self._session_capabilities(session_id)
        self.app._emit("runtime.capability.updated", {
            "runtime": self.config.runtime, "runtimeId": self.config.runtime_id,
            "sessionId": session_id, "revision": value.revision,
            "capabilities": [{
                "capabilityId": item.capability_id, "scope": item.scope,
                "runtime": self.config.runtime, "runtimeId": self.config.runtime_id,
                "sessionId": session_id, "version": item.version,
                "supported": item.supported, "available": item.available,
                "allowed": item.allowed, "unavailableReason": item.unavailable_reason,
                "metadata": dict(item.metadata),
            } for item in value.capabilities],
        })

    async def get_session_capabilities(self, session_id, external_session_id=None):
        return self._session_capabilities(session_id)

    def _session_capabilities(self, session_id):
        native = self.app.store.get("native_inventory", session_id)
        if native:
            cooperative = bool(native.get("_meta", {}).get("aa", {}).get("cooperative"))
            return RuntimeCapabilitySet(runtime=self.config.runtime, session_id=session_id, revision=1, capabilities=(
                RuntimeCapability(capability_id="session.send_message", scope="session", runtime=self.config.runtime, session_id=session_id, supported=False, available=False, allowed=False, unavailable_reason="native_attach_required"),
                RuntimeCapability(capability_id="session.interrupt", scope="session", runtime=self.config.runtime, session_id=session_id, supported=cooperative, available=cooperative),
            ))
        state = self.app.state(session_id)
        live = self.app.sessions.get(session_id)
        ready = bool(live and not live["closing"])
        blocked = live["client"].capabilities.get("_meta", {}).get("aa", {}).get("unavailableCapabilities", {}) if live else {}
        capabilities = [
            RuntimeCapability(
                capability_id="session.configuration.read",
                scope="session",
                runtime=self.config.runtime,
                session_id=session_id,
            ),
            RuntimeCapability(
                capability_id="session.configuration.update",
                scope="session",
                runtime=self.config.runtime,
                session_id=session_id,
                available=ready and state["status"] == "idle",
            ),
            RuntimeCapability(
                capability_id="session.send_message",
                scope="session", runtime=self.config.runtime, session_id=session_id,
                supported="session.send_message" not in blocked,
                available=ready and state["status"] == "idle" and "session.send_message" not in blocked,
                unavailable_reason=blocked.get("session.send_message"),
            ),
            RuntimeCapability(
                capability_id="session.interrupt",
                scope="session",
                runtime=self.config.runtime,
                session_id=session_id,
                available=ready and state["status"] == "running",
            ),
            RuntimeCapability(
                capability_id="session.close",
                scope="session",
                runtime=self.config.runtime,
                session_id=session_id,
                available=ready,
            ),
            RuntimeCapability(
                capability_id="session.interaction.approval",
                scope="session", runtime=self.config.runtime, session_id=session_id,
                supported="session.interaction.approval" not in blocked,
                available=ready and "session.interaction.approval" not in blocked,
                unavailable_reason=blocked.get("session.interaction.approval"),
            ),
        ]
        descriptor = live["client"].capabilities if live else self.app.store.get("binding_capabilities", session_id) or {}
        can_resume = descriptor.get("loadSession") is True or "resume" in descriptor.get("sessionCapabilities", {})
        capabilities.append(RuntimeCapability(
            capability_id="session.recover", scope="session", runtime=self.config.runtime, session_id=session_id,
            supported=can_resume, available=can_resume and not ready and state["status"] == "blocked",
        ))
        snapshot = self.app.configurations.snapshot(session_id)
        categories = {item.get("category") for item in snapshot.options}
        for category in ("model", "permission"):
            supported = category in categories
            capabilities.append(
                RuntimeCapability(
                    capability_id="catalog." + category,
                    scope="session",
                    runtime=self.config.runtime,
                    session_id=session_id,
                    supported=supported,
                    available=supported and ready,
                )
            )
        for capability_id in (
            "session.commands", "runtime.attachment", "session.authentication.read",
            "session.resources.read", "session.resources.update", "session.queue.read",
            "session.queue.update", "session.execution_position.read", "session.execution_position.select",
        ):
            supported = self.agent_capabilities.supported(session_id, capability_id)
            capabilities.append(
                RuntimeCapability(
                    capability_id=capability_id,
                    scope="session",
                    runtime=self.config.runtime,
                    session_id=session_id,
                    supported=supported,
                    available=supported and ready and state["status"] == "idle",
                    metadata={"maxFiles": 16, "maxBytes": 33554432}
                    if capability_id == "runtime.attachment"
                    else {},
                )
            )
        steering = self.agent_capabilities.supported(session_id, "session.steer")
        capabilities.append(RuntimeCapability(
            capability_id="session.steer", scope="session", runtime=self.config.runtime,
            session_id=session_id, supported=steering,
            available=steering and ready and state["status"] in {"running", "waiting_approval"},
        ))
        return RuntimeCapabilitySet(
            runtime=self.config.runtime,
            session_id=session_id,
            revision=state["metadata"]["stateRevision"],
            capabilities=tuple(capabilities),
        )

    async def execute_workflow(self, request):
        values, method = dict(request.values), request.operation
        try:
            if method == "prepare":
                result = self.app.prepare(values)
            elif method in {"get_preparation", "refresh_preparation"}:
                result = self.app.preparation_view(values["preparationId"])
            elif method == "reserve":
                result = self.app.reserve(values)
            elif method == "begin_creation":
                result = self.app.begin(values)
            elif method == "get_creation":
                result = self.app.creation_view(values["createOperationId"])
            elif method in {"respond_preparation", "respond_creation"}:
                scope = values.get("preparationId", values.get("createOperationId"))
                result = self.app.interactions.respond(scope, values)
            elif method == "cancel_preparation":
                key = values["preparationId"]
                row = self.app.store.require("preparation", key)
                if row.get("create_operation_id"):
                    raise AcpError(
                        "preparation_consumed", "准备已绑定创建操作，请取消该操作。"
                    )
                with self.app.store.transaction():
                    row.update(phase="cancelled", revision=row["revision"] + 1)
                    self.app.store.put("preparation", key, row)
                if key in self.app.contexts:
                    await self.app._close_context(self.app.contexts[key])
                result = self.app.preparation_view(key)
            elif method == "cancel_initialization":
                key = values["createOperationId"]
                row = self.app.store.require("creation", key)
                context = self.app.sessions.get(row["session_id"])
                if context:
                    await self.app._close_context(context)
                with self.app.store.transaction():
                    row = self.app.store.require("creation", key)
                    if row["message_accepted"] is None:
                        row["phase"] = "outcome_unknown"
                        self.app.store.put("creation", key, row)
                result = self.app.creation_view(key)
            elif method == "close_session":
                result = await self.app.close_session(
                    values["sessionId"], values["ownerGeneration"]
                )
            elif method == "recover_session":
                from .domain.definitions import fingerprint
                from .domain.operations import require_same_input
                key = fingerprint([values["sessionId"], values["operationId"]])
                digest = fingerprint(values)
                previous = self.app.store.get("recovery_operation", key)
                if previous:
                    require_same_input(previous["inputDigest"], digest)
                    result = previous["result"]
                else:
                    row = self.app.store.require("binding", values["sessionId"])
                    if values.get("expectedGeneration") != row["owner_generation"]:
                        raise AcpError("owner_changed", "执行者已变化。")
                    pending = {"inputDigest": digest, "result": {"operationId": values["operationId"], "phase": "outcome_unknown"}}
                    with self.app.store.transaction():
                        self.app.store.put("recovery_operation", key, pending)
                    state = await self.app.recover(values["sessionId"])
                    result = {"operationId": values["operationId"], "phase": "completed", "state": state}
                    with self.app.store.transaction():
                        self.app.store.put("recovery_operation", key, {"inputDigest": digest, "result": result})
            elif method == "agent_operation":
                from .application.agent_operations import execute_agent_operation
                result = await execute_agent_operation(self.app, values)
            elif method == "get_tree":
                result = await self.agent_capabilities.invoke(values["sessionId"],
                    "session.execution_position.read", "aa/operate", {
                        "operation": "session.tree", "operationId": values.get("operationId", values["sessionId"]),
                        "expectedGeneration": self.app.store.require("binding", values["sessionId"])["owner_generation"],
                        "values": {"cursor": values.get("cursor"), "limit": values.get("limit", 500)},
                    })
            elif method == "select_position":
                result = await self.agent_capabilities.invoke(values["sessionId"],
                    "session.execution_position.select", "aa/select_position", values, writable=True)
            elif method == "get_response":
                scope = values["scopeId"]
                rows = [
                    row
                    for row in self.app.store.values("interaction")
                    if row["scope_id"] == scope
                    and row.get("response_operation_id")
                    == values["responseOperationId"]
                ]
                result = {"disposition": "applied" if rows else "unknown"}
            else:
                raise RuntimeUnsupportedError(method)
            return RuntimeWorkflowResult(result)
        except AcpError as error:
            mapped = RuntimeUpstreamError(str(error))
            mapped.code = error.code
            raise mapped from error

    async def list_model_catalog(self, query=None, limit=100):
        return RuntimeModelCatalog(runtime=self.config.runtime, revision=0, models=())

    async def list_permission_catalog(self, query=None, limit=100):
        return RuntimePermissionCatalog(
            runtime=self.config.runtime,
            revision=1,
            permissions=tuple(
                RuntimePermissionItem(id=value, title=title, selection_id=value)
                for value, title in self.profile.permission_options
            ),
        )

    async def list_scoped_model_catalog(self, session_id, query=None, limit=100):
        snapshot = self.app.configurations.snapshot(session_id)
        models = []
        for option in snapshot.options:
            if option.get("category") == "model":
                for group in option.get("options", []):
                    models.extend(
                        RuntimeModelItem(
                            id=value["value"],
                            title=value["name"],
                            selection_id=value["value"],
                        )
                        for value in group.get("options", [group])
                    )
        return RuntimeModelCatalog(
            runtime=self.config.runtime, revision=snapshot.revision, models=tuple(models[:limit])
        )

    async def list_sessions(self, limit=100, cursor=None, force=False):
        from .domain.definitions import fingerprint
        rows = [SessionMeta(session_id=row["session_id"], external_session_id=row["agent_session_id"],
                runtime=self.config.runtime, cwd=row["workspace"]["registered_path"])
                for row in self.app.store.values("binding")]
        client = await self.app.inventory_client()
        if client.capabilities.get("sessionCapabilities", {}).get("list") is not None:
            page = await client.list_sessions(cursor=cursor)
            bound = {row.external_session_id for row in rows}
            for native in page.get("sessions", []):
                if native["sessionId"] in bound:
                    continue
                key = "acp_native_" + fingerprint([self.config.runtime_id, native["sessionId"]])[:40]
                with self.app.store.transaction():
                    self.app.store.put("native_inventory", key, native)
                rows.append(SessionMeta(session_id=key, external_session_id=native["sessionId"],
                    runtime=self.config.runtime, cwd=native.get("cwd"), title=native.get("title"), metadata={"readOnly": True}))
        return tuple(rows[:limit])

    async def get_session_state(self, session_id, external_session_id=None):
        native = self.app.store.get("native_inventory", session_id)
        if native:
            status = "blocked"
            if native.get("_meta", {}).get("aa", {}).get("cooperative"):
                try:
                    client = await self.app.inventory_client()
                    observed = await client.extension("aa/observe", {"sessionId": native["sessionId"], "operation": "state"})
                    status = observed.get("status", "blocked")
                except Exception:  # noqa: BLE001 -- unavailable native observation must remain read-only and blocked
                    status = "blocked"
            return SessionState(session_id=session_id, external_session_id=native["sessionId"],
                runtime=self.config.runtime, status=status, status_reason="native_attach_required" if status == "blocked" else None, metadata={"readOnly": True})
        value = self.app.state(session_id)
        return SessionState(
            session_id=session_id,
            external_session_id=value["externalSessionId"],
            runtime=self.config.runtime,
            status=value["status"],
            status_reason=value["statusReason"],
            selections=value["selections"],
            metadata=value["metadata"],
        )

    async def get_session_snapshot(
        self, session_id, external_session_id=None, limit=None
    ):
        native = self.app.store.get("native_inventory", session_id)
        if native:
            client = await self.app.inventory_client()
            replay = await client.extension("aa/read_history", {"sessionId": native["sessionId"]})
            projection = self.app.projection_factory(session_id, "native:" + native["sessionId"])
            for update in replay.get("updates", []):
                projection.apply(update)
            projection.finish()
            return RuntimeTimelineSnapshot(session_id=session_id, external_session_id=native["sessionId"], runtime=self.config.runtime,
                items=tuple(RuntimeTimelineItem(id=row["id"], session_id=session_id, type=row["type"], role=row.get("role"), status=row["status"], order_seq=row["orderSeq"], content_hash=row["contentHash"], revision=row["revision"], content=row["content"], source=row["source"]) for row in projection.items.values()), complete=False)
        items = []
        for row in self.app.store.values("projection"):
            if row["sessionId"] == session_id:
                items.append(
                    RuntimeTimelineItem(
                        id=row["id"],
                        session_id=session_id,
                        type=row["type"],
                        role=row.get("role"),
                        status=row["status"],
                        order_seq=row["orderSeq"],
                        content_hash=row["contentHash"],
                        revision=row["revision"],
                        content=row["content"],
                        source=row["source"],
                    )
                )
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime=self.config.runtime,
            items=tuple(
                sorted(items, key=lambda item: item.order_seq)[-(limit or 1000) :]
            ),
            complete=False,
        )

    async def get_session_notices(self, session_id, external_session_id=None):
        if self.app.store.get("native_inventory", session_id):
            return ()
        context = self.app.sessions.get(session_id)
        if not context:
            return ()
        return tuple(
            SessionNotice(
                notice_id=row["interactionId"],
                session_id=session_id,
                runtime=self.config.runtime,
                type="interaction",
                title=row["title"],
                status="open" if row["status"] == "open" else "closed",
                interaction_type="approval"
                if row["kind"] == "approval"
                else "input_request",
                response_required=row["status"] == "open",
                actions=tuple(row["actions"]),
                metadata={
                    **row["metadata"],
                    "kind": row["kind"],
                    "ownerGeneration": row["ownerGeneration"],
                    "requestRevision": row["requestRevision"],
                },
            )
            for row in self.app.interactions.views(context["scopeId"])
        )

    async def start_turn(
        self,
        session_id,
        external_session_id,
        content,
        selections=None,
        attachments=(),
        client_message_id=None,
        cwd=None,
    ):
        if (
            external_session_id
            != self.app.store.require("binding", session_id)["agent_session_id"]
        ):
            raise RuntimeInvalidRequestError("原生会话身份不匹配。")
        current = self.app.state(session_id)["selections"]
        changes = {
            key: value
            for key, value in (selections or {}).items()
            if value is not None and current.get(key) != value
        }
        if changes:
            updated = await self.update_session_selections(
                session_id, external_session_id, changes
            )
            if not updated.ok:
                return updated
        blocks = None
        if attachments:
            from .infrastructure.attachments import materialize

            if not self.agent_capabilities.supported(session_id, "runtime.attachment"):
                raise RuntimeInvalidRequestError("当前 Agent 不支持附件。")
            blocks = await materialize(
                self.host, session_id, attachments, self.app.root / "attachments"
            )
        result = await self.app.submit(
            session_id, client_message_id, content, blocks=blocks
        )
        if result.get("messageAccepted") is None:
            import asyncio

            from .domain.definitions import fingerprint
            try:
                async with asyncio.timeout(20):
                    while True:
                        row = self.app.store.require("prompt", fingerprint([session_id, client_message_id]))
                        if row["message_accepted"] is not None:
                            result = {"ok": row["message_accepted"], "messageAccepted": row["message_accepted"],
                                      "phase": row["phase"], "clientMessageId": client_message_id}
                            if row["message_accepted"] is False:
                                result.update(code="message_rejected", message="当前权限或用户审批未允许此消息。")
                            break
                        if row["phase"] == "outcome_unknown":
                            break
                        await asyncio.sleep(0.01)
            except TimeoutError:
                pass
            if result.get("messageAccepted") is None:
                result = {**result, "code": "operation_outcome_unknown"}
        return RuntimeOperationResult(
            ok=result["ok"], code=result.get("code"), message=result.get("message"), result=result
        )

    async def steer_turn(self, session_id, external_session_id, content, attachments=(), client_message_id=None):
        from dataclasses import asdict

        from .domain.definitions import fingerprint
        from .domain.operations import require_same_input

        if not client_message_id:
            raise RuntimeInvalidRequestError("消息需要稳定业务身份。")
        self.agent_capabilities.context(session_id, external_session_id)
        if not self.agent_capabilities.supported(session_id, "session.steer"):
            raise RuntimeUnsupportedError("steer_turn")
        digest = fingerprint([content, [asdict(item) for item in attachments]])
        key = fingerprint([session_id, client_message_id])
        previous = self.app.store.get("steer_operation", key)
        if previous:
            require_same_input(previous["inputDigest"], digest)
            result = previous["result"]
            return RuntimeOperationResult(ok=result["messageAccepted"] is True, code=result.get("code"), result=result)
        blocks = []
        if attachments:
            from .infrastructure.attachments import materialize
            if not self.agent_capabilities.supported(session_id, "runtime.attachment"):
                raise RuntimeInvalidRequestError("当前 Agent 不支持附件。")
            blocks = await materialize(self.host, session_id, attachments, self.app.root / "attachments")
        row = {"inputDigest": digest, "result": {"messageAccepted": None, "code": "outcome_unknown"}}
        with self.app.store.transaction():
            operation, fresh = self.app.prompts.prepare(session_id, client_message_id, content, blocks or None)
            if not fresh:
                result = {"messageAccepted": operation.message_accepted, "phase": operation.phase,
                          "clientMessageId": client_message_id}
                return RuntimeOperationResult(ok=operation.message_accepted is True, result=result)
            self.app.store.put("steer_operation", key, row)
        try:
            response = await self.agent_capabilities.invoke(session_id, "session.steer", "aa/steer", {
                "content": content, "blocks": blocks, "clientMessageId": client_message_id,
            }, external_session_id=external_session_id)
        except BaseException:
            with self.app.store.transaction():
                self.app.prompts.save(operation.lose_connection())
            raise
        accepted = response.get("outcome") == "injected"
        result = {"messageAccepted": accepted, "clientMessageId": client_message_id,
                  **({} if accepted else {"code": "turn_not_running"})}
        with self.app.store.transaction():
            self.app.prompts.save(operation.accept("acp_steering_injected") if accepted else operation.reject("acp_no_running_turn"))
            self.app.store.put("steer_operation", key, {**row, "result": result})
        return RuntimeOperationResult(ok=accepted, code=result.get("code"), result=result)

    async def list_commands(
        self, session_id, external_session_id=None, query=None, limit=50
    ):
        value = await self.agent_capabilities.invoke(
            session_id,
            "session.commands",
            "aa/list_commands",
            {},
            external_session_id=external_session_id,
        )
        return tuple(
            RuntimeCommand(
                id=item["name"],
                title=item["name"],
                description=item.get("description"),
                accepts_args=True,
                args_schema={"type": "string"},
                metadata={
                    "ui": {
                        "kind": "execute",
                        "acceptsMultiline": True,
                        "allowedStatuses": ["idle"],
                    }
                },
            )
            for item in value["commands"]
            if not query
            or query.casefold()
            in (item["name"] + " " + item.get("description", "")).casefold()
        )[:limit]

    async def execute_command(
        self, session_id, command, external_session_id=None, raw=None, args=()
    ):
        try:
            value = await self.agent_capabilities.invoke(
                session_id,
                "session.commands",
                "aa/execute_command",
                {"command": command, "raw": raw, "args": list(args)},
                writable=True,
                external_session_id=external_session_id,
            )
            return RuntimeCommandResult(
                command=command,
                ok=value["ok"],
                code=value.get("code"),
                message=value.get("message"),
                result=value.get("result", {}),
            )
        except AcpError as error:
            return RuntimeCommandResult(
                command=command, ok=False, code=error.code, message=str(error)
            )

    async def update_session_selections(
        self, session_id, external_session_id, selections
    ):
        self.agent_capabilities.context(session_id, external_session_id)
        snapshot = self.app.configurations.snapshot(session_id)
        values = {}
        for category, value in selections.items():
            if value is None:
                continue
            option = next(
                (item for item in snapshot.options if item.get("category") == category),
                None,
            )
            if option is None:
                raise RuntimeInvalidRequestError("当前 Agent 不支持此配置。")
            values[option["id"]] = value
        from uuid import uuid4

        result = await self.update_session_configuration(
            session_id,
            {
                "operationId": uuid4().hex,
                "expectedRevision": snapshot.revision,
                "values": values,
            },
        )
        return RuntimeOperationResult(ok=result["phase"] == "completed", result=result)

    async def interrupt_session(self, session_id, reason=None):
        native = self.app.store.get("native_inventory", session_id)
        if native:
            client = await self.app.inventory_client()
            result = await client.extension("aa/observe", {"sessionId": native["sessionId"], "operation": "interrupt", "expectedGeneration": native.get("_meta", {}).get("aa", {}).get("ownerGeneration")})
            return RuntimeOperationResult(result=result)
        context = self.app.sessions.get(session_id)
        if not context:
            raise RuntimeInvalidRequestError("执行者已断开。")
        await context["client"].interrupt(context["agentSessionId"])
        return RuntimeOperationResult(
            result={"interruptRequested": True, "executionStopped": False}
        )

    async def respond_interaction(
        self, session_id, notice_id, action_id, input_data=None
    ):
        context = self.app.sessions.get(session_id)
        if not context:
            raise RuntimeInvalidRequestError("执行者已断开。")
        data = dict(input_data or {})
        result = self.app.interactions.respond(
            context["scopeId"],
            {
                **data,
                "interactionId": notice_id,
                "actionId": action_id,
                "input": data.get("response"),
            },
        )
        return RuntimeOperationResult(result=result)

    async def resynchronize(self, session_id=None, external_session_id=None):
        if session_id and self.app.store.get("native_inventory", session_id):
            return
        rows = (
            [self.app.store.require("binding", session_id)]
            if session_id
            else self.app.store.values("binding")
        )
        with self.app.store.transaction():
            for row in rows:
                self.app._emit("session.meta.upsert", self.app.meta(row["session_id"]))
                self.app._emit(
                    "session.state.updated", self.app.state(row["session_id"])
                )
                self._publish_session_capabilities(row["session_id"])
        await self.sync.flush()

    async def sync_session_timeline(self, session_id, external_session_id=None):
        await self.resynchronize(session_id, external_session_id)
        return True
