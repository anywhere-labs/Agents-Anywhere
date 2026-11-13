package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.RemotePlanningState
import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.api.RemoteSessionEventPayload
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.feature.sessions.toAgentSession
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SessionCacheRecoveryTest {
    @Test
    fun returningRefreshesPlanningWithoutReloadingTheTimeline() = withServer { controller ->
        val cache = SessionStateCache()
        val first = cache.open("account", "a", "token")
        cache.close(first, loaded().copy(planning = plan(1)))
        val current = cache.open("account", "a", "token").cached!!

        val refreshed = runBlocking { controller.refreshRuntimeLiveDomains("a", current) }
        val next = controller.mergeRuntimeLiveState(current, current, refreshed)

        assertEquals(2, next.planning!!.revision)
        assertEquals(listOf("approve"), next.planning!!.actions)
        assertSame(current.timeline, next.timeline)
        // A push (including a new epoch) received during the read must win.
        val pushed = current.copy(planning = plan(1).copy(epoch = "new-epoch"))
        assertEquals(pushed.planning, controller.mergeRuntimeLiveState(pushed, current, refreshed).planning)
    }

    @Test
    fun temporaryPlanningReadFailureRetainsTheCachedPlan() = withServer(planningStatus = 503) { controller ->
        val current = loaded().copy(planning = plan(1))
        val refreshed = runBlocking { controller.refreshRuntimeLiveDomains("a", current) }
        assertEquals(current.planning, controller.mergeRuntimeLiveState(current, current, refreshed).planning)
    }

    @Test
    fun revokedPlanningAccessIsPropagatedForVisitInvalidation() = withServer(planningStatus = 403) { controller ->
        try {
            runBlocking { controller.refreshRuntimeLiveDomains("a", loaded()) }
            fail("Expected revoked access")
        } catch (error: ApiException) {
            assertEquals(403, error.statusCode)
        }
    }

    @Test
    fun historyStartedBeforeSnapshotCannotReappearDuringOrAfterReplacement() = withServer { controller ->
        val current = loaded()
        val generation = current.timeline.historyGeneration
        val older = SessionTimelineState(messages = listOf(message("deleted")), hasMore = true)
        val loading = current.beginSnapshotLoad(clearErrors = false)
        assertSame(loading, controller.applyOlder("a", loading, older, generation))

        val snapshot = loaded().copy(timeline = SessionTimelineState(messages = listOf(message("replacement"))))
        val replaced = controller.mergeSnapshotWithLiveState("a", snapshot, loading, loading, replaceHistory = true)
            .completeSnapshotLoad()
        assertSame(replaced, controller.applyOlder("a", replaced, older, generation))
        assertEquals(listOf("replacement"), replaced.messages.map { it.id })
        assertFalse(replaced.hasMore)

        // A newly issued page still works after the boundary.
        val next = controller.applyOlder("a", replaced, older, replaced.timeline.historyGeneration)
        assertEquals(setOf("replacement", "deleted"), next.messages.map { it.id }.toSet())
        assertTrue(next.hasMore)
    }

    @Test
    fun timelineSnapshotAlsoInvalidatesOutstandingHistory() = withServer { controller ->
        val current = loaded().let { it.copy(timeline = it.timeline.copy(loadingOlder = true)) }
        val replaced = controller.applyRealtimeEvent(current, RemoteSessionEventEnvelope(
            protocolVersion = "1.0", eventId = "reset", sequence = 11, cursor = "seq:11",
            type = "timeline.snapshot", sessionId = "a", emittedAt = null,
            payload = RemoteSessionEventPayload(),
        ), emptyList())
        val older = SessionTimelineState(messages = listOf(message("deleted")), hasMore = true)
        assertSame(replaced, controller.applyOlder("a", replaced, older, current.timeline.historyGeneration))
        assertTrue(replaced.messages.isEmpty())
        assertFalse(replaced.timeline.loadingOlder)
    }

    private fun withServer(planningStatus: Int = 200, block: (SessionDetailController) -> Unit) {
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.requestUrl!!.encodedPath
                val body = when {
                    path.endsWith("/planning") -> """{"sessionId":"a","epoch":"epoch","revision":2,"capabilities":{"actions":["approve"]}}"""
                    path.endsWith("/runtime/state") -> """{"state":{"sessionId":"a","runtime":"codex","status":"idle","updatedSeq":10}}"""
                    path.endsWith("/runtime/notices") -> """{"notices":[]}"""
                    path.endsWith("/runtime/capabilities") -> """{"capabilitySet":{"capabilities":[]}}"""
                    else -> error("Unexpected request: $path")
                }
                return MockResponse().setHeader("Content-Type", "application/json")
                    .setResponseCode(if (path.endsWith("/planning")) planningStatus else 200).setBody(body)
            }
        }
        server.start()
        val controller = SessionDetailController(SessionsApi(), object : AuthSessionReader {
            override fun readServerUrl() = "http://127.0.0.1:${server.port}"
            override fun readAccessToken() = "token"
        })
        try { block(controller) } finally { controller.dispose(); server.shutdown() }
    }

    private fun plan(revision: Int) = RemotePlanningState("a", "plan", "live", "epoch", revision,
        null, null, null, emptyList(), emptyList())

    private fun message(id: String) = TimelineMessage(id, author = MessageAuthor.Agent, text = id)

    private fun loaded() = SessionDetailState(initialized = true,
        meta = SessionMeta(session = SessionsApi().parseSession(JSONObject().put("id", "a")
            .put("connectorId", "connector").put("runtime", "codex").put("updatedSeq", 10))
            .toAgentSession(emptyMap())),
        timeline = SessionTimelineState(messages = listOf(message("cached")), hasMore = true))
}
