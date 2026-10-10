package com.agentsanywhere.app.feature.devices

import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceRuntimeStateTest {
    private fun runtime(id: String, configured: Boolean = true) = DeviceRuntime(
        connectorId = "device",
        id = id,
        type = "codex",
        displayName = id,
        present = true,
        configured = configured,
        active = false,
        status = DeviceRuntimeStatus.Stopped,
        discovery = emptyMap(),
        schema = null,
        uiSchema = emptyMap(),
        config = null,
        error = null,
        lastDiscoveredAt = null,
        updatedAt = null,
    )

    @Test
    fun deletionRemovesTheInstance() {
        val state = DeviceRuntimeManagementState(runtimes = listOf(runtime("old"), runtime("other")))

        val next = state.afterDeletion("old", runtime("old", configured = false))

        assertEquals(listOf("other"), next.runtimes.map { it.id })
        assertEquals(emptyList<String>(), next.discoveredUnconfiguredRuntimes.map { it.id })
    }

    @Test
    fun deletionKeepsASuccessorFromAnOlderServer() {
        val state = DeviceRuntimeManagementState(runtimes = listOf(runtime("old"), runtime("other")))

        val next = state.afterDeletion("old", runtime("new", configured = false))

        assertEquals(setOf("other", "new"), next.runtimes.map { it.id }.toSet())
    }
}
