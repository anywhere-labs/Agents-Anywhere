package com.agentsanywhere.app.feature.sessiondetail

import org.junit.Assert.*
import org.junit.Test

class SessionMessageQueueTest {
    private val sessionId = "session"
    private val first = QueuedSessionMessage("first", "First instruction")
    private val second = QueuedSessionMessage("second", "Second instruction")

    private fun store() = SessionMessageQueueStore().also {
        it.enqueue(sessionId, first)
        it.enqueue(sessionId, second)
    }

    @Test fun sendsInOrderAndCannotClaimTwice() {
        val store = store()
        assertEquals(first, store.claimNext(sessionId))
        assertNull(store.claimNext(sessionId))
        store.finishSend(sessionId, first.id, true)
        assertEquals(second, store.claimNext(sessionId))
    }

    @Test fun failureHoldsLaterMessagesUntilExplicitSend() {
        val store = store()
        store.claimNext(sessionId)
        store.finishSend(sessionId, first.id, false)
        assertEquals(QueuedMessageStatus.Failed, store.read(sessionId).messages.first().status)
        assertNull(store.claimNext(sessionId))
        assertTrue(store.claimImmediate(sessionId, first.id))
        store.finishImmediate(sessionId, first.id, true)
        assertEquals(first, store.claimNext(sessionId))
    }

    @Test fun editingHoldsQueueAndLockedMessagesCannotBeChanged() {
        val store = store()
        store.edit(sessionId, first.id, true)
        assertNull(store.claimNext(sessionId))
        store.edit(sessionId, first.id, false, "Revised instruction")
        assertEquals("Revised instruction", store.claimNext(sessionId)?.content)
        store.edit(sessionId, first.id, true, "Changed while sending")
        store.remove(sessionId, first.id)
        assertEquals("Revised instruction", store.read(sessionId).messages.first().content)
        assertEquals(2, store.read(sessionId).messages.size)
    }

    @Test fun cancellingEditPreservesMessageAndSavingPreservesAttachmentsAndSelections() {
        val attachment = TimelineAttachment("file", "note.txt", "text/plain", 12)
        val original = first.copy(attachments = listOf(attachment), selections = mapOf("model" to "chosen-model"))
        val store = SessionMessageQueueStore()
        store.enqueue(sessionId, original)
        store.edit(sessionId, first.id, true)
        assertNull(store.claimNext(sessionId))
        store.edit(sessionId, first.id, false)
        assertEquals(original, store.read(sessionId).messages.single())
        store.edit(sessionId, first.id, true)
        store.edit(sessionId, first.id, false, "Updated instruction")
        assertEquals(original.copy(content = "Updated instruction"), store.claimNext(sessionId))
    }

    @Test fun emptyTextCannotReplaceMessageUnlessItHasAttachments() {
        val store = store()
        store.edit(sessionId, first.id, true)
        store.edit(sessionId, first.id, false, " ")
        assertTrue(store.read(sessionId).messages.first().editing)
        assertEquals(first.content, store.read(sessionId).messages.first().content)
        assertNull(store.claimNext(sessionId))
    }

    @Test fun pauseHoldsQueueAndNewStopWinsOverEarlierSend() {
        val store = store()
        store.pause(sessionId)
        val generation = store.read(sessionId).pauseGeneration
        assertNull(store.claimNext(sessionId))
        assertFalse(store.claimImmediate(sessionId, second.id))
        store.pause(sessionId)
        store.resume(sessionId, generation)
        assertTrue(store.read(sessionId).paused)
        store.resume(sessionId)
        assertEquals(first, store.claimNext(sessionId))
    }

    @Test fun sendNowLocksQueueUntilInterruptCompletesAndMovesChosenMessageToFront() {
        val store = store()
        assertTrue(store.claimImmediate(sessionId, second.id))
        assertNull(store.claimNext(sessionId))
        assertFalse(store.claimImmediate(sessionId, first.id))
        store.remove(sessionId, second.id)
        assertEquals(2, store.read(sessionId).messages.size)
        store.finishImmediate(sessionId, second.id, true)
        assertEquals(second, store.claimNext(sessionId))
        store.finishSend(sessionId, second.id, true)
        assertEquals(first, store.claimNext(sessionId))
    }

    @Test fun failedInterruptPreservesOrderAndStopsSelectedMessageFromAutoSending() {
        val store = store()
        store.claimImmediate(sessionId, second.id)
        store.finishImmediate(sessionId, second.id, false)
        assertEquals(listOf(first.id, second.id), store.read(sessionId).messages.map { it.id })
        assertEquals(QueuedMessageStatus.Failed, store.read(sessionId).messages.last().status)
    }

    @Test fun pausedQueueLetsFreshSendThroughAndSteeringAlwaysBypassesQueue() {
        val state = SessionMessageQueueState(messages = listOf(first))
        assertTrue(state.shouldQueue(null))
        assertFalse(state.shouldQueue(SessionSendMode.Steer))
        assertFalse(state.copy(paused = true).shouldQueue(null))
        assertTrue(state.copy(paused = true).shouldQueue(SessionSendMode.Queue))
        assertFalse(SessionMessageQueueState().shouldQueue(null))
    }

    @Test fun restoreRetainsAttachmentsSelectionsAndPauseButNeverRetriesUncertainRequests() {
        val attachment = TimelineAttachment("file", "image.png", "image/png", 123, "digest")
        val state = SessionMessageQueueState(paused = true, messages = listOf(
            first.copy(attachments = listOf(attachment), selections = mapOf("model" to "model-id", "permission" to null), editing = true),
            second.copy(status = QueuedMessageStatus.Sending),
            QueuedSessionMessage("third", "Third", status = QueuedMessageStatus.Interrupting),
        ))
        val restored = decodeMessageQueue(encodeMessageQueue(state))!!
        assertTrue(restored.paused)
        assertFalse(restored.messages.first().editing)
        assertEquals(listOf(attachment), restored.messages.first().attachments)
        assertEquals(state.messages.first().selections, restored.messages.first().selections)
        assertEquals(listOf(QueuedMessageStatus.Queued, QueuedMessageStatus.Failed, QueuedMessageStatus.Failed), restored.messages.map { it.status })
        assertNull(decodeMessageQueue("broken json"))
    }

    @Test fun reconcileServerEchoAvoidsSendingAnAlreadyAcceptedMessageAndSessionsAreIsolated() {
        val store = store()
        store.enqueue("other-session", first)
        store.reconcile(sessionId, setOf(first.id))
        assertEquals(listOf(second), store.read(sessionId).messages)
        assertEquals(listOf(first), store.read("other-session").messages)
        store.enqueue(sessionId, second)
        assertEquals(1, store.read(sessionId).messages.size)
    }

    @Test fun busyIncludesApprovalsAndPendingButNotDisconnectedOrUnknown() {
        assertTrue(SessionRuntimeStatus.Running.isBusyForMessageQueue())
        assertTrue(SessionRuntimeStatus.Pending.isBusyForMessageQueue())
        assertTrue(SessionRuntimeStatus.WaitingApproval.isBusyForMessageQueue())
        assertTrue(SessionRuntimeStatus.Blocked.isBusyForMessageQueue())
        assertFalse(SessionRuntimeStatus.Idle.isBusyForMessageQueue())
        assertFalse(SessionRuntimeStatus.Disconnected.isBusyForMessageQueue())
        assertFalse(SessionRuntimeStatus.Unknown.isBusyForMessageQueue())
    }
}
