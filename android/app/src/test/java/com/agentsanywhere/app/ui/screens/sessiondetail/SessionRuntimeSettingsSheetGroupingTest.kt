package com.agentsanywhere.app.ui.screens.sessiondetail

import com.agentsanywhere.app.api.RemoteRuntimeModelGroup
import com.agentsanywhere.app.feature.sessiondetail.RuntimeSelectionOption
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionRuntimeSettingsSheetGroupingTest {
    private fun modelOption(
        selectionId: String,
        modelId: String,
        modelLabel: String,
        effortLabel: String? = null,
        group: RemoteRuntimeModelGroup? = null,
    ) = RuntimeSelectionOption(
        selectionId = selectionId,
        label = listOfNotNull(modelLabel, effortLabel).joinToString(" · "),
        description = null,
        default = false,
        modelId = modelId,
        modelLabel = modelLabel,
        effortLabel = effortLabel,
        group = group,
    )

    @Test
    fun sameDisplayNameFromDifferentGroupsIsNotMerged() {
        val deepseek = RemoteRuntimeModelGroup("deepseek", "DeepSeek")
        val relay = RemoteRuntimeModelGroup("relay-a", "Relay A")
        val groups = listOf(
            modelOption("s1", "deepseek/deepseek-v4", "deepseek-v4", "High", deepseek),
            modelOption("s2", "deepseek/deepseek-v4", "deepseek-v4", "Low", deepseek),
            modelOption("s3", "relay-a/deepseek-v4", "deepseek-v4", "High", relay),
        ).groupByModel()

        assertEquals(listOf("deepseek-v4", "deepseek-v4"), groups.map { it.label })
        assertEquals(listOf(listOf("s1", "s2"), listOf("s3")), groups.map { g -> g.options.map { it.selectionId } })
        assertEquals(listOf(deepseek, relay), groups.map { it.group })
    }

    @Test
    fun modelNameContainingSeparatorIsNotSplit() {
        val option = modelOption("s1", "m", "gpt · mini")
        val groups = listOf(option).groupByModel()

        assertEquals("gpt · mini", groups.single().label)
        assertEquals("Default", option.effortDisplayLabel("Default"))
    }

    @Test
    fun optionsWithoutModelIdFallBackToLabelSplit() {
        val legacy = listOf("a" to "gpt-5 · High", "b" to "gpt-5 · Low").map { (id, label) ->
            RuntimeSelectionOption(selectionId = id, label = label, description = null, default = false)
        }
        val groups = legacy.groupByModel()

        assertEquals(listOf("gpt-5"), groups.map { it.label })
        assertEquals(listOf("High", "Low"), groups.single().options.map { it.effortDisplayLabel("Default") })
    }
}
