package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.MISSING_ORDER_SEQ

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
    /** Server and account on disk; null when this visit is not persisted. */
    internal val diskScope: String? = null,
    /** The disk scope's epoch when the visit opened; sign-out changes it. */
    internal val diskEpoch: String? = null,
) {
    internal var active = true
    var latestState: SessionDetailState? = cached
}

/**
 * Account-scoped LRU; only completed snapshots can seed incremental recovery.
 * With a [disk] store, visits are also written to disk so a restarted process
 * or an offline device still shows what this client loaded before.
 */
class SessionStateCache(
    private val maxEntries: Int = 5,
    private val maxBytes: Long = 16L * 1024 * 1024,
    private val disk: SessionDiskStore? = null,
) {
    private data class Entry(val state: SessionDetailState, val reading: SessionReadingPosition, val bytes: Long)
    private val entries = linkedMapOf<String, Entry>()
    private var scope: String? = null
    private val visits = mutableMapOf<String, SessionVisit>()
    private var bytes = 0L

    @Synchronized
    fun open(scope: String, sessionId: String, token: String, diskScope: String? = null): SessionVisit {
        if (this.scope != scope) {
            clear()
            this.scope = scope
        }
        visits[sessionId]?.let { previous ->
            previous.latestState?.let { close(previous, it) }
            previous.active = false
        }
        val cached = entries.remove(sessionId)?.also { entries[sessionId] = it }
        val persisted = diskScope?.takeIf { disk != null }
        return SessionVisit(
            scope, sessionId, token, cached?.state, cached?.reading ?: SessionReadingPosition(),
            diskScope = persisted, diskEpoch = persisted?.let { disk?.epoch(it) },
        ).also { visits[sessionId] = it }
    }

    @Synchronized
    fun isCurrent(visit: SessionVisit): Boolean = visits[visit.sessionId] === visit && visit.active && scope == visit.scope

    @Synchronized
    fun close(visit: SessionVisit, state: SessionDetailState) {
        if (!isCurrent(visit)) return
        visit.active = false
        visits.remove(visit.sessionId)
        remove(visit.sessionId)
        if (!cacheable(visit, state)) return
        persist(visit, state)
        if (maxEntries <= 0) return
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
        // Protocol items share their strings with the projected rows, so they
        // are left out instead of counting the same text twice.
        val estimated = saved.copy(timeline = saved.timeline.copy(remoteItems = emptyMap()))
        val size = (estimated.toString().length.toLong() + visit.readingPosition.toString().length) * 2
        if (size > maxBytes) return
        entries[visit.sessionId] = Entry(saved, visit.readingPosition, size)
        bytes += size
        while (entries.size > maxEntries || bytes > maxBytes) remove(entries.keys.first())
    }

    /** Writes the open visit to disk without ending it (backgrounding, periodic saves). */
    @Synchronized
    fun save(visit: SessionVisit, state: SessionDetailState) {
        if (isCurrent(visit) && cacheable(visit, state)) persist(visit, state)
    }

    /** The disk copy for a visit that memory could not serve. */
    suspend fun readPersisted(visit: SessionVisit): PersistedSession? {
        val store = disk ?: return null
        val diskScope = visit.diskScope ?: return null
        val stored = store.read(diskScope, visit.sessionId) ?: return null
        // A sign-out or a newer visit while reading wins over the stored copy.
        if (!isCurrent(visit) || store.epoch(diskScope) != visit.diskEpoch) return null
        return stored
    }

    @Synchronized
    fun invalidate(visit: SessionVisit) {
        if (!isCurrent(visit)) return
        remove(visit.sessionId)
        visit.active = false
        visits.remove(visit.sessionId)
        visit.diskScope?.let { disk?.delete(it, visit.sessionId) }
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

    /** Only an authoritative history is kept; an offline first read is not one. */
    private fun cacheable(visit: SessionVisit, state: SessionDetailState): Boolean =
        state.initialized && state.session?.id == visit.sessionId && !state.timeline.historyBaseMissing

    private fun persist(visit: SessionVisit, state: SessionDetailState) {
        val store = disk ?: return
        val diskScope = visit.diskScope ?: return
        val epoch = visit.diskEpoch ?: return
        val record = state.toPersistedSession(visit.readingPosition.copy()) ?: return
        store.write(diskScope, epoch, visit.sessionId, record)
    }
}

/**
 * The protocol documents behind a visit, or null without them. Items whose
 * position the projection inferred keep that position, so a restore orders
 * them exactly as they were shown.
 */
internal fun SessionDetailState.toPersistedSession(reading: SessionReadingPosition): PersistedSession? {
    val remote = meta.remote?.takeIf { it.id == session?.id } ?: return null
    val ordering = timeline.orderingItems.associateBy { it.id }
    val items = timeline.remoteItems.values.map { item ->
        if (item.orderSeq != MISSING_ORDER_SEQ) item
        else ordering[item.id]?.let { item.copy(orderSeq = it.orderSeq) } ?: item
    }
    return PersistedSession(
        session = remote,
        items = items,
        nextSeq = timeline.nextSeq,
        hasMore = timeline.hasMore,
        eventCursor = realtime.cursor,
        reading = reading,
    )
}
