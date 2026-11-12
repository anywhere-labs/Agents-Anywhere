package com.agentsanywhere.app.feature.devices

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceAgentOperationsTest {
    private val claude = runtimeType("claude", displayName = "Claude Code")

    @Test
    fun aNewAgentIsCreatedActiveUnderTheSuggestedName() = runBlocking {
        // Instance names are unique on a device, whatever their type.
        val server = FakeDeviceAgentOperations(runtimes = listOf(runtime("rti_0", type = "codex", name = "Claude Code")))

        val added = addDeviceRuntime(server, "device", claude)

        assertEquals(listOf("create:claude:Claude Code 2:true"), server.calls)
        assertEquals("Claude Code 2", added.name)
    }

    @Test
    fun aQuickAddWithoutANameStartsTheConfiguredInstance() = runBlocking {
        val server = FakeDeviceAgentOperations(runtimes = listOf(runtime("rti_0", name = "Claude Code")))

        addDeviceRuntime(server, "device", claude)

        assertEquals(listOf("active:rti_0:true"), server.calls)
    }

    @Test
    fun aRetryContinuesWithTheInstanceAFailedStartCreated() = runBlocking {
        val server = FakeDeviceAgentOperations().apply { failCreateAfterPersisting = true }
        val reported = mutableListOf<DeviceRuntime>()
        val request = DeviceRuntimeAddRequest(name = "Claude Code")

        val failure = runCatching { addDeviceRuntime(server, "device", claude, request, reported::add) }.exceptionOrNull()
        server.failCreateAfterPersisting = false
        addDeviceRuntime(server, "device", claude, request)

        assertTrue(failure is IllegalStateException)
        assertEquals("Claude Code", reported.single().name)
        assertEquals(listOf("create:claude:Claude Code:true", "active:rti_1:true"), server.calls)
        assertEquals(1, server.runtimes.size)
    }

    @Test
    fun aRenamedRetryKeepsTheEarlierInstance() = runBlocking {
        val server = FakeDeviceAgentOperations(runtimes = listOf(runtime("rti_4", name = "Claude Code", status = DeviceRuntimeStatus.Error)))

        addDeviceRuntime(server, "device", claude, DeviceRuntimeAddRequest(name = "Work", config = mapOf("a" to 1), runtimeId = "rti_4"))

        assertEquals(listOf("rename:rti_4:Work", "config:rti_4", "active:rti_4:true"), server.calls)
    }

    @Test
    fun aClearedInstanceIsConfiguredAgainBeforeItStarts() = runBlocking {
        val server = FakeDeviceAgentOperations(runtimes = listOf(runtime("rti_2", name = "Claude Code", configured = false)))

        addDeviceRuntime(server, "device", claude, DeviceRuntimeAddRequest(name = "Claude Code"))

        assertEquals(listOf("config:rti_2", "active:rti_2:true"), server.calls)
    }

    @Test
    fun aRunningAgentIsNotWrittenAgainByAQuickAdd() = runBlocking {
        val running = runtime("rti_3", name = "Claude Code", active = true, status = DeviceRuntimeStatus.Running)
        val server = FakeDeviceAgentOperations(runtimes = listOf(running))

        val result = addDeviceRuntime(server, "device", claude, DeviceRuntimeAddRequest(name = "Claude Code"))

        assertEquals(emptyList<String>(), server.calls)
        assertEquals("rti_3", result.id)
    }

    @Test
    fun namesMatchTheWayTheServerStoresThem() = runBlocking {
        val running = runtime("rti_3", name = "Claude Code", active = true, status = DeviceRuntimeStatus.Running)
        val server = FakeDeviceAgentOperations(runtimes = listOf(running))

        addDeviceRuntime(server, "device", claude, DeviceRuntimeAddRequest(name = "  Claude\u3000 Code "))

        assertEquals(emptyList<String>(), server.calls)
    }

    @Test
    fun aMissingRetryInstanceOrTypeIsReportedWithoutWrites() = runBlocking {
        val server = FakeDeviceAgentOperations()

        val missing = runCatching {
            addDeviceRuntime(server, "device", claude, DeviceRuntimeAddRequest(runtimeId = "rti_gone"))
        }.exceptionOrNull()
        val unavailable = runCatching {
            addDeviceRuntime(server, "device", claude.copy(present = false))
        }.exceptionOrNull()

        assertTrue(missing is DeviceRuntimeMissingException)
        assertTrue(unavailable is DeviceRuntimeTypeUnavailableException)
        assertEquals(emptyList<String>(), server.calls)
    }

    @Test
    fun observedOperationsReportOnlySuccessfulWrites() = runBlocking {
        val server = FakeDeviceAgentOperations(runtimes = listOf(runtime("rti_1")))
        var changes = 0
        val observed = server.observingChanges { changes++ }

        observed.listDeviceRuntimes("device")
        observed.setDeviceRuntimeActive("device", "rti_1", true)
        observed.renameDeviceRuntime("device", "rti_missing", "x")

        assertEquals(1, changes)
    }
}
