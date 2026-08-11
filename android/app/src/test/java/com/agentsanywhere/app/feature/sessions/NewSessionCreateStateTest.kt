package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NewSessionCreateStateTest {
    @Test
    fun submissionGuardDeduplicatesClicksAndKeepsStableClientMessageIdForRetry() {
        val initial = NewSessionSubmissionState()
        val first = initial.begin { "client-1" }!!

        assertTrue(first.state.inFlight)
        assertEquals("client-1", first.clientMessageId)
        assertNull(first.state.begin { "client-2" })

        val failed = first.state.fail("offline", outcomeUnknown = false)
        val retry = failed.begin { "client-2" }!!
        assertEquals("client-1", retry.clientMessageId)
        assertEquals("client-1", retry.state.clientMessageId)
    }

    @Test
    fun unknownOrRestoredInFlightSubmissionCannotBeRetriedBlindly() {
        val unknown = NewSessionSubmissionState(clientMessageId = "client-1")
            .fail("unknown", outcomeUnknown = true)
        assertNull(unknown.begin { "client-2" })

        val restored = NewSessionSubmissionState(inFlight = true, clientMessageId = "client-1")
            .interrupted("interrupted")
        assertFalse(restored.inFlight)
        assertTrue(restored.outcomeUnknown)
        assertEquals("client-1", restored.clientMessageId)
        assertNull(restored.begin { "client-2" })
    }

    @Test
    fun inlineAttachmentUsesOneBase64LayerAndStableSha256Metadata() {
        val inline = NewSessionAttachmentPart(
            name = "hello.txt",
            mediaType = "text/plain",
            bytes = "hello".toByteArray(),
        ).toInlineAttachmentRef()

        assertEquals("hello", Base64.getDecoder().decode(inline.contentBase64).toString(Charsets.UTF_8))
        assertEquals(5L, inline.size)
        assertEquals(inline.sha256, inline.fileId)
        assertEquals(64, inline.sha256.length)
        assertEquals("text/plain", inline.mediaType)
    }

    @Test
    fun draftValidationAllowsTextOrPureAttachmentButRejectsEmptyAndInvalidRuntime() {
        val base = draft(content = "message")
        assertNull(validateNewSessionDraft(base))
        assertNull(
            validateNewSessionDraft(
                base.copy(
                    content = "",
                    attachments = listOf(NewSessionAttachmentPart("file.txt", "text/plain", byteArrayOf(1))),
                ),
            ),
        )
        assertNotNull(validateNewSessionDraft(base.copy(content = "", attachments = emptyList())))
        assertNotNull(validateNewSessionDraft(base.copy(runtime = "acp")))
    }

    @Test
    fun timeoutReconciliationOnlyAcceptsOneNewMatchingServerSession() {
        val request = draft(
            content = "message",
            knownSessionIds = setOf("known"),
        )
        val matching = session(id = "created")
        val known = session(id = "known")
        val wrongRuntime = session(id = "wrong-runtime", runtime = "claude")
        val wrongCwd = session(id = "wrong-cwd", cwd = "/other")
        val state = SessionsState(sessions = listOf(known, matching, wrongRuntime, wrongCwd))

        assertEquals(listOf("created"), state.newCreateCandidates(request).map { it.id })
        assertTrue(state.newCreateCandidates(request.copy(knownSessionIds = setOf("known", "created"))).isEmpty())
        assertEquals(
            2,
            state.copy(sessions = state.sessions + session(id = "created-2"))
                .newCreateCandidates(request)
                .size,
        )
    }

    private fun draft(
        content: String,
        knownSessionIds: Set<String> = emptySet(),
    ): NewSessionCreateDraft {
        return NewSessionCreateDraft(
            connectorId = "connector",
            runtime = "codex",
            title = "Task",
            cwd = "/workspace",
            content = content,
            selections = NewSessionSelections(model = "model-id", permission = "permission-id"),
            attachments = emptyList(),
            clientMessageId = "client-message",
            knownSessionIds = knownSessionIds,
        )
    }

    private fun session(
        id: String,
        runtime: String = "codex",
        cwd: String = "/workspace",
    ): AgentSession {
        return AgentSession(
            id = id,
            connectorId = "connector",
            deviceName = "Device",
            title = "Task",
            summary = "",
            cwd = cwd,
            workspaceLabel = "workspace",
            runtime = runtime,
            runtimeLabel = runtime,
            status = SessionStatus.Idle,
            statusLabel = "Idle",
            updatedAtLabel = "",
            metaLabel = "",
            pinned = false,
            archived = false,
            unread = false,
            lastReadSeq = 0,
            takeover = true,
            connectorOnline = true,
            live = false,
            sortKey = "",
            updatedSeq = 0,
        )
    }
}
