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
        val next = listOf(runtime("old"), runtime("other")).afterRuntimeDeletion("old", runtime("old", configured = false))

        assertEquals(listOf("other"), next.map { it.id })
    }

    @Test
    fun deletionKeepsASuccessorFromAnOlderServer() {
        val next = listOf(runtime("old"), runtime("other")).afterRuntimeDeletion("old", runtime("new", configured = false))

        assertEquals(setOf("other", "new"), next.map { it.id }.toSet())
    }

    @Test
    fun anUpdatedRuntimeReplacesItsEntryOrIsAppended() {
        val runtimes = listOf(runtime("a"), runtime("b"))

        assertEquals(listOf("a", "b"), runtimes.withRuntime(runtime("b").copy(active = true)).map { it.id })
        assertEquals(true, runtimes.withRuntime(runtime("b").copy(active = true)).last().active)
        assertEquals(listOf("a", "b", "c"), runtimes.withRuntime(runtime("c")).map { it.id })
    }
}
