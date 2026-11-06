package com.agentsanywhere.app.feature.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebLoginModelsTest {
    private val origin = "https://agents.example.test"

    @Test
    fun viewportBridgeScriptOnlyPatchesViewportHeight() {
        val script = webLoginViewportBridgeScript()

        assertTrue(script.isNotBlank())
        assertTrue(script.contains("--agents-anywhere-android-viewport-height"))
        assertTrue(script.contains("innerHeight"))

        // This script is registered for every origin, including third-party identity
        // providers, so it must never touch network traffic or know our API layout.
        assertFalse(script.contains("fetch("))
        assertFalse(script.contains("XMLHttpRequest"))
        assertFalse(script.contains("rewriteApiUrl"))
        assertFalse(script.contains("webOrigin"))

        // One wrapper, one install call, and nothing that breaks inlined HTML.
        assertEquals(1, Regex("installViewportHeightFix\\(\\);").findAll(script).count())
        assertFalse(script.contains("</script>"))
    }

    @Test
    fun viewportBridgeScriptSkipsSubFrames() {
        // Pinning a frame's height to its own innerHeight would break self-sizing iframes.
        assertTrue(webLoginViewportBridgeScript().contains("window.top !== window"))
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
    fun injectedScriptsAreStructurallyComplete() {
        // A truncated document-start script raises "Unexpected end of input" on every page the
        // WebView opens, which blanks the app; keep the wrapper and brace balance in check.
        listOf(
            "viewport" to webLoginViewportBridgeScript(),
            "api" to webLoginApiOriginBridgeScript(origin),
        ).forEach { (name, script) ->
            val trimmed = script.trim()
            assertTrue("$name script must open an IIFE", trimmed.startsWith("(() => {"))
            assertTrue("$name script must close the IIFE", trimmed.endsWith("})();"))
            assertEquals("$name script braces", 0, trimmed.count { it == '{' } - trimmed.count { it == '}' })
            assertEquals("$name script parens", 0, trimmed.count { it == '(' } - trimmed.count { it == ')' })
        }
    }
}
