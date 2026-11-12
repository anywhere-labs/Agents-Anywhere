package com.agentsanywhere.app.feature.devices

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceRuntimeTypesTest {
    @Test
    fun singleTypesCanBeAddedOnceAndAgainAfterBeingCleared() {
        val codex = runtimeType("codex", policy = "single")

        assertTrue(DeviceAgentInventory("device", listOf(codex)).canAdd(codex))
        assertFalse(DeviceAgentInventory("device", listOf(codex), listOf(runtime("codex", type = "codex"))).canAdd(codex))
        val cleared = runtime("codex", type = "codex", configured = false)
        assertTrue(DeviceAgentInventory("device", listOf(codex), listOf(cleared)).canAdd(codex))
    }

    @Test
    fun multipleTypesRespectTheirInstanceLimit() {
        val pi = runtimeType("pi", maxInstances = 2)
        val one = DeviceAgentInventory("device", listOf(pi), listOf(runtime("rti_1", type = "pi")))
        val two = one.copy(runtimes = one.runtimes + runtime("rti_2", type = "pi"))

        assertTrue(one.canAdd(pi))
        assertFalse(two.canAdd(pi))
    }

    @Test
    fun typesWithoutASchemaOrNotReportedCannotBeAdded() {
        val missing = runtimeType("dsh", present = false)
        val schemaless = runtimeType("claude").copy(schema = null)
        val unknownPolicy = runtimeType("opencode").copy(instancePolicy = "pooled")
        val inventory = DeviceAgentInventory("device", listOf(missing, schemaless, unknownPolicy))

        assertEquals(emptyList<String>(), inventory.addableTypes.map { it.type })
    }

    @Test
    fun recommendedTypesComeFirstThenRankThenName() {
        val inventory = DeviceAgentInventory(
            "device",
            listOf(
                runtimeType("pi", displayName = "Pi"),
                runtimeType("claude", displayName = "Claude Code", recommended = true, rank = 20),
                runtimeType("dsh", displayName = "DeepSeek Harness"),
                runtimeType("codex", displayName = "Codex", recommended = true, rank = 10),
            ),
        )

        assertEquals(listOf("codex", "claude", "dsh", "pi"), inventory.addableTypes.map { it.type })
    }

    @Test
    fun instancesOfAnUnreportedTypeStillHaveATypeToEdit() {
        val inventory = DeviceAgentInventory("device", emptyList(), listOf(runtime("claude", type = "claude")))

        val type = inventory.type(inventory.runtimes.single())
        assertEquals("claude", type?.type)
        assertEquals("Claude Code", type?.displayName)
        assertEquals(emptyList<String>(), inventory.addableTypes.map { it.type })
    }

    @Test
    fun suggestedNamesAreUniqueAndDshUsesItsShortName() {
        val claude = runtimeType("claude", displayName = "Claude Code")
        val taken = listOf(runtime("a", name = "Claude Code"), runtime("b", name = "claude code 2"))

        assertEquals("Claude Code 3", suggestedRuntimeName(claude, taken))
        assertEquals("Claude Code 2", suggestedRuntimeName(claude, listOf(runtime("c", name = " claude\u00a0 code"))))
        assertEquals("DSH", suggestedRuntimeName(runtimeType("dsh", displayName = "DeepSeek Harness"), taken))
    }

    @Test
    fun addingAfterAClearedInstanceReusesItsIdentityAndName() {
        val codex = runtimeType("codex", displayName = "Codex", policy = "single")
        val cleared = runtime("rti_9", type = "codex", name = "Work Codex", configured = false)
        val inventory = DeviceAgentInventory("device", listOf(codex), listOf(cleared, runtime("rti_1", name = "Claude")))

        val plan = inventory.addPlan(codex)

        assertEquals("rti_9", plan.runtimeId)
        assertEquals("Work Codex", plan.name)
        assertEquals(mapOf("ipcEnabled" to true), plan.config)
        assertTrue(plan.nameTaken(" claude "))
        assertFalse(plan.nameTaken("Work Codex"))
    }

    @Test
    fun anAddCanContinueTheInstanceAFailedAttemptCreated() {
        val pi = runtimeType("pi", displayName = "Pi")
        val leftover = runtime("rti_5", type = "pi", name = "Pi", status = DeviceRuntimeStatus.Error)
        val inventory = DeviceAgentInventory("device", listOf(pi), listOf(leftover, runtime("rti_6", type = "pi", name = "Pi 2")))

        val fresh = inventory.addPlan(pi)
        val continued = inventory.addPlan(pi, continuing = "pi")

        assertEquals("Pi 3", fresh.name)
        assertEquals("rti_5", continued.runtimeId)
        assertEquals("Pi", continued.name)
        assertFalse(continued.nameTaken("PI"))
        assertTrue(continued.nameTaken("pi  2"))
    }

    @Test
    fun onlyNamedInstancesHaveToFillTheNamedInstanceFields() {
        val codex = runtimeType(
            "codex",
            policy = "single",
            uiSchema = mapOf("requiredForNamedInstance" to listOf("codexHome", "notInSchema")),
        )
        val fresh = DeviceAgentInventory("device", listOf(codex))
        val defaultInstance = fresh.copy(runtimes = listOf(runtime("codex", type = "codex", configured = false)))

        assertEquals(listOf("codexHome"), fresh.addPlan(codex).requiredFields)
        assertEquals(emptyList<String>(), defaultInstance.addPlan(codex).requiredFields)
        assertEquals("codex", defaultInstance.addPlan(codex).runtimeId)
    }
}
