package com.agentsanywhere.app.feature.devices

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceRuntimeStateTest {
    @Test
    fun listResponseReplacesExistingRuntimesAndSortsNativeOrder() {
        val previous = DeviceRuntimeManagementState(
            connectorId = "connector",
            runtimes = listOf(runtime("old")),
            loading = true,
            errorMessage = "old error",
        )

        val next = previous.replace(
            DeviceRuntimeList(
                connectorId = "connector",
                runtimes = listOf(runtime("claude"), runtime("codex")),
                serverTime = null,
            ),
        )

        assertEquals(listOf("codex", "claude"), next.runtimes.map { it.id })
        assertFalse(next.loading)
        assertNull(next.errorMessage)
    }

    @Test
    fun singleRuntimeResponseUpdatesWithoutLosingOtherRows() {
        val state = DeviceRuntimeManagementState(
            connectorId = "connector",
            runtimes = listOf(runtime("codex"), runtime("claude")),
        )

        val next = state.replace(runtime("codex", active = true))

        assertTrue(next.runtimes.first { it.id == "codex" }.active)
        assertEquals(2, next.runtimes.size)
    }

    @Test
    fun configDraftUsesUiOrderAndPreservesUnknownKeys() {
        val runtime = runtime("claude").copy(
            schema = mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "environment" to mapOf("type" to "object"),
                    "executablePath" to mapOf("type" to "string", "default" to "/auto/claude"),
                ),
            ),
            uiSchema = mapOf("order" to listOf("executablePath", "environment")),
            config = mapOf(
                "environment" to mapOf("HTTP_PROXY" to "http://proxy", "OLD" to null),
                "futureKey" to "preserve-me",
            ),
        )

        val draft = runtime.toConfigDraft()

        assertEquals(listOf("executablePath", "environment"), draft.fieldOrder)
        assertEquals("/auto/claude", draft.executablePath)
        assertTrue(draft.environment.first { it.key == "OLD" }.removeInheritedValue)
        val saved = draft.copy(executablePath = "/custom/claude").toConfig()
        assertEquals("/custom/claude", saved["executablePath"])
        assertEquals("preserve-me", saved["futureKey"])
        assertEquals(null, (saved["environment"] as Map<*, *>)["OLD"])
    }

    @Test
    fun blankPathIsRemovedAndEnvironmentValidationIsDeterministic() {
        val base = DeviceRuntimeConfigDraft(
            baseConfig = mapOf("executablePath" to "/old"),
            fieldOrder = listOf("executablePath", "environment"),
            supportsExecutablePath = true,
            supportsEnvironment = true,
            executablePath = " ",
            environment = listOf(RuntimeEnvironmentVariable("", "value")),
        )

        assertEquals(RuntimeConfigValidationError.BlankName, base.validationError())
        assertFalse(base.toConfig().containsKey("executablePath"))
        assertEquals(
            RuntimeConfigValidationError.DuplicateName,
            base.copy(
                environment = listOf(
                    RuntimeEnvironmentVariable("KEY", "one"),
                    RuntimeEnvironmentVariable("KEY", "two"),
                ),
            ).validationError(),
        )
    }

    private fun runtime(id: String, active: Boolean = false): DeviceRuntime {
        return DeviceRuntime(
            connectorId = "connector",
            id = id,
            type = "native",
            displayName = id,
            present = true,
            configured = true,
            active = active,
            status = if (active) DeviceRuntimeStatus.Running else DeviceRuntimeStatus.Stopped,
            discovery = emptyMap(),
            schema = null,
            uiSchema = emptyMap(),
            config = null,
            error = null,
            lastDiscoveredAt = null,
            updatedAt = null,
        )
    }
}
