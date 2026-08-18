package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionListIndicatorTest {
    @Test
    fun busyStatusesShowSpinner() {
        listOf(SessionStatus.Running, SessionStatus.Waiting, SessionStatus.Pending).forEach { status ->
            assertEquals(SessionListIndicator.Busy, session(status = status).listIndicator())
        }
    }

    @Test
    fun unreadDotOnlyAppearsForUnreadIdleSession() {
        assertEquals(
            SessionListIndicator.Unread,
            session(status = SessionStatus.Idle, unread = true).listIndicator(),
        )
        assertEquals(
            SessionListIndicator.None,
            session(status = SessionStatus.Idle, unread = false).listIndicator(),
        )
        listOf(SessionStatus.Stopping, SessionStatus.Blocked, SessionStatus.Unknown).forEach { status ->
            assertEquals(SessionListIndicator.None, session(status = status, unread = true).listIndicator())
        }
    }

    @Test
    fun approvalAndErrorTakePriorityOverUnread() {
        assertEquals(
            SessionListIndicator.WaitingApproval,
            session(status = SessionStatus.WaitingApproval, unread = true).listIndicator(),
        )
        assertEquals(
            SessionListIndicator.Error,
            session(status = SessionStatus.Error, unread = true).listIndicator(),
        )
    }

    private fun session(status: SessionStatus, unread: Boolean = false) = AgentSession(
        id = "session",
        connectorId = "connector",
        deviceName = "Device",
        title = "Session",
        summary = "",
        cwd = "/workspace",
        workspaceLabel = "workspace",
        runtime = "codex",
        runtimeLabel = "Codex",
        status = status,
        statusLabel = "",
        updatedAtLabel = "now",
        metaLabel = "",
        pinned = false,
        archived = false,
        unread = unread,
        lastReadSeq = 0,
        takeover = false,
        connectorOnline = true,
        live = false,
        sortKey = "",
        updatedSeq = 1,
    )
}
