package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.api.RemoteSessionQueueItem
import com.agentsanywhere.app.api.RemoteSessionQueueState
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.feature.sessions.toAgentSession
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionMessageQueueTest {
    @Test
    fun queueEventReplacesTheWholeQueueAndIgnoresOlderRevisions() {
        val first = reduceRealtimeEvents(opened(), listOf(queueEvent(revision = 2, "a", "b")), emptyList())
        assertEquals(listOf("a", "b"), first.queue!!.items.map { it.messageId })

        val stale = reduceRealtimeEvents(first, listOf(queueEvent(revision = 1, "old")), emptyList())
        assertEquals(2L, stale.queue!!.revision)

        val cleared = reduceRealtimeEvents(stale, listOf(queueEvent(revision = 3)), emptyList())
        assertTrue(cleared.queue!!.items.isEmpty())
        // The envelope borrows the session's sequence; it must not move the cursor.
        assertEquals("seq:0", cleared.realtime.cursor)
    }

    @Test
    fun repeatedQueueProjectionIsNotDroppedAsADuplicateEvent() {
        // The queue is a live projection: the same event id can carry a newer queue.
        val first = queueEvent(revision = 1, "a").copy(eventId = "queue")
        val second = queueEvent(revision = 2).copy(eventId = "queue")
        val state = reduceRealtimeEvents(opened(), listOf(first), emptyList())
        assertEquals(2L, reduceRealtimeEvents(state, listOf(second), emptyList()).queue!!.revision)
    }

    @Test
    fun snapshotKeepsTheNewerQueue() {
        val live = opened().copy(queue = queue(revision = 5, "live"))
        val snapshot = opened().copy(queue = queue(revision = 4, "snapshot"))
        assertEquals("live", reduceSnapshotWithLiveState(snapshot, live, opened()).queue!!.items.single().messageId)

        val newer = opened().copy(queue = queue(revision = 6, "snapshot"))
        assertEquals("snapshot", reduceSnapshotWithLiveState(newer, live, opened()).queue!!.items.single().messageId)
    }

    @Test
    fun parsesQueueEventsAndOnlyForTheQueueType() {
        val payload = JSONObject().put("queue", queueJson(revision = 7, "q1"))
        val event = SessionsApi().parseSessionEvent(envelope("runtime.queue.updated", payload))
        assertEquals(7L, event.payload.queue!!.revision)
        assertEquals("q1", event.payload.queue!!.items.single().messageId)
        assertEquals("boom", event.payload.queue!!.items.single().errorMessage)

        val other = SessionsApi().parseSessionEvent(envelope("runtime.state.updated", payload))
        assertNull(other.payload.queue)
    }

    @Test
    fun messagesWaitWhileBusyOrBehindEarlierMessages() {
        assertTrue(messageMustWait(SessionRuntimeStatus.Running, null))
        assertTrue(messageMustWait(SessionRuntimeStatus.WaitingApproval, null))
        assertFalse(messageMustWait(SessionRuntimeStatus.Idle, null))
        assertFalse(messageMustWait(SessionRuntimeStatus.Idle, queue(revision = 1)))
        assertTrue(messageMustWait(SessionRuntimeStatus.Idle, queue(revision = 1, "a")))
    }

    @Test
    fun queuePausesOnAFailedHeadOrAnErroredTurn() {
        assertEquals(QueuePause.Failed, queuePause(SessionRuntimeStatus.Idle, queue(revision = 1, "a", headStatus = "failed")))
        assertEquals(QueuePause.Error, queuePause(SessionRuntimeStatus.Error, queue(revision = 1, "a")))
        assertNull(queuePause(SessionRuntimeStatus.Running, queue(revision = 1, "a")))
        assertNull(queuePause(SessionRuntimeStatus.Error, queue(revision = 1)))
    }

    @Test
    fun queuedSendCarriesTheQueueFieldAndReturnsTheQueue() = withServer(
        MockResponse().setHeader("Content-Type", "application/json").setBody(
            JSONObject().put("ok", true).put(
                "result",
                JSONObject().put("delivery", "queued").put("queuePosition", 1).put("queue", queueJson(revision = 3, "q1")),
            ).toString(),
        ),
    ) { server, controller ->
        val result = controller.sendMessage(SESSION_ID, "hi", "msg_1", delivery = MessageDelivery.Interrupt).getOrThrow()
        val body = JSONObject(server.takeRequest().body.readUtf8())
        assertEquals("interrupt", body.getString("queue"))
        assertTrue(result.queued)
        assertEquals(3L, result.queue!!.revision)
    }

    @Test
    fun directSendLeavesTheQueueFieldOut() = withServer(
        MockResponse().setHeader("Content-Type", "application/json").setBody("""{"ok":true,"result":{}}"""),
    ) { server, controller ->
        val result = controller.sendMessage(SESSION_ID, "hi", "msg_1").getOrThrow()
        val request = server.takeRequest()
        assertTrue(request.path!!.endsWith("/runtime/messages"))
        assertFalse(JSONObject(request.body.readUtf8()).has("queue"))
        assertFalse(result.queued)
    }

    @Test
    fun steerGoesToTheSteerRouteAndReportsADeclinedTurn() = withServer(
        MockResponse().setHeader("Content-Type", "application/json")
            .setBody("""{"ok":true,"result":{"ok":false,"message":"turn ended"}}"""),
    ) { server, controller ->
        val result = controller.sendMessage(SESSION_ID, "hi", "msg_1", delivery = MessageDelivery.Steer)
        val request = server.takeRequest()
        assertTrue(request.path!!.endsWith("/runtime/steer"))
        assertFalse(JSONObject(request.body.readUtf8()).has("queue"))
        assertTrue(result.exceptionOrNull() is SteerRejected)
        assertEquals("turn ended", result.exceptionOrNull()!!.message)
    }

    @Test
    fun queueActionsReadTheWholeQueue() = withServer(
        MockResponse().setHeader("Content-Type", "application/json").setBody(queueJson(revision = 9).toString()),
    ) { server, controller ->
        val queue = controller.sendQueueItemNow(SESSION_ID, "q 1").getOrThrow()
        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertTrue(request.path!!.endsWith("/runtime/queue/q%201/send-now"))
        assertEquals(9L, queue.revision)
    }

    private fun withServer(
        response: MockResponse,
        block: suspend (MockWebServer, SessionDetailController) -> Unit,
    ) = runBlocking {
        val server = MockWebServer()
        server.enqueue(response)
        server.start()
        try {
            val origin = "http://127.0.0.1:${server.port}"
            block(server, SessionDetailController(SessionsApi(ApiClient()), auth(origin)))
        } finally {
            server.shutdown()
        }
    }

    private companion object {
        const val SESSION_ID = "session-1"

        fun auth(serverUrl: String) = object : AuthSessionReader {
            override fun readServerUrl() = serverUrl
            override fun readAccessToken() = "token"
        }

        fun opened() = SessionDetailState(
            meta = SessionMeta(
                session = SessionsApi().parseSession(
                    JSONObject().put("id", SESSION_ID).put("connectorId", "c").put("runtime", "codex").put("updatedSeq", 1),
                ).toAgentSession(emptyMap()),
            ),
            initialized = true,
        )

        fun queue(revision: Long, vararg ids: String, headStatus: String = "queued") = RemoteSessionQueueState(
            sessionId = SESSION_ID,
            revision = revision,
            items = ids.mapIndexed { index, id ->
                RemoteSessionQueueItem(
                    messageId = id,
                    sessionId = SESSION_ID,
                    clientMessageId = "msg_$id",
                    content = id,
                    status = if (index == 0) headStatus else "queued",
                    position = index + 1,
                    interruptRequested = false,
                    attachmentCount = 0,
                    errorCode = null,
                    errorMessage = null,
                )
            },
        )

        fun queueEvent(revision: Long, vararg ids: String) = RemoteSessionEventEnvelope(
            protocolVersion = "1.0",
            eventId = "queue:$revision",
            sequence = 99,
            cursor = "seq:99",
            type = "runtime.queue.updated",
            sessionId = SESSION_ID,
            emittedAt = null,
            payload = com.agentsanywhere.app.api.RemoteSessionEventPayload(queue = queue(revision, *ids)),
        )

        fun queueJson(revision: Long, vararg ids: String) = JSONObject()
            .put("sessionId", SESSION_ID)
            .put("revision", revision)
            .put(
                "items",
                JSONArray(
                    ids.mapIndexed { index, id ->
                        JSONObject()
                            .put("messageId", id)
                            .put("sessionId", SESSION_ID)
                            .put("clientMessageId", "msg_$id")
                            .put("content", "text $id")
                            .put("status", "failed")
                            .put("position", index + 1)
                            .put("interruptRequested", false)
                            .put("attachments", JSONArray())
                            .put("error", JSONObject().put("code", "x").put("message", "boom"))
                    },
                ),
            )

        fun envelope(type: String, payload: JSONObject) = JSONObject()
            .put("protocolVersion", "1.0")
            .put("eventId", "e1")
            .put("sequence", 0)
            .put("cursor", "seq:0")
            .put("type", type)
            .put("sessionId", SESSION_ID)
            .put("payload", payload)
    }
}
