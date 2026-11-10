package com.agentsanywhere.app.api

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RuntimeCatalogDtosTest {
    private fun parseModels(modelsJson: String): List<RemoteRuntimeModel> =
        JSONObject("{\"runtime\":\"dsh\",\"revision\":1,\"models\":$modelsJson}")
            .parseRemoteRuntimeModelCatalog()
            .models

    @Test
    fun parsesModelGroupWhenPresent() {
        val models = parseModels(
            """[{"id":"relay-a/deepseek-v4","displayName":"deepseek-v4","selectionId":"s1",
                "group":{"id":"relay-a","displayName":"Relay A"}}]""",
        )
        assertEquals(RemoteRuntimeModelGroup(id = "relay-a", displayName = "Relay A"), models.single().group)
    }

    @Test
    fun parsesGroupItemDisplayNameWhenPresent() {
        val models = parseModels(
            """[{"id":"relay-a/deepseek-v4","displayName":"deepseek-v4（Relay A）","selectionId":"s1",
                "group":{"id":"relay-a","displayName":"Relay A","itemDisplayName":"deepseek-v4"}},
               {"id":"relay-a/v4-flash","displayName":"v4-flash","selectionId":"s2",
                "group":{"id":"relay-a","displayName":"Relay A","itemDisplayName":null}}]""",
        )
        assertEquals("deepseek-v4", models[0].group?.itemDisplayName)
        assertNull(models[1].group?.itemDisplayName)
    }

    @Test
    fun nullOrMissingGroupParsesAsNull() {
        val models = parseModels(
            """[{"id":"a","displayName":"A","group":null},{"id":"b","displayName":"B"}]""",
        )
        assertNull(models[0].group)
        assertNull(models[1].group)
    }

    @Test
    fun groupWithBlankIdOrNameParsesAsNull() {
        val models = parseModels(
            """[{"id":"a","displayName":"A","group":{"id":"","displayName":"X"}},
                {"id":"b","displayName":"B","group":{"id":"x","displayName":"  "}}]""",
        )
        assertNull(models[0].group)
        assertNull(models[1].group)
    }
}
