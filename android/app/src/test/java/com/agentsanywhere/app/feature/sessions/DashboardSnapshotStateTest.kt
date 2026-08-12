package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DashboardSnapshotStateTest {
    @Test
    fun dashboardSnapshotReplacesCollectionsButPreservesNewerLocalMutation() {
        val current = SessionsState(
            sessions = listOf(session("local", updatedSeq = 8, pinned = true)),
            devices = listOf(device("old-device")),
            hasLoaded = true,
            sessionRequestGenerations = mapOf("local" to 4L),
            nextRequestGeneration = 5L,
        )
        val snapshot = SessionsState(
            sessions = listOf(
                session("local", updatedSeq = 7, pinned = false),
                session("new", updatedSeq = 1, pinned = false),
            ),
            archivedSessions = listOf(session("archived", updatedSeq = 2, pinned = false, archived = true)),
            devices = listOf(device("new-device")),
            hasLoaded = true,
        )

        val replaced = current.replacedByDashboardSnapshot(snapshot)

        assertEquals(listOf("local", "new"), replaced.sessions.map { it.id })
        assertTrue(replaced.sessions.first { it.id == "local" }.pinned)
        assertEquals(listOf("archived"), replaced.archivedSessions.map { it.id })
        assertEquals(listOf("new-device"), replaced.devices.map { it.id })
        assertEquals(mapOf("local" to 4L), replaced.sessionRequestGenerations)
        assertEquals(5L, replaced.nextRequestGeneration)
        assertFalse(replaced.isLoading)
    }

    private fun device(id: String) = AgentDevice(id, id, subtitle = "", online = true)

    private fun session(
        id: String,
        updatedSeq: Int,
        pinned: Boolean,
        archived: Boolean = false,
    ) = AgentSession(
        id = id,
        connectorId = "connector",
        deviceName = "Device",
        title = id,
        summary = "",
        cwd = null,
        workspaceLabel = "",
        runtime = "codex",
        runtimeLabel = "Codex",
        status = SessionStatus.Idle,
        statusLabel = "Idle",
        updatedAtLabel = "",
        metaLabel = "",
        pinned = pinned,
        archived = archived,
        unread = false,
        lastReadSeq = 0,
        takeover = false,
        connectorOnline = true,
        live = false,
        sortKey = id,
        updatedSeq = updatedSeq,
    )
}
