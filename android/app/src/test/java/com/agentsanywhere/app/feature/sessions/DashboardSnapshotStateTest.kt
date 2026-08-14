package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.DevicesApi
import com.agentsanywhere.app.api.FilesApi
import com.agentsanywhere.app.api.RemoteDashboardSnapshot
import com.agentsanywhere.app.api.RemoteDevice
import com.agentsanywhere.app.api.RemoteSession
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DashboardSnapshotStateTest {
    @Test
    fun dashboardSnapshotExposesOnlySupportedV2Sessions() {
        val controller = SessionsController(
            sessionsApi = SessionsApi(),
            devicesApi = DevicesApi(),
            filesApi = FilesApi(),
            sessionStore = object : AuthSessionReader {
                override fun readServerUrl(): String = ""
                override fun readAccessToken(): String = ""
            },
        )
        val snapshot = RemoteDashboardSnapshot(
            devices = listOf(remoteDevice()),
            sessions = listOf(
                remoteSession("codex", "codex"),
                remoteSession("claude", "claude"),
                remoteSession("acp", "acp"),
                remoteSession("unknown", "future-provider"),
            ),
            serverTime = "now",
        )

        val state = controller.dashboardSnapshotState(snapshot)

        assertEquals(listOf("claude", "codex"), state.sessions.map { it.id }.sorted())
    }

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

    private fun device(id: String) = AgentDevice(id, id, online = true)

    private fun remoteDevice() = RemoteDevice(
        id = "connector",
        name = "Device",
        deviceOs = null,
        status = "online",
        lastSeenAt = null,
        createdAt = "now",
        updatedAt = "now",
    )

    private fun remoteSession(id: String, runtime: String) = RemoteSession(
        id = id,
        connectorId = "connector",
        connectorStatus = "online",
        runtime = runtime,
        externalSessionId = null,
        title = id,
        cwd = null,
        status = "idle",
        takeover = false,
        pinned = false,
        pinnedAt = null,
        archived = false,
        archivedAt = null,
        unread = false,
        lastReadSeq = 0,
        lastSyncedAt = null,
        sourceObservedAt = null,
        lastActivityAt = null,
        lastItemAt = null,
        lastItemOrderSeq = null,
        sortAt = null,
        updatedSeq = 0,
    )

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
