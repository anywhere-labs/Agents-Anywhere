package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteRuntimeCapability
import com.agentsanywhere.app.api.RemoteRuntimeCapabilitySet
import com.agentsanywhere.app.api.RemoteRuntimeModel
import com.agentsanywhere.app.api.RemoteRuntimeModelCatalog
import com.agentsanywhere.app.api.RemoteRuntimeNotice
import com.agentsanywhere.app.api.RemoteRuntimePermission
import com.agentsanywhere.app.api.RemoteRuntimePermissionCatalog
import com.agentsanywhere.app.api.RemoteRuntimeReasoning
import com.agentsanywhere.app.api.RemoteSessionRuntimeState
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionDetailStateTest {
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
}
