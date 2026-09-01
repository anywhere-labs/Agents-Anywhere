package com.agentsanywhere.app.feature.sessions

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NewSessionPreferenceStoreTest {
    @Test
    fun preferenceRoundTripPreservesScopedModelSelection() {
        val scope = NewSessionRuntimeScope("connector-1", "codex-2")
        val preference = NewSessionPreference(
            connectorId = scope.connectorId,
            runtimeId = scope.runtimeId,
            selections = mapOf(
                scope to NewSessionSelections(
                    model = "gpt-5.6:high",
                    permission = "workspace-write",
                ),
            ),
        )

        val decoded = decodeNewSessionPreference(encodeNewSessionPreference(preference))

        assertEquals(preference, decoded)
    }

    @Test
    fun invalidPreferenceIsIgnored() {
        assertNull(decodeNewSessionPreference("{\"connectorId\":\"\",\"runtimeId\":\"codex\"}"))
        assertNull(decodeNewSessionPreference("not-json"))
    }

    @Test
    fun catalogRestoresEffortFromScopedSelectionHint() {
        val scope = NewSessionRuntimeScope("connector-1", "codex-2")
        val requestKey = NewSessionRuntimeRequestKey(scope.connectorId, scope.runtimeId, generation = 1)
        val initial = NewSessionRuntimeSelectionState(
            connectorId = scope.connectorId,
            selectedRuntimeId = scope.runtimeId,
            requestKey = requestKey,
            selectionHints = mapOf(
                scope to NewSessionSelections(model = "gpt-5.6:high"),
            ),
        )

        val restored = initial.applyModelCatalog(requestKey, modelCatalog())

        assertEquals("gpt-5.6", restored.selectedModelId)
        assertEquals("high", restored.selectedReasoningId)
        assertEquals("gpt-5.6:high", restored.selectedModelSelectionId)
    }

    private fun modelCatalog() = NewSessionModelCatalog(
        runtime = "codex",
        runtimeId = "codex-2",
        runtimeType = "codex",
        revision = 1,
        serverTime = null,
        models = listOf(
            NewSessionModel(
                id = "gpt-5.6",
                selectionId = null,
                displayName = "GPT-5.6",
                description = null,
                default = true,
                metadata = emptyMap(),
                reasoningItems = listOf(
                    NewSessionReasoning(
                        id = "medium",
                        selectionId = "gpt-5.6:medium",
                        fullModelId = null,
                        displayName = "Medium",
                        description = null,
                        default = true,
                        metadata = emptyMap(),
                    ),
                    NewSessionReasoning(
                        id = "high",
                        selectionId = "gpt-5.6:high",
                        fullModelId = null,
                        displayName = "High",
                        description = null,
                        default = false,
                        metadata = emptyMap(),
                    ),
                ),
            ),
        ),
    )
}
