package com.agentsanywhere.app.api

import org.junit.Assert.assertEquals
import org.junit.Test

class NativeRuntimesTest {
    @Test
    fun `only server-returned v2 native runtimes enter Android state`() {
        assertEquals(
            listOf("claude", "codex"),
            listOf("codex", "acp", "claude", "opencode", "codex")
                .supportedV2NativeRuntimes(),
        )
    }

    @Test
    fun `missing native runtimes are not synthesized locally`() {
        assertEquals(emptyList<String>(), listOf("acp", "opencode").supportedV2NativeRuntimes())
        assertEquals(listOf("codex"), listOf("codex").supportedV2NativeRuntimes())
    }
}
