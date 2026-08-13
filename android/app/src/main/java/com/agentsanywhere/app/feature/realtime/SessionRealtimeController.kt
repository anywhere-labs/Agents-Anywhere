package com.agentsanywhere.app.feature.realtime

import com.agentsanywhere.app.api.RealtimeTransport
import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.api.eventCursorSequence
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
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
) {
    private val retryNow = Channel<Unit>(Channel.CONFLATED)
    private val connectionLock = Any()
    private val activeSocket = AtomicReference<WebSocket?>()
    private val activeJob = AtomicReference<Job?>()
    private val generationSequence = AtomicLong(0)
    private val activeConnectionGeneration = AtomicLong(0)
    private val runtimeRefreshSequence = AtomicLong(0)
    private val activeRuntimeRefreshGeneration = AtomicLong(0)

    fun isCurrentConnection(generation: Long): Boolean = activeConnectionGeneration.get() == generation

    fun isCurrentRuntimeRefresh(connectionGeneration: Long, refreshGeneration: Long): Boolean =
        isCurrentConnection(connectionGeneration) && activeRuntimeRefreshGeneration.get() == refreshGeneration

    fun requestImmediateReconnect() {
        synchronized(connectionLock) {
            activeSocket.getAndSet(null)?.cancel()
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
    ): Job {
        val job = scope.launch(Dispatchers.IO) {
        var attempt = 0
        var hasConnected = false
        var lastSnapshotRequiredCursor: String? = null
        suspend fun requestSnapshotOnce(reason: String, connectionGeneration: Long) {
            if (!isCurrentConnection(connectionGeneration)) return
            val currentCursor = cursor()
            if (lastSnapshotRequiredCursor == currentCursor) return
            lastSnapshotRequiredCursor = currentCursor
            onSnapshotRequired(reason)
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
            var runtimeRefreshJob: Job? = null
            var latestRuntimeRefreshGeneration = 0L
            try {
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

                fun refreshRuntime() {
                    runtimeRefreshJob?.cancel()
                    val refreshGeneration = runtimeRefreshSequence.incrementAndGet()
                    latestRuntimeRefreshGeneration = refreshGeneration
                    activeRuntimeRefreshGeneration.set(refreshGeneration)
                    runtimeRefreshJob = launch {
                        onRuntimeRefreshRequired(connectionGeneration, refreshGeneration)
                    }
                }

                fun recoverFrom(recoveryCursor: String) {
                    recoveryJob?.cancel()
                    recoveryJob = launch {
                        try {
                            recover(
                                serverUrl = serverUrl,
                                accessToken = accessToken,
                                sessionId = sessionId,
                                initialCursor = recoveryCursor,
                                onEvents = { events ->
                                    if (isCurrentConnection(connectionGeneration)) onEvents(events)
                                },
                                onCursorAdvanced = { recoveredCursor ->
                                    if (isCurrentConnection(connectionGeneration)) {
                                        onCursorAdvanced(recoveredCursor)
                                    }
                                },
                                onSnapshotRequired = { reason ->
                                    requestSnapshotOnce(reason, connectionGeneration)
                                },
                            )
                        } finally {
                            if (isCurrentConnection(connectionGeneration)) {
                                onConnectionChanged(true, false, 0, null)
                            }
                        }
                    }
                }

                if (hasConnected) {
                    onConnectionChanged(true, true, 0, null)
                    val recoveryCursor = cursor()
                    if (lastSnapshotRequiredCursor != recoveryCursor) recoverFrom(recoveryCursor)
                    refreshRuntime()
                }
                for (firstMessage in incoming) {
                    val batch = mutableListOf<RemoteSessionEventEnvelope>()
                    transport.parseSessionMessage(firstMessage)?.let(batch::add)
                    var timelineEvents = batch.count(RemoteSessionEventEnvelope::isTimelineUpsert)
                    while (timelineEvents < MAX_TIMELINE_EVENT_BATCH_SIZE && batch.size < MAX_WIRE_EVENT_BATCH_SIZE) {
                        val message = withTimeoutOrNull(EVENT_BATCH_WINDOW_MILLIS) {
                            incoming.receiveCatching().getOrNull()
                        } ?: break
                        transport.parseSessionMessage(message)?.let { event ->
                            batch += event
                            if (event.isTimelineUpsert()) timelineEvents += 1
                        }
                    }
                    if (batch.isEmpty()) continue
                    if (!isCurrentConnection(connectionGeneration)) break
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
                            launch { requestSnapshotOnce("session.refetch_required", connectionGeneration) }
                        }
                        "runtime.refetch_required" -> {
                            refreshRuntime()
                        }
                        else -> Unit
                        }
                    }
                    if (isCurrentConnection(connectionGeneration)) onEvents(batch)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (isCurrentConnection(connectionGeneration)) {
                    onConnectionChanged(false, false, attempt, error.message)
                }
            } finally {
                val wasActiveConnection = synchronized(connectionLock) {
                    val current = isCurrentConnection(connectionGeneration)
                    if (current) activeConnectionGeneration.set(0)
                    activeSocket.compareAndSet(socket, null)
                    current
                }
                activeRuntimeRefreshGeneration.compareAndSet(latestRuntimeRefreshGeneration, 0)
                recoveryJob?.cancel()
                runtimeRefreshJob?.cancel()
                socket?.cancel()
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
    ) {
        var after = initialCursor
        repeat(MAX_RECOVERY_PAGES) {
            val response = transport.recoverSessionEvents(serverUrl, accessToken, sessionId, after)
            if (response.snapshotRequired) {
                onSnapshotRequired("events.snapshotRequired")
                return
            }
            val events = response.events.sortedWith(
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
        const val EVENT_BATCH_WINDOW_MILLIS = 8L
    }
}

private fun RemoteSessionEventEnvelope.isTimelineUpsert(): Boolean =
    type == "timeline.item_created" || type == "timeline.item_updated"
