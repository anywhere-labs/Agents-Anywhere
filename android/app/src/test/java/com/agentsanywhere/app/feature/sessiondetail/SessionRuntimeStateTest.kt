package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteRuntimeModel
import com.agentsanywhere.app.api.RemoteRuntimeModelCatalog
import com.agentsanywhere.app.api.RemoteRuntimeReasoning
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionRuntimeStateTest {
    @Test
    fun capabilityRequiresAllThreeServerConditions() {
        fun capability(supported: Boolean, available: Boolean, allowed: Boolean) = EffectiveCapability(
            capabilityId = SESSION_SEND_MESSAGE_CAPABILITY,
            version = "1",
            scope = "session",
            runtime = "codex",
            sessionId = "session",
            supported = supported,
            available = available,
            allowed = allowed,
            unavailableReason = null,
            parameters = emptyMap(),
        )
        assertTrue(capability(true, true, true).usable)
        assertFalse(capability(false, true, true).usable)
        assertFalse(capability(true, false, true).usable)
        assertFalse(capability(true, true, false).usable)
    }

    @Test
    fun modelSelectionUsesReasoningSelectionIdsAndValidHint() {
        val catalog = RemoteRuntimeModelCatalog(
            runtime = "codex",
            revision = 1,
            models = listOf(
                RemoteRuntimeModel(
                    id = "model",
                    selectionId = null,
                    displayName = "Model",
                    description = null,
                    default = true,
                    reasoningItems = listOf(
                        RemoteRuntimeReasoning("low", "model-low", null, "Low", null, true, emptyMap()),
                        RemoteRuntimeReasoning("high", "model-high", null, "High", null, false, emptyMap()),
                    ),
                    metadata = emptyMap(),
                ),
            ),
        )
        val options = catalog.selectionOptions()
        assertEquals("model-high", options.validatedSelection("model-high"))
        assertEquals("model-low", options.validatedSelection("missing"))
    }
}
