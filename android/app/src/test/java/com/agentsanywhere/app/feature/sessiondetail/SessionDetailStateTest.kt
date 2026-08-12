package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteRuntimeCapability
import com.agentsanywhere.app.api.RemoteRuntimeCapabilitySet
import com.agentsanywhere.app.api.RemoteRuntimeModel
import com.agentsanywhere.app.api.RemoteRuntimeModelCatalog
import com.agentsanywhere.app.api.RemoteRuntimeNotice
import com.agentsanywhere.app.api.RemoteRuntimePermission
import com.agentsanywhere.app.api.RemoteRuntimePermissionCatalog
import com.agentsanywhere.app.api.RemoteRuntimeReasoning
import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.api.RemoteSessionEventPayload
import com.agentsanywhere.app.api.RemoteTimelineItem
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.api.RemoteSessionRuntimeState
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONObject

class SessionDetailStateTest {
    @Test
    fun realtimeEventsUpdateOnlyTheirOwnerAndDeduplicateByEventId() {
        val controller = SessionDetailController(
            SessionsApi(),
            object : AuthSessionReader {
                override fun readServerUrl(): String = "https://server.example"
                override fun readAccessToken(): String = "token"
            },
        )
        val initial = SessionDetailState(
            meta = SessionMeta(session = session(connectorOnline = true)),
            timeline = SessionTimelineState(eventCursor = "seq:1"),
            runtime = remoteRuntimeState("idle", 1).toSessionRuntimeState("old"),
            capabilities = capabilitySet(true, true, true, revision = 1).toEffectiveCapabilities("connector", "old"),
            initialized = true,
        )
        val timeline = event(
            id = "timeline-event",
            type = "timeline.item_created",
            sequence = 2,
            payload = RemoteSessionEventPayload(item = timelineItem("message", 2, 2)),
        )
        val afterTimeline = controller.applyRealtimeEvent(initial, timeline, emptyList())
        assertEquals(listOf("message"), afterTimeline.messages.map { it.text })
        assertEquals(SessionRuntimeStatus.Idle, afterTimeline.runtime.status)
        assertSame(initial.session, afterTimeline.session)
        assertEquals("seq:2", afterTimeline.realtime.cursor)

        val duplicate = controller.applyRealtimeEvent(afterTimeline, timeline, emptyList())
        assertSame(afterTimeline, duplicate)

        val runtime = event(
            id = "runtime-event",
            type = "runtime.state.updated",
            sequence = 2,
            payload = RemoteSessionEventPayload(state = remoteRuntimeState("running", 2)),
        )
        val afterRuntime = controller.applyRealtimeEvent(afterTimeline, runtime, emptyList())
        assertEquals(SessionRuntimeStatus.Running, afterRuntime.runtime.status)
        assertEquals(listOf("message"), afterRuntime.messages.map { it.text })
        assertEquals(setOf("timeline-event", "runtime-event"), afterRuntime.realtime.processedEventIds)
    }

    @Test
    fun realtimeSnapshotsAndRevisionsNeverOverwriteOtherOrNewerOwners() {
        val controller = SessionDetailController(
            SessionsApi(),
            object : AuthSessionReader {
                override fun readServerUrl(): String = "https://server.example"
                override fun readAccessToken(): String = "token"
            },
        )
        val original = SessionDetailState(
            meta = SessionMeta(session = session(connectorOnline = true)),
            timeline = SessionTimelineState(messages = listOf(message("old", "old", 1, 1, 1))),
            runtime = remoteRuntimeState("running", 10).toSessionRuntimeState("new"),
            capabilities = capabilitySet(true, true, true, revision = 5).toEffectiveCapabilities("connector", "new"),
            initialized = true,
        ).applyNoticeObservation(listOf(remoteNotice(4, 8)), "new", replace = true)

        val snapshot = event(
            id = "snapshot",
            type = "timeline.snapshot",
            sequence = 11,
            payload = RemoteSessionEventPayload(items = listOf(timelineItem("replacement", 11, 11))),
        )
        val afterSnapshot = controller.applyRealtimeEvent(original, snapshot, emptyList())
        assertEquals(listOf("replacement"), afterSnapshot.messages.map { it.text })
        assertEquals(SessionRuntimeStatus.Running, afterSnapshot.runtime.status)
        assertEquals(4, afterSnapshot.notices.notices.single().revision)

        val staleRuntime = controller.applyRealtimeEvent(
            afterSnapshot,
            event("stale-runtime", "runtime.state.updated", 12, RemoteSessionEventPayload(state = remoteRuntimeState("idle", 9))),
            emptyList(),
        )
        val staleCapabilities = controller.applyRealtimeEvent(
            staleRuntime,
            event(
                "stale-capability",
                "runtime.capability.updated",
                12,
                RemoteSessionEventPayload(capabilitySet = capabilitySet(false, false, false, revision = 4)),
            ),
            emptyList(),
        )
        val staleNotice = controller.applyRealtimeEvent(
            staleCapabilities,
            event(
                "stale-notice",
                "runtime.notice.updated",
                12,
                RemoteSessionEventPayload(notice = remoteNotice(3, 7)),
            ),
            emptyList(),
        )
        assertEquals(SessionRuntimeStatus.Running, staleNotice.runtime.status)
        assertTrue(staleNotice.capabilities.isUsable(SESSION_SEND_MESSAGE_CAPABILITY, "codex"))
        assertEquals(4, staleNotice.notices.notices.single().revision)
    }

    @Test
    fun realtimeMetaNoticeSnapshotAndCatalogEventsAreOwnerScoped() {
        val controller = SessionDetailController(
            SessionsApi(),
            object : AuthSessionReader {
                override fun readServerUrl(): String = "https://server.example"
                override fun readAccessToken(): String = "token"
            },
        )
        val initial = SessionDetailState(
            meta = SessionMeta(session = session(connectorOnline = true)),
            timeline = SessionTimelineState(messages = listOf(message("kept", "kept", 1, 1, 1))),
            runtime = remoteRuntimeState("running", 5).toSessionRuntimeState("now"),
            catalogs = RuntimeCatalogs(
                model = RemoteRuntimeModelCatalog("codex", 5, emptyList()),
                permission = RemoteRuntimePermissionCatalog("codex", 5, emptyList()),
            ),
            initialized = true,
        ).applyNoticeObservation(listOf(remoteNotice(1, 1)), "old", replace = true)

        val metaSession = session(connectorOnline = false).copy(title = "Realtime title", updatedSeq = 2)
        var state = controller.applyRealtimeEvent(
            initial,
            event("meta", "session.meta.updated", 6, RemoteSessionEventPayload(session = metaSession.toRemote())),
            emptyList(),
        )
        state = controller.applyRealtimeEvent(
            state,
            event(
                "notice-snapshot",
                "runtime.notice.snapshot",
                6,
                RemoteSessionEventPayload(notices = listOf(remoteNotice(2, 6).copy(noticeId = "notice-2"))),
            ),
            emptyList(),
        )
        state = controller.applyRealtimeEvent(
            state,
            event(
                "model",
                "runtime.catalog.updated",
                6,
                RemoteSessionEventPayload(
                    catalogType = "model",
                    modelCatalog = RemoteRuntimeModelCatalog("codex", 6, emptyList()),
                ),
            ),
            emptyList(),
        )
        state = controller.applyRealtimeEvent(
            state,
            event(
                "permission-stale",
                "runtime.catalog.updated",
                6,
                RemoteSessionEventPayload(
                    catalogType = "permission",
                    permissionCatalog = RemoteRuntimePermissionCatalog("codex", 4, emptyList()),
                ),
            ),
            emptyList(),
        )

        assertEquals("Realtime title", state.session?.title)
        assertFalse(state.session?.connectorOnline ?: true)
        assertEquals(listOf("kept"), state.messages.map { it.text })
        assertEquals(SessionRuntimeStatus.Running, state.runtime.status)
        assertEquals(listOf("notice-2"), state.notices.notices.map { it.noticeId })
        assertEquals(6L, state.catalogs.model?.revision)
        assertEquals(5L, state.catalogs.permission?.revision)
    }

    @Test
    fun staleManualSnapshotCannotOverwriteEventsReceivedWhileItWasLoading() {
        val controller = SessionDetailController(
            SessionsApi(),
            object : AuthSessionReader {
                override fun readServerUrl(): String = "https://server.example"
                override fun readAccessToken(): String = "token"
            },
        )
        val staleSnapshot = SessionDetailState(
            meta = SessionMeta(session = session(true).copy(title = "Snapshot", updatedSeq = 5)),
            timeline = SessionTimelineState(
                messages = listOf(message("snapshot", "snapshot", 1, 5, 5)),
                nextSeq = 5,
                eventCursor = "seq:5",
            ),
            runtime = remoteRuntimeState("idle", 5).toSessionRuntimeState("snapshot"),
            capabilities = capabilitySet(true, true, false, revision = 5)
                .toEffectiveCapabilities("connector", "snapshot"),
            notices = RuntimeNotices(eventSequence = 5),
            realtime = SessionRealtimeState(cursor = "seq:5"),
            initialized = true,
        )
        val live = SessionDetailState(
            meta = SessionMeta(session = session(false).copy(title = "Live", updatedSeq = 7)),
            timeline = SessionTimelineState(
                messages = listOf(message("live", "live", 1, 7, 7)),
                nextSeq = 7,
                eventCursor = "seq:7",
            ),
            runtime = remoteRuntimeState("running", 7).toSessionRuntimeState("live"),
            capabilities = capabilitySet(true, true, true, revision = 7)
                .toEffectiveCapabilities("connector", "live"),
            notices = RuntimeNotices(
                notices = listOf(remoteNotice(2, 7).toRuntimeNoticeForTest()),
                isLoaded = true,
                eventSequence = 7,
            ),
            realtime = SessionRealtimeState(
                connected = true,
                cursor = "seq:7",
                processedEventIds = setOf("event-7"),
            ),
            initialized = true,
        )

        val merged = controller.mergeSnapshotWithLiveState("session", staleSnapshot, live)

        assertEquals("Live", merged.session?.title)
        assertEquals(listOf("snapshot", "live"), merged.messages.map { it.text })
        assertEquals(SessionRuntimeStatus.Running, merged.runtime.status)
        assertTrue(merged.capabilities.isUsable(SESSION_SEND_MESSAGE_CAPABILITY, "codex"))
        assertEquals(7L, merged.notices.eventSequence)
        assertEquals("seq:7", merged.realtime.cursor)
        assertTrue(merged.realtime.connected)
    }

    @Test
    fun snapshotMergeKeepsEqualRevisionLiveOwners() {
        val controller = SessionDetailController(
            sessionsApi = SessionsApi(),
            sessionStore = object : AuthSessionReader {
                override fun readServerUrl(): String = "https://server.example"
                override fun readAccessToken(): String = "token"
            },
        )
        val snapshot = SessionDetailState(
            meta = SessionMeta(session = session(true).copy(title = "Snapshot", updatedSeq = 7)),
            catalogs = RuntimeCatalogs(
                model = RemoteRuntimeModelCatalog("snapshot", 7, emptyList()),
                permission = RemoteRuntimePermissionCatalog("snapshot", 7, emptyList()),
            ),
            initialized = true,
        )
        val live = SessionDetailState(
            meta = SessionMeta(session = session(true).copy(title = "Live", updatedSeq = 7)),
            catalogs = RuntimeCatalogs(
                model = RemoteRuntimeModelCatalog("live", 7, emptyList()),
                permission = RemoteRuntimePermissionCatalog("live", 7, emptyList()),
            ),
            initialized = true,
        )

        val merged = controller.mergeSnapshotWithLiveState("session", snapshot, live)

        assertEquals("Live", merged.session?.title)
        assertEquals("live", merged.catalogs.model?.runtime)
        assertEquals("live", merged.catalogs.permission?.runtime)
    }

    @Test
    fun unknownRuntimeStatusStaysUnknownInsteadOfFallingBackToIdle() {
        val state = remoteRuntimeState(status = "future_status", updatedSeq = 7)
            .toSessionRuntimeState(serverTime = "now")

        assertEquals(SessionRuntimeStatus.Unknown, state.status)
        assertTrue(state.isLoaded)
        assertEquals("future_status_reason", state.statusReason)
        assertEquals(7, state.updatedSeq)
    }

    @Test
    fun effectiveCapabilityRequiresSupportedAvailableAndAllowed() {
        listOf(
            Triple(false, true, true),
            Triple(true, false, true),
            Triple(true, true, false),
        ).forEach { (supported, available, allowed) ->
            val state = capabilitySet(supported, available, allowed)
                .toEffectiveCapabilities("connector", "now")
            assertFalse(state.isUsable("session.send_message", "codex"))
        }

        val usable = capabilitySet(true, true, true).toEffectiveCapabilities("connector", "now")
        assertTrue(usable.isUsable("session.send_message", "codex"))
        assertFalse(usable.isUsable("future.capability", "codex"))
    }

    @Test
    fun timelineMergeUsesStableSourceRevisionAndOrderSequence() {
        val current = listOf(
            message(id = "newer", source = "source-a", revision = 2, updatedSeq = 5, orderSeq = 20),
            message(id = "later", source = "source-b", revision = 1, updatedSeq = 1, orderSeq = 30),
        )
        val stale = message(id = "stale", source = "source-a", revision = 1, updatedSeq = 4, orderSeq = 5)

        val staleMerge = mergeTimelineMessages(current, listOf(stale))
        assertEquals(listOf("newer", "later"), staleMerge.map { it.id })

        val revised = message(id = "revised", source = "source-a", revision = 3, updatedSeq = 6, orderSeq = 10)
        val revisedMerge = mergeTimelineMessages(staleMerge, listOf(revised))
        assertEquals(listOf("revised", "later"), revisedMerge.map { it.id })
        val changedBySequence = message(
            id = "sequence",
            source = "source-a",
            revision = 2,
            updatedSeq = 7,
            orderSeq = 15,
        )
        assertEquals(
            listOf("sequence", "later"),
            mergeTimelineMessages(revisedMerge, listOf(changedBySequence)).map { it.id },
        )
        assertEquals(current, mergeTimelineMessages(current, emptyList()))
    }

    @Test
    fun timelineOrderingMatchesWebWithoutTurnOwnership() {
        val controller = SessionDetailController(
            SessionsApi(),
            object : AuthSessionReader {
                override fun readServerUrl(): String = "https://server.example"
                override fun readAccessToken(): String = "token"
            },
        )
        val initial = SessionDetailState(
            meta = SessionMeta(session = session(true)),
            initialized = true,
        )
        val items = listOf(
            timelineItem("later", 10, 10).copy(id = "later"),
            timelineItem("same-z", 5, 6).copy(id = "same-z"),
            timelineItem("same-b", 5, 5).copy(id = "same-b"),
            timelineItem("same-a", 5, 5).copy(id = "same-a"),
        )
        val events = items.map { item ->
            event(
                id = "event-${item.id}",
                type = "timeline.item_created",
                sequence = item.updatedSeq.toLong(),
                payload = RemoteSessionEventPayload(item = item),
            )
        }

        val result = controller.applyRealtimeEvents(initial, events, emptyList())

        assertEquals(listOf("same-a", "same-b", "same-z", "later"), result.messages.map { it.id })
        assertEquals(4, result.timeline.orderingItems.size)
    }

    @Test
    fun invalidRealtimeOrderKeepsExistingStableOrder() {
        val controller = SessionDetailController(
            SessionsApi(),
            object : AuthSessionReader {
                override fun readServerUrl(): String = "https://server.example"
                override fun readAccessToken(): String = "token"
            },
        )
        val initial = SessionDetailState(
            meta = SessionMeta(session = session(true)),
            timeline = SessionTimelineState(
                messages = listOf(message("item", "item", 1, 5, 20)),
                orderingItems = listOf(TimelineOrderingItem("item", 20, 1, 5)),
            ),
            initialized = true,
        )
        val update = event(
            "updated-item",
            "timeline.item_updated",
            6,
            RemoteSessionEventPayload(
                item = timelineItem("updated", orderSeq = 0, updatedSeq = 6).copy(
                    id = "item",
                    revision = 2,
                ),
            ),
        )

        val result = controller.applyRealtimeEvent(initial, update, emptyList())

        assertEquals(20, result.timeline.orderingItems.single().orderSeq)
        assertEquals(20, result.messages.single().orderSeq)
        assertEquals("updated", result.messages.single().text)

        val newInvalid = controller.applyRealtimeEvent(
            result,
            event(
                "new-invalid",
                "timeline.item_created",
                7,
                RemoteSessionEventPayload(item = timelineItem("new", 0, 7).copy(id = "new-item")),
            ),
            emptyList(),
        )
        assertTrue(newInvalid.timeline.orderingItems.single { it.id == "new-item" }.orderSeq > 20)
        assertEquals("new", newInvalid.messages.last().text)
    }

    @Test
    fun consecutiveOptimisticMessagesUseIncreasingFiniteOrder() {
        val controller = SessionDetailController(
            SessionsApi(),
            object : AuthSessionReader {
                override fun readServerUrl(): String = "https://server.example"
                override fun readAccessToken(): String = "token"
            },
        )
        val initial = SessionDetailState(
            timeline = SessionTimelineState(
                messages = listOf(message("server", "server", 1, 4, 4)),
                orderingItems = listOf(TimelineOrderingItem("server", 4, 1, 4)),
                nextSeq = 4,
            ),
        )

        val first = controller.addOptimisticMessage("session", initial, "one", "client-1")
        val second = controller.addOptimisticMessage("session", first, "two", "client-2")
        val optimistic = second.messages.filter { it.optimistic }

        assertEquals(listOf("client-1", "client-2"), optimistic.map { it.id })
        assertTrue(optimistic[0].orderSeq < optimistic[1].orderSeq)
        assertTrue(optimistic.all { it.orderSeq < Int.MAX_VALUE })
    }

    @Test
    fun failedRetryKeepsClientMessageIdAndServerEchoReplacesItEvenAfterFailure() {
        val controller = controller()
        val initial = SessionDetailState(meta = SessionMeta(session = session(true)))
        val optimistic = controller.addOptimisticMessage(
            sessionId = "session",
            state = initial,
            text = "retry me",
            clientMessageId = "client-retry",
            retryAction = RuntimeMessageAction.Send,
        )
        val failed = controller.markOptimisticMessage(
            sessionId = "session",
            state = optimistic,
            clientMessageId = "client-retry",
            status = "failed",
            errorMessage = "offline",
        )
        val retried = controller.addOptimisticMessage(
            sessionId = "session",
            state = failed,
            text = "retry me",
            clientMessageId = "client-retry",
            retryAction = RuntimeMessageAction.Send,
        )
        assertEquals(1, retried.messages.count { it.clientMessageId == "client-retry" })
        assertEquals("pending", retried.messages.single().status)

        val echo = timelineItem("retry me", 1, 2).copy(
            id = "server-message",
            role = "user",
            source = JSONObject().put("clientMessageId", "client-retry"),
        )
        val resolved = controller.applyRealtimeEvent(
            retried,
            event("echo", "timeline.item_created", 2, RemoteSessionEventPayload(item = echo)),
            emptyList(),
        )
        assertEquals(listOf("server-message"), resolved.messages.map { it.id })
        assertFalse(resolved.messages.single().optimistic)
        assertTrue(controller.hasServerEcho(resolved, "client-retry"))

        val duplicate = controller.applyRealtimeEvent(
            resolved,
            event("echo-duplicate", "timeline.item_updated", 3, RemoteSessionEventPayload(item = echo)),
            emptyList(),
        )
        assertEquals(listOf("server-message"), duplicate.messages.map { it.id })
        val revisedEcho = echo.copy(
            revision = 2,
            updatedSeq = 4,
            text = "retry accepted",
            content = JSONObject().put("kind", "text").put("text", "retry accepted"),
        )
        val revised = controller.applyRealtimeEvent(
            duplicate,
            event("echo-revised", "timeline.item_updated", 4, RemoteSessionEventPayload(item = revisedEcho)),
            emptyList(),
        )
        assertEquals(listOf("server-message"), revised.messages.map { it.id })
        assertEquals("retry accepted", revised.messages.single().text)
        assertEquals(2, revised.messages.single().revision)
    }

    @Test
    fun timelineRendererCoversPlatformTypesAndUsesSafeDiagnosticForExtensions() {
        val controller = controller()
        val items = listOf(
            timelineItem("user", 1, 1).copy(role = "user", content = JSONObject().put("kind", "markdown").put("text", "user")),
            timelineItem("assistant", 2, 2).copy(content = JSONObject().put("kind", "text").put("text", "assistant")),
            timelineItem("structured", 2, 2).copy(
                id = "item-structured",
                text = "",
                content = JSONObject()
                    .put("kind", "multimodal")
                    .put("content", org.json.JSONArray().put(JSONObject().put("text", "structured message"))),
            ),
            timelineItem("system-role", 3, 3).copy(role = "system", content = JSONObject().put("kind", "text").put("text", "system role")),
            timelineItem("command", 4, 4).copy(type = "tool", content = JSONObject().put("kind", "command").put("command", "pwd")),
            timelineItem("tool-call", 5, 5).copy(type = "tool", content = JSONObject().put("kind", "tool_call").put("title", "Read")),
            timelineItem("file-change", 6, 6).copy(
                type = "tool",
                content = JSONObject().put("kind", "file_change").put(
                    "changes",
                    org.json.JSONArray().put(JSONObject().put("path", "/workspace/a.txt").put("action", "update")),
                ),
            ),
            timelineItem("artifact", 7, 7).copy(type = "artifact", content = JSONObject().put("kind", "image").put("path", "/workspace/a.png")),
            timelineItem("compact", 8, 8).copy(type = "marker", status = "running", content = JSONObject().put("kind", "compact").put("state", "started")),
            timelineItem("error", 9, 9).copy(type = "system", status = "failed", content = JSONObject().put("kind", "error").put("message", "boom")),
            timelineItem("reasoning", 10, 10).copy(type = "system", content = JSONObject().put("kind", "reasoning").put("text", "think")),
            timelineItem("unknown", 11, 11).copy(
                type = "future.type",
                content = JSONObject().put("kind", "future_kind").put("password", "do-not-leak"),
            ),
        )
        val events = items.map { item ->
            event("event-${item.id}", "timeline.item_created", item.updatedSeq.toLong(), RemoteSessionEventPayload(item = item))
        }

        val rendered = controller.applyRealtimeEvents(
            SessionDetailState(meta = SessionMeta(session = session(true))),
            events,
            emptyList(),
        )

        assertTrue(rendered.messages.any { it.kind == TimelineMessageKind.Command })
        assertTrue(rendered.messages.any { it.kind == TimelineMessageKind.ToolCall })
        assertTrue(rendered.messages.any { it.kind == TimelineMessageKind.FileChange })
        assertTrue(rendered.messages.any { it.kind == TimelineMessageKind.Artifact })
        assertTrue(rendered.messages.any { it.kind == TimelineMessageKind.Marker })
        assertTrue(rendered.messages.any { it.kind == TimelineMessageKind.Error })
        assertTrue(rendered.messages.any { it.kind == TimelineMessageKind.Reasoning })
        assertEquals("structured message", rendered.messages.single { it.id == "item-structured" }.text)
        val unknown = rendered.messages.single { it.kind == TimelineMessageKind.Diagnostic }
        assertTrue(unknown.text.contains("future.type / future_kind"))
        assertTrue(unknown.text.contains("item-unknown"))
        assertFalse(unknown.text.contains("do-not-leak"))
        assertEquals(12, rendered.timeline.orderingItems.size)
    }

    @Test
    fun newerRevisionReplacesUnknownDiagnosticWithKnownPlatformItem() {
        val controller = controller()
        val initial = timelineItem("unknown", 1, 1).copy(
            type = "future.type",
            content = JSONObject().put("kind", "future"),
        )
        val diagnostic = controller.applyRealtimeEvent(
            SessionDetailState(meta = SessionMeta(session = session(true))),
            event("unknown-created", "timeline.item_created", 1, RemoteSessionEventPayload(item = initial)),
            emptyList(),
        )
        val replacement = initial.copy(
            type = "message",
            role = "assistant",
            text = "resolved",
            content = JSONObject().put("kind", "text").put("text", "resolved"),
            revision = 2,
            updatedSeq = 2,
        )

        val resolved = controller.applyRealtimeEvent(
            diagnostic,
            event("unknown-updated", "timeline.item_updated", 2, RemoteSessionEventPayload(item = replacement)),
            emptyList(),
        )

        assertEquals(TimelineMessageKind.Text, resolved.messages.single().kind)
        assertEquals("resolved", resolved.messages.single().text)
        assertEquals(2, resolved.messages.single().revision)
    }

    @Test
    fun attachmentOnlyMessageKeepsEmptyTextAndAttachmentMetadata() {
        val controller = controller()
        val attachment = JSONObject()
            .put("fileId", "file-1")
            .put("name", "photo.png")
            .put("mediaType", "image/png")
            .put("size", 3)
            .put("sha256", "abc")
        val item = timelineItem("", 1, 1).copy(
            role = "user",
            content = JSONObject().put("kind", "multimodal").put("text", "").put("attachments", org.json.JSONArray().put(attachment)),
        )
        val state = controller.applyRealtimeEvent(
            SessionDetailState(meta = SessionMeta(session = session(true))),
            event("attachment", "timeline.item_created", 1, RemoteSessionEventPayload(item = item)),
            emptyList(),
        )

        assertEquals("", state.messages.single().text)
        assertEquals("file-1", state.messages.single().attachments.single().fileId)
        assertEquals("abc", state.messages.single().attachments.single().sha256)
    }

    @Test
    fun knownTimelineSubtypesAndStatusesNeverFallIntoDiagnosticRenderer() {
        val controller = controller()
        val statuses = listOf(
            "pending",
            "running",
            "waiting_approval",
            "done",
            "failed",
            "cancelled",
            "interrupted",
        )
        val items = buildList {
            statuses.forEachIndexed { index, status ->
                add(
                    timelineItem("status-$status", index + 1, index + 1).copy(
                        status = status,
                        role = listOf("user", "assistant", "system", "tool")[index % 4],
                        content = JSONObject().put("kind", "text").put("text", status),
                    ),
                )
            }
            listOf(
                "command",
                "mcp",
                "tool_call",
                "tool_result",
                "file_change",
                "permission",
                "input_request",
                "web_search",
            ).forEachIndexed { index, kind ->
                val content = JSONObject().put("kind", kind).put("title", kind)
                if (kind == "file_change") {
                    content.put("changes", org.json.JSONArray().put(JSONObject().put("path", "file.txt")))
                }
                add(timelineItem("tool-$kind", 20 + index, 20 + index).copy(type = "tool", content = content))
            }
            listOf("file", "file_change", "diff", "image", "document", "code").forEachIndexed { index, kind ->
                val content = JSONObject().put("kind", kind).put("path", "/workspace/$kind")
                if (kind == "file_change") {
                    content.put("changes", org.json.JSONArray().put(JSONObject().put("path", "file.txt")))
                }
                add(timelineItem("artifact-$kind", 40 + index, 40 + index).copy(type = "artifact", content = content))
            }
            listOf("compact", "system", "runtime", "notice", "error").forEachIndexed { index, kind ->
                add(
                    timelineItem("marker-$kind", 60 + index, 60 + index).copy(
                        type = "marker",
                        content = JSONObject().put("kind", kind).put("label", kind),
                    ),
                )
            }
            listOf("reasoning", "runtime", "system", "error", "notice", "compact")
                .forEachIndexed { index, kind ->
                    add(
                        timelineItem("system-$kind", 80 + index, 80 + index).copy(
                            type = "system",
                            content = JSONObject().put("kind", kind).put("text", kind),
                        ),
                    )
                }
        }
        val events = items.map { item ->
            event(
                "known-${item.id}",
                "timeline.item_created",
                item.updatedSeq.toLong(),
                RemoteSessionEventPayload(item = item),
            )
        }

        val rendered = controller.applyRealtimeEvents(
            SessionDetailState(meta = SessionMeta(session = session(true))),
            events,
            emptyList(),
        )

        assertFalse(rendered.messages.any { it.kind == TimelineMessageKind.Diagnostic })
        statuses.forEach { status -> assertTrue(rendered.messages.any { it.status == status }) }
        assertTrue(rendered.messages.count { it.kind == TimelineMessageKind.Artifact } >= 5)
        assertTrue(rendered.messages.any { it.kind == TimelineMessageKind.FileChange && it.type == "artifact" })
        assertTrue(rendered.messages.any { it.kind == TimelineMessageKind.Marker })
        assertTrue(rendered.messages.any { it.kind == TimelineMessageKind.Error })
    }

    @Test
    fun hundredRealtimeTimelineEventsMergeAsOneStableBatchWithoutDuplicates() {
        val controller = SessionDetailController(
            SessionsApi(),
            object : AuthSessionReader {
                override fun readServerUrl(): String = "https://server.example"
                override fun readAccessToken(): String = "token"
            },
        )
        val initial = SessionDetailState(
            meta = SessionMeta(session = session(true)),
            initialized = true,
        )
        val events = (1..100).map { index ->
            event(
                id = "event-$index",
                type = "timeline.item_created",
                sequence = index.toLong(),
                payload = RemoteSessionEventPayload(
                    item = timelineItem("message-$index", index, index),
                ),
            )
        }

        val result = controller.applyRealtimeEvents(initial, events + events.last(), emptyList())

        assertEquals(100, result.messages.size)
        assertEquals((1..100).map { "message-$it" }, result.messages.map { it.text })
        assertEquals(100, result.realtime.processedEventIds.size)
        assertEquals("seq:100", result.realtime.cursor)
    }

    @Test
    fun runtimeRefreshCannotOverwriteRealtimeOwnerObservedAfterRequestStarted() {
        val controller = SessionDetailController(
            SessionsApi(),
            object : AuthSessionReader {
                override fun readServerUrl(): String = "https://server.example"
                override fun readAccessToken(): String = "token"
            },
        )
        val requestState = SessionDetailState(
            runtime = remoteRuntimeState("idle", 4).toSessionRuntimeState("request"),
            capabilities = capabilitySet(true, true, false, 4).toEffectiveCapabilities("connector", "request"),
        )
        val current = requestState.copy(
            runtime = remoteRuntimeState("running", 5).toSessionRuntimeState("event"),
            capabilities = capabilitySet(true, true, true, 5).toEffectiveCapabilities("connector", "event"),
        )
        val refreshed = requestState.copy(
            runtime = remoteRuntimeState("idle", 4).toSessionRuntimeState("response"),
            capabilities = capabilitySet(true, true, false, 4).toEffectiveCapabilities("connector", "response"),
        )

        val merged = controller.mergeRuntimeLiveState(current, requestState, refreshed)

        assertEquals(SessionRuntimeStatus.Running, merged.runtime.status)
        assertTrue(merged.capabilities.isUsable(SESSION_SEND_MESSAGE_CAPABILITY, "codex"))
    }

    @Test
    fun domainObservationsDoNotOverwriteOtherOwners() {
        val originalSession = session(connectorOnline = true)
        val originalRuntime = remoteRuntimeState("running", updatedSeq = 9).toSessionRuntimeState("runtime-time")
        val originalMessage = message("message", "source", revision = 1, updatedSeq = 3, orderSeq = 1)
        val originalNotice = remoteNotice(revision = 2, updatedSeq = 8)
        val initial = SessionDetailState(
            meta = SessionMeta(session = originalSession),
            timeline = SessionTimelineState(messages = listOf(originalMessage), nextSeq = 3),
            runtime = originalRuntime,
        ).applyNoticeObservation(listOf(originalNotice), "notice-time", replace = true)

        val offlineMeta = initial.applyMetaObservation(session(connectorOnline = false), "meta-time")
        assertEquals(SessionRuntimeStatus.Running, offlineMeta.runtime.status)
        assertEquals(listOf(originalMessage), offlineMeta.timeline.messages)
        assertEquals(listOf("notice-1"), offlineMeta.notices.notices.map { it.noticeId })

        val runtimeError = offlineMeta.applyRuntimeObservation(
            remoteRuntimeState("error", updatedSeq = 10).toSessionRuntimeState("runtime-time-2"),
        )
        assertSame(offlineMeta.meta.session, runtimeError.meta.session)
        assertEquals(listOf(originalMessage), runtimeError.timeline.messages)
        assertEquals(SessionRuntimeStatus.Error, runtimeError.runtime.status)

        val notices = runtimeError.applyNoticeObservation(
            listOf(remoteNotice(revision = 3, updatedSeq = 10)),
            "notice-time-2",
            replace = true,
        )
        assertSame(runtimeError.meta.session, notices.meta.session)
        assertEquals(SessionRuntimeStatus.Error, notices.runtime.status)
        assertEquals(3, notices.notices.notices.single().revision)
    }

    @Test
    fun staleRuntimeCapabilitiesAndNoticesCannotReplaceNewerFacts() {
        val running = remoteRuntimeState("running", updatedSeq = 10).toSessionRuntimeState("new")
        val newerCapabilities = capabilitySet(true, true, true, revision = 5)
            .toEffectiveCapabilities("connector", "new")
        val state = SessionDetailState(runtime = running, capabilities = newerCapabilities)
            .applyNoticeObservation(listOf(remoteNotice(revision = 4, updatedSeq = 9)), "new", replace = true)

        val afterStaleRuntime = state.applyRuntimeObservation(
            remoteRuntimeState("idle", updatedSeq = 8).toSessionRuntimeState("old"),
        )
        val afterStaleCapabilities = afterStaleRuntime.applyCapabilitiesObservation(
            capabilitySet(false, false, false, revision = 4).toEffectiveCapabilities("connector", "old"),
        )
        val afterStaleNotice = afterStaleCapabilities.applyNoticeObservation(
            listOf(remoteNotice(revision = 3, updatedSeq = 8)),
            "old",
            replace = true,
        )

        assertEquals(SessionRuntimeStatus.Running, afterStaleNotice.runtime.status)
        assertTrue(afterStaleNotice.capabilities.isUsable("session.send_message", "codex"))
        assertEquals(4, afterStaleNotice.notices.notices.single().revision)
    }

    @Test
    fun messageActionUsesEffectiveCapabilitiesAndNeverFallsBackAcrossActions() {
        val send = effectiveCapabilities(SESSION_SEND_MESSAGE_CAPABILITY)
        val steer = effectiveCapabilities(SESSION_STEER_CAPABILITY)
        val both = effectiveCapabilities(SESSION_SEND_MESSAGE_CAPABILITY, SESSION_STEER_CAPABILITY)

        assertEquals(RuntimeMessageAction.Send, send.messageAction("codex", SessionRuntimeStatus.Idle))
        assertEquals(RuntimeMessageAction.Steer, steer.messageAction("codex", SessionRuntimeStatus.Running))
        assertEquals(RuntimeMessageAction.Send, both.messageAction("codex", SessionRuntimeStatus.Idle))
        assertEquals(RuntimeMessageAction.Steer, both.messageAction("codex", SessionRuntimeStatus.Running))
        assertNull(EffectiveCapabilities(isLoaded = true).messageAction("codex", SessionRuntimeStatus.Idle))
    }

    @Test
    fun liveCatalogSelectionUsesHintThenDefaultThenFirstValidSelection() {
        val model = RemoteRuntimeModelCatalog(
            runtime = "codex",
            revision = 3,
            models = listOf(
                RemoteRuntimeModel(
                    id = "model-a",
                    selectionId = "model:a",
                    displayName = "Model A",
                    description = null,
                    default = false,
                    reasoningItems = emptyList(),
                    metadata = emptyMap(),
                ),
                RemoteRuntimeModel(
                    id = "model-b",
                    selectionId = null,
                    displayName = "Model B",
                    description = null,
                    default = true,
                    reasoningItems = listOf(
                        RemoteRuntimeReasoning(
                            id = "high",
                            selectionId = "model:b:high",
                            fullModelId = null,
                            displayName = "High",
                            description = null,
                            default = true,
                            metadata = emptyMap(),
                        ),
                    ),
                    metadata = emptyMap(),
                ),
            ),
        ).selectionOptions()
        val permission = RemoteRuntimePermissionCatalog(
            runtime = "codex",
            revision = 2,
            permissions = listOf(
                RemoteRuntimePermission(
                    id = "read",
                    selectionId = "permission:read",
                    displayName = "Read",
                    description = null,
                    default = false,
                    metadata = emptyMap(),
                ),
            ),
        ).selectionOptions()

        assertEquals("model:a", model.validatedSelection("model:a"))
        assertEquals("model:b:high", model.validatedSelection("missing"))
        assertEquals("permission:read", permission.validatedSelection(null))
        assertNull(emptyList<RuntimeSelectionOption>().validatedSelection("missing"))
    }

    @Test
    fun commandsFuzzyMatchAliasesAndNoticeInputIsValidatedAndTyped() {
        val command = RuntimeCommand(
            id = "compact",
            title = "Compact context",
            description = "Reduce history",
            aliases = listOf("shrink"),
            category = "context",
            scope = "session",
            enabled = false,
            disabledReason = "runtime_busy",
            acceptsArgs = true,
            argsSchema = null,
            metadata = emptyMap(),
        )
        assertTrue(command.matches("compact"))
        assertTrue(command.matches("shrink context"))
        assertFalse(command.matches("unknown"))
        assertFalse(command.enabled)

        val action = RuntimeNoticeAction(
            actionId = "submit",
            label = "Submit",
            style = "primary",
            input = RuntimeNoticeActionInput(
                required = true,
                schema = mapOf(
                    "required" to listOf("count", "confirmed"),
                    "properties" to mapOf(
                        "count" to mapOf("title" to "Count", "type" to "integer"),
                        "confirmed" to mapOf("title" to "Confirmed", "type" to "boolean"),
                    ),
                ),
                uiSchema = null,
            ),
            unknown = mapOf("future" to true),
        )
        assertTrue(action.coerceInput(mapOf("count" to "2", "confirmed" to "yes")).isSuccess)
        assertEquals(2L, action.coerceInput(mapOf("count" to "2", "confirmed" to "yes")).getOrThrow()?.get("count"))
        assertEquals(true, action.coerceInput(mapOf("count" to "2", "confirmed" to "yes")).getOrThrow()?.get("confirmed"))
        assertTrue(action.coerceInput(mapOf("count" to "bad", "confirmed" to "yes")).isFailure)
        assertTrue(action.coerceInput(mapOf("count" to "2")).isFailure)
    }

    @Test
    fun catalogAndCommandRequestKeysDropLateResponsesAndFailuresKeepStaleData() {
        val originalModel = RemoteRuntimeModelCatalog("codex", 1, emptyList())
        val newerModel = RemoteRuntimeModelCatalog("codex", 2, emptyList())
        val firstCatalogRequest = RuntimeCatalogs(model = originalModel).beginModel("session-a")
        val firstKey = firstCatalogRequest.requestKey!!
        val secondCatalogRequest = firstCatalogRequest.beginPermission("session-b")
        assertEquals(originalModel, secondCatalogRequest.applyModel(firstKey, newerModel).model)

        val activeModelRequest = RuntimeCatalogs(model = originalModel).beginModel("session-a")
        val failedCatalog = activeModelRequest.failModel(activeModelRequest.requestKey!!, "offline")
        assertEquals(originalModel, failedCatalog.model)
        assertTrue(failedCatalog.modelStale)
        assertEquals("offline", failedCatalog.modelErrorMessage)

        val oldCommand = RuntimeCommand(
            id = "old",
            title = "Old",
            description = null,
            aliases = emptyList(),
            category = null,
            scope = "session",
            enabled = true,
            disabledReason = null,
            acceptsArgs = false,
            argsSchema = null,
            metadata = emptyMap(),
        )
        val firstCommands = RuntimeCommands(commands = listOf(oldCommand), isLoaded = true).begin("session-a")
        val staleKey = firstCommands.requestKey!!
        val latestCommands = firstCommands.begin("session-b")
        assertEquals(listOf(oldCommand), latestCommands.apply(staleKey, emptyList()).commands)
        val failedCommands = latestCommands.fail(latestCommands.requestKey!!, "offline")
        assertEquals(listOf(oldCommand), failedCommands.commands)
        assertTrue(failedCommands.stale)
        assertEquals("offline", failedCommands.errorMessage)
    }

    private fun remoteRuntimeState(status: String, updatedSeq: Int): RemoteSessionRuntimeState {
        return RemoteSessionRuntimeState(
            sessionId = "session",
            runtime = "codex",
            externalSessionId = null,
            status = status,
            selections = mapOf("model" to "model-selection"),
            statusReason = "future_status_reason",
            error = null,
            metadata = mapOf("owner" to "runtime"),
            updatedSeq = updatedSeq,
            createdAt = "created",
            updatedAt = "updated",
        )
    }

    private fun controller(): SessionDetailController = SessionDetailController(
        SessionsApi(),
        object : AuthSessionReader {
            override fun readServerUrl(): String = "https://server.example"
            override fun readAccessToken(): String = "token"
        },
    )

    private fun event(
        id: String,
        type: String,
        sequence: Long,
        payload: RemoteSessionEventPayload,
    ): RemoteSessionEventEnvelope = RemoteSessionEventEnvelope(
        protocolVersion = "1.0",
        eventId = id,
        sequence = sequence,
        cursor = "seq:$sequence",
        type = type,
        sessionId = "session",
        emittedAt = "now",
        payload = payload,
    )

    private fun timelineItem(text: String, orderSeq: Int, updatedSeq: Int): RemoteTimelineItem = RemoteTimelineItem(
        id = "item-$text",
        sessionId = "session",
        type = "message",
        status = "done",
        role = "assistant",
        text = text,
        content = org.json.JSONObject().put("text", text),
        source = org.json.JSONObject(),
        orderSeq = orderSeq,
        revision = 1,
        updatedSeq = updatedSeq,
        createdAt = "now",
        updatedAt = "now",
    )

    private fun capabilitySet(
        supported: Boolean,
        available: Boolean,
        allowed: Boolean,
        revision: Long = 1,
    ): RemoteRuntimeCapabilitySet {
        return RemoteRuntimeCapabilitySet(
            revision = revision,
            capabilities = listOf(
                RemoteRuntimeCapability(
                    capabilityId = "session.send_message",
                    version = "1",
                    scope = "session",
                    runtime = "codex",
                    sessionId = "session",
                    supported = supported,
                    available = available,
                    allowed = allowed,
                    unavailableReason = null,
                    parameters = emptyMap(),
                ),
            ),
        )
    }

    private fun effectiveCapabilities(vararg ids: String): EffectiveCapabilities {
        return EffectiveCapabilities(
            revision = 1,
            capabilities = ids.map { id ->
                EffectiveCapability(
                    capabilityId = id,
                    version = "1",
                    scope = "session",
                    runtime = "codex",
                    sessionId = "session",
                    supported = true,
                    available = true,
                    allowed = true,
                    unavailableReason = null,
                    parameters = emptyMap(),
                )
            },
            isLoaded = true,
        )
    }

    private fun remoteNotice(revision: Int, updatedSeq: Int): RemoteRuntimeNotice {
        return RemoteRuntimeNotice(
            noticeId = "notice-1",
            type = "approval",
            sessionId = "session",
            source = mapOf("runtime" to "codex"),
            title = "Approve",
            message = null,
            severity = "warning",
            status = "open",
            interactionType = "approval",
            blocking = null,
            responseRequired = true,
            actions = emptyList(),
            context = emptyMap(),
            metadata = emptyMap(),
            expiresAt = null,
            revision = revision,
            updatedSeq = updatedSeq,
            createdAt = null,
            resolvedAt = null,
        )
    }

    private fun RemoteRuntimeNotice.toRuntimeNoticeForTest(): RuntimeNotice = RuntimeNotice(
        noticeId = noticeId,
        type = type,
        sessionId = sessionId,
        title = title,
        message = message,
        severity = severity,
        status = status,
        interactionType = interactionType,
        blocking = null,
        responseRequired = responseRequired,
        revision = revision,
        updatedSeq = updatedSeq,
        source = source,
        actions = emptyList(),
        context = context,
        metadata = metadata,
        expiresAt = expiresAt,
        createdAt = createdAt,
        updatedAt = updatedAt,
        resolvedAt = resolvedAt,
    )

    private fun message(
        id: String,
        source: String,
        revision: Int,
        updatedSeq: Int,
        orderSeq: Int,
    ): TimelineMessage {
        return TimelineMessage(
            id = id,
            sourceItemId = source,
            author = MessageAuthor.Agent,
            text = id,
            revision = revision,
            updatedSeq = updatedSeq,
            orderSeq = orderSeq,
        )
    }

    private fun session(connectorOnline: Boolean): AgentSession {
        return AgentSession(
            id = "session",
            connectorId = "connector",
            deviceName = "Device",
            title = "Title",
            summary = "",
            cwd = "/workspace",
            workspaceLabel = "workspace",
            runtime = "codex",
            runtimeLabel = "Codex",
            status = SessionStatus.Idle,
            statusLabel = "Idle",
            updatedAtLabel = "",
            metaLabel = "Codex",
            pinned = false,
            archived = false,
            unread = false,
            lastReadSeq = 0,
            takeover = true,
            connectorOnline = connectorOnline,
            live = false,
            sortKey = "",
            updatedSeq = 1,
        )
    }

    private fun AgentSession.toRemote() = com.agentsanywhere.app.api.RemoteSession(
        id = id,
        connectorId = connectorId,
        connectorStatus = if (connectorOnline) "online" else "offline",
        runtime = runtime,
        externalSessionId = null,
        title = title,
        cwd = cwd,
        status = "idle",
        takeover = takeover,
        pinned = pinned,
        pinnedAt = null,
        archived = archived,
        archivedAt = null,
        unread = unread,
        lastReadSeq = lastReadSeq,
        lastSyncedAt = null,
        sourceObservedAt = null,
        lastActivityAt = null,
        lastItemAt = null,
        lastItemOrderSeq = null,
        sortAt = sortKey,
        updatedSeq = updatedSeq,
    )
}
