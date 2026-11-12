package com.agentsanywhere.app.api

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DevicesApiRuntimeTypesTest {
    @Test
    fun parsesRuntimeTypesAndSkipsInvalidIdentities() {
        val list = DevicesApi().parseRuntimeTypeList(
            JSONObject(
                """{"connectorId":"c1","runtimeTypes":[
                  {"runtimeType":"codex","displayName":"Codex","present":true,"available":true,"recommended":true,
                   "recommendationRank":10,"schema":{"type":"object","properties":{"codexHome":{"type":"string"}}},
                   "uiSchema":{"order":["codexHome"]},"defaults":{"ipcEnabled":true},"instancePolicy":"single","maxInstances":1},
                  {"runtimeType":"pi","displayName":"Pi","present":true,"available":false,"reason":"Not installed",
                   "configSchema":{"schema":{"type":"object"},"uiSchema":{"order":[]},"defaults":{"executionMode":"auto"}},
                   "instancePolicy":"multiple","maxInstances":null},
                  {"runtimeType":"rti_bad","displayName":"Bad","present":true}
                ]}""",
            ),
            fallbackConnectorId = "fallback",
        )

        assertEquals("c1", list.connectorId)
        assertEquals(listOf("codex", "pi"), list.runtimeTypes.map { it.runtimeType })
        val codex = list.runtimeTypes[0]
        assertEquals(10, codex.recommendationRank)
        assertEquals(mapOf("ipcEnabled" to true), codex.defaults)
        assertEquals(listOf("codexHome"), codex.uiSchema["order"])
        val pi = list.runtimeTypes[1]
        assertEquals("Not installed", pi.reason)
        assertEquals(mapOf("type" to "object"), pi.schema)
        assertEquals(mapOf("executionMode" to "auto"), pi.defaults)
        assertNull(pi.maxInstances)
        assertEquals("multiple", pi.instancePolicy)
    }

    @Test
    fun nestedConfigBecomesNestedJson() {
        val json = mapOf<String, Any?>(
            "environment" to mapOf("PATH" to null, "A" to "1"),
            "customModels" to listOf(mapOf("modelId" to "m", "efforts" to listOf(mapOf("effortId" to "high")))),
            "historyDirs" to listOf(listOf("/a")),
        ).toJsonObject()

        assertTrue(json.get("environment") is JSONObject)
        assertTrue(json.getJSONObject("environment").isNull("PATH"))
        val model = json.getJSONArray("customModels").getJSONObject(0)
        assertEquals("high", model.getJSONArray("efforts").getJSONObject(0).getString("effortId"))
        assertTrue(json.getJSONArray("historyDirs").get(0) is JSONArray)
    }

    @Test
    fun jsonTextRoundTripsThroughKotlinValues() {
        val value = parseJsonValue("""{"a":[1,{"b":null}],"c":"x"}""")

        assertEquals(mapOf("a" to listOf(1, mapOf("b" to null)), "c" to "x"), value)
        assertEquals(value, parseJsonValue(formatJsonValue(value)))
        assertEquals("\"x\"", formatJsonValue("x"))
        assertEquals("[\"/a\\\\/b\"]", formatJsonValue(listOf("/a\\/b")).replace(Regex("\\s"), ""))
    }

    @Test
    fun textAfterTheJsonValueIsRejected() {
        assertTrue(runCatching { parseJsonValue("[\"/a\"] garbage") }.isFailure)
        assertEquals(listOf("/a"), parseJsonValue(" [\"/a\"] \n"))
    }
}
