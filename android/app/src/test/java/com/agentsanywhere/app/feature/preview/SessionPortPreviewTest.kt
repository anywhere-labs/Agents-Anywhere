package com.agentsanywhere.app.feature.preview

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.RemoteListeningPort
import com.agentsanywhere.app.api.RemoteSessionEventEnvelope
import com.agentsanywhere.app.api.RemoteSessionEventPayload
import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.sessiondetail.SessionDetailState
import com.agentsanywhere.app.feature.sessiondetail.SessionMeta
import com.agentsanywhere.app.feature.sessiondetail.SessionRealtimeState
import com.agentsanywhere.app.feature.sessiondetail.SessionTimelineState
import com.agentsanywhere.app.feature.sessiondetail.reduceRealtimeEvent
import com.agentsanywhere.app.feature.sessiondetail.reduceRealtimeEvents
import com.agentsanywhere.app.feature.sessiondetail.reduceSnapshotWithLiveState
import com.agentsanywhere.app.feature.sessions.toAgentSession
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port events in the session state (PV-5, same rules as Web #700). */
class SessionPortPreviewTest {
    @Test
    fun aPortReportKeepsOnlyThisSessionsPortsAndIsStableWhenNothingChanged() {
        val empty = emptyMap<Int, RemoteListeningPort>()
        val first = applySessionPortEvent(empty, "port.listening", listening(port(5173), port(8080, "other"), port(3000, null)), SESSION_ID)
        assertEquals(listOf(5173), first.keys.toList())
        assertSame(first, applySessionPortEvent(first, "port.listening", listening(port(5173)), SESSION_ID))
        val changed = applySessionPortEvent(first, "port.listening", listening(port(5173, url = "http://localhost:5173/app")), SESSION_ID)
        assertFalse(changed === first)
        assertEquals("http://localhost:5173/app", localPortUrl(changed.getValue(5173)))
        assertEquals("http://localhost:3000", localPortUrl(port(3000)))

        // A full report replaces: a port missing from it is gone.
        val replaced = applySessionPortEvent(changed, "port.listening", listening(port(4000)), SESSION_ID)
        assertEquals(listOf(4000), replaced.keys.toList())

        val closed = applySessionPortEvent(replaced, "port.closed", RemoteSessionEventPayload(closedPort = 4000), SESSION_ID)
        assertTrue(closed.isEmpty())
        assertSame(closed, applySessionPortEvent(closed, "port.closed", RemoteSessionEventPayload(closedPort = 4000), SESSION_ID))
        assertSame(empty, applySessionPortEvent(empty, "port.listening", RemoteSessionEventPayload(), SESSION_ID))
    }

    @Test
    fun theCardListsAtMostThreePortsLowestFirst() {
        val ports = listOf(9000, 3000, 8080, 5173).associateWith { port(it) }
        assertEquals(listOf(3000, 5173, 8080), visibleListeningPorts(ports).map { it.port })
    }

    @Test
    fun portEventsUpdateTheSessionWithoutMovingTheCursor() {
        val state = loadedState()
        val listening = event(envelope("port.listening", sequence = 99, payload = listeningJson(5173 to SESSION_ID, 9000 to "session-2")))
        val withPorts = reduceRealtimeEvent(state, listening, emptyList())
        assertEquals(listOf(5173), withPorts.listeningPorts.keys.toList())
        // Neither the recovery cursor nor the deduplication set moves.
        assertEquals(state.realtime, withPorts.realtime)
        assertEquals(state.timeline, withPorts.timeline)

        val closed = event(envelope("port.closed", sequence = 100, payload = JSONObject().put("deviceId", "connector-1").put("port", 5173)))
        val batched = reduceRealtimeEvents(state, listOf(listening, closed), emptyList())
        assertTrue(batched.listeningPorts.isEmpty())
        assertEquals(state.realtime, batched.realtime)

        // A report without history position (no eventId, sequence or cursor) applies too.
        val bare = event(
            JSONObject().put("type", "port.listening").put("payload", listeningJson(3000 to SESSION_ID)).toString(),
        )
        assertEquals(listOf(3000), reduceRealtimeEvent(state, bare, emptyList()).listeningPorts.keys.toList())
    }

    @Test
    fun portsAreClearedWhenTheDeviceGoesOffline() {
        val withPorts = reduceRealtimeEvent(
            loadedState(),
            event(envelope("port.listening", sequence = 5, payload = listeningJson(5173 to SESSION_ID))),
            emptyList(),
        )
        assertEquals(1, withPorts.listeningPorts.size)

        val offline = reduceRealtimeEvent(
            withPorts,
            event(envelope("session.meta.updated", sequence = 6, eventId = "meta-6", payload = JSONObject().put("session", sessionJson("offline", updatedSeq = 6)))),
            emptyList(),
        )
        assertTrue(offline.listeningPorts.isEmpty())

        // The same through a local session update (for example a takeover response).
        assertTrue(withPorts.withSession(withPorts.session!!.copy(connectorOnline = false)).listeningPorts.isEmpty())
        assertEquals(1, withPorts.withSession(withPorts.session!!.copy(title = "renamed")).listeningPorts.size)
    }

    @Test
    fun aSnapshotKeepsLivePortsUnlessTheDeviceIsOffline() {
        val live = reduceRealtimeEvent(
            loadedState(),
            event(envelope("port.listening", sequence = 5, payload = listeningJson(5173 to SESSION_ID))),
            emptyList(),
        )
        val online = reduceSnapshotWithLiveState(loadedState(), live, loadedState())
        assertEquals(listOf(5173), online.listeningPorts.keys.toList())

        val offlineSnapshot = loadedState(connectorStatus = "offline", updatedSeq = 9)
        val offline = reduceSnapshotWithLiveState(offlineSnapshot, live, loadedState())
        assertTrue(offline.listeningPorts.isEmpty())
    }

    @Test
    fun errorCodesMapToTheirOwnTextAndEverythingElseFails() {
        val codes = mapOf(
            "preview_port_not_allowed" to PortPreviewError.PortNotAllowed,
            "preview_limit_reached" to PortPreviewError.LimitReached,
            "preview_domain_not_configured" to PortPreviewError.DomainNotConfigured,
            "preview_unavailable" to PortPreviewError.PreviewUnavailable,
            "connector_offline" to PortPreviewError.ConnectorOffline,
            // Codes from the first draft of the brief are not contract codes.
            "preview_disabled" to PortPreviewError.Failed,
            "port_not_listening" to PortPreviewError.Failed,
            "something_else" to PortPreviewError.Failed,
        )
        codes.forEach { (code, expected) ->
            assertEquals(code, expected, portPreviewError(ApiException("x", statusCode = 409, errorCode = code)))
        }
        assertEquals(PortPreviewError.Failed, portPreviewError(ApiException("x", statusCode = 500)))
        assertEquals(PortPreviewError.Failed, portPreviewError(IllegalStateException("network")))

        assertTrue(isPortPreviewDisabled(ApiException("x", statusCode = 404)))
        assertTrue(isPortPreviewDisabled(ApiException("x", statusCode = 409, errorCode = "preview_domain_not_configured")))
        assertFalse(isPortPreviewDisabled(ApiException("x", statusCode = 409, errorCode = "preview_limit_reached")))
        assertFalse(isPortPreviewDisabled(IllegalStateException("network")))
    }

    private companion object {
        const val SESSION_ID = "session-1"

        fun port(number: Int, sessionId: String? = SESSION_ID, url: String? = null) =
            RemoteListeningPort(port = number, pid = 100L + number, processName = "node", sessionId = sessionId, url = url)

        fun listening(vararg ports: RemoteListeningPort) = RemoteSessionEventPayload(ports = ports.toList())

        fun listeningJson(vararg ports: Pair<Int, String?>): JSONObject = JSONObject()
            .put("deviceId", "connector-1")
            .put("ports", JSONArray().apply {
                ports.forEach { (number, sessionId) ->
                    put(JSONObject().put("port", number).put("pid", number).put("processName", "node").put("sessionId", sessionId ?: JSONObject.NULL))
                }
            })

        fun sessionJson(connectorStatus: String = "online", updatedSeq: Int = 1): JSONObject = JSONObject()
            .put("id", SESSION_ID).put("connectorId", "connector-1").put("runtime", "codex")
            .put("title", "Session").put("connectorStatus", connectorStatus).put("updatedSeq", updatedSeq)

        fun envelope(type: String, sequence: Long, payload: JSONObject, eventId: String = "$type:$sequence"): String = JSONObject()
            .put("protocolVersion", "1.2").put("eventId", eventId).put("sequence", sequence).put("cursor", "seq:$sequence")
            .put("type", type).put("sessionId", SESSION_ID).put("emittedAt", "2026-11-16T00:00:00Z")
            .put("payload", payload).toString()

        fun event(text: String): RemoteSessionEventEnvelope = SessionsApi().parseSessionEvent(JSONObject(text))

        fun loadedState(connectorStatus: String = "online", updatedSeq: Int = 1): SessionDetailState {
            val remote = SessionsApi().parseSession(sessionJson(connectorStatus, updatedSeq))
            return SessionDetailState(
                initialized = true,
                meta = SessionMeta(session = remote.toAgentSession(emptyMap()), remote = remote),
                timeline = SessionTimelineState(eventCursor = "seq:4", nextSeq = 4),
                realtime = SessionRealtimeState(cursor = "seq:4"),
            )
        }
    }
}
