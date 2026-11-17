package com.agentsanywhere.app.feature.realtime

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.RealtimeTransport
import com.agentsanywhere.app.api.RemoteDashboardSnapshot
import com.agentsanywhere.app.api.RemoteEventRecoveryResponse
import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.api.RemoteSessionEventPayload
import com.agentsanywhere.app.api.RemoteWsTicket
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/** 加密模式下会话事件流经 [SessionStreamRouter]，不再拿会话 WS 票据。 */
class SessionRealtimeSecureStreamTest {
    private class NoWebSocketTransport : RealtimeTransport {
        val ticketRequests = AtomicInteger()

        override fun createDashboardTicket(serverUrl: String, authorizationToken: String, clientId: String): RemoteWsTicket =
            throw UnsupportedOperationException()

        override fun createSessionTicket(serverUrl: String, authorizationToken: String, clientId: String, sessionId: String): RemoteWsTicket {
            ticketRequests.incrementAndGet()
            throw AssertionError("an encrypted session must not open the plaintext session WebSocket")
        }

        override fun dashboardWebSocketUrl(serverUrl: String, ticket: String): String = throw UnsupportedOperationException()
        override fun sessionWebSocketUrl(serverUrl: String, sessionId: String, ticket: String): String = throw UnsupportedOperationException()
        override fun recoverSessionEvents(serverUrl: String, authorizationToken: String, sessionId: String, after: String) =
            RemoteEventRecoveryResponse(events = emptyList(), nextCursor = after, snapshotRequired = false, serverTime = null)

        override fun parseDashboardMessage(text: String): RemoteDashboardSnapshot? = null

        override fun parseSessionMessage(text: String): RemoteSessionEventEnvelope? {
            val json = JSONObject(text)
            return RemoteSessionEventEnvelope(
                protocolVersion = "1.1",
                eventId = json.getString("eventId"),
                sequence = json.getLong("sequence"),
                cursor = "seq:${json.getLong("sequence")}",
                type = json.getString("type"),
                sessionId = json.getString("sessionId"),
                emittedAt = null,
                payload = RemoteSessionEventPayload(),
            )
        }

        override fun openWebSocket(url: String, listener: WebSocketListener): WebSocket = throw UnsupportedOperationException()
    }

    private val auth = object : AuthSessionReader {
        override fun readServerUrl() = "http://localhost"
        override fun readAccessToken() = "token"
    }

    @Test
    fun eventsArriveThroughTheSecureStream() = runBlocking<Unit> {
        val transport = NoWebSocketTransport()
        var afterCursor: String? = null
        var closedByController = false
        val router = object : SessionStreamRouter {
            override suspend fun openSecureStream(
                serverUrl: String,
                token: String?,
                sessionId: String,
                afterCursor: String?,
                onMessage: (String) -> Unit,
                onClosed: () -> Unit,
            ): (() -> Unit) {
                afterCursorSeen(afterCursor)
                onMessage(JSONObject().put("eventId", "e6").put("sequence", 6).put("type", "timeline.item_created").put("sessionId", sessionId).toString())
                return { closedByController = true }
            }

            fun afterCursorSeen(value: String?) {
                afterCursor = value
            }
        }
        val received = CompletableDeferred<List<RemoteSessionEventEnvelope>>()
        val runtimeRefreshed = CompletableDeferred<Unit>()
        val job = SessionRealtimeController(transport, auth, "client", streamRouter = { router }).start(
            scope = this, sessionId = "s1", cursor = { "seq:5" },
            onEvents = { received.complete(it) }, onCursorAdvanced = {}, onSnapshotRequired = {},
            onRuntimeRefreshRequired = { _, _ -> runtimeRefreshed.complete(Unit) },
            onConnectionChanged = { _, _, _, _ -> },
        )
        try {
            val events = withTimeout(5_000) { received.await() }
            assertEquals("e6", events.single().eventId)
            withTimeout(5_000) { runtimeRefreshed.await() }
            assertEquals("seq:5", afterCursor)
            assertEquals(0, transport.ticketRequests.get())
        } finally {
            job.cancelAndJoin()
        }
        assertTrue(closedByController)
    }

    @Test
    fun aRefusedStreamNeverFallsBackToTheWebSocket() = runBlocking<Unit> {
        val transport = NoWebSocketTransport()
        val failure = CompletableDeferred<String?>()
        val router = object : SessionStreamRouter {
            override suspend fun openSecureStream(
                serverUrl: String, token: String?, sessionId: String, afterCursor: String?,
                onMessage: (String) -> Unit, onClosed: () -> Unit,
            ): (() -> Unit) = throw ApiException("Pair first", 409, errorCode = "e2ee_required")
        }
        val job = SessionRealtimeController(transport, auth, "client", retryDelay = { 60_000L }, streamRouter = { router }).start(
            scope = this, sessionId = "s1", cursor = { "seq:5" },
            onEvents = {}, onCursorAdvanced = {}, onSnapshotRequired = {},
            onRuntimeRefreshRequired = { _, _ -> },
            onConnectionChanged = { connected, _, _, error -> if (!connected && error != null) failure.complete(error) },
        )
        try {
            assertEquals("Pair first", withTimeout(5_000) { failure.await() })
            assertEquals(0, transport.ticketRequests.get())
        } finally {
            job.cancelAndJoin()
        }
    }
}
