package com.agentsanywhere.app.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Test

class RuntimeLabelsTest {
    @Test
    fun `dsh uses the DeepSeek Harness product label`() {
        assertEquals("DeepSeek Harness", "dsh".runtimeLabel())
        assertEquals("Codex", "codex".runtimeLabel())
        assertEquals("Claude Code", "claude".runtimeLabel())
    }
}
