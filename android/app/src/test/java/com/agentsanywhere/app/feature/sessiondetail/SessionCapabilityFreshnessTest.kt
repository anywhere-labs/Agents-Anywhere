package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.RealtimeTransport
import com.agentsanywhere.app.api.RemoteDashboardSnapshot
import com.agentsanywhere.app.api.RemoteEventRecoveryResponse
import com.agentsanywhere.app.api.RemoteRuntimeCapability
import com.agentsanywhere.app.api.RemoteRuntimeCapabilitySet
import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.api.RemoteSessionEventPayload
import com.agentsanywhere.app.api.RemoteWsTicket
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.feature.realtime.SessionRealtimeController
import com.agentsanywhere.app.feature.sessions.toAgentSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
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
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionCapabilityFreshnessTest {
    @Test
    fun returningToCachedSessionAcceptsRepeatedOnlinePresenceAtTheSameSequence() {
        val online = metaEvent(sequence = 5, takeover = true).copy(eventId = "presence-online")
        val offline = metaEvent(sequence = 5, takeover = true, connectorStatus = "offline")
            .copy(eventId = "presence-offline")
        val beforeLeaving = reduceRealtimeEvents(openedSession(takeover = true), listOf(online, offline), emptyList())
        assertFalse(beforeLeaving.session!!.connectorOnline)

        val cache = SessionStateCache()
        cache.close(cache.open("account", SESSION_ID, "token"), beforeLeaving)
        val cached = cache.open("account", SESSION_ID, "token").cached!!
        val recovered = reduceRealtimeEvents(cached, listOf(online), emptyList())

        assertTrue(recovered.session!!.connectorOnline)
        assertEquals("seq:5", recovered.realtime.cursor)
    }

    @Test
    fun returningToCachedSessionAcceptsRepeatedCapabilitiesAtTheSameSequence() {
        val available = capabilityEvent(sequence = 5, revision = 5, allowed = true)
            .copy(eventId = "capabilities-available")
        val unavailable = capabilityEvent(sequence = 5, revision = 5, allowed = true, available = false)
            .copy(eventId = "capabilities-unavailable")
        val beforeLeaving = reduceRealtimeEvents(openedSession(takeover = true), listOf(available, unavailable), emptyList())
        assertFalse(beforeLeaving.composerEnabled())

        val cache = SessionStateCache()
        cache.close(cache.open("account", SESSION_ID, "token"), beforeLeaving)
        val cached = cache.open("account", SESSION_ID, "token").cached!!
        val recovered = reduceRealtimeEvents(cached, listOf(available), emptyList())

        assertTrue(recovered.composerEnabled())
    }

    @Test
    fun returningToCachedSessionStillDeduplicatesDurableEvents() {
        val snapshot = event("timeline.snapshot", sequence = 5, RemoteSessionEventPayload())
        val beforeLeaving = reduceRealtimeEvents(openedSession(), listOf(snapshot), emptyList())
        val cache = SessionStateCache()
        cache.close(cache.open("account", SESSION_ID, "token"), beforeLeaving)
        val cached = cache.open("account", SESSION_ID, "token").cached!!

        assertSame(cached, reduceRealtimeEvent(cached, snapshot, emptyList()))
        assertSame(cached, reduceRealtimeEvents(cached, listOf(snapshot), emptyList()))
    }

    @Test
    fun takeoverPushAfterStoredCapabilitiesEnablesComposer() {
        // The connector's report of its reconnect arrives first.
        val stored = reduceRealtimeEvents(
            openedSession(available = false),
            listOf(capabilityEvent(sequence = 6, revision = STORED_REVISION, allowed = false)),
            devices = emptyList(),
        )
        assertEquals(STORED_REVISION, stored.capabilities.revision)

        val state = reduceRealtimeEvents(stored, takeoverPush(sequence = 7), devices = emptyList())

        assertTrue(state.composerEnabled())
    }

    @Test
    fun recoveredCapabilitiesDoNotReplaceALaterPushWhileTheConnectorIsOnline() {
        // The recovery was computed before takeover but answers after its push.
        val pushed = reduceRealtimeEvents(openedSession(), takeoverPush(sequence = 6), devices = emptyList())

        val state = recover(
            pushed,
            listOf(
                metaEvent(sequence = 5, takeover = false),
                capabilityEvent(sequence = 5, revision = STORED_REVISION, allowed = false),
            ),
        )

        assertTrue(state.composerEnabled())
    }

    @Test
    fun recoveredCapabilitiesApplyWhileTheConnectorIsOffline() {
        // The live read cannot succeed offline, so recovery is the only source.
        val state = recover(
            openedSession(takeover = true),
            listOf(
                metaEvent(sequence = 6, takeover = true, connectorStatus = "offline"),
                capabilityEvent(sequence = 6, revision = STORED_REVISION, allowed = true, available = false),
            ),
        )

        assertEquals(STORED_REVISION, state.capabilities.revision)
        assertFalse(state.composerEnabled())
    }

    @Test
    fun failedBackgroundCapabilityReadKeepsTheComposerEnabled() = withRuntimeServer { controller ->
        val current = openedSession(takeover = true)

        val refreshed = runBlocking { controller.refreshRuntimeLiveDomains(SESSION_ID, current) }
        val state = controller.mergeRuntimeLiveState(current, current, refreshed)

        assertNull(state.capabilities.errorMessage)
        assertTrue(state.composerEnabled())
    }

    @Test
    fun failedFirstCapabilityReadIsReported() = withRuntimeServer { controller ->
        val current = openedSession(takeover = true).copy(capabilities = EffectiveCapabilities())

        val refreshed = runBlocking { controller.refreshRuntimeLiveDomains(SESSION_ID, current) }

        assertEquals("connector session capabilities request timed out", refreshed.capabilities.errorMessage)
        assertFalse(refreshed.composerEnabled())
    }

    @Test
    fun snapshotKeepsCapabilitiesPushedWhileItWasInFlight() {
        val requestState = openedSession().beginSnapshotLoad(clearErrors = false)
        val live = reduceRealtimeEvents(requestState, takeoverPush(sequence = 6), devices = emptyList())
        // Read before takeover, while the connector reported only stored facts.
        val snapshot = openedSession(capabilityRevision = STORED_REVISION)

        val state = reduceSnapshotWithLiveState(snapshot, live, requestState).completeSnapshotLoad()

        assertTrue(state.composerEnabled())
    }

    @Test
    fun snapshotReplacesCapabilitiesUnchangedSinceItsRequest() {
        val requestState = openedSession(takeover = true, available = false, capabilityRevision = STORED_REVISION)
            .beginSnapshotLoad(clearErrors = false)
        val snapshot = openedSession(takeover = true)

        val state = reduceSnapshotWithLiveState(snapshot, requestState, requestState).completeSnapshotLoad()

        assertTrue(state.composerEnabled())
    }

    @Test
    fun requiredSnapshotDiscardsStaleHistoryAndCanResetAFutureCursor() {
        val old = openedSession().copy(
            timeline = SessionTimelineState(messages = listOf(
                TimelineMessage("stale", author = MessageAuthor.Agent, text = "stale")), nextSeq = 100),
            realtime = SessionRealtimeState(cursor = "seq:100", processedEventIds = setOf("old-event")),
        )
        val snapshot = openedSession().copy(
            timeline = SessionTimelineState(messages = listOf(
                TimelineMessage("fresh", author = MessageAuthor.Agent, text = "fresh")), nextSeq = 3),
            realtime = SessionRealtimeState(cursor = "seq:3"),
        )
        val restored = reduceSnapshotWithLiveState(snapshot, old, old, replaceHistory = true)
        assertEquals(listOf("fresh"), restored.messages.map { it.id })
        assertEquals("seq:3", restored.realtime.cursor)
        assertTrue(restored.realtime.processedEventIds.isEmpty())
    }

    @Test
    fun requiredSnapshotKeepsOnlyTimelineObservationsReceivedDuringItsRead() {
        val old = openedSession().copy(timeline = SessionTimelineState(messages = listOf(
            TimelineMessage("stale", author = MessageAuthor.Agent, text = "stale")), nextSeq = 5))
        val incoming = TimelineMessage("during-read", author = MessageAuthor.Agent, text = "new", updatedSeq = 7)
        val live = old.copy(timeline = old.timeline.copy(
            messages = old.messages + incoming,
            orderingItems = listOf(TimelineOrderingItem(incoming.id, 7, 1, 7)), nextSeq = 7),
            realtime = SessionRealtimeState(cursor = "seq:7"))
        val snapshot = openedSession().copy(timeline = SessionTimelineState(messages = listOf(
            TimelineMessage("fresh", author = MessageAuthor.Agent, text = "fresh")), nextSeq = 6),
            realtime = SessionRealtimeState(cursor = "seq:6"))
        val restored = reduceSnapshotWithLiveState(snapshot, live, old, replaceHistory = true)
        assertEquals(setOf("fresh", "during-read"), restored.messages.map { it.id }.toSet())
        assertEquals("seq:7", restored.realtime.cursor)
    }

    @Test
    fun revokedAccessDuringRecoveryInvalidatesTheVisitAndStopsItsSubscription() = runBlocking {
        val cache = SessionStateCache()
        val visit = cache.open("account", SESSION_ID, "token")
        val revoked = CompletableDeferred<Throwable>()
        val job = SessionRealtimeController(
            transport = RecoveryTransport(emptyList(), com.agentsanywhere.app.api.ApiException("Revoked", 403)),
            sessionStore = auth("http://localhost"), clientId = "client",
        ).start(
            scope = this, sessionId = SESSION_ID, cursor = { "seq:5" },
            onEvents = {}, onCursorAdvanced = {}, onSnapshotRequired = {},
            onRuntimeRefreshRequired = { _, _ -> }, onConnectionChanged = { _, _, _, _ -> },
            onAccessRevoked = { cache.invalidate(visit); revoked.complete(it) },
        )
        withTimeout(5_000) { revoked.await(); job.join() }
        assertFalse(cache.isCurrent(visit))
        cache.close(visit, openedSession())
        assertNull(cache.open("account", SESSION_ID, "token").cached)
    }

    private fun recover(
        initial: SessionDetailState,
        recovered: List<RemoteSessionEventEnvelope>,
    ): SessionDetailState = runBlocking {
        val lock = Any()
        var state = initial
        val recoveryApplied = CompletableDeferred<Unit>()
        val liveReadRequested = CompletableDeferred<Unit>()
        val job = SessionRealtimeController(
            transport = RecoveryTransport(recovered),
            sessionStore = auth("http://localhost"),
            clientId = "client",
            retryDelay = { 60_000L },
        ).start(
            scope = this,
            sessionId = SESSION_ID,
            cursor = { "seq:5" },
            onEvents = { events -> synchronized(lock) { state = reduceRealtimeEvents(state, events, emptyList()) } },
            onCursorAdvanced = { recoveryApplied.complete(Unit) },
            onSnapshotRequired = {},
            onRuntimeRefreshRequired = { _, _ -> liveReadRequested.complete(Unit) },
            onConnectionChanged = { _, _, _, _ -> },
        )
        withTimeout(5_000) {
            recoveryApplied.await()
            liveReadRequested.await()
        }
        job.cancelAndJoin()
        synchronized(lock) { state }
    }

    private fun withRuntimeServer(block: (SessionDetailController) -> Unit) {
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl?.encodedPath.orEmpty()
                return when {
                    path.endsWith("/runtime/state") -> json(
                        200,
                        """{"state":{"sessionId":"$SESSION_ID","runtime":"codex","status":"idle","updatedSeq":5}}""",
                    )
                    path.endsWith("/runtime/notices") -> json(200, """{"notices":[]}""")
                    path.endsWith("/planning") -> json(200, """{"sessionId":"$SESSION_ID"}""")
                    path.endsWith("/runtime/capabilities") -> json(
                        504,
                        """{"detail":{"code":"runtime_capabilities_timeout","message":"connector session capabilities request timed out"}}""",
                    )
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        try {
            val origin = "http://127.0.0.1:${server.port}"
            block(SessionDetailController(SessionsApi(ApiClient()), auth(origin)))
        } finally {
            server.shutdown()
        }
    }

    private class RecoveryTransport(
        private val recovered: List<RemoteSessionEventEnvelope>,
        private val failure: Exception? = null,
    ) : RealtimeTransport {
        override fun createDashboardTicket(serverUrl: String, authorizationToken: String, clientId: String): RemoteWsTicket =
            throw UnsupportedOperationException()

        override fun createSessionTicket(
            serverUrl: String,
            authorizationToken: String,
            clientId: String,
            sessionId: String,
        ) = RemoteWsTicket(ticket = "ticket", expiresAt = "", serverTime = "")

        override fun dashboardWebSocketUrl(serverUrl: String, ticket: String): String =
            throw UnsupportedOperationException()

        override fun sessionWebSocketUrl(serverUrl: String, sessionId: String, ticket: String) = "ws://localhost/$sessionId"

        override fun recoverSessionEvents(
            serverUrl: String,
            authorizationToken: String,
            sessionId: String,
            after: String,
        ): RemoteEventRecoveryResponse {
            failure?.let { throw it }
            return RemoteEventRecoveryResponse(
                events = recovered,
                nextCursor = "seq:${recovered.maxOf { it.sequence }}",
                snapshotRequired = false,
                serverTime = null,
            )
        }

        override fun parseDashboardMessage(text: String): RemoteDashboardSnapshot? = null

        override fun parseSessionMessage(text: String) = event(text, sequence = 5, RemoteSessionEventPayload())

        // Opens and subscribes at once, which starts recovery and a live read.
        override fun openWebSocket(url: String, listener: WebSocketListener): WebSocket {
            listener.onOpen(IdleSocket, handshake)
            listener.onMessage(IdleSocket, "session.subscribed")
            return IdleSocket
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
        const val CONNECTOR_ID = "connector-1"

        // Stored connector facts carry a microsecond clock; live reads the session sequence.
        const val STORED_REVISION = 1_730_000_000_000_000L

        val handshake: Response = Response.Builder()
            .request(IdleSocket.request())
            .protocol(Protocol.HTTP_1_1)
            .code(101)
            .message("Switching Protocols")
            .build()

        fun auth(serverUrl: String) = object : AuthSessionReader {
            override fun readServerUrl() = serverUrl
            override fun readAccessToken() = "token"
        }

        fun json(code: Int, body: String) = MockResponse()
            .setResponseCode(code)
            .setHeader("Content-Type", "application/json")
            .setBody(body)

        fun remoteSession(takeover: Boolean, updatedSeq: Int, connectorStatus: String = "online") =
            SessionsApi().parseSession(
                JSONObject()
                    .put("id", SESSION_ID)
                    .put("connectorId", CONNECTOR_ID)
                    .put("connectorStatus", connectorStatus)
                    .put("runtime", "codex")
                    .put("takeover", takeover)
                    .put("updatedSeq", updatedSeq),
            )

        fun capabilitySet(revision: Long, allowed: Boolean, available: Boolean = true) = RemoteRuntimeCapabilitySet(
            revision = revision,
            capabilities = listOf(
                RemoteRuntimeCapability(
                    capabilityId = SESSION_SEND_MESSAGE_CAPABILITY,
                    version = "1",
                    scope = "session",
                    runtime = "codex",
                    sessionId = SESSION_ID,
                    supported = true,
                    available = available,
                    allowed = allowed,
                    unavailableReason = if (!available) "connector_offline" else if (!allowed) "takeover_required" else null,
                    parameters = emptyMap(),
                    runtimeId = "codex",
                ),
            ),
        )

        fun openedSession(
            takeover: Boolean = false,
            available: Boolean = true,
            capabilityRevision: Long = 5,
        ) = SessionDetailState(
            meta = SessionMeta(session = remoteSession(takeover, updatedSeq = 5).toAgentSession(emptyMap())),
            runtime = SessionRuntimeState(
                sessionId = SESSION_ID,
                runtime = "codex",
                status = SessionRuntimeStatus.Idle,
                updatedSeq = 5,
                isLoaded = true,
            ),
            capabilities = capabilitySet(capabilityRevision, allowed = takeover, available = available)
                .toEffectiveCapabilities(CONNECTOR_ID, serverTime = null),
            initialized = true,
        )

        fun event(type: String, sequence: Long, payload: RemoteSessionEventPayload) = RemoteSessionEventEnvelope(
            protocolVersion = "1.1",
            eventId = "$type:$sequence",
            sequence = sequence,
            cursor = "seq:$sequence",
            type = type,
            sessionId = SESSION_ID,
            emittedAt = null,
            payload = payload,
        )

        fun metaEvent(sequence: Long, takeover: Boolean, connectorStatus: String = "online") = event(
            "session.meta.updated",
            sequence,
            RemoteSessionEventPayload(session = remoteSession(takeover, sequence.toInt(), connectorStatus)),
        )

        fun capabilityEvent(sequence: Long, revision: Long, allowed: Boolean, available: Boolean = true) = event(
            "runtime.capability.updated",
            sequence,
            RemoteSessionEventPayload(capabilitySet = capabilitySet(revision, allowed, available)),
        )

        // Enabling takeover pushes session meta with live capabilities.
        fun takeoverPush(sequence: Long) = listOf(
            metaEvent(sequence, takeover = true),
            capabilityEvent(sequence, revision = sequence, allowed = true),
        )

        // Mirrors the composer gate in SessionDetailScreen.
        fun SessionDetailState.composerEnabled() = sessionComposerEnabled(
            takeoverEnabled = session?.takeover == true,
            capabilityFactsFresh = capabilities.isLoaded && capabilities.errorMessage == null,
            canSendMessage = capabilities.isUsable(
                SESSION_SEND_MESSAGE_CAPABILITY,
                session?.runtimeId,
                session?.runtimeType,
            ),
            canUseCommands = false,
        )
    }
}
