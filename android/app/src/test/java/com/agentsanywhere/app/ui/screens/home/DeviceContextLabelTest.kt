package com.agentsanywhere.app.ui.screens.home

import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceContextLabelTest {
    @Test fun distinguishesDuplicateDeviceNames() {
        val devices = listOf(AgentDevice("device-123456", "Mac", online = true), AgentDevice("device-abcdef", "Mac", online = false))
        assertEquals("Mac · 123456", deviceContextLabel(devices, "device-123456"))
        assertEquals("Mac · abcdef", deviceContextLabel(devices, "device-abcdef"))
    }

    @Test fun usesFallbackForUnknownDevice() {
        assertEquals("Laptop", deviceContextLabel(emptyList(), "device-1", "Laptop"))
        assertEquals("device-1", deviceContextLabel(emptyList(), "device-1"))
    }

    @Test fun sidebarContextLabelWithDisambiguatedDevice() {
        val devices = listOf(AgentDevice("device-123456", "Mac", online = true), AgentDevice("device-abcdef", "Mac", online = false))
        val session1 = createSession(connectorId = "device-123456", deviceName = "Mac")
        val label1 = session1.sidebarContextLabel(
            projectName = "Project A",
            deviceName = deviceContextLabel(devices, session1.connectorId, session1.deviceName),
        )
        assertEquals("Mac · 123456 · Project A", label1)

        val uniqueDevice = listOf(AgentDevice("device-999999", "Linux", online = true))
        val session2 = createSession(connectorId = "device-999999", deviceName = "Linux")
        val label2 = session2.sidebarContextLabel(
            projectName = "Project B",
            deviceName = deviceContextLabel(uniqueDevice, session2.connectorId, session2.deviceName),
        )
        assertEquals("Linux · Project B", label2)
    }

    @Test fun formatsProjectDisplayNameWithCountAndStripsDuplicateSuffix() {
        assertEquals("营销内容发布 (2)", formatProjectDisplayName("营销内容发布", 2))
        assertEquals("SynologyDrive-售前资料 (1)", formatProjectDisplayName("SynologyDrive-售前资料", 1))
        assertEquals("系统运维 (1)", formatProjectDisplayName("系统运维 (1)", 1))
        assertEquals("系统运维 (2)", formatProjectDisplayName("系统运维 (2)", 2))
        assertEquals("系统运维 (3)", formatProjectDisplayName("系统运维 (1)", 3))
        assertEquals("素材工作台 (0)", formatProjectDisplayName("素材工作台", 0))
        assertEquals("V2 (Beta) (1)", formatProjectDisplayName("V2 (Beta)", 1))
    }

    private fun createSession(connectorId: String, deviceName: String) = AgentSession(
        id = "session-$connectorId",
        connectorId = connectorId,
        projectId = "project-1",
        deviceName = deviceName,
        title = "Test Session",
        summary = "",
        cwd = "/repo",
        workspaceLabel = "repo",
        runtime = "codex",
        runtimeLabel = "Codex",
        status = SessionStatus.Idle,
        statusLabel = "",
        updatedAtLabel = "",
        metaLabel = "",
        pinned = false,
        archived = false,
        unread = false,
        lastReadSeq = 0,
        takeover = false,
        connectorOnline = true,
        live = false,
        sortKey = "",
        updatedSeq = 0,
    )
}
