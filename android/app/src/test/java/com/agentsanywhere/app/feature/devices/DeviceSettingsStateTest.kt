package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.model.AgentDevice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceSettingsStateTest {
    @Test
    fun onlyDesktopDevicesHaveDeviceSettings() {
        assertTrue(AgentDevice("d", "Mac", online = true, connectorKind = "desktop").hasDeviceSettings)
        assertFalse(AgentDevice("c", "Box", online = true, connectorKind = "cli").hasDeviceSettings)
        assertFalse(AgentDevice("u", "Old", online = true).hasDeviceSettings)
    }

    @Test
    fun cannotEditUntilLoaded() {
        val loading = DeviceSettingsState().loadStarted()
        assertFalse(loading.canEdit)

        val loaded = loading.loaded(DeviceSettingsResult(DeviceSettings(confirmQuitOnShutdown = false), delivered = null))
        assertTrue(loaded.canEdit)
        assertEquals(false, loaded.settings?.confirmQuitOnShutdown)
    }

    @Test
    fun saveShowsNewValueAndLocksUntilDone() {
        val loaded = DeviceSettingsState().loaded(DeviceSettingsResult(DeviceSettings(), delivered = null))

        val saving = loaded.saveStarted(confirmQuitOnShutdown = true)
        assertEquals(true, saving.settings?.confirmQuitOnShutdown)
        assertFalse(saving.canEdit)

        val saved = saving.saved(DeviceSettingsResult(DeviceSettings(confirmQuitOnShutdown = true), delivered = false))
        assertEquals(true, saved.settings?.confirmQuitOnShutdown)
        assertTrue(saved.canEdit)
    }

    @Test
    fun failedSaveRestoresPreviousValue() {
        val loaded = DeviceSettingsState().loaded(DeviceSettingsResult(DeviceSettings(), delivered = null))

        val failed = loaded.saveStarted(confirmQuitOnShutdown = true).saveFailed(loaded.settings)

        assertEquals(false, failed.settings?.confirmQuitOnShutdown)
        assertTrue(failed.canEdit)
    }

    @Test
    fun failedFirstLoadOffersRetry() {
        val failed = DeviceSettingsState().loadStarted().loadFailed()

        assertTrue(failed.loadFailed)
        assertNull(failed.settings)
        assertFalse(failed.canEdit)
    }
}
