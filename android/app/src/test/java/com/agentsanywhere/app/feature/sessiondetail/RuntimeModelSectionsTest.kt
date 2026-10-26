package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteRuntimeModel
import com.agentsanywhere.app.api.RemoteRuntimeModelGroup
import com.agentsanywhere.app.api.RemoteRuntimeReasoning
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RuntimeModelSectionsTest {
    private data class Item(val id: String, val group: RemoteRuntimeModelGroup?)

    private fun group(id: String, name: String = id.uppercase()) = RemoteRuntimeModelGroup(id, name)

    private fun List<Item>.sections() = sectionByModelGroup(Item::group)
        .map { section -> section.header to section.items.map(Item::id) }

    @Test
    fun noGroupsIsOneHeaderlessSection() {
        val items = listOf(Item("a", null), Item("b", null))
        assertEquals(listOf(null to listOf("a", "b")), items.sections())
    }

    @Test
    fun singleGroupIsOneHeaderlessSectionInCatalogOrder() {
        val items = listOf(Item("a", group("x")), Item("b", null), Item("c", group("x")))
        assertEquals(listOf(null to listOf("a", "b", "c")), items.sections())
    }

    @Test
    fun emptyListHasNoSections() {
        assertEquals(emptyList<Pair<String?, List<String>>>(), emptyList<Item>().sections())
    }

    @Test
    fun interleavedGroupsUseFirstAppearanceOrderAndKeepCatalogOrderWithin() {
        val items = listOf(
            Item("r1", group("relay")),
            Item("d1", group("deepseek")),
            Item("r2", group("relay")),
            Item("d2", group("deepseek")),
        )
        assertEquals(
            listOf("RELAY" to listOf("r1", "r2"), "DEEPSEEK" to listOf("d1", "d2")),
            items.sections(),
        )
    }

    @Test
    fun ungroupedModelsGoToTrailingHeaderlessSection() {
        val items = listOf(
            Item("u1", null),
            Item("a1", group("a")),
            Item("b1", group("b")),
            Item("u2", null),
        )
        assertEquals(
            listOf("A" to listOf("a1"), "B" to listOf("b1"), null to listOf("u1", "u2")),
            items.sections(),
        )
    }

    @Test
    fun duplicateGroupIdKeepsFirstDisplayName() {
        val items = listOf(
            Item("a1", group("a", "First")),
            Item("b1", group("b", "Bee")),
            Item("a2", group("a", "Second")),
        )
        assertEquals(
            listOf("First" to listOf("a1", "a2"), "Bee" to listOf("b1")),
            items.sections(),
        )
    }

    @Test
    fun modelSelectionOptionsCarryModelFieldsAndGroup() {
        val relay = group("relay-a", "Relay A")
        val options = listOf(
            RemoteRuntimeModel(
                id = "relay-a/deepseek-v4",
                selectionId = null,
                displayName = "deepseek · v4",
                description = null,
                default = false,
                reasoningItems = listOf(
                    RemoteRuntimeReasoning(
                        id = "high",
                        selectionId = "sel-high",
                        fullModelId = null,
                        displayName = "High",
                        description = null,
                        default = true,
                        metadata = emptyMap(),
                    ),
                ),
                metadata = emptyMap(),
                group = relay,
            ),
            RemoteRuntimeModel(
                id = "plain",
                selectionId = "sel-plain",
                displayName = "Plain",
                description = null,
                default = false,
                reasoningItems = emptyList(),
                metadata = emptyMap(),
            ),
        ).modelSelectionOptions()

        assertEquals(listOf("sel-high", "sel-plain"), options.map { it.selectionId })
        val high = options[0]
        assertEquals("deepseek · v4 · High", high.label)
        assertEquals("relay-a/deepseek-v4", high.modelId)
        assertEquals("deepseek · v4", high.modelLabel)
        assertEquals("High", high.effortLabel)
        assertEquals(relay, high.group)
        val plain = options[1]
        assertEquals("Plain", plain.label)
        assertEquals("plain", plain.modelId)
        assertNull(plain.effortLabel)
        assertNull(plain.group)
    }

    @Test
    fun rowUnderProviderHeaderDropsProviderButFlatListKeepsLabel() {
        val deepseek = RemoteRuntimeModelGroup("deepseek", "DeepSeek", itemDisplayName = "deepseek-v4")
        val relay = RemoteRuntimeModelGroup("relay", "Relay", itemDisplayName = "deepseek-v4")
        val grouped = listOf(Item("d", deepseek), Item("r", relay)).sectionByModelGroup(Item::group)
        assertEquals("deepseek-v4", grouped[0].rowLabel("deepseek-v4（DeepSeek）", deepseek))
        assertEquals("deepseek-v4", grouped[1].rowLabel("deepseek-v4（Relay）", relay))
        // A group without itemDisplayName keeps the catalog label.
        assertEquals("v4-flash", grouped[0].rowLabel("v4-flash", group("deepseek")))
        // One provider stays flat, so the row keeps the catalog label.
        val flat = listOf(Item("d", deepseek)).sectionByModelGroup(Item::group)
        assertEquals("deepseek-v4（DeepSeek）", flat.single().rowLabel("deepseek-v4（DeepSeek）", deepseek))
    }
}
