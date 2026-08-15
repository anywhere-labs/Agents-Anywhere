package com.agentsanywhere.app.feature.devices

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceAgentPreviewStateTest {
    @Test
    fun onlineAgentCountOnlyIncludesConfiguredActiveRunningRuntimes() {
        val inventory = DeviceRuntimeList(
            connectorId = "connector",
            runtimes = listOf(
                runtime("running"),
                runtime("unconfigured").copy(configured = false),
                runtime("inactive").copy(active = false),
                runtime("starting").copy(status = DeviceRuntimeStatus.Starting),
                runtime("stopped").copy(status = DeviceRuntimeStatus.Stopped),
                runtime("error").copy(status = DeviceRuntimeStatus.Error),
                runtime("unknown").copy(status = DeviceRuntimeStatus.Unknown),
            ),
            serverTime = null,
        )

        assertEquals(1, inventory.onlineAgentCount())
    }

    @Test
    fun refreshKeepsLoadedCountsAndDropsDevicesThatAreNoLongerOnline() {
        val current = DeviceAgentPreviews(
            generation = 3L,
            byDeviceId = mapOf(
                "keep" to DeviceAgentPreviewState.Loaded(2),
                "offline" to DeviceAgentPreviewState.Loaded(1),
            ),
        )

        val refreshed = current.beginRefresh(setOf("keep", "new"))

        assertEquals(4L, refreshed.generation)
        assertEquals(DeviceAgentPreviewState.Loaded(2), refreshed.byDeviceId["keep"])
        assertEquals(DeviceAgentPreviewState.Loading, refreshed.byDeviceId["new"])
        assertFalse("offline" in refreshed.byDeviceId)
    }

    @Test
    fun failuresDoNotReplacePreviousSuccessfulCounts() {
        val current = DeviceAgentPreviews(
            generation = 5L,
            byDeviceId = mapOf(
                "cached" to DeviceAgentPreviewState.Loaded(2),
                "initial" to DeviceAgentPreviewState.Loading,
            ),
        )

        val failed = current
            .failed(requestGeneration = 5L, deviceId = "cached")
            .failed(requestGeneration = 5L, deviceId = "initial")

        assertEquals(DeviceAgentPreviewState.Loaded(2), failed.byDeviceId["cached"])
        assertEquals(DeviceAgentPreviewState.Unavailable, failed.byDeviceId["initial"])
    }

    @Test
    fun staleAndRemovedDeviceResultsAreIgnored() {
        val current = DeviceAgentPreviews(
            generation = 8L,
            byDeviceId = mapOf("current" to DeviceAgentPreviewState.Loading),
        )

        assertSame(current, current.loaded(7L, "current", 9))
        assertSame(current, current.failed(7L, "current"))
        assertSame(current, current.loaded(8L, "removed", 9))
        assertTrue(current.byDeviceId["current"] is DeviceAgentPreviewState.Loading)
    }

    private fun runtime(id: String): DeviceRuntime {
        return DeviceRuntime(
            connectorId = "connector",
            id = id,
            type = "native",
            displayName = id,
            present = true,
            configured = true,
            active = true,
            status = DeviceRuntimeStatus.Running,
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
