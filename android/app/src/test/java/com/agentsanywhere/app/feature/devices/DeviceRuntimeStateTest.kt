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

    @Test
    fun savingLeavesOutABlankGatewayKeySoTheServerKeepsIt() {
        val draft = runtime("pi").copy(
            schema = mapOf("properties" to mapOf("modelGateway" to emptyMap<String, Any?>())),
            config = mapOf(
                "modelGateway" to mapOf("baseUrl" to "https://gate.example/v1", "apiKey" to "  "),
                "other" to mapOf("apiKey" to null),
            ),
        ).toConfigDraft()

        val config = draft.toConfig()

        assertEquals(mapOf("baseUrl" to "https://gate.example/v1"), config["modelGateway"])
        assertEquals(emptyMap<String, Any?>(), config["other"])
    }

    @Test
    fun savingKeepsAnEnteredGatewayKeyAndConfigWithoutOne() {
        val entered = mapOf("modelGateway" to mapOf("baseUrl" to "https://gate.example/v1", "apiKey" to "sk-new"))
        assertEquals(entered, withoutBlankSecrets(entered))

        val redacted = mapOf("modelGateway" to mapOf("baseUrl" to "https://gate.example/v1"))
        assertEquals(redacted, withoutBlankSecrets(redacted))
    }
}
