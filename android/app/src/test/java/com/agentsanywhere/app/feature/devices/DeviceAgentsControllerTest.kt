package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.api.ApiException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceAgentsControllerTest {
    private val claude = runtimeType("claude", displayName = "Claude Code")

    @Test
    fun aFirstLoadFailureCanBeRetried() = runBlocking {
        val server = FakeDeviceAgentOperations(types = listOf(claude)).apply { failList = IllegalStateException("offline") }
        val controller = DeviceAgentsController("device", server)

        controller.refresh()
        assertTrue(controller.state.value.loadFailed)
        assertEquals("offline", controller.state.value.loadErrorMessage)

        server.failList = null
        controller.refresh(discover = true)
        assertTrue(controller.state.value.loaded)
        assertFalse(controller.state.value.loadFailed)
        assertEquals(1, server.discovered)
        assertEquals(listOf("claude"), controller.state.value.addableTypes.map { it.type })
    }

    @Test
    fun aConnectorThatIsStillStartingIsAskedAgainButARefusalIsNot() = runBlocking {
        val fake = FakeDeviceAgentOperations(types = listOf(claude))
        var failures = 2
        var status = 409
        val server = object : DeviceAgentOperations by fake {
            override suspend fun listDeviceRuntimeTypes(connectorId: String, discover: Boolean): Result<List<DeviceRuntimeType>> {
                if (failures-- > 0) return Result.failure(ApiException("not ready", statusCode = status))
                return fake.listDeviceRuntimeTypes(connectorId, discover)
            }
        }

        val starting = DeviceAgentsController("device", server)
        starting.refresh(discover = true, retryDelays = listOf(1L, 1L, 1L))
        failures = 1
        status = 403
        val refused = DeviceAgentsController("device", server)
        refused.refresh(discover = true, retryDelays = listOf(1L, 1L, 1L))

        assertTrue(starting.state.value.loaded)
        assertTrue(refused.state.value.loadFailed)
    }

    @Test
    fun aLaterFailureKeepsTheLoadedAgents() = runBlocking {
        val server = FakeDeviceAgentOperations(runtimes = listOf(runtime("rti_1")), types = listOf(claude))
        val controller = DeviceAgentsController("device", server)
        controller.refresh()

        server.failList = IllegalStateException("offline")
        val result = controller.refresh(discover = true)

        assertTrue(result.isFailure)
        assertFalse(controller.state.value.loadFailed)
        assertEquals(listOf("rti_1"), controller.state.value.configuredRuntimes.map { it.id })
    }

    @Test
    fun anAddReadsTheServerAgainEvenWhenItFails() = runBlocking {
        val server = FakeDeviceAgentOperations(types = listOf(claude)).apply { failCreateAfterPersisting = true }
        val controller = DeviceAgentsController("device", server)
        controller.refresh()

        val result = controller.add(claude, DeviceRuntimeAddRequest(name = "Claude Code"))

        assertTrue(result.isFailure)
        assertNull(controller.state.value.busyId)
        assertEquals(DeviceRuntimeStatus.Error, controller.state.value.configuredRuntimes.single().status)
    }

    @Test
    fun oneOperationRunsAtATime() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val server = object : DeviceAgentOperations by FakeDeviceAgentOperations(runtimes = listOf(runtime("rti_1")), types = listOf(claude)) {
            override suspend fun setDeviceRuntimeActive(connectorId: String, runtimeId: String, active: Boolean): Result<DeviceRuntime> {
                gate.await()
                return Result.success(runtime(runtimeId, active = active))
            }
        }
        val controller = DeviceAgentsController("device", server)
        controller.refresh()

        val first = async { controller.setActive(runtime("rti_1"), true) }
        yield()
        assertEquals("rti_1", controller.state.value.busyId)
        val second = controller.rename(runtime("rti_1"), "Other")
        val refresh = controller.refresh()
        gate.complete(Unit)

        assertTrue(first.await().isSuccess)
        assertTrue(second.exceptionOrNull() is DeviceAgentBusyException)
        assertTrue(refresh.exceptionOrNull() is DeviceAgentBusyException)
        assertNull(controller.state.value.busyId)
    }

    @Test
    fun aRefreshThatFinishesAfterAnOperationStartedIsDiscarded() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val stale = runtime("rti_1", name = "Stale")
        val fake = FakeDeviceAgentOperations(runtimes = listOf(runtime("rti_1")), types = listOf(claude))
        var holdNextList = false
        val server = object : DeviceAgentOperations by fake {
            override suspend fun listDeviceRuntimes(connectorId: String): Result<DeviceRuntimeList> {
                if (holdNextList) {
                    holdNextList = false
                    gate.await()
                    return Result.success(DeviceRuntimeList(connectorId, listOf(stale), serverTime = null))
                }
                return fake.listDeviceRuntimes(connectorId)
            }
        }
        val controller = DeviceAgentsController("device", server)
        controller.refresh()

        holdNextList = true
        val refresh = async { controller.refresh() }
        yield()
        controller.rename(runtime("rti_1"), "Fresh")
        gate.complete(Unit)
        refresh.await()

        assertEquals("Fresh", controller.state.value.configuredRuntimes.single().name)
    }

    @Test
    fun deletingRemovesTheAgentFromTheList() = runBlocking {
        val server = FakeDeviceAgentOperations(runtimes = listOf(runtime("rti_1"), runtime("rti_2")), types = listOf(claude))
        val controller = DeviceAgentsController("device", server)
        controller.refresh()

        controller.delete(runtime("rti_1"))

        assertEquals(listOf("rti_2"), controller.state.value.configuredRuntimes.map { it.id })
    }
}
