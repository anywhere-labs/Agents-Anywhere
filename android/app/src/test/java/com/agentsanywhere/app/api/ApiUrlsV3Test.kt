package com.agentsanywhere.app.api

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ApiUrlsV3Test {
    @Test
    fun v3RoutesKeepTheirNamespace() {
        assertEquals("/api/v3/e2ee/commands", apiPath("/api/v3/e2ee/commands"))
        assertEquals("/api/v2/sessions", apiPath("/sessions"))
        assertEquals(
            listOf("https://v3.example.com/api/v3/e2ee/commands"),
            apiUrlCandidates("https://v3.example.com", "/api/v3/e2ee/commands").distinct(),
        )
    }

    @Test
    fun aV3ResponseDoesNotMarkTheServerLegacy() {
        rememberApiUrl("https://v3-legacy.example.com", "https://v3-legacy.example.com/api/v3/e2ee/commands")
        assertFalse(usesLegacyApiRoute("https://v3-legacy.example.com"))
    }
}
