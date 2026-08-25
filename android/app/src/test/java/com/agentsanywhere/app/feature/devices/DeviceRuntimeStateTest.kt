package com.agentsanywhere.app.feature.devices

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.runBlocking

class DeviceRuntimeStateTest {
    @Test
    fun listResponseReplacesExistingRuntimesAndSortsProviderOrder() {
        val previous = DeviceRuntimeManagementState(
            connectorId = "connector",
            runtimes = listOf(runtime("old")),
            loading = true,
            pendingRuntimeId = "old",
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
        assertNull(next.pendingRuntimeId)
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
    fun runtimeSectionsUseConfiguredAndPresentAsTheirOnlySourceOfTruth() {
        val configuredMissing = runtime("configured-missing").copy(present = false)
        val discovered = runtime("discovered").copy(configured = false, present = true)
        val absent = runtime("absent").copy(configured = false, present = false)
        val state = DeviceRuntimeManagementState(
            runtimes = listOf(absent, discovered, configuredMissing),
        )

        assertEquals(listOf("configured-missing"), state.configuredRuntimes.map { it.id })
        assertEquals(listOf("discovered"), state.discoveredUnconfiguredRuntimes.map { it.id })
    }

    @Test
    fun runtimeSectionsKeepProviderPriorityAndDiscoveryAvailabilityDefaultsToTrue() {
        val other = runtime("other").copy(configured = false)
        val claude = runtime("claude").copy(configured = false, discovery = mapOf("available" to false))
        val codex = runtime("codex").copy(configured = false)
        val state = DeviceRuntimeManagementState(runtimes = listOf(other, claude, codex))

        assertEquals(
            listOf("codex", "claude", "other"),
            state.discoveredUnconfiguredRuntimes.map { it.id },
        )
        assertTrue(codex.discoveryAvailable)
        assertFalse(claude.discoveryAvailable)
    }

    @Test
    fun dynamicInstancesSortByProviderAndExposeInstanceFirstLabels() {
        val claude = runtime("rti_claude_work", type = "claude").copy(displayName = "Work Claude")
        val codex = runtime("rti_codex_personal", type = "codex").copy(displayName = "Personal")
        val state = DeviceRuntimeManagementState(runtimes = listOf(claude, codex))

        assertEquals(listOf("rti_codex_personal", "rti_claude_work"), state.configuredRuntimes.map { it.id })
        assertEquals("Personal", codex.labels.primary)
        assertEquals("Codex", codex.labels.secondary)
    }

    @Test
    fun discoveryFailurePreservesInventoryAndClearsProgress() {
        val state = DeviceRuntimeManagementState(
            runtimes = listOf(runtime("codex")),
            discovering = true,
        )

        val next = state.discoveryFailed("friendly failure")

        assertEquals(listOf("codex"), next.runtimes.map { it.id })
        assertFalse(next.discovering)
        assertEquals("friendly failure", next.errorMessage)
        assertTrue(next.errorFromDiscovery)
    }

    @Test
    fun configureAndStartStopsWhenSaveFails() = runBlocking {
        var started = false
        val result = configureAndStartRuntime(
            saveConfig = { Result.failure(IllegalStateException("save")) },
            startRuntime = {
                started = true
                Result.success(runtime("codex", active = true))
            },
        )

        assertTrue(result is DeviceRuntimeSetupResult.SaveFailed)
        assertFalse(started)
    }

    @Test
    fun configureAndStartPreservesConfiguredRuntimeWhenStartFails() = runBlocking {
        val configured = runtime("codex").copy(configured = true, active = false)
        val result = configureAndStartRuntime(
            saveConfig = { Result.success(configured) },
            startRuntime = { Result.failure(IllegalStateException("start")) },
        )

        assertTrue(result is DeviceRuntimeSetupResult.StartFailed)
        assertEquals(
            configured,
            (result as DeviceRuntimeSetupResult.StartFailed).configuredRuntime,
        )
    }

    @Test
    fun configureAndStartReturnsActivatedRuntimeOnSuccess() = runBlocking {
        val active = runtime("codex", active = true)
        val result = configureAndStartRuntime(
            saveConfig = { Result.success(runtime("codex")) },
            startRuntime = { Result.success(active) },
        )

        assertEquals(DeviceRuntimeSetupResult.Success(active), result)
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

    private fun runtime(
        id: String,
        active: Boolean = false,
        type: String = id,
    ): DeviceRuntime {
        return DeviceRuntime(
            connectorId = "connector",
            id = id,
            type = type,
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
