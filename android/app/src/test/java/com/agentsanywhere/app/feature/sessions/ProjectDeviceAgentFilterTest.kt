package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.ProjectSessionCounts
import com.agentsanywhere.app.model.SessionStatus
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProjectDeviceAgentFilterTest {
    private fun project(manuallyCreated: Boolean = false) = AgentProject(
        id = "project",
        userId = "user",
        connectorId = "device-a",
        name = "workspace",
        workspacePath = "/workspace",
        pinned = false,
        pinnedAt = null,
        activeSessionCount = if (manuallyCreated) 0 else 1,
        lastActivityAt = null,
        createdAt = "",
        updatedAt = "",
        manuallyCreated = manuallyCreated,
        sidebarSessionCounts = ProjectSessionCounts(active = 1, archived = 1),
    )

    private fun session(runtime: String, archived: Boolean = false, pinned: Boolean = false) = AgentSession(
        id = "$runtime-$archived-$pinned",
        connectorId = "device-a",
        projectId = "project",
        deviceName = "Laptop",
        title = "Task",
        summary = "",
        cwd = null,
        workspaceLabel = "workspace",
        runtime = runtime,
        runtimeLabel = runtime,
        status = SessionStatus.Idle,
        statusLabel = "",
        updatedAtLabel = "",
        metaLabel = "",
        pinned = pinned,
        archived = archived,
        unread = false,
        lastReadSeq = 0,
        takeover = false,
        connectorOnline = true,
        live = false,
        sortKey = "",
        updatedSeq = 0,
    )

    @Test
    fun deviceAndAgentFilterMatchesOnlyVisibleSessions() {
        val sessions = listOf(session("codex"), session("claude", archived = true), session("dsh", pinned = true))
        val codex = ProjectDeviceAgentFilter(connectorId = "device-a", runtime = "codex")
        val claude = ProjectDeviceAgentFilter(runtime = "claude")

        assertTrue(projectHasVisibleSessions(project(), sessions, ProjectSessionStatusFilter.Active, codex))
        assertFalse(projectHasVisibleSessions(project(), sessions, ProjectSessionStatusFilter.Archived, codex))
        assertTrue(projectHasVisibleSessions(project(), sessions, ProjectSessionStatusFilter.Archived, claude))
        assertFalse(projectHasVisibleSessions(project(), sessions, ProjectSessionStatusFilter.Active, claude))
        assertFalse(projectHasVisibleSessions(project(), sessions, ProjectSessionStatusFilter.Active, ProjectDeviceAgentFilter(runtime = "dsh")))
        assertFalse(projectHasVisibleSessions(project(), sessions, ProjectSessionStatusFilter.All, ProjectDeviceAgentFilter(connectorId = "device-b")))
    }

    @Test
    fun emptyManualProjectsOnlySurviveWithoutDeviceOrAgentGate() {
        val empty = project(manuallyCreated = true).copy(sidebarSessionCounts = ProjectSessionCounts())

        assertTrue(projectHasVisibleSessions(project(), emptyList(), ProjectSessionStatusFilter.Active))
        assertTrue(projectHasVisibleSessions(empty, emptyList(), ProjectSessionStatusFilter.Active))
        assertFalse(projectHasVisibleSessions(empty, emptyList(), ProjectSessionStatusFilter.Active, ProjectDeviceAgentFilter(connectorId = "device-a")))
        assertFalse(projectHasVisibleSessions(empty, emptyList(), ProjectSessionStatusFilter.Active, ProjectDeviceAgentFilter(runtime = "codex")))
    }
}
