package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.feature.sessions.toAgentSession
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class SessionDiskCacheTest {
    private val root: File = Files.createTempDirectory("session-disk-cache").toFile()
    private var clock = 1_000L

    @After
    fun cleanUp() {
        root.deleteRecursively()
    }

    @Test
    fun leavingWritesProtocolDocumentsAndANewProcessRestoresTheSameProjection() = runBlocking {
        val disk = store()
        val first = controller(disk)
        val visit = first.openVisit(SESSION_ID)
        val state = loaded(cursor = "seq:12", hasMore = true)
            .let { first.addOptimisticMessage(SESSION_ID, it, "unsent", "opt_1") }
        visit.readingPosition.firstVisibleItemIndex = 3
        visit.readingPosition.reading = listOf("following:false")
        first.sessionCache.close(visit, state)
        disk.flush()
        first.dispose()

        // A new process: empty memory, same disk.
        val second = controller(disk)
        val reopened = second.openVisit(SESSION_ID)
        assertNull(reopened.cached)
        val restored = second.restoreVisit(reopened, emptyList(), SessionDetailState())!!

        val expected = state.messages.filterNot { it.optimistic }
        assertEquals(expected, restored.messages)
        assertEquals(state.timeline.orderingItems, restored.timeline.orderingItems)
        assertEquals("seq:12", restored.realtime.cursor)
        assertEquals(state.nextSeq, restored.nextSeq)
        assertTrue(restored.hasMore)
        assertTrue(restored.initialized)
        assertEquals("Cached title", restored.session!!.title)
        assertEquals(3, reopened.readingPosition.firstVisibleItemIndex)
        assertEquals(listOf("following:false"), reopened.readingPosition.reading)
        // Live facts are never stored; the next visit reads them again.
        assertFalse(restored.runtime.isLoaded)
        assertFalse(restored.capabilities.isLoaded)
        second.dispose()
    }

    @Test
    fun inferredPositionsSurviveTheRoundTrip() = runBlocking {
        val disk = store()
        val api = SessionsApi()
        val items = listOf(item("u1", 1, "user", "hello"), item("a1", null, "assistant", "no position"))
            .map(api::parseTimelineItem)
        val state = loaded(cursor = "seq:3", items = items)
        val visit = SessionStateCache(disk = disk).let { cache ->
            cache.open("memory", SESSION_ID, "token", SCOPE).also { cache.close(it, state) }
        }
        disk.flush()
        val stored = disk.read(SCOPE, SESSION_ID)!!
        val position = state.timeline.orderingItems.single { it.id == "a1" }.orderSeq
        assertEquals(position, stored.items.single { it.id == "a1" }.orderSeq)
        assertNotNull(visit)
    }

    @Test
    fun recordsOfAnotherVersionOrScopeAreIgnoredAndDropped() = runBlocking {
        val disk = store()
        save(disk, loaded(cursor = "seq:1"))
        val file = root.walkTopDown().single { it.isFile }
        file.writeText(JSONObject(file.readText()).put("version", SessionDiskStore.RECORD_VERSION + 1).toString())
        assertNull(disk.read(SCOPE, SESSION_ID))
        assertFalse(file.exists())

        save(disk, loaded(cursor = "seq:1"))
        assertNull(disk.read(SessionDiskStore.scopeFor("https://server", "someone-else"), SESSION_ID))
        assertNotNull(disk.read(SCOPE, SESSION_ID))
    }

    @Test
    fun leastRecentlyUsedSessionsAreEvictedByCountAndSize() = runBlocking {
        val disk = store(maxEntries = 2)
        save(disk, loaded(cursor = "seq:1", sessionId = "a"))
        save(disk, loaded(cursor = "seq:1", sessionId = "b"))
        clock += 10
        assertNotNull(disk.read(SCOPE, "a")) // reading refreshes recency
        save(disk, loaded(cursor = "seq:1", sessionId = "c"))
        assertNotNull(disk.read(SCOPE, "a"))
        assertNull(disk.read(SCOPE, "b"))
        assertNotNull(disk.read(SCOPE, "c"))

        val small = store(maxBytes = 1)
        save(small, loaded(cursor = "seq:1", sessionId = "a"))
        assertNull(small.read(SCOPE, "a"))
    }

    @Test
    fun signingOutDeletesTheAccountAndLatePagesCannotWriteItBack() = runBlocking {
        val disk = store()
        val controller = controller(disk)
        val open = controller.openVisit(SESSION_ID)
        controller.saveVisit(open, loaded(cursor = "seq:4"))
        disk.flush()
        assertNotNull(disk.read(SCOPE, SESSION_ID))

        disk.forget(SCOPE)
        // A page closing or backgrounding after sign-out.
        controller.saveVisit(open, loaded(cursor = "seq:5"))
        controller.sessionCache.close(open, loaded(cursor = "seq:5"))
        disk.flush()
        assertNull(disk.read(SCOPE, SESSION_ID))
        assertTrue(root.walkTopDown().none { it.isFile })

        // Signing in again starts a new epoch.
        val next = controller(disk)
        next.sessionCache.close(next.openVisit(SESSION_ID), loaded(cursor = "seq:6"))
        disk.flush()
        assertEquals("seq:6", disk.read(SCOPE, SESSION_ID)!!.eventCursor)
    }

    @Test
    fun signingInToAnotherAccountRemovesOtherAccounts() = runBlocking {
        val disk = store()
        save(disk, loaded(cursor = "seq:1"))
        val other = SessionDiskStore.scopeFor("https://server", "user-2")
        controller(disk, userId = "user-2")
        disk.flush()
        assertNull(disk.read(SCOPE, SESSION_ID))
        assertTrue(root.walkTopDown().none { it.isFile })
        assertNull(disk.read(other, SESSION_ID))
    }

    @Test
    fun onlyAuthoritativeHistoryIsWrittenAndRevokedAccessDeletesIt() = runBlocking {
        val disk = store()
        val cache = SessionStateCache(disk = disk)
        val offlineBase = loaded(cursor = "seq:0").let {
            it.copy(timeline = it.timeline.copy(historyUnavailable = true, historyBaseMissing = true))
        }
        cache.close(cache.open("memory", SESSION_ID, "token", SCOPE), offlineBase)
        disk.flush()
        assertNull(disk.read(SCOPE, SESSION_ID))

        save(disk, loaded(cursor = "seq:1"))
        val visit = cache.open("memory", SESSION_ID, "token", SCOPE)
        cache.invalidate(visit)
        disk.flush()
        assertNull(disk.read(SCOPE, SESSION_ID))
    }

    @Test
    fun withoutAnAccountNothingIsStored() = runBlocking {
        val disk = store()
        val controller = controller(disk, userId = "")
        controller.sessionCache.close(controller.openVisit(SESSION_ID), loaded(cursor = "seq:1"))
        disk.flush()
        assertTrue(root.walkTopDown().none { it.isFile })
    }

    private fun store(maxEntries: Int = 50, maxBytes: Long = 64L * 1024 * 1024) =
        SessionDiskStore(File(root, "store-${System.nanoTime()}"), maxEntries, maxBytes, now = { clock++ })

    private fun save(disk: SessionDiskStore, state: SessionDetailState) {
        val cache = SessionStateCache(disk = disk)
        cache.close(cache.open("memory", state.session!!.id, "token", SCOPE), state)
        disk.flush()
    }

    private fun controller(disk: SessionDiskStore, userId: String = "user-1") = SessionDetailController(
        SessionsApi(),
        object : AuthSessionReader {
            override fun readServerUrl() = "https://server"
            override fun readAccessToken() = "token"
            override fun readUserId() = userId
        },
        disk,
    )

    private companion object {
        const val SESSION_ID = "session-1"
        val SCOPE = SessionDiskStore.scopeFor("https://server", "user-1")

        fun item(id: String, orderSeq: Int?, role: String, text: String): JSONObject = JSONObject()
            .put("id", id).put("sessionId", SESSION_ID).put("type", "message").put("role", role)
            .put("status", "done").put("content", JSONObject().put("text", text))
            .put("orderSeq", orderSeq ?: JSONObject.NULL).put("revision", 1).put("updatedSeq", orderSeq ?: 9)
            .put("createdAt", "2026-01-01T00:00:00Z")

        fun loaded(
            cursor: String,
            hasMore: Boolean = false,
            sessionId: String = SESSION_ID,
            items: List<com.agentsanywhere.app.api.RemoteTimelineItem> = listOf(
                item("u1", 1, "user", "hello"), item("a1", 2, "assistant", "hi"),
            ).map(SessionsApi()::parseTimelineItem),
        ): SessionDetailState {
            val remote = SessionsApi().parseSession(JSONObject().put("id", sessionId).put("connectorId", "c")
                .put("runtime", "codex").put("title", "Cached title").put("updatedSeq", 1))
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
    }
}
