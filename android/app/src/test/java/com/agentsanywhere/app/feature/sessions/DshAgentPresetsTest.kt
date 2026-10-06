package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.DeviceRuntimeStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DshAgentPresetsTest {
    private val runtime = DeviceRuntime(
        connectorId = "connector",
        id = "dsh-local",
        type = "dsh",
        displayName = "DeepSeek Harness",
        present = true,
        configured = true,
        active = true,
        status = DeviceRuntimeStatus.Running,
        discovery = emptyMap(),
        schema = mapOf("properties" to mapOf("defaultAgentPreset" to mapOf("default" to "standard"))),
        uiSchema = mapOf("defaultAgentPreset" to mapOf("options" to listOf(
            mapOf("value" to "standard", "label" to "standard"),
            mapOf("value" to "custom", "label" to "团队模式"),
            mapOf("value" to "disabled", "disabled" to true),
        ))),
        config = mapOf("defaultAgentPreset" to "custom"),
        error = null,
        lastDiscoveredAt = null,
        updatedAt = null,
    )

    @Test
    fun selectedPresetOverridesDefaultButDisabledPresetFallsBack() {
        val options = dshAgentPresetOptions(runtime)
        assertEquals(listOf("standard", "custom", "disabled"), options.map { it.id })
        assertEquals("团队模式", options[1].label)
        assertEquals(false, options[2].enabled)
        assertEquals("standard", dshNewSessionAgentPreset(runtime, options, "standard"))
        assertEquals("custom", dshNewSessionAgentPreset(runtime, options, "disabled"))
        assertNull(dshNewSessionAgentPreset(runtime, options.filter { !it.enabled }, "standard"))
    }

    @Test
    fun missingCatalogUsesConfiguredDefaultAndOtherRuntimesHaveNoPreset() {
        assertEquals("custom", dshNewSessionAgentPreset(runtime, emptyList(), "standard"))
        val runtimeDefault = runtime.copy(
            config = null,
            schema = null,
            defaults = mapOf("defaultAgentPreset" to "minimal"),
        )
        assertEquals("minimal", dshNewSessionAgentPreset(runtimeDefault, emptyList(), null))
        val codex = runtime.copy(type = "codex")
        assertEquals(emptyList<DshAgentPresetOption>(), dshAgentPresetOptions(codex))
        assertNull(dshNewSessionAgentPreset(codex, emptyList(), "custom"))
    }
}
