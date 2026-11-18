package com.agentsanywhere.app.feature.realtime

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.RealtimeTransport
import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.api.SESSION_CATCHUP_REQUIRED
import com.agentsanywhere.app.api.eventCursorSequence
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.WebSocket
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

class SessionRealtimeController(
    private val transport: RealtimeTransport,
    private val sessionStore: AuthSessionReader,
    private val clientId: String,
    private val retryDelay: (Int) -> Long = ::reconnectDelayMillis,
    /** E2EE: when it returns a stream, events come through the device's secure channel instead of the WS. */
    private val streamRouter: () -> SessionStreamRouter? = { null },
) {
    private val retryNow = Channel<Unit>(Channel.CONFLATED)
    private val pairingRevisionState = MutableStateFlow(0L)
    val pairingRevision = pairingRevisionState.asStateFlow()
    private val connectionLock = Any()
    private val activeSocket = AtomicReference<WebSocket?>()
    private val activeSecureStream = AtomicReference<(() -> Unit)?>()
    private val activeJob = AtomicReference<Job?>()
    private val generationSequence = AtomicLong(0)
    private val activeConnectionGeneration = AtomicLong(0)
    private val runtimeRefreshSequence = AtomicLong(0)
    private val activeRuntimeRefreshGeneration = AtomicLong(0)

    fun isCurrentConnection(generation: Long): Boolean = activeConnectionGeneration.get() == generation

    fun isCurrentRuntimeRefresh(connectionGeneration: Long, refreshGeneration: Long): Boolean =
        isCurrentConnection(connectionGeneration) && activeRuntimeRefreshGeneration.get() == refreshGeneration

    fun devicePaired() {
        pairingRevisionState.value += 1
        requestImmediateReconnect()
    }

    fun requestImmediateReconnect() {
        synchronized(connectionLock) {
            activeSocket.getAndSet(null)?.cancel()
            activeSecureStream.getAndSet(null)?.invoke()
        }
        retryNow.trySend(Unit)
    }

    fun start(
        scope: CoroutineScope,
        sessionId: String,
        cursor: suspend () -> String,
        onEvents: suspend (List<RemoteSessionEventEnvelope>) -> Unit,
        onCursorAdvanced: suspend (String) -> Unit,
        onSnapshotRequired: suspend (reason: String) -> Unit,
        onRuntimeRefreshRequired: suspend (connectionGeneration: Long, refreshGeneration: Long) -> Unit,
        onConnectionChanged: (connected: Boolean, recovering: Boolean, attempt: Int, error: String?) -> Unit,
        onAccessRevoked: suspend (Throwable) -> Unit = {},
        /** Protocol 1.2: the device is offline, so the shown history is only what was loaded before. */
        historyUnavailable: suspend () -> Boolean = { false },
        /** Only an offline snapshot was applied; once the device answers, a snapshot is read first. */
        historyBaseMissing: suspend () -> Boolean = { false },
        /** A recovery read learned whether the device can serve history. */
        onHistoryAvailability: suspend (available: Boolean) -> Unit = {},
    ): Job {
        val job = scope.launch(Dispatchers.IO) {
        val visitJob = coroutineContext.job
        var attempt = 0
        var hasConnected = false
        val snapshotMutex = Mutex()
        var pendingSnapshotReason: String? = null
        var lastSnapshotRequest: Pair<Long, String>? = null
        suspend fun requestSnapshot(reason: String?, connectionGeneration: Long): Boolean = snapshotMutex.withLock {
            if (!isCurrentConnection(connectionGeneration)) return@withLock false
            val requiredReason = pendingSnapshotReason ?: reason ?: return@withLock false
            val request = connectionGeneration to cursor()
            // An offline snapshot is no base: once the device answers it is read again at the same cursor.
            if (pendingSnapshotReason == null && lastSnapshotRequest == request && !historyBaseMissing()) return@withLock true
            // Retain the requirement across reconnects even if live events advance the cursor.
            pendingSnapshotReason = requiredReason
            onSnapshotRequired(requiredReason)
            lastSnapshotRequest = request
            pendingSnapshotReason = null
            true
        }
        while (isActive) {
            val serverUrl = sessionStore.readServerUrl()
            val accessToken = sessionStore.readAccessToken()
            if (serverUrl.isBlank() || accessToken.isBlank()) return@launch
            val connectionGeneration = generationSequence.incrementAndGet()
            synchronized(connectionLock) {
                activeConnectionGeneration.set(connectionGeneration)
            }

            val incoming = Channel<String>(Channel.UNLIMITED)
            var socket: WebSocket? = null
            val opened = AtomicBoolean(false)
            val openSignal = CompletableDeferred<Boolean>()
            var recoveryJob: Job? = null
            // Catch-up requests that arrive while a recovery is reading run once it ends.
            val catchupLock = Any()
            var recoveryRunning = false
            var recoveryGeneration = 0L
            var catchupPending = false
            // Live timeline items received while the history is unavailable wait for
            // the gap before them to be recovered, so the cursor cannot skip it.
            val deferredTimeline = mutableListOf<RemoteSessionEventEnvelope>()
            fun takeDeferredTimeline(): List<RemoteSessionEventEnvelope> =
                synchronized(deferredTimeline) { deferredTimeline.toList().also { deferredTimeline.clear() } }
            var snapshotJob: Job? = null
            var runtimeRefreshJob: Job? = null
            var latestRuntimeRefreshGeneration = 0L
            var secureStream: (() -> Unit)? = null
            try {
                val secure = streamRouter()?.openSecureStream(
                    serverUrl = serverUrl,
                    token = accessToken,
                    sessionId = sessionId,
                    afterCursor = cursor(),
                    onMessage = { message -> incoming.trySend(message) },
                    onClosed = { incoming.close() },
                )
                if (secure != null) {
                    val close: () -> Unit = {
                        secure()
                        incoming.close()
                    }
                    secureStream = close
                    val installed = synchronized(connectionLock) {
                        if (!isCurrentConnection(connectionGeneration)) {
                            false
                        } else {
                            activeSecureStream.getAndSet(close)?.invoke()
                            true
                        }
                    }
                    if (!installed) {
                        close()
                        return@launch
                    }
                    opened.set(true)
                    onConnectionChanged(true, hasConnected, 0, null)
                } else {
                    val ticket = transport.createSessionTicket(serverUrl, accessToken, clientId, sessionId)
                    if (!isCurrentConnection(connectionGeneration)) return@launch
                    socket = transport.openWebSocket(
                        transport.sessionWebSocketUrl(serverUrl, sessionId, ticket.ticket),
                        channelListener(incoming) {
                            opened.set(true)
                            openSignal.complete(true)
                            if (isCurrentConnection(connectionGeneration)) {
                                onConnectionChanged(true, hasConnected, 0, null)
                            }
                        }.also { listener -> listener.onTerminated = { openSignal.complete(false) } },
                    )
                    val installed = synchronized(connectionLock) {
                        if (!isCurrentConnection(connectionGeneration)) {
                            false
                        } else {
                            activeSocket.getAndSet(socket)?.cancel()
                            true
                        }
                    }
                    if (!installed) return@launch
                    if (!openSignal.await()) throw IllegalStateException("Session WebSocket handshake failed.")
                }

                fun refreshRuntime() {
                    runtimeRefreshJob?.cancel()
                    val refreshGeneration = runtimeRefreshSequence.incrementAndGet()
                    latestRuntimeRefreshGeneration = refreshGeneration
                    activeRuntimeRefreshGeneration.set(refreshGeneration)
                    runtimeRefreshJob = launch {
                        onRuntimeRefreshRequired(connectionGeneration, refreshGeneration)
                    }
                }

                suspend fun recoverWithFailureHandling(recovery: suspend () -> Unit) {
                    try {
                        recovery()
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        if (!isCurrentConnection(connectionGeneration)) return
                        if (error is ApiException && error.statusCode in listOf(403, 404)) {
                            onAccessRevoked(error)
                            visitJob.cancel()
                        } else {
                            onConnectionChanged(false, false, attempt, error.message)
                            socket?.cancel()
                        }
                    }
                }

                fun recoverFrom(recoveryCursor: String?) {
                    recoveryJob?.cancel()
                    val generation = synchronized(catchupLock) {
                        recoveryRunning = true
                        catchupPending = false
                        ++recoveryGeneration
                    }
                    recoveryJob = launch {
                        try {
                            recoverWithFailureHandling {
                                var from = recoveryCursor ?: cursor()
                                while (true) {
                                    if (!requestSnapshot(null, connectionGeneration)) {
                                        recover(
                                            serverUrl = serverUrl,
                                            accessToken = accessToken,
                                            sessionId = sessionId,
                                            initialCursor = from,
                                            onEvents = { events ->
                                                if (isCurrentConnection(connectionGeneration)) onEvents(events)
                                            },
                                            onCursorAdvanced = { recoveredCursor ->
                                                if (isCurrentConnection(connectionGeneration)) {
                                                    onCursorAdvanced(recoveredCursor)
                                                }
                                            },
                                            onSnapshotRequired = { reason ->
                                                requestSnapshot(reason, connectionGeneration)
                                            },
                                            takeDeferred = ::takeDeferredTimeline,
                                            historyBaseMissing = historyBaseMissing,
                                            onHistoryAvailability = { available ->
                                                if (isCurrentConnection(connectionGeneration)) onHistoryAvailability(available)
                                            },
                                        )
                                    }
                                    val again = synchronized(catchupLock) {
                                        if (recoveryGeneration != generation || !catchupPending) false
                                        else { catchupPending = false; true }
                                    }
                                    if (!again || !isCurrentConnection(connectionGeneration)) break
                                    from = cursor()
                                }
                                if (isCurrentConnection(connectionGeneration)) {
                                    onConnectionChanged(true, false, 0, null)
                                }
                            }
                        } finally {
                            synchronized(catchupLock) {
                                if (recoveryGeneration == generation) recoveryRunning = false
                            }
                        }
                    }
                }

                /** Recovers from this client's own cursor, after any recovery already reading. */
                fun requestCatchup() {
                    val start = synchronized(catchupLock) {
                        if (recoveryRunning) { catchupPending = true; false } else true
                    }
                    if (start) recoverFrom(null)
                }

                if (hasConnected) {
                    onConnectionChanged(true, true, 0, null)
                    recoverFrom(cursor())
                    refreshRuntime()
                } else if (secureStream != null) {
                    // The subscription replays events after the cursor itself; it may not send `session.subscribed`.
                    refreshRuntime()
                    hasConnected = true
                }
                for (firstMessage in incoming) {
                    // One fixed window from the first event; new messages never
                    // postpone the flush. The reducer merges complete item revisions.
                    val flushDeadline = System.nanoTime() + EVENT_BATCH_WINDOW_MILLIS * 1_000_000L
                    val batch = mutableListOf<RemoteSessionEventEnvelope>()
                    transport.parseSessionMessage(firstMessage)?.let(batch::add)
                    var timelineEvents = batch.count(RemoteSessionEventEnvelope::isTimelineUpsert)
                    while (timelineEvents < MAX_TIMELINE_EVENT_BATCH_SIZE && batch.size < MAX_WIRE_EVENT_BATCH_SIZE) {
                        val remaining = remainingBatchMillis(flushDeadline)
                        if (remaining == 0L) break
                        val message = withTimeoutOrNull(remaining) {
                            incoming.receiveCatching().getOrNull()
                        } ?: break
                        transport.parseSessionMessage(message)?.let { event ->
                            batch += event
                            if (event.isTimelineUpsert()) timelineEvents += 1
                        }
                    }
                    // A size-limited batch must not bypass the 30 Hz cadence.
                    delay(remainingBatchMillis(flushDeadline))
                    if (batch.isEmpty()) continue
                    if (!isCurrentConnection(connectionGeneration)) break
                    var catchup = false
                    batch.forEach { event ->
                        when (event.type) {
                        "session.subscribed" -> {
                            if (!hasConnected) {
                                onConnectionChanged(true, true, 0, null)
                                recoverFrom(cursor())
                                refreshRuntime()
                                hasConnected = true
                            }
                        }
                        "session.refetch_required" -> {
                            if (snapshotJob?.isActive != true) snapshotJob = launch {
                                recoverWithFailureHandling {
                                    requestSnapshot("session.refetch_required", connectionGeneration)
                                }
                            }
                        }
                        "runtime.refetch_required" -> {
                            refreshRuntime()
                        }
                        SESSION_CATCHUP_REQUIRED -> if (hasConnected) catchup = true
                        else -> Unit
                        }
                    }
                    var deliver: List<RemoteSessionEventEnvelope> = batch
                    if (hasConnected && historyUnavailable()) {
                        val (timeline, other) = batch.partition(RemoteSessionEventEnvelope::isTimelineEvent)
                        if (timeline.isNotEmpty()) {
                            synchronized(deferredTimeline) { deferredTimeline += timeline }
                            catchup = true
                        }
                        // The device came back: read what it could not serve while offline.
                        if (other.any { it.type == "session.meta.updated" && it.payload.session?.connectorStatus == "online" }) {
                            catchup = true
                        }
                        deliver = other
                    }
                    if (isCurrentConnection(connectionGeneration) && deliver.isNotEmpty()) onEvents(deliver)
                    if (catchup && isCurrentConnection(connectionGeneration)) requestCatchup()
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (isCurrentConnection(connectionGeneration) &&
                    error is ApiException && error.statusCode in listOf(403, 404)) {
                    onAccessRevoked(error)
                    return@launch
                }
                if (isCurrentConnection(connectionGeneration)) {
                    onConnectionChanged(false, false, attempt, error.message)
                }
            } finally {
                val wasActiveConnection = synchronized(connectionLock) {
                    val current = isCurrentConnection(connectionGeneration)
                    if (current) activeConnectionGeneration.set(0)
                    activeSocket.compareAndSet(socket, null)
                    secureStream?.let { activeSecureStream.compareAndSet(it, null) }
                    current
                }
                activeRuntimeRefreshGeneration.compareAndSet(latestRuntimeRefreshGeneration, 0)
                recoveryJob?.cancel()
                snapshotJob?.cancel()
                runtimeRefreshJob?.cancel()
                socket?.cancel()
                secureStream?.invoke()
                incoming.close()
                if (wasActiveConnection) onConnectionChanged(false, false, attempt, null)
            }
            if (!isActive) break
            if (opened.get()) attempt = 0 else attempt = (attempt + 1).coerceAtMost(30)
            val requested = withTimeoutOrNull(retryDelay(attempt)) { retryNow.receive() } != null
            if (requested) attempt = 0
        }
        }
        activeJob.getAndSet(job)?.cancel()
        job.invokeOnCompletion { activeJob.compareAndSet(job, null) }
        return job
    }

    private suspend fun recover(
        serverUrl: String,
        accessToken: String,
        sessionId: String,
        initialCursor: String,
        onEvents: suspend (List<RemoteSessionEventEnvelope>) -> Unit,
        onCursorAdvanced: suspend (String) -> Unit,
        onSnapshotRequired: suspend (reason: String) -> Unit,
        takeDeferred: () -> List<RemoteSessionEventEnvelope> = { emptyList() },
        historyBaseMissing: suspend () -> Boolean = { false },
        onHistoryAvailability: suspend (available: Boolean) -> Unit = {},
    ) {
        var after = initialCursor
        repeat(MAX_RECOVERY_PAGES) { page ->
            val response = transport.recoverSessionEvents(serverUrl, accessToken, sessionId, after)
            if (response.deviceOffline) {
                // Nothing is readable until the device returns. The cursor stays and
                // deferred live items are dropped: the next recovery reads them again.
                takeDeferred()
                onHistoryAvailability(false)
                return
            }
            if (response.snapshotRequired || (page == 0 && historyBaseMissing())) {
                // Without an authoritative base (an offline first read), read one now.
                onSnapshotRequired(if (response.snapshotRequired) "events.snapshotRequired" else "events.deviceOnline")
                takeDeferred().takeIf { it.isNotEmpty() }?.let { onEvents(it) }
                return
            }
            // The device answered: history is readable again before items apply.
            if (page == 0) onHistoryAvailability(true)
            val deferred = if (page == 0) takeDeferred() else emptyList()
            // Sorted together so newer live items cannot hide older recovered ones.
            val events = (recoveredEventsToApply(response.events) + deferred).sortedWith(
                compareBy<RemoteSessionEventEnvelope> { it.sequence }.thenBy { it.eventId },
            )
            if (events.isNotEmpty()) onEvents(events)
            val next = response.nextCursor
            onCursorAdvanced(next)
            val lastEventSequence = response.events.maxOfOrNull { it.sequence } ?: eventCursorSequence(after) ?: 0L
            val nextSequence = eventCursorSequence(next) ?: lastEventSequence
            if (next == after || lastEventSequence >= nextSequence) return
            after = next
        }
        onSnapshotRequired("events.recoveryLimit")
    }

    private companion object {
        const val MAX_RECOVERY_PAGES = 8
        const val MAX_TIMELINE_EVENT_BATCH_SIZE = 100
        const val MAX_WIRE_EVENT_BATCH_SIZE = 128
        const val EVENT_BATCH_WINDOW_MILLIS = 34L
    }
}

private fun RemoteSessionEventEnvelope.isTimelineUpsert(): Boolean =
    type == "timeline.item_created" || type == "timeline.item_updated"

/** Events whose sequence advances the recovery cursor of the session history. */
private fun RemoteSessionEventEnvelope.isTimelineEvent(): Boolean =
    isTimelineUpsert() || type == "timeline.snapshot"

/**
 * Recovered capabilities are projected from stored connector facts and can be
 * older than pushes applied while the request was in flight. Every recovery
 * also re-reads live capabilities, so, as on Web, stored ones are only applied
 * while the connector is offline and that read cannot succeed.
 */
private fun recoveredEventsToApply(events: List<RemoteSessionEventEnvelope>): List<RemoteSessionEventEnvelope> {
    val session = events.lastOrNull { it.type == "session.meta.updated" && it.payload.session != null }
        ?.payload
        ?.session
    if (session?.connectorStatus != "online") return events
    return events.filterNot { it.type == "runtime.capability.updated" }
}

private fun remainingBatchMillis(deadline: Long): Long =
    ((deadline - System.nanoTime() + 999_999L) / 1_000_000L).coerceAtLeast(0L)
