package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.runtimeInstanceLabels
import org.junit.Assert.assertEquals
import org.junit.Test

class RuntimeLabelsTest {
    @Test
    fun `dsh uses the DeepSeek Harness product label`() {
        assertEquals("DeepSeek Harness", "dsh".runtimeLabel())
        assertEquals("Codex", "codex".runtimeLabel())
        assertEquals("Claude Code", "claude".runtimeLabel())
    }

    @Test
    fun `instance name is primary and provider is secondary`() {
        val named = runtimeInstanceLabels("Personal", "dsh")
        assertEquals("Personal", named.primary)
        assertEquals("DeepSeek Harness", named.secondary)

        val fallback = runtimeInstanceLabels("", "codex")
        assertEquals("Codex", fallback.primary)
        assertEquals(null, fallback.secondary)

        val legacyFallback = runtimeInstanceLabels("codex", "codex")
        assertEquals("Codex", legacyFallback.primary)
        assertEquals(null, legacyFallback.secondary)
    }
}
