package com.agentsanywhere.app.ui.screens.sessiondetail

import com.agentsanywhere.app.feature.sessiondetail.RuntimeSelectionOption
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionRuntimeSettingsLabelsTest {
    @Test
    fun emptyEffortLabelDisplaysDefault() {
        assertEquals("Default", option("DeepSeek").effortDisplayLabel("Default"))
    }

    @Test
    fun explicitEffortLabelRemainsVisible() {
        assertEquals("High", option("DeepSeek · High").effortDisplayLabel("Default"))
    }

    private fun option(label: String) = RuntimeSelectionOption(
        selectionId = "selection",
        label = label,
        description = null,
        default = true,
    )
}
