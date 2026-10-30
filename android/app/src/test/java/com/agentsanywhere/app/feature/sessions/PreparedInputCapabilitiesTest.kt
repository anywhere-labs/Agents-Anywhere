package com.agentsanywhere.app.feature.sessions

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PreparedInputCapabilitiesTest {
    private fun prepared(): PreparedRuntimeWorkspace {
        val snapshot = JSONObject("""{"options":[{"category":"model","currentValue":"provider/text","_meta":{"aa":{"modelInputModalities":{"provider/text":["text"],"provider/vision":["text","image"]}}}}]}""")
        val (current, inputs) = AgentForm.modelInputModalities(snapshot)
        val reasoning = NewSessionReasoning("low", "opaque-reasoning", null, "Low", null, true, emptyMap())
        val text = NewSessionModel("provider/text", "opaque-text", "Text", null, true, listOf(reasoning), emptyMap())
        val vision = text.copy(id = "provider/vision", selectionId = "opaque-vision", reasoningItems = emptyList())
        return PreparedRuntimeWorkspace("prep", 1, 1, NewSessionModelCatalog("pi", 1, listOf(text, vision), null), inputModalitiesByModel = inputs, defaultModelId = current)
    }

    @Test fun `prepared input follows opaque model and reasoning selection without decoding IDs`() {
        val value = prepared()
        assertEquals(listOf("text"), value.inputModalities("opaque-reasoning"))
        assertEquals(listOf("text", "image"), value.inputModalities("opaque-vision"))
        assertEquals(listOf("text"), value.inputModalities(null))
        assertNull(value.inputModalities("stale-selection"))
    }

    @Test fun `first image is rejected before creation and its draft remains unchanged`() {
        val image = NewSessionAttachmentPart("image.png", "image/png", byteArrayOf(1))
        val value = NewSessionCreateDraft("connector", "pi", null, "/workspace", "describe", NewSessionSelections(model = "opaque-reasoning"), listOf(image), "message", emptySet(), preparedWorkspace = prepared())
        assertTrue(validateNewSessionDraft(value)!!.contains("image input"))
        assertEquals(listOf(image), value.attachments)
        assertNull(validateNewSessionDraft(value.copy(selections = NewSessionSelections(model = "opaque-vision"))))
        assertNull(validateNewSessionDraft(value.copy(attachments = listOf(image.copy(name = "note.txt", mediaType = "text/plain")))))
        assertTrue(validateNewSessionDraft(value.copy(attachments = listOf(image.copy(mediaType = "IMAGE/PNG"))))!!.contains("image input"))
        // Only Connector image types become model input; other images travel as files.
        assertNull(validateNewSessionDraft(value.copy(attachments = listOf(image.copy(name = "logo.svg", mediaType = "image/svg+xml")))))
    }

    @Test fun `older agents without modality metadata retain attachment transport`() {
        assertTrue(AgentForm.modelInputModalities(null).second.isEmpty())
        assertNull(prepared().copy(inputModalitiesByModel = emptyMap()).inputModalities("opaque-text"))
    }
}
