package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.feature.sessions.toAgentSession
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class FailedSendDiscardTest {
    @Test
    fun deletingAFailedSendRemovesItFromTheVisitAndFromLaterVisits() = withServer { controller ->
        val failed = failedSend(controller)
        assertTrue(failed.messages.single { it.id == FAILED_ID }.isFailedLocalSend)

        val deleted = controller.discardFailedMessage(SESSION_ID, failed, FAILED_ID)

        assertEquals(listOf("server"), deleted.messages.map { it.id })
        // The next visit starts from these stored messages.
        assertTrue(controller.optimisticMessages(SESSION_ID).isEmpty())
    }

    @Test
    fun aSnapshotRequestedBeforeTheDeletionCannotBringTheMessageBack() = withServer { controller ->
        val requestState = failedSend(controller)
        val deleted = controller.discardFailedMessage(SESSION_ID, requestState, FAILED_ID)

        val snapshot = runBlocking { controller.loadInitialSnapshot(SESSION_ID, emptyList(), requestState) }.getOrThrow()
        assertFalse(snapshot.messages.any { it.id == FAILED_ID })

        val merged = controller.mergeSnapshotWithLiveState(SESSION_ID, snapshot, deleted, requestState)
        assertFalse(merged.messages.any { it.id == FAILED_ID })
        assertTrue(controller.optimisticMessages(SESSION_ID).isEmpty())
    }

    @Test
    fun sendingTheSameMessageAgainShowsItAgain() = withServer { controller ->
        val deleted = controller.discardFailedMessage(SESSION_ID, failedSend(controller), FAILED_ID)

        val resent = controller.addOptimisticMessage(SESSION_ID, deleted, "hello", FAILED_ID)

        assertEquals("pending", resent.messages.single { it.id == FAILED_ID }.status)
        assertEquals(listOf(FAILED_ID), controller.optimisticMessages(SESSION_ID).map { it.id })
    }

    @Test
    fun onlySendsThatFailedOnThisDeviceCanBeDeleted() = withServer { controller ->
        val sending = controller.addOptimisticMessage(SESSION_ID, loaded(), "hello", FAILED_ID)

        assertSame(sending, controller.discardFailedMessage(SESSION_ID, sending, FAILED_ID))
        assertSame(sending, controller.discardFailedMessage(SESSION_ID, sending, "server"))
        assertEquals(listOf(FAILED_ID), controller.optimisticMessages(SESSION_ID).map { it.id })
    }

    @Test
    fun theServerEchoOfADeletedSendStillAppears() = withServer { controller ->
        val deleted = controller.discardFailedMessage(SESSION_ID, failedSend(controller), FAILED_ID)
        val echo = TimelineMessage(
            id = "echo",
            author = MessageAuthor.User,
            text = "hello",
            orderSeq = 2,
            clientMessageId = FAILED_ID,
        )

        val next = controller.applyOlder(
            SESSION_ID,
            deleted,
            SessionTimelineState(messages = listOf(echo)),
            deleted.timeline.historyGeneration,
        )

        assertEquals(setOf("server", "echo"), next.messages.map { it.id }.toSet())
    }

    private fun failedSend(controller: SessionDetailController): SessionDetailState {
        val sending = controller.addOptimisticMessage(SESSION_ID, loaded(), "hello", FAILED_ID)
        return controller.markOptimisticMessage(
            sessionId = SESSION_ID,
            state = sending,
            clientMessageId = FAILED_ID,
            status = "failed",
            errorMessage = "session is running",
        )
    }

    private fun loaded() = SessionDetailState(
        initialized = true,
        meta = SessionMeta(
            session = SessionsApi().parseSession(
                JSONObject().put("id", SESSION_ID).put("connectorId", "connector")
                    .put("runtime", "codex").put("updatedSeq", 10),
            ).toAgentSession(emptyMap()),
        ),
        timeline = SessionTimelineState(
            messages = listOf(TimelineMessage("server", author = MessageAuthor.Agent, text = "ready", orderSeq = 1)),
            nextSeq = 10,
        ),
    )

    private fun withServer(block: (SessionDetailController) -> Unit) {
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                return when {
                    path.endsWith("/sessions/$SESSION_ID/snapshot") -> MockResponse()
                        .setHeader("Content-Type", "application/json")
                        .setBody(
                            """{"session":{"id":"$SESSION_ID","connectorId":"connector","runtime":"codex","updatedSeq":10},""" +
                                """"timeline":{"items":[],"nextSeq":10,"hasMore":false},"eventCursor":"seq:10"}""",
                        )
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        val controller = SessionDetailController(SessionsApi(), object : AuthSessionReader {
            override fun readServerUrl() = "http://127.0.0.1:${server.port}"
            override fun readAccessToken() = "token"
        })
        try {
            block(controller)
        } finally {
            controller.dispose()
            server.shutdown()
        }
    }

    private companion object {
        const val SESSION_ID = "a"
        const val FAILED_ID = "opt_1"
    }
}
