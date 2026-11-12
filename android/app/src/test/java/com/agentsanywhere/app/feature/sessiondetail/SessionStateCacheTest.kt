package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.sessions.toAgentSession
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SessionStateCacheTest {
    @Test
    fun returningRetainsHistoryCursorAndReadingWithoutRetainingBusyFlags() {
        val cache = SessionStateCache()
        val visit = cache.open("server:account", "a", "token")
        val state = loaded("a").copy(selectionUpdating = true, interrupting = true,
            realtime = SessionRealtimeState(connected = true, recovering = true, cursor = "seq:10"),
            timeline = SessionTimelineState(messages = listOf(message("older"), message("latest")),
                nextSeq = 30, hasMore = true, loadingOlder = true))
        visit.readingPosition.firstVisibleItemIndex = 6
        visit.readingPosition.reading = listOf("following:false", "e:older:true")
        cache.close(visit, state)
        val other = cache.open("server:account", "b", "token")
        cache.close(other, loaded("b"))
        val restored = cache.open("server:account", "a", "token")
        assertEquals(listOf("older", "latest"), restored.cached!!.messages.map { it.id })
        // History paging is not proof that intervening stream changes were consumed.
        assertEquals("seq:10", restored.cached!!.realtime.cursor)
        assertEquals(6, restored.readingPosition.firstVisibleItemIndex)
        assertEquals(listOf("following:false", "e:older:true"), restored.readingPosition.reading)
        assertFalse(restored.cached!!.selectionUpdating)
        assertFalse(restored.cached!!.interrupting)
        assertFalse(restored.cached!!.timeline.loadingOlder)
        assertFalse(restored.cached!!.realtime.connected)
    }

    @Test
    fun aLateVisitCannotReplaceItsSuccessorOrResurrectRevokedAccess() {
        val cache = SessionStateCache()
        val old = cache.open("account", "a", "old-token")
        cache.close(old, loaded("a"))
        val current = cache.open("account", "a", "new-token")
        assertFalse(cache.isCurrent(old))
        cache.close(old, loaded("a").copy(timeline = SessionTimelineState(messages = listOf(message("late")))))
        assertTrue(cache.isCurrent(current))
        cache.invalidate(current)
        cache.close(current, loaded("a"))
        assertNull(cache.open("account", "a", "new-token").cached)
    }

    @Test
    fun credentialRefreshRetainsTheCurrentVisitBeforeCompositionDisposesIt() {
        val cache = SessionStateCache()
        val old = cache.open("account", "a", "old-token")
        old.latestState = loaded("a").copy(timeline = SessionTimelineState(messages = listOf(message("streamed"))))
        val next = cache.open("account", "a", "new-token")
        assertEquals("streamed", next.cached!!.messages.single().id)
        cache.close(old, loaded("a"))
        assertTrue(cache.isCurrent(next))
    }

    @Test
    fun changingAccountOrServerDiscardsHistoryAndLateSaves() {
        val cache = SessionStateCache()
        val first = cache.open("server:alice", "a", "token")
        cache.close(first, loaded("a"))
        val second = cache.open("server:alice", "a", "token")
        assertNotNull(second.cached)
        assertNull(cache.open("server:bob", "a", "token").cached)
        cache.close(second, loaded("a"))
        assertNull(cache.open("other-server:alice", "a", "token").cached)
    }

    @Test
    fun leastRecentlyUsedSessionIsEvicted() {
        val cache = SessionStateCache(maxEntries = 2)
        fun visit(id: String) { val visit = cache.open("account", id, "token"); cache.close(visit, loaded(id)) }
        visit("a"); visit("b"); visit("a"); visit("c")
        assertNotNull(cache.open("account", "a", "token").cached)
        assertNull(cache.open("account", "b", "token").cached)
        assertNotNull(cache.open("account", "c", "token").cached)
    }

    @Test
    fun oversizedHistoryCannotPinTheCache() {
        val cache = SessionStateCache(maxBytes = 16_000)
        val small = cache.open("account", "small", "token")
        cache.close(small, loaded("small"))
        val large = cache.open("account", "large", "token")
        cache.close(large, loaded("large").copy(timeline = SessionTimelineState(
            messages = listOf(message("large").copy(text = "x".repeat(20_000))))))
        assertNull(cache.open("account", "large", "token").cached)
        assertNotNull(cache.open("account", "small", "token").cached)
    }

    @Test
    fun incompleteOrMismatchedSnapshotsMustHydrateAgain() {
        val cache = SessionStateCache()
        val incomplete = cache.open("account", "a", "token")
        cache.close(incomplete, loaded("a").copy(initialized = false))
        val mismatched = cache.open("account", "a", "token")
        assertNull(mismatched.cached)
        cache.close(mismatched, loaded("b"))
        assertNull(cache.open("account", "a", "token").cached)
    }

    @Test
    fun childReadingStateMayBeSavedAfterParentDeparture() {
        val cache = SessionStateCache()
        val visit = cache.open("account", "a", "token")
        cache.close(visit, loaded("a"))
        visit.readingPosition.firstVisibleItemIndex = 12
        assertEquals(12, cache.open("account", "a", "token").readingPosition.firstVisibleItemIndex)
    }

    @Test
    fun logoutInvalidatesActiveVisitsAndPreventsLateRepopulation() {
        val cache = SessionStateCache()
        val visit = cache.open("account", "a", "token")
        cache.clear()
        assertFalse(cache.isCurrent(visit))
        cache.close(visit, loaded("a"))
        assertNull(cache.open("account", "a", "token").cached)
    }

    private fun message(id: String) = TimelineMessage(id = id, author = MessageAuthor.Agent, text = id)

    private fun loaded(id: String) = SessionDetailState(initialized = true, meta = SessionMeta(
        session = SessionsApi().parseSession(JSONObject().put("id", id).put("connectorId", "device")
            .put("runtime", "codex").put("takeover", true).put("updatedSeq", 10)).toAgentSession(emptyMap()),
    ))
}
