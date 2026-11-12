package com.agentsanywhere.app.api

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DevicesApiDeviceSettingsTest {
    @Test
    fun parsesDeviceSettingsResponse() {
        val settings = DevicesApi().parseDeviceSettings(
            JSONObject(
                """{"connectorId":"conn_x","settings":{"confirmQuitOnShutdown":true},
                   "delivered":false,"serverTime":"2026-11-09T08:00:00Z"}""",
            ),
            fallbackConnectorId = "fallback",
        )

        assertEquals("conn_x", settings.connectorId)
        assertTrue(settings.confirmQuitOnShutdown)
        assertEquals(false, settings.delivered)
        assertEquals("2026-11-09T08:00:00Z", settings.serverTime)
    }

    @Test
    fun readResponseHasNoDeliveryAndMissingFieldsUseDefaults() {
        val settings = DevicesApi().parseDeviceSettings(
            JSONObject("""{"settings":{},"delivered":null}"""),
            fallbackConnectorId = "conn_y",
        )

        assertEquals("conn_y", settings.connectorId)
        assertFalse(settings.confirmQuitOnShutdown)
        assertNull(settings.delivered)
    }

    @Test
    fun parsesConnectorKind() {
        val api = DevicesApi()
        val desktop = api.parseDevice(JSONObject("""{"id":"c1","name":"Mac","connectorKind":"desktop"}"""))
        val legacy = api.parseDevice(JSONObject("""{"id":"c2","name":"Box"}"""))

        assertEquals("desktop", desktop.connectorKind)
        assertNull(legacy.connectorKind)
    }
}
