package com.agentsanywhere.app.api

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** preview 1.0 client API (PV-5). */
class PreviewsApiTest {
    @Test
    fun versionedPathsAreNotPrefixedWithTheV2Namespace() {
        assertEquals("/api/v3/previews", apiPath("/api/v3/previews"))
        assertEquals("/api/v3", apiPath("/api/v3"))
        assertEquals("/api/v2/sessions/list", apiPath("/sessions/list"))
        assertEquals("/api/v2/sessions", apiPath("/api/v2/sessions"))
        // A route merely starting with "api" is still a v2 route.
        assertEquals("/api/v2/apivault", apiPath("/apivault"))
    }

    @Test
    fun aV3RequestHasOneCandidateAndDoesNotDecideWhereV2RoutesLive() {
        val server = "https://preview-namespace.example"
        assertEquals(listOf("$server/api/v3/previews"), apiUrlCandidates(server, "/api/v3/previews"))
        rememberApiUrl(server, "$server/api/v3/previews")
        assertFalse(usesLegacyApiRoute(server))
        // Still both candidates for v2 routes: the v3 answer said nothing about them.
        assertEquals(2, apiUrlCandidates(server, "/sessions/list").size)

        val legacy = "https://preview-legacy.example"
        rememberApiUrl(legacy, "$legacy/sessions/list")
        assertTrue(usesLegacyApiRoute(legacy))
        assertEquals("$legacy/api/v3/previews/p1", apiUrl(legacy, "/api/v3/previews/p1"))
    }

    @Test
    fun talksToApiV3Previews() {
        val server = MockWebServer()
        val view = previewJson("prv/1", plaintextNotice = true)
        server.enqueue(json(JSONObject().put("previews", org.json.JSONArray().put(previewJson("prv-0")))))
        server.enqueue(json(view))
        server.enqueue(json(JSONObject().put("ticketUrl", "https://abc.preview.example/__aa/ticket?t=x").put("expiresAt", "2026-11-16T00:01:00Z")))
        server.enqueue(json(previewJson("prv/1", state = "closed").put("closeReason", "user_closed")))
        server.enqueue(MockResponse().setResponseCode(204))
        server.start()
        try {
            val url = "http://127.0.0.1:${server.port}"
            val api = PreviewsApi(ApiClient())

            val listed = api.list(url, "token")
            val created = api.create(url, "token", CreatePreviewRequest(deviceId = "connector-1", port = 5173, sessionId = "session-1"))
            val ticket = api.ticket(url, "token", "prv/1")
            val closed = api.close(url, "token", "prv/1")
            val closedWithoutBody = api.close(url, "token", "prv/1")

            assertEquals(listOf("prv-0"), listed.map { it.previewId })
            assertEquals("prv/1", created.previewId)
            assertEquals(5173, created.port)
            assertEquals("https://abc.preview.example", created.url)
            assertTrue(created.plaintextNotice)
            assertEquals("https://abc.preview.example/__aa/ticket?t=x", ticket.ticketUrl)
            assertEquals("closed", closed?.state)
            assertEquals("user_closed", closed?.closeReason)
            assertNull(closedWithoutBody)

            val requests = List(5) { server.takeRequest() }
            assertEquals(
                listOf(
                    "GET /api/v3/previews",
                    "POST /api/v3/previews",
                    "POST /api/v3/previews/prv%2F1/ticket",
                    "DELETE /api/v3/previews/prv%2F1",
                    "DELETE /api/v3/previews/prv%2F1",
                ),
                requests.map { "${it.method} ${it.requestUrl!!.encodedPath}" },
            )
            requests.forEach { assertEquals("Bearer token", it.getHeader("Authorization")) }
            val body = JSONObject(requests[1].body.readUtf8())
            assertEquals(setOf("deviceId", "port", "sessionId", "visibility"), body.keys().asSequence().toSet())
            assertEquals("connector-1", body.getString("deviceId"))
            assertEquals(5173, body.getInt("port"))
            assertEquals("session-1", body.getString("sessionId"))
            assertEquals("private", body.getString("visibility"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun errorsKeepTheirStatusAndCode() {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().setResponseCode(409).setHeader("Content-Type", "application/json")
                .setBody("""{"detail":{"code":"preview_limit_reached","message":"limit"}}"""),
        )
        server.enqueue(MockResponse().setResponseCode(404).setBody("Not Found"))
        server.start()
        try {
            val url = "http://127.0.0.1:${server.port}"
            val api = PreviewsApi(ApiClient())
            val limit = runCatching { api.create(url, "token", CreatePreviewRequest("connector-1", 5173)) }.exceptionOrNull() as ApiException
            assertEquals(409, limit.statusCode)
            assertEquals("preview_limit_reached", limit.errorCode)
            // A server without port preview: one request, no legacy retry.
            val missing = runCatching { api.create(url, "token", CreatePreviewRequest("connector-1", 5173)) }.exceptionOrNull() as ApiException
            assertEquals(404, missing.statusCode)
            assertEquals(2, server.requestCount)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun parsesPortEventsWithoutAHistoryPosition() {
        val api = SessionsApi()
        val listening = api.parseSessionEvent(
            JSONObject(
                """{"protocolVersion":"1.2","type":"port.listening","sessionId":"session-1",
                   "payload":{"deviceId":"connector-1","ports":[
                     {"port":5173,"pid":42,"processName":"node","sessionId":"session-1","url":"http://localhost:5173/app"},
                     {"port":0},{"port":"80"},{"port":3000,"sessionId":null}]}}""",
            ),
        )
        assertEquals(PORT_LISTENING_EVENT, listening.type)
        assertEquals("", listening.cursor)
        assertEquals(
            listOf(
                RemoteListeningPort(5173, 42, "node", "session-1", "http://localhost:5173/app"),
                RemoteListeningPort(3000),
            ),
            listening.payload.ports,
        )

        val closed = api.parseSessionEvent(
            JSONObject("""{"type":"port.closed","eventId":"e","sequence":7,"cursor":"seq:7","sessionId":"session-1","payload":{"deviceId":"connector-1","port":5173}}"""),
        )
        assertEquals(5173, closed.payload.closedPort)
    }

    private fun json(body: JSONObject) = MockResponse().setHeader("Content-Type", "application/json").setBody(body.toString())

    private fun previewJson(id: String, state: String = "open", plaintextNotice: Boolean = false): JSONObject = JSONObject()
        .put("previewId", id).put("slug", "abc").put("deviceId", "connector-1").put("sessionId", "session-1")
        .put("port", 5173).put("visibility", "private").put("state", state).put("closeReason", JSONObject.NULL)
        .put("url", "https://abc.preview.example").put("expiresAt", "2026-11-17T00:00:00Z")
        .put("plaintextNotice", plaintextNotice)
}
