package com.agentsanywhere.app.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NewSessionDraftTest {
    @Test
    fun previewKeepsOnlyThePreparedSessionMetadata() {
        val draft = NewSessionDraft(
            connectorId = "device-1",
            runtime = "codex",
            title = "New session",
            cwd = "/workspace",
            deviceName = "Mac",
            runtimeLabel = "Codex",
            knownSessionIds = setOf("existing"),
        )

        val preview = draft.previewSession()

        assertEquals(NewSessionDraft.LOCAL_NEW_SESSION_ID, preview.id)
        assertEquals("device-1", preview.connectorId)
        assertEquals("codex", preview.runtime)
        assertEquals("/workspace", preview.cwd)
        assertTrue(preview.takeover)
    }

    @Test
    fun firstRealMessageCreatesTheServerRequestWithPreparedSelections() {
        val selections = NewSessionSelections(model = "gpt-5.6:high", permission = "full-access")
        val prepared = NewSessionDraft(
            connectorId = "device-1",
            runtime = "codex",
            title = "New session",
            cwd = "/workspace",
            deviceName = "Mac",
            runtimeLabel = "Codex",
            knownSessionIds = setOf("existing"),
            selections = selections,
        )

        val request = prepared.firstMessageRequest(
            content = "  fix the tests  ",
            selections = selections,
            clientMessageId = "message-1",
        )

        assertEquals("fix the tests", request.content)
        assertEquals("gpt-5.6:high", request.selections.model)
        assertEquals("full-access", request.selections.permission)
        assertEquals(setOf("existing"), request.knownSessionIds)
    }
}
