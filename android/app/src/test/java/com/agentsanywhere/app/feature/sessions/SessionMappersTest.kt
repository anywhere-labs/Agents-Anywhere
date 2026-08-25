package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.RemoteSession
import com.agentsanywhere.app.model.SessionStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionMappersTest {
    @Test
    fun mapsEveryKnownSessionStatusWithoutFallingBackToIdle() {
        val expected = mapOf(
            "idle" to SessionStatus.Idle,
            "waiting" to SessionStatus.Waiting,
            "pending" to SessionStatus.Pending,
            "running" to SessionStatus.Running,
            "stopping" to SessionStatus.Stopping,
            "waiting_approval" to SessionStatus.WaitingApproval,
            "error" to SessionStatus.Error,
            "blocked" to SessionStatus.Blocked,
            "future_status" to SessionStatus.Unknown,
        )

        expected.forEach { (remoteStatus, status) ->
            assertEquals(status, remoteSession(remoteStatus).toAgentSession(emptyMap()).status)
        }
    }

    @Test
    fun activeStatusesAreMarkedLive() {
        listOf("waiting", "pending", "running", "waiting_approval").forEach { status ->
            assertTrue(remoteSession(status).toAgentSession(emptyMap()).live)
        }
        listOf("idle", "stopping", "error", "blocked", "future_status").forEach { status ->
            assertFalse(remoteSession(status).toAgentSession(emptyMap()).live)
        }
    }

    @Test
    fun namedInstanceLabelIsPrimaryAndProviderTypeIsSecondary() {
        val session = remoteSession("idle").copy(
            runtimeId = "rti_codex_work_01",
            runtimeType = "codex",
            runtimeName = "Work Codex",
        ).toAgentSession(emptyMap())

        assertEquals("codex", session.runtime)
        assertEquals("rti_codex_work_01", session.runtimeId)
        assertEquals("codex", session.runtimeType)
        assertEquals("Work Codex", session.runtimeName)
        assertEquals("Work Codex", session.runtimeLabel)
        assertEquals("Work Codex · Codex", session.runtimeContextLabel)
        assertTrue(session.metaLabel.startsWith("Work Codex  ·  Codex"))
    }

    private fun remoteSession(status: String) = RemoteSession(
        id = "session",
        connectorId = "connector",
        connectorStatus = "online",
        runtime = "codex",
        externalSessionId = null,
        title = "Session",
        cwd = "/workspace",
        status = status,
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
        updatedSeq = 1,
    )
}
