package com.agentsanywhere.app.api

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionsDtoTest {
    private val api = SessionsApi(ApiClient())

    @Test
    fun parsesLatestTurnEndSeqWhenPresent() {
        val json = JSONObject("""
            {
                "id": "sess-1",
                "connectorId": "conn-1",
                "status": "idle",
                "takeover": false,
                "pinned": false,
                "archived": false,
                "unread": true,
                "lastReadSeq": 5,
                "latestTurnEndSeq": 12,
                "lastItemOrderSeq": 7,
                "updatedSeq": 15
            }
        """.trimIndent())

        val session = api.parseSession(json)
        assertEquals("sess-1", session.id)
        assertEquals(true, session.unread)
        assertEquals(5, session.lastReadSeq)
        assertEquals(12, session.latestTurnEndSeq)
        assertEquals(7, session.lastItemOrderSeq)
    }

    @Test
    fun parsesLatestTurnEndSeqAsNullWhenMissingOrNull() {
        val missingJson = JSONObject("""
            {
                "id": "sess-2",
                "connectorId": "conn-1",
                "status": "idle",
                "takeover": false,
                "pinned": false,
                "archived": false,
                "unread": false,
                "lastReadSeq": 0,
                "updatedSeq": 1
            }
        """.trimIndent())

        val missingSession = api.parseSession(missingJson)
        assertNull(missingSession.latestTurnEndSeq)

        val nullJson = JSONObject("""
            {
                "id": "sess-3",
                "connectorId": "conn-1",
                "status": "idle",
                "takeover": false,
                "pinned": false,
                "archived": false,
                "unread": false,
                "lastReadSeq": 0,
                "latestTurnEndSeq": null,
                "updatedSeq": 1
            }
        """.trimIndent())

        val nullSession = api.parseSession(nullJson)
        assertNull(nullSession.latestTurnEndSeq)
    }
}
