package com.agentsanywhere.app.feature.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionAlertsTest {
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
