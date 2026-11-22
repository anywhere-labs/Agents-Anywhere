package dev.agentsanywhere.v3.core

import dev.agentsanywhere.v3.core.merge.ResultSource
import dev.agentsanywhere.v3.core.merge.SessionMerger
import dev.agentsanywhere.v3.core.model.DeviceSessionResult
import dev.agentsanywhere.v3.core.model.SessionList
import dev.agentsanywhere.v3.core.model.SessionSummary
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Runs every case of contracts/aa-v3/1.0/fixtures/session-merge.json (shared with Web, Desktop and iOS). */
class SessionMergeFixturesTest {
    private val fixture: JsonObject by lazy {
        val dir = System.getProperty("aa.contracts") ?: "../../contracts/aa-v3/1.0"
        AAJson.parseToJsonElement(File(dir, "fixtures/session-merge.json").readText()) as JsonObject
    }

    @Test
    fun allCases() {
        val cases = fixture["cases"].arr
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val name = case["name"].str
            val initial = (case["initial_cache"] as JsonObject).mapValues { (_, v) ->
                AAJson.decodeFromJsonElement(SessionList.serializer(), v).sessions
            }
            val local = case["local_e2ee_devices"].arr.mapNotNull { it.str }.toSet()
            val merger = SessionMerger(initial)
            for (event in case["events"].arr) {
                val source = if (event["source"].str == "client_tunnel") ResultSource.ClientTunnel else ResultSource.ControlPlane
                merger.apply(source, AAJson.decodeFromJsonElement(DeviceSessionResult.serializer(), event["result"]!!), local)
            }
            val expected = case["expected"]
            assertEquals(expected["session_order"].arr.map { it.str }, merger.merged().map { it.id }, "$name: order")
            val wantStates = (expected["device_states"] as JsonObject).mapValues { (_, v) ->
                Triple(v["status"].str, v["stale"].bool, v["error_code"].str)
            }
            val gotStates = merger.deviceStates.mapValues { (_, s) -> Triple(s.status, s.stale, s.errorCode) }
            assertEquals(wantStates, gotStates, "$name: device states")
        }
    }

    @Test
    fun sortIsStableForEqualTimes() {
        val list = AAJson.decodeFromString(ListSerializer(SessionSummary.serializer()), """[
            {"id":"b","device_id":"d1","updated_at":"2026-11-20T10:00:00Z"},
            {"id":"a","device_id":"d1","updated_at":"2026-11-20T10:00:00Z"},
            {"id":"c","device_id":"d0","updated_at":"2026-11-20T10:00:00Z"}]""")
        assertEquals(listOf("c", "a", "b"), list.sortedWith(SessionMerger.ORDER).map { it.id })
    }
}
