package com.agentsanywhere.app.feature.notifications

import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.SessionsApi
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionAlertsTest {
    private val api = SessionsApi(ApiClient())

    private fun remoteSession(
        id: String = "sess-1",
        status: String = "idle",
        itemSeq: Int? = 5,
        unread: Boolean = false,
        turnEndSeq: Int? = 2,
    ) = api.parseSession(
        JSONObject(
            """
            {
                "id": "$id",
                "connectorId": "conn-1",
                "status": "$status",
                "takeover": false,
                "pinned": false,
                "archived": false,
                "unread": $unread,
                "lastReadSeq": 0,
                "lastItemOrderSeq": ${itemSeq ?: "null"},
                "latestTurnEndSeq": ${turnEndSeq ?: "null"},
                "updatedSeq": 1
            }
            """.trimIndent(),
        ),
    )

    @Test fun mapsRemoteSessionsToAlertInputs() {
        val input = sessionAlertInputs(listOf(remoteSession())).single()
        assertEquals("sess-1", input.id)
        assertEquals(SessionAlertState("idle", 5, false, 2), input.state)
    }

    @Test fun mapsMissingSeqFieldsToNeutralDefaults() {
        val input = sessionAlertInputs(listOf(remoteSession(itemSeq = null, turnEndSeq = null))).single()
        assertEquals(SessionAlertState("idle", -1, false, null), input.state)
    }

    @Test fun computeAlertListAlertsOnChangeAndRetainsUnseenKeys() {
        val previous = mapOf(
            "a" to SessionAlertState("running", 1, false),
            "b" to SessionAlertState("idle", 2, false),
        )
        val inputs = listOf(SessionAlertInput("a", "A", SessionAlertState("idle", 2, true)))
        val (alerts, next) = computeAlertList(previous, inputs, baseline = false)
        assertEquals(listOf(SessionAlertNotification("a", "A", SessionAlert.Response)), alerts)
        assertEquals(SessionAlertState("idle", 2, true), next["a"])
        assertEquals(SessionAlertState("idle", 2, false), next["b"])
    }

    @Test fun computeAlertListBaselineOnlyAlertsPendingApprovals() {
        val (alerts, next) = computeAlertList(
            emptyMap(),
            listOf(
                SessionAlertInput("a", "A", SessionAlertState("waiting_approval", 1, true)),
                SessionAlertInput("b", "B", SessionAlertState("idle", 1, true)),
                SessionAlertInput("c", "C", SessionAlertState("error", 1, false)),
            ),
            baseline = true,
        )
        assertEquals(listOf(SessionAlertNotification("a", "A", SessionAlert.Approval)), alerts)
        assertEquals(setOf("a", "b", "c"), next.keys)
    }

    @Test fun computeAlertListDoesNotRepeatAfterConsume() {
        val inputs = listOf(SessionAlertInput("a", "A", SessionAlertState("waiting_approval", 1, true)))
        val (first, next) = computeAlertList(emptyMap(), inputs, baseline = true)
        assertTrue(first.isNotEmpty())
        val (second, _) = computeAlertList(next, inputs, baseline = false)
        assertTrue(second.isEmpty())
    }

    @Test fun detectsNewApprovalWithoutRepeatingIt() {
        val approval = SessionAlertState("waiting_approval", 3, true)
        assertEquals(SessionAlert.Approval, sessionAlert(null, approval, true))
        assertNull(sessionAlert(approval, approval, false))
    }
    @Test fun detectsUnreadResponseAfterBaseline() {
        val old = SessionAlertState("running", 4, false)
        val response = SessionAlertState("idle", 5, true)
        assertEquals(SessionAlert.Response, sessionAlert(old, response, false))
        assertNull(sessionAlert(response, response, false))
        assertNull(sessionAlert(null, response, true))
        assertNull(sessionAlert(old, response.copy(unread = false), false))
    }
    @Test fun detectsNewErrorWithoutReplayingBaseline() {
        val current = SessionAlertState("error", 2, false)
        assertNull(sessionAlert(null, current, true))
        assertEquals(SessionAlert.Attention, sessionAlert(SessionAlertState("running", 2, false), current, false))
        assertNull(sessionAlert(current, current, false))
    }
    @Test fun detectsUnreadResponseWhenStreamingReusesItemSeqWithTurnEndSeq() {
        val running = SessionAlertState(status = "running", itemSeq = 5, unread = false, turnEndSeq = 2)
        // Stream completed without creating a higher item orderSeq, but latestTurnEndSeq advanced to 3.
        val completed = SessionAlertState(status = "idle", itemSeq = 5, unread = true, turnEndSeq = 3)
        assertEquals(SessionAlert.Response, sessionAlert(running, completed, false))
        assertNull(sessionAlert(completed, completed, false))
    }
    @Test fun doesNotRepeatResponseAlertWhenTurnEndSeqUnchanged() {
        val notified = SessionAlertState(status = "idle", itemSeq = 5, unread = true, turnEndSeq = 3)
        val pollAgain = SessionAlertState(status = "idle", itemSeq = 5, unread = true, turnEndSeq = 3)
        assertNull(sessionAlert(notified, pollAgain, false))
    }
    @Test fun detectsUnreadResponseWithTurnEndSeqWhenPreviousWasIdleAndRead() {
        val readState = SessionAlertState(status = "idle", itemSeq = 5, unread = false, turnEndSeq = 2)
        val newTurn = SessionAlertState(status = "idle", itemSeq = 5, unread = true, turnEndSeq = 3)
        assertEquals(SessionAlert.Response, sessionAlert(readState, newTurn, false))
    }
    @Test fun fallbackToItemSeqWhenTurnEndSeqMissing() {
        val old = SessionAlertState("running", 4, false, turnEndSeq = null)
        val response = SessionAlertState("idle", 5, true, turnEndSeq = null)
        assertEquals(SessionAlert.Response, sessionAlert(old, response, false))
        assertNull(sessionAlert(response, response, false))
    }
    @Test fun migrationWhenPreviousLacksTurnEndSeq() {
        val oldRunningWithoutTurnSeq = SessionAlertState("running", 4, false, turnEndSeq = null)
        val completedWithTurnSeq = SessionAlertState("idle", 4, true, turnEndSeq = 5)
        assertEquals(SessionAlert.Response, sessionAlert(oldRunningWithoutTurnSeq, completedWithTurnSeq, false))

        val alreadyIdleUnreadOld = SessionAlertState("idle", 4, true, turnEndSeq = null)
        val sameCompleted = SessionAlertState("idle", 4, true, turnEndSeq = 5)
        assertNull(sessionAlert(alreadyIdleUnreadOld, sameCompleted, false))
    }
    @Test fun detectsUnreadResponseForNewSessionAfterBaselineWithTurnEndSeq() {
        val newSession = SessionAlertState(status = "idle", itemSeq = 0, unread = true, turnEndSeq = 3)
        assertNull(sessionAlert(null, newSession, baseline = true))
        assertEquals(SessionAlert.Response, sessionAlert(null, newSession, baseline = false))
    }
}
