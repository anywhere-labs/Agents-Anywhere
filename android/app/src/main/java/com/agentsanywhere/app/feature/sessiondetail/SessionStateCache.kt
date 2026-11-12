package com.agentsanywhere.app.feature.sessiondetail

/** Data only: no views, sockets, image bytes or coroutine scopes survive a visit. */
data class SessionReadingPosition(
    var firstVisibleItemIndex: Int = 0,
    var firstVisibleItemScrollOffset: Int = 0,
    var reading: List<String> = emptyList(),
)

class SessionVisit internal constructor(
    val scope: String,
    val sessionId: String,
    val token: String,
    val cached: SessionDetailState?,
    var readingPosition: SessionReadingPosition,
) {
    internal var active = true
    var latestState: SessionDetailState? = cached
}

/** Account-scoped LRU; only completed snapshots can seed incremental recovery. */
class SessionStateCache(
    private val maxEntries: Int = 5,
    private val maxBytes: Long = 16L * 1024 * 1024,
) {
    private data class Entry(val state: SessionDetailState, val reading: SessionReadingPosition, val bytes: Long)
    private val entries = linkedMapOf<String, Entry>()
    private var scope: String? = null
    private val visits = mutableMapOf<String, SessionVisit>()
    private var bytes = 0L

    @Synchronized
    fun open(scope: String, sessionId: String, token: String): SessionVisit {
        if (this.scope != scope) {
            clear()
            this.scope = scope
        }
        visits[sessionId]?.let { previous ->
            previous.latestState?.let { close(previous, it) }
            previous.active = false
        }
        val cached = entries.remove(sessionId)?.also { entries[sessionId] = it }
        return SessionVisit(scope, sessionId, token, cached?.state, cached?.reading ?: SessionReadingPosition())
            .also { visits[sessionId] = it }
    }

    @Synchronized
    fun isCurrent(visit: SessionVisit): Boolean = visits[visit.sessionId] === visit && visit.active && scope == visit.scope

    @Synchronized
    fun close(visit: SessionVisit, state: SessionDetailState) {
        if (!isCurrent(visit)) return
        visit.active = false
        visits.remove(visit.sessionId)
        remove(visit.sessionId)
        if (!state.initialized || state.session?.id != visit.sessionId || maxEntries <= 0) return
        val saved = state.completeSnapshotLoad().copy(
            realtime = state.realtime.copy(connected = false, recovering = false, lastErrorMessage = null),
            catalogs = state.catalogs.copy(modelLoading = false, permissionLoading = false),
            commands = state.commands.copy(isLoading = false, stale = true),
            actionError = null,
            takeoverInFlight = false,
            sending = state.messages.hasPendingOptimisticSend(),
            interrupting = false,
            selectionUpdating = false,
            commandExecuting = false,
            respondingNoticeIds = emptySet(),
        )
        // Estimate retained strings once on departure, never during streaming.
        val size = (saved.toString().length.toLong() + visit.readingPosition.toString().length) * 2
        if (size > maxBytes) return
        entries[visit.sessionId] = Entry(saved, visit.readingPosition, size)
        bytes += size
        while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys.first())
    }

    @Synchronized
    fun invalidate(visit: SessionVisit) {
        if (!isCurrent(visit)) return
        remove(visit.sessionId)
        visit.active = false
        visits.remove(visit.sessionId)
    }

    private fun remove(id: String) {
        entries.remove(id)?.let { bytes -= it.bytes }
    }

    @Synchronized
    fun clear() {
        visits.values.forEach { it.active = false }
        visits.clear()
        entries.clear()
        bytes = 0
        scope = null
    }
}
