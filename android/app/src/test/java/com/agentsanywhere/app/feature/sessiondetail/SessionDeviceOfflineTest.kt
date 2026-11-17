package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.RealtimeTransport
import com.agentsanywhere.app.api.RemoteDashboardSnapshot
import com.agentsanywhere.app.api.RemoteEventRecoveryResponse
import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.api.RemoteWsTicket
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.feature.realtime.SessionRealtimeController
import com.agentsanywhere.app.feature.sessions.toAgentSession
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference

/** Protocol 1.2 device-offline semantics (same rules as Web #667). */
class SessionDeviceOfflineTest {
    @Test
    fun parsesProtocol12FieldsAndKeepsOlderServersCompatible() {
        val api = SessionsApi()
        val session = api.parseSession(sessionJson().put("planState", "awaiting_review").put("goalState", "active"))
        assertEquals("awaiting_review", session.planState)
        assertEquals("active", session.goalState)
        assertEquals("awaiting_review", session.toAgentSession(emptyMap()).planState)
        // Older Servers send neither field.
        assertEquals("none", api.parseSession(sessionJson()).planState)
        assertEquals("none", api.parseSession(sessionJson()).goalState)

        val event = api.parseSessionEvent(JSONObject(catchupJson("e1", 9)))
        assertEquals("1.2", event.protocolVersion)
    }

    @Test
    fun offlineSnapshotKeepsLoadedHistoryCursorAndPaging() = withServer(snapshotOffline = true) { controller ->
        val loaded = loadedState(cursor = "seq:10", hasMore = true)
        val request = loaded.beginSnapshotLoad(clearErrors = false)
        val snapshot = runBlocking { controller.loadInitialSnapshot(SESSION_ID, emptyList(), request) }.getOrThrow()
        assertTrue(snapshot.historyUnavailable)

        val merged = controller.mergeSnapshotWithLiveState(SESSION_ID, snapshot, request, request, replaceHistory = true)
            .completeSnapshotLoad()

        assertEquals(listOf("u1", "a1"), merged.messages.map { it.id })
        assertEquals(setOf("u1", "a1"), merged.timeline.remoteItems.keys)
        // The Server's head (seq:99) is not this client's position.
        assertEquals("seq:10", merged.realtime.cursor)
        assertTrue(merged.hasMore)
        assertTrue(merged.historyUnavailable)
        assertFalse(merged.timeline.historyBaseMissing)
        // Metadata from the snapshot still applies.
        assertEquals("Offline title", merged.session!!.title)

        // Retained content stays cacheable.
        val cache = SessionStateCache()
        cache.close(cache.open("account", SESSION_ID, "token"), merged)
        assertEquals(listOf("u1", "a1"), cache.open("account", SESSION_ID, "token").cached!!.messages.map { it.id })
    }

    @Test
    fun offlineFirstSnapshotIsNotABaseAndIsNeverCached() = withServer(snapshotOffline = true) { controller ->
        val initial = SessionDetailState(meta = SessionMeta(isLoading = true))
        val request = initial.beginSnapshotLoad(clearErrors = true)
        val snapshot = runBlocking { controller.loadInitialSnapshot(SESSION_ID, emptyList(), request) }.getOrThrow()
        val merged = controller.mergeSnapshotWithLiveState(SESSION_ID, snapshot, request, request).completeSnapshotLoad()

        assertTrue(merged.initialized)
        assertTrue(merged.messages.isEmpty())
        assertEquals("seq:0", merged.realtime.cursor)
        assertEquals(0, merged.nextSeq)
        assertFalse(merged.hasMore)
        assertTrue(merged.historyUnavailable)
        assertTrue(merged.timeline.historyBaseMissing)

        val cache = SessionStateCache()
        cache.close(cache.open("account", SESSION_ID, "token"), merged)
        assertNull(cache.open("account", SESSION_ID, "token").cached)
    }

    @Test
    fun liveSnapshotAfterAnOfflineBaseReplacesItAuthoritatively() = withServer(snapshotOffline = false) { controller ->
        val offline = loadedState(cursor = "seq:0").let {
            it.copy(timeline = it.timeline.copy(historyUnavailable = true, historyBaseMissing = true,
                messages = emptyList(), orderingItems = emptyList(), remoteItems = emptyMap()))
        }
        val request = offline.beginSnapshotLoad(clearErrors = false)
        val snapshot = runBlocking { controller.loadInitialSnapshot(SESSION_ID, emptyList(), request) }.getOrThrow()
        val merged = controller.mergeSnapshotWithLiveState(SESSION_ID, snapshot, request, request, replaceHistory = true)
        assertFalse(merged.historyUnavailable)
        assertFalse(merged.timeline.historyBaseMissing)
        assertEquals("seq:99", merged.realtime.cursor)
        assertEquals(listOf("u1", "a1"), merged.messages.map { it.id })
    }

    @Test
    fun offlineHistoryPageKeepsContentAndIsNotTheStartOfHistory() = withServer(snapshotOffline = true) { controller ->
        val current = loadedState(cursor = "seq:10", hasMore = true).let {
            it.copy(timeline = it.timeline.copy(loadingOlder = true))
        }
        val older = runBlocking { controller.loadOlder(SESSION_ID, beforeOrderSeq = 1) }.getOrThrow()
        assertTrue(older.historyUnavailable)
        val next = controller.applyOlder(SESSION_ID, current, older, current.timeline.historyGeneration)
        assertEquals(current.messages, next.messages)
        assertTrue(next.hasMore)
        assertFalse(next.timeline.loadingOlder)
        assertTrue(next.historyUnavailable)
    }

    @Test
    fun protocol12EventsApplyAndCatchupNeverMovesTheCursor() {
        val state = loadedState(cursor = "seq:10")
        val item = event(timelineJson("e11", 11, item("a2", 3, "assistant", "later")))
        val applied = reduceRealtimeEvents(state, listOf(item), emptyList())
        assertEquals("seq:11", applied.realtime.cursor)
        assertTrue(applied.messages.any { it.id == "a2" })
        assertTrue("a2" in applied.timeline.remoteItems)

        val catchup = event(catchupJson("c1", 40))
        assertEquals(applied, reduceRealtimeEvents(applied, listOf(catchup), emptyList()))
        assertEquals(applied, reduceRealtimeEvent(applied, catchup, emptyList()))
    }

    @Test
    fun liveEventsWhileOfflineCannotSkipTheGap() {
        val offline = loadedState(cursor = "seq:10").markHistoryUnavailable()
        val next = reduceRealtimeEvents(offline, listOf(
            event(timelineJson("e20", 20, item("a3", 9, "assistant", "after a gap"))),
            event(metaJson("m21", 21, "offline")),
        ), emptyList())
        assertEquals("seq:10", next.realtime.cursor)
        assertEquals(offline.nextSeq, next.nextSeq)
        assertEquals(offline.timeline.eventCursor, next.timeline.eventCursor)
    }

    @Test
    fun catchupRequiredRecoversFromTheClientsOwnCursor() = runBlocking {
        val state = AtomicReference(loadedState(cursor = "seq:5"))
        val transport = ScriptedTransport { after ->
            if (after == "seq:5") recovery(after, events = listOf(timelineJson("e6", 6, item("a2", 3, "assistant", "six"))))
            else recovery(after)
        }
        val job = startRealtime(transport, state)
        try {
            awaitUntil { state.get().realtime.cursor == "seq:6" }
            transport.push(catchupJson("c1", 50))
            awaitUntil { transport.recoveries.size >= 2 }
            assertEquals(listOf("seq:5", "seq:6"), transport.recoveries.take(2))
            // The catch-up event's own position is never applied.
            assertEquals("seq:6", state.get().realtime.cursor)
        } finally {
            job.cancelAndJoin()
        }
    }

    @Test
    fun timelineItemWhileOfflineWaitsForTheGapAndAppliesInOrder() = runBlocking {
        val state = AtomicReference(loadedState(cursor = "seq:5"))
        val deviceOnline = AtomicReference(false)
        val delivered = CopyOnWriteArrayList<List<Long>>()
        val transport = ScriptedTransport { after ->
            if (!deviceOnline.get()) recovery(after, offline = true)
            else recovery(after, events = listOf(
                timelineJson("e6", 6, item("a2", 3, "assistant", "six")),
                timelineJson("e7", 7, item("a3", 4, "assistant", "seven")),
            ), next = "seq:7")
        }
        val job = startRealtime(transport, state, delivered)
        try {
            awaitUntil { state.get().historyUnavailable }
            assertEquals("seq:5", state.get().realtime.cursor)

            deviceOnline.set(true)
            transport.push(timelineJson("e8", 8, item("a4", 5, "assistant", "eight")))
            awaitUntil { state.get().messages.any { it.id == "a4" } }

            val current = state.get()
            assertFalse(current.historyUnavailable)
            assertEquals(listOf("u1", "a1", "a2", "a3", "a4"), current.messages.map { it.id })
            assertEquals("seq:8", current.realtime.cursor)
            // The live item was held back and applied after the gap, in sequence order.
            val timelineBatches = delivered.filter { batch -> batch.any { it >= 6 } }
            assertEquals(listOf(6L, 7L, 8L), timelineBatches.single())
            assertEquals(listOf("seq:5", "seq:5"), transport.recoveries.take(2))
        } finally {
            job.cancelAndJoin()
        }
    }

    @Test
    fun deviceComingOnlineRecoversWhatItCouldNotServe() = runBlocking {
        val state = AtomicReference(loadedState(cursor = "seq:5"))
        val deviceOnline = AtomicReference(false)
        val transport = ScriptedTransport { after ->
            if (!deviceOnline.get()) recovery(after, offline = true)
            else recovery(after, events = listOf(timelineJson("e6", 6, item("a2", 3, "assistant", "six"))))
        }
        val job = startRealtime(transport, state)
        try {
            awaitUntil { state.get().historyUnavailable }
            deviceOnline.set(true)
            transport.push(metaJson("m7", 7, "online"))
            awaitUntil { state.get().messages.any { it.id == "a2" } }
            assertFalse(state.get().historyUnavailable)
            assertTrue(state.get().session!!.connectorOnline)
        } finally {
            job.cancelAndJoin()
        }
    }

    @Test
    fun deviceAnsweringAfterAnOfflineFirstReadRequestsASnapshot() = runBlocking {
        val base = loadedState(cursor = "seq:0").let {
            it.copy(timeline = it.timeline.copy(historyUnavailable = true, historyBaseMissing = true))
        }
        val state = AtomicReference(base)
        val snapshots = CopyOnWriteArrayList<String>()
        val transport = ScriptedTransport { after -> recovery(after) }
        val job = startRealtime(transport, state, onSnapshot = { reason ->
            snapshots += reason
            state.set(loadedState(cursor = "seq:20"))
        })
        try {
            awaitUntil { snapshots.isNotEmpty() }
            assertEquals("events.deviceOnline", snapshots.first())
            assertEquals("seq:20", state.get().realtime.cursor)
        } finally {
            job.cancelAndJoin()
        }
    }

    private fun kotlinx.coroutines.CoroutineScope.startRealtime(
        transport: ScriptedTransport,
        state: AtomicReference<SessionDetailState>,
        delivered: MutableList<List<Long>> = CopyOnWriteArrayList(),
        onSnapshot: (String) -> Unit = {},
    ) = SessionRealtimeController(transport, auth("http://localhost"), "client", retryDelay = { 60_000L }).start(
        scope = this,
        sessionId = SESSION_ID,
        cursor = { state.get().realtime.cursor },
        onEvents = { events ->
            delivered += events.filter { it.type.startsWith("timeline.") }.map { it.sequence }
            state.updateAndGet { reduceRealtimeEvents(it, events, emptyList()) }
        },
        onCursorAdvanced = { cursor ->
            state.updateAndGet { it.copy(realtime = it.realtime.copy(cursor = laterEventCursor(it.realtime.cursor, cursor))) }
        },
        onSnapshotRequired = onSnapshot,
        onRuntimeRefreshRequired = { _, _ -> },
        onConnectionChanged = { _, _, _, _ -> },
        historyUnavailable = { state.get().historyUnavailable },
        historyBaseMissing = { state.get().timeline.historyBaseMissing },
        onHistoryAvailability = { available ->
            state.updateAndGet { if (available) it.markHistoryLive() else it.markHistoryUnavailable() }
        },
    )

    private suspend fun awaitUntil(condition: () -> Boolean) = withTimeout(5_000) {
        while (!condition()) delay(10)
    }

    private fun withServer(snapshotOffline: Boolean, block: (SessionDetailController) -> Unit) {
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                val body = when {
                    path.endsWith("/snapshot") -> snapshotJson(snapshotOffline)
                    path.endsWith("/timeline") -> JSONObject().put("sessionId", SESSION_ID)
                        .put("items", JSONArray()).put("nextSeq", 0).put("hasMore", false)
                        .put("serverTime", "2026-01-01T00:00:00Z")
                        .put("historySource", "unavailable").put("deviceOffline", true).toString()
                    else -> return MockResponse().setResponseCode(404)
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            }
        }
        server.start()
        val controller = SessionDetailController(SessionsApi(ApiClient()), auth("http://127.0.0.1:${server.port}"))
        try { block(controller) } finally { controller.dispose(); server.shutdown() }
    }

    private class ScriptedTransport(
        private val respond: (after: String) -> RemoteEventRecoveryResponse,
    ) : RealtimeTransport {
        val recoveries = CopyOnWriteArrayList<String>()
        @Volatile private var listener: WebSocketListener? = null
        @Volatile private var socket: WebSocket? = null

        fun push(text: String) = listener!!.onMessage(socket!!, text)

        override fun createDashboardTicket(serverUrl: String, authorizationToken: String, clientId: String): RemoteWsTicket =
            throw UnsupportedOperationException()

        override fun createSessionTicket(serverUrl: String, authorizationToken: String, clientId: String, sessionId: String) =
            RemoteWsTicket(ticket = "ticket", expiresAt = "", serverTime = "")

        override fun dashboardWebSocketUrl(serverUrl: String, ticket: String): String = throw UnsupportedOperationException()

        override fun sessionWebSocketUrl(serverUrl: String, sessionId: String, ticket: String) = "ws://localhost/$sessionId"

        override fun recoverSessionEvents(serverUrl: String, authorizationToken: String, sessionId: String, after: String) =
            respond(after).also { recoveries += after }

        override fun parseDashboardMessage(text: String): RemoteDashboardSnapshot? = null

        override fun parseSessionMessage(text: String) = SessionsApi().parseSessionEvent(JSONObject(text))

        override fun openWebSocket(url: String, listener: WebSocketListener): WebSocket {
            val opened = object : WebSocket by IdleSocket {
                override fun cancel() = listener.onClosed(this, 1000, "cancelled")
            }
            this.listener = listener
            socket = opened
            listener.onOpen(opened, handshake)
            listener.onMessage(opened, envelope("sub", 0, "session.subscribed", JSONObject()))
            return opened
        }
    }

    private object IdleSocket : WebSocket {
        override fun request(): Request = Request.Builder().url("http://localhost/").build()
        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean = false
        override fun send(bytes: ByteString): Boolean = false
        override fun close(code: Int, reason: String?): Boolean = true
        override fun cancel() = Unit
    }

    private companion object {
        const val SESSION_ID = "session-1"

        val handshake: Response = Response.Builder()
            .request(IdleSocket.request())
            .protocol(Protocol.HTTP_1_1)
            .code(101)
            .message("Switching Protocols")
            .build()

        fun auth(serverUrl: String) = object : AuthSessionReader {
            override fun readServerUrl() = serverUrl
            override fun readAccessToken() = "token"
            override fun readUserId() = "user-1"
        }

        fun sessionJson(title: String = "Cached title", connectorStatus: String = "online"): JSONObject = JSONObject()
            .put("id", SESSION_ID).put("connectorId", "connector-1").put("runtime", "codex")
            .put("title", title).put("connectorStatus", connectorStatus).put("updatedSeq", 1)

        fun item(id: String, orderSeq: Int, role: String, text: String): JSONObject = JSONObject()
            .put("id", id).put("sessionId", SESSION_ID).put("type", "message").put("role", role)
            .put("status", "done").put("content", JSONObject().put("text", text))
            .put("orderSeq", orderSeq).put("revision", 1).put("updatedSeq", orderSeq)
            .put("createdAt", "2026-01-01T00:00:0${orderSeq % 10}Z")

        fun snapshotJson(offline: Boolean): String = JSONObject()
            .put("session", sessionJson(title = if (offline) "Offline title" else "Live title",
                connectorStatus = if (offline) "offline" else "online").put("updatedSeq", 2))
            .put("timeline", JSONObject()
                .put("items", if (offline) JSONArray() else JSONArray().put(item("u1", 1, "user", "hello"))
                    .put(item("a1", 2, "assistant", "hi")))
                .put("nextSeq", if (offline) 0 else 2).put("hasMore", false))
            .put("notices", JSONArray())
            .put("eventCursor", "seq:99")
            .put("serverTime", "2026-01-01T00:00:00Z")
            .put("historySource", if (offline) "unavailable" else "live")
            .put("deviceOffline", offline)
            .toString()

        fun loadedState(cursor: String, hasMore: Boolean = false): SessionDetailState {
            val api = SessionsApi()
            val remote = api.parseSession(sessionJson())
            val items = listOf(item("u1", 1, "user", "hello"), item("a1", 2, "assistant", "hi")).map(api::parseTimelineItem)
            val projection = mergeRemoteTimelineItems(emptyList(), emptyList(), items, replace = true)
            return SessionDetailState(
                initialized = true,
                meta = SessionMeta(session = remote.toAgentSession(emptyMap()), remote = remote),
                timeline = SessionTimelineState(
                    messages = projection.messages,
                    orderingItems = projection.orderingItems,
                    remoteItems = emptyMap<String, com.agentsanywhere.app.api.RemoteTimelineItem>().mergeRemoteItems(items),
                    nextSeq = 2,
                    hasMore = hasMore,
                    eventCursor = cursor,
                ),
                realtime = SessionRealtimeState(cursor = cursor),
            )
        }

        fun envelope(id: String, sequence: Long, type: String, payload: JSONObject): String = JSONObject()
            .put("protocolVersion", "1.2").put("eventId", id).put("sequence", sequence).put("cursor", "seq:$sequence")
            .put("type", type).put("sessionId", SESSION_ID).put("emittedAt", "2026-01-01T00:00:00Z")
            .put("payload", payload).toString()

        fun timelineJson(id: String, sequence: Long, item: JSONObject) =
            envelope(id, sequence, "timeline.item_created", JSONObject().put("item", item))

        fun catchupJson(id: String, sequence: Long) = envelope(id, sequence, "session.catchup_required",
            JSONObject().put("sessionId", SESSION_ID).put("reason", "device_reconnected"))

        fun metaJson(id: String, sequence: Long, connectorStatus: String) = envelope(id, sequence, "session.meta.updated",
            JSONObject().put("session", sessionJson(connectorStatus = connectorStatus).put("updatedSeq", sequence)))

        fun event(text: String): RemoteSessionEventEnvelope = SessionsApi().parseSessionEvent(JSONObject(text))

        fun recovery(
            after: String,
            events: List<String> = emptyList(),
            offline: Boolean = false,
            next: String? = null,
        ): RemoteEventRecoveryResponse {
            val parsed = events.map(::event)
            return RemoteEventRecoveryResponse(
                events = parsed,
                nextCursor = next ?: parsed.maxOfOrNull { it.sequence }?.let { "seq:$it" } ?: after,
                snapshotRequired = false,
                serverTime = null,
                deviceOffline = offline,
            )
        }
    }
}
