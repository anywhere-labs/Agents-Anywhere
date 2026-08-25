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
            runtimeId = "rti_codex_work_01",
            runtimeType = "codex",
            runtimeName = "Work Codex",
        )

        val preview = draft.previewSession()

        assertEquals(NewSessionDraft.LOCAL_NEW_SESSION_ID, preview.id)
        assertEquals("device-1", preview.connectorId)
        assertEquals("codex", preview.runtime)
        assertEquals("rti_codex_work_01", preview.runtimeId)
        assertEquals("codex", preview.runtimeType)
        assertEquals("Work Codex", preview.runtimeName)
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
            runtimeId = "rti_codex_work_01",
            runtimeType = "codex",
        )

        val request = prepared.firstMessageRequest(
            content = "  fix the tests  ",
            selections = selections,
            clientMessageId = "message-1",
        )

        assertEquals("fix the tests", request.content)
        assertEquals("gpt-5.6:high", request.selections.model)
        assertEquals("full-access", request.selections.permission)
        assertEquals("codex", request.runtime)
        assertEquals("rti_codex_work_01", request.runtimeId)
        assertEquals("codex", request.runtimeType)
        assertEquals(setOf("existing"), request.knownSessionIds)
    }
}
