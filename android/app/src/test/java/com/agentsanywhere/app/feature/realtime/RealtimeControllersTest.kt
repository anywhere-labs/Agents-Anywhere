package com.agentsanywhere.app.feature.realtime

import com.agentsanywhere.app.api.RealtimeTransport
import com.agentsanywhere.app.api.RemoteDashboardSnapshot
import com.agentsanywhere.app.api.RemoteEventRecoveryResponse
import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.api.RemoteSessionEventPayload
import com.agentsanywhere.app.api.RemoteWsTicket
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RealtimeControllersTest {
    @Test
    fun lateTicketFromReplacedStartCannotOpenOrReplaceNewConnection() = runBlocking {
        val firstTicketStarted = java.util.concurrent.CountDownLatch(1)
        val releaseFirstTicket = java.util.concurrent.CountDownLatch(1)
        val secondOpened = CompletableDeferred<Unit>()
        val transport = ReplacedStartTransport(firstTicketStarted, releaseFirstTicket, secondOpened)
        val controller = SessionRealtimeController(
            transport = transport,
            sessionStore = auth(),
            clientId = "android-install",
            retryDelay = { 30_000L },
        )

        val first = controller.start(
            scope = this,
            sessionId = "old-session",
            cursor = { "seq:0" },
            onEvents = {},
            onCursorAdvanced = {},
            onSnapshotRequired = {},
            onRuntimeRefreshRequired = { _, _ -> },
            onConnectionChanged = { _, _, _, _ -> },
        )
        assertTrue(firstTicketStarted.await(2, java.util.concurrent.TimeUnit.SECONDS))
        val second = controller.start(
            scope = this,
            sessionId = "new-session",
            cursor = { "seq:0" },
            onEvents = {},
            onCursorAdvanced = {},
            onSnapshotRequired = {},
            onRuntimeRefreshRequired = { _, _ -> },
            onConnectionChanged = { _, _, _, _ -> },
        )
        withTimeout(2_000) { secondOpened.await() }
        releaseFirstTicket.countDown()
        first.cancelAndJoin()
        second.cancelAndJoin()

        assertEquals(listOf("new-session"), transport.openedSessions)
    }

    @Test
    fun liveTimelineBatchIsDeliveredWhileRecoveryAndRuntimeRefreshAreBlocked() = runBlocking {
        val liveDelivered = CompletableDeferred<List<RemoteSessionEventEnvelope>>()
        val recoveryStarted = java.util.concurrent.CountDownLatch(1)
        val releaseRecovery = java.util.concurrent.CountDownLatch(1)
        val transport = BlockingRealtimeTransport(recoveryStarted, releaseRecovery)
        val controller = SessionRealtimeController(
            transport = transport,
            sessionStore = auth(),
            clientId = "android-install",
            retryDelay = { 30_000L },
        )

        val job = controller.start(
            scope = this,
            sessionId = "session",
            cursor = { "seq:7" },
            onEvents = { events ->
                if (events.any { it.type == "timeline.item_created" }) liveDelivered.complete(events)
            },
            onCursorAdvanced = {},
            onSnapshotRequired = {},
            onRuntimeRefreshRequired = { _, _ -> awaitCancellation() },
            onConnectionChanged = { _, _, _, _ -> },
        )

        assertTrue(recoveryStarted.await(2, java.util.concurrent.TimeUnit.SECONDS))
        transport.send("timeline")
        val delivered = withTimeout(2_000) { liveDelivered.await() }
        releaseRecovery.countDown()
        job.cancelAndJoin()

        assertEquals(listOf("timeline.item_created"), delivered.map { it.type })
    }

    @Test
    fun oneHundredQueuedTimelineEventsAreDeliveredInOneBatch() = runBlocking {
        val delivered = CompletableDeferred<List<RemoteSessionEventEnvelope>>()
        val transport = BurstRealtimeTransport(eventCount = 100)
        val controller = SessionRealtimeController(
            transport = transport,
            sessionStore = auth(),
            clientId = "android-install",
            retryDelay = { 30_000L },
        )

        val job = controller.start(
            scope = this,
            sessionId = "session",
            cursor = { "seq:0" },
            onEvents = { events ->
                val timeline = events.filter { it.type == "timeline.item_created" }
                if (timeline.size == 100) delivered.complete(timeline)
            },
            onCursorAdvanced = {},
            onSnapshotRequired = {},
            onRuntimeRefreshRequired = { _, _ -> },
            onConnectionChanged = { _, _, _, _ -> },
        )

        val batch = withTimeout(2_000) { delivered.await() }
        job.cancelAndJoin()

        assertEquals(100, batch.size)
        assertEquals((1L..100L).toList(), batch.map { it.sequence })
    }

    @Test
    fun sessionReconnectUsesFreshTicketAndRecoversFromLatestCursor() = runBlocking {
        val firstRecovered = CompletableDeferred<Unit>()
        val secondRecovered = CompletableDeferred<Unit>()
        val recoveryCount = AtomicInteger()
        val cursor = AtomicReference("seq:7")
        val transport = FakeRealtimeTransport(
            recovery = RemoteEventRecoveryResponse(emptyList(), "seq:9", false, "now"),
            onRecovery = {
                when (recoveryCount.incrementAndGet()) {
                    2 -> firstRecovered.complete(Unit)
                    3 -> secondRecovered.complete(Unit)
                }
            },
        )
        val controller = SessionRealtimeController(
            transport = transport,
            sessionStore = auth(),
            clientId = "android-install",
            retryDelay = { 0L },
        )

        val job = controller.start(
            scope = this,
            sessionId = "session",
            cursor = { cursor.get() },
            onEvents = {},
            onCursorAdvanced = { cursor.set(it) },
            onSnapshotRequired = {},
            onRuntimeRefreshRequired = { _, _ -> },
            onConnectionChanged = { _, _, _, _ -> },
        )
        withTimeout(2_000) { firstRecovered.await() }
        transport.closeCurrent()
        withTimeout(2_000) { secondRecovered.await() }
        job.cancelAndJoin()

        assertTrue(transport.sessionTicketCount.get() >= 2)
        assertEquals(listOf("ticket-1", "ticket-2"), transport.openedTickets.take(2))
        assertEquals(listOf("seq:7", "seq:9", "seq:9"), transport.recoveryCursors.take(3))
    }

    @Test
    fun snapshotRequiredTriggersOneExplicitRefetchAndStopsRecoveryPaging() = runBlocking {
        val requested = CompletableDeferred<String>()
        val transport = FakeRealtimeTransport(
            recovery = RemoteEventRecoveryResponse(emptyList(), "seq:20", true, "now"),
        )
        val controller = SessionRealtimeController(
            transport = transport,
            sessionStore = auth(),
            clientId = "android-install",
            retryDelay = { 0L },
        )

        val job = controller.start(
            scope = this,
            sessionId = "session",
            cursor = { "seq:7" },
            onEvents = {},
            onCursorAdvanced = {},
            onSnapshotRequired = { requested.complete(it) },
            onRuntimeRefreshRequired = { _, _ -> },
            onConnectionChanged = { _, _, _, _ -> },
        )
        assertEquals("events.snapshotRequired", withTimeout(2_000) { requested.await() })
        job.cancelAndJoin()

        assertEquals(1, transport.recoveryCursors.size)
    }

    @Test
    fun retryBackoffIsBoundedAndJitterNeverExceedsThirtySeconds() {
        assertEquals(1_000L, reconnectDelayMillis(0, randomUnit = 0.0))
        assertTrue(reconnectDelayMillis(3, randomUnit = 1.0) in 8_000L..10_000L)
        assertEquals(30_000L, reconnectDelayMillis(30, randomUnit = 1.0))
    }

    private fun auth(): AuthSessionReader = object : AuthSessionReader {
        override fun readServerUrl(): String = "https://server.example"
        override fun readAccessToken(): String = "access"
    }

    private class FakeRealtimeTransport(
        private val recovery: RemoteEventRecoveryResponse,
        private val onRecovery: () -> Unit = {},
    ) : RealtimeTransport {
        val sessionTicketCount = AtomicInteger()
        val openedTickets = mutableListOf<String>()
        val recoveryCursors = mutableListOf<String>()
        private lateinit var activeListener: WebSocketListener
        private lateinit var activeSocket: FakeWebSocket

        fun closeCurrent() {
            activeListener.onClosed(activeSocket, 1000, "test reconnect")
        }

        override fun createDashboardTicket(
            serverUrl: String,
            authorizationToken: String,
            clientId: String,
        ): RemoteWsTicket = ticket("dashboard")

        override fun createSessionTicket(
            serverUrl: String,
            authorizationToken: String,
            clientId: String,
            sessionId: String,
        ): RemoteWsTicket = ticket("ticket-${sessionTicketCount.incrementAndGet()}")

        override fun dashboardWebSocketUrl(serverUrl: String, ticket: String): String = "wss://server/$ticket"

        override fun sessionWebSocketUrl(serverUrl: String, sessionId: String, ticket: String): String =
            "wss://server/$ticket"

        override fun recoverSessionEvents(
            serverUrl: String,
            authorizationToken: String,
            sessionId: String,
            after: String,
        ): RemoteEventRecoveryResponse {
            recoveryCursors += after
            onRecovery()
            return recovery
        }

        override fun parseDashboardMessage(text: String): RemoteDashboardSnapshot? = null

        override fun parseSessionMessage(text: String): RemoteSessionEventEnvelope? {
            if (text != "subscribed") return null
            return RemoteSessionEventEnvelope(
                protocolVersion = "1.0",
                eventId = "subscribed-${sessionTicketCount.get()}",
                sequence = 7,
                cursor = "seq:7",
                type = "session.subscribed",
                sessionId = "session",
                emittedAt = "now",
                payload = RemoteSessionEventPayload(eventCursor = "seq:7"),
            )
        }

        override fun openWebSocket(url: String, listener: WebSocketListener): WebSocket {
            val ticket = url.substringAfterLast('/')
            openedTickets += ticket
            val socket = FakeWebSocket(url)
            activeSocket = socket
            activeListener = listener
            listener.onOpen(socket, okhttp3.Response.Builder()
                .request(socket.request())
                .protocol(okhttp3.Protocol.HTTP_1_1)
                .code(101)
                .message("Switching Protocols")
                .build())
            listener.onMessage(socket, "subscribed")
            return socket
        }

        private fun ticket(value: String) = RemoteWsTicket(value, "later", "now")
    }

    private class ReplacedStartTransport(
        private val firstTicketStarted: java.util.concurrent.CountDownLatch,
        private val releaseFirstTicket: java.util.concurrent.CountDownLatch,
        private val secondOpened: CompletableDeferred<Unit>,
    ) : RealtimeTransport {
        private val ticketCount = AtomicInteger()
        val openedSessions = mutableListOf<String>()

        override fun createDashboardTicket(
            serverUrl: String,
            authorizationToken: String,
            clientId: String,
        ): RemoteWsTicket = RemoteWsTicket("dashboard", "later", "now")

        override fun createSessionTicket(
            serverUrl: String,
            authorizationToken: String,
            clientId: String,
            sessionId: String,
        ): RemoteWsTicket {
            if (ticketCount.incrementAndGet() == 1) {
                firstTicketStarted.countDown()
                releaseFirstTicket.await(2, java.util.concurrent.TimeUnit.SECONDS)
            }
            return RemoteWsTicket(sessionId, "later", "now")
        }

        override fun dashboardWebSocketUrl(serverUrl: String, ticket: String): String = "wss://server/$ticket"

        override fun sessionWebSocketUrl(serverUrl: String, sessionId: String, ticket: String): String =
            "wss://server/$sessionId"

        override fun recoverSessionEvents(
            serverUrl: String,
            authorizationToken: String,
            sessionId: String,
            after: String,
        ): RemoteEventRecoveryResponse = RemoteEventRecoveryResponse(emptyList(), after, false, "now")

        override fun parseDashboardMessage(text: String): RemoteDashboardSnapshot? = null

        override fun parseSessionMessage(text: String): RemoteSessionEventEnvelope? = null

        override fun openWebSocket(url: String, listener: WebSocketListener): WebSocket {
            val sessionId = url.substringAfterLast('/')
            openedSessions += sessionId
            val socket = FakeWebSocket(url)
            listener.onOpen(
                socket,
                okhttp3.Response.Builder()
                    .request(socket.request())
                    .protocol(okhttp3.Protocol.HTTP_1_1)
                    .code(101)
                    .message("Switching Protocols")
                    .build(),
            )
            if (sessionId == "new-session") secondOpened.complete(Unit)
            return socket
        }
    }

    private class BlockingRealtimeTransport(
        private val recoveryStarted: java.util.concurrent.CountDownLatch,
        private val releaseRecovery: java.util.concurrent.CountDownLatch,
    ) : RealtimeTransport {
        private lateinit var listener: WebSocketListener

        fun send(message: String) {
            listener.onMessage(socket, message)
        }

        override fun createDashboardTicket(
            serverUrl: String,
            authorizationToken: String,
            clientId: String,
        ): RemoteWsTicket = RemoteWsTicket("dashboard", "later", "now")

        override fun createSessionTicket(
            serverUrl: String,
            authorizationToken: String,
            clientId: String,
            sessionId: String,
        ): RemoteWsTicket = RemoteWsTicket("session-ticket", "later", "now")

        override fun dashboardWebSocketUrl(serverUrl: String, ticket: String): String = "wss://server/$ticket"

        override fun sessionWebSocketUrl(serverUrl: String, sessionId: String, ticket: String): String =
            "wss://server/$ticket"

        override fun recoverSessionEvents(
            serverUrl: String,
            authorizationToken: String,
            sessionId: String,
            after: String,
        ): RemoteEventRecoveryResponse {
            recoveryStarted.countDown()
            releaseRecovery.await(2, java.util.concurrent.TimeUnit.SECONDS)
            return RemoteEventRecoveryResponse(emptyList(), after, false, "now")
        }

        override fun parseDashboardMessage(text: String): RemoteDashboardSnapshot? = null

        override fun parseSessionMessage(text: String): RemoteSessionEventEnvelope? = when (text) {
            "subscribed" -> event("subscribed", "session.subscribed", 7)
            "timeline" -> event("timeline", "timeline.item_created", 8)
            else -> null
        }

        override fun openWebSocket(url: String, listener: WebSocketListener): WebSocket {
            this.listener = listener
            listener.onOpen(
                socket,
                okhttp3.Response.Builder()
                    .request(socket.request())
                    .protocol(okhttp3.Protocol.HTTP_1_1)
                    .code(101)
                    .message("Switching Protocols")
                    .build(),
            )
            listener.onMessage(socket, "subscribed")
            return socket
        }

        private fun event(id: String, type: String, sequence: Long) = RemoteSessionEventEnvelope(
            protocolVersion = "1.0",
            eventId = id,
            sequence = sequence,
            cursor = "seq:$sequence",
            type = type,
            sessionId = "session",
            emittedAt = "now",
            payload = RemoteSessionEventPayload(),
        )

        private val socket = FakeWebSocket("wss://server/session-ticket")
    }

    private class BurstRealtimeTransport(
        private val eventCount: Int,
    ) : RealtimeTransport {
        override fun createDashboardTicket(
            serverUrl: String,
            authorizationToken: String,
            clientId: String,
        ): RemoteWsTicket = RemoteWsTicket("dashboard", "later", "now")

        override fun createSessionTicket(
            serverUrl: String,
            authorizationToken: String,
            clientId: String,
            sessionId: String,
        ): RemoteWsTicket = RemoteWsTicket("session-ticket", "later", "now")

        override fun dashboardWebSocketUrl(serverUrl: String, ticket: String): String = "wss://server/$ticket"

        override fun sessionWebSocketUrl(serverUrl: String, sessionId: String, ticket: String): String =
            "wss://server/$ticket"

        override fun recoverSessionEvents(
            serverUrl: String,
            authorizationToken: String,
            sessionId: String,
            after: String,
        ): RemoteEventRecoveryResponse = RemoteEventRecoveryResponse(emptyList(), after, false, "now")

        override fun parseDashboardMessage(text: String): RemoteDashboardSnapshot? = null

        override fun parseSessionMessage(text: String): RemoteSessionEventEnvelope? {
            val sequence = text.substringAfter("timeline-", "").toLongOrNull() ?: return null
            return RemoteSessionEventEnvelope(
                protocolVersion = "1.0",
                eventId = "event-$sequence",
                sequence = sequence,
                cursor = "seq:$sequence",
                type = "timeline.item_created",
                sessionId = "session",
                emittedAt = "now",
                payload = RemoteSessionEventPayload(),
            )
        }

        override fun openWebSocket(url: String, listener: WebSocketListener): WebSocket {
            val socket = FakeWebSocket(url)
            listener.onOpen(
                socket,
                okhttp3.Response.Builder()
                    .request(socket.request())
                    .protocol(okhttp3.Protocol.HTTP_1_1)
                    .code(101)
                    .message("Switching Protocols")
                    .build(),
            )
            (1..eventCount).forEach { listener.onMessage(socket, "timeline-$it") }
            return socket
        }
    }

    private class FakeWebSocket(url: String) : WebSocket {
        private val request = Request.Builder().url(url).build()
        override fun request(): Request = request
        override fun queueSize(): Long = 0L
        override fun send(text: String): Boolean = true
        override fun send(bytes: ByteString): Boolean = true
        override fun close(code: Int, reason: String?): Boolean = true
        override fun cancel() = Unit
    }
}
