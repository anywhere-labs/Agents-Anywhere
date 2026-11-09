package com.agentsanywhere.app.feature.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebLoginModelsTest {
    private val origin = "https://agents.example.test"

    @Test
    fun scriptRegistrationAllowsIdpLayoutRecoveryButRestrictsApiRewriting() {
        for (loginOrigin in listOf(origin, "https://custom.example.test:8443", "http://localhost:5174")) {
            val viewportScript = "viewport fixture"
            val registrations = mutableListOf<Pair<String, Set<String>>>()

            registerWebLoginScripts(viewportScript, loginOrigin) { script, allowedOrigins ->
                registrations += script to allowedOrigins
            }

            assertEquals(
                listOf(
                    viewportScript to setOf("*"),
                    webLoginApiOriginBridgeScript(loginOrigin) to setOf(loginOrigin),
                ),
                registrations,
            )
        }
    }

    @Test
    fun scriptRegistrationRejectsWildcardOriginBeforeRegisteringAnything() {
        val registrations = mutableListOf<Pair<String, Set<String>>>()

        val result = runCatching {
            registerWebLoginScripts("viewport fixture", "*") { script, allowedOrigins ->
                registrations += script to allowedOrigins
            }
        }

        assertTrue(result.exceptionOrNull() is IllegalArgumentException)
        assertTrue(registrations.isEmpty())
    }

    @Test
    fun apiOriginBridgeScriptKeepsApiRewriteAndDropsViewportFix() {
        val script = webLoginApiOriginBridgeScript(origin)

        assertTrue(script.contains(origin))
        assertTrue(script.contains("XMLHttpRequest"))
        assertFalse(script.contains("viewportHeightProperty"))
        assertFalse(script.contains("installViewportHeightFix"))
    }

    @Test
    fun apiOriginBridgeScriptIsStructurallyComplete() {
        val script = webLoginApiOriginBridgeScript(origin).trim()
        assertTrue(script.startsWith("(() => {"))
        assertTrue(script.endsWith("})();"))
        assertEquals(0, script.count { it == '{' } - script.count { it == '}' })
        assertEquals(0, script.count { it == '(' } - script.count { it == ')' })
    }
}
