package com.agentsanywhere.app.api

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionsApiTest {
    @Test
    fun metaAndBulkRequestsUseV2RoutesAndAuthoritativeResponses() {
        val responses = ArrayDeque(
            listOf(
                TestResponse(body = sessionResponse("session/one", updatedSeq = 10)),
                TestResponse(body = sessionResponse("session/one", updatedSeq = 11)),
                TestResponse(body = bulkResponse(listOf("one", "two"), notFound = listOf("missing"))),
                TestResponse(body = bulkResponse(listOf("two", "one"))),
                TestResponse(body = bulkResponse(listOf("one", "two"))),
            ),
        )
        withJsonServer(responses) { serverUrl, requests ->
            val api = SessionsApi()

            val meta = api.getSessionMeta(serverUrl, "token", "session/one")
            val patched = api.patchSession(
                serverUrl = serverUrl,
                authorizationToken = "token",
                sessionId = "session/one",
                title = "  Exact title  ",
                pinned = true,
                archived = false,
            )
            val archived = api.archiveSessions(serverUrl, "token", listOf("one", "two"))
            val unarchived = api.unarchiveSessions(serverUrl, "token", listOf("two", "one"))
            val read = api.markSessionsRead(serverUrl, "token", listOf("one", "two"))

            assertRequest(requests[0], "GET", "/api/v2/sessions/session%2Fone/meta", "")
            assertEquals("PATCH", requests[1].method)
            assertEquals("/api/v2/sessions/session%2Fone/meta", requests[1].path)
            val patchBody = JSONObject(requests[1].body)
            assertEquals("  Exact title  ", patchBody.getString("title"))
            assertTrue(patchBody.getBoolean("pinned"))
            assertFalse(patchBody.getBoolean("archived"))
            assertRequest(requests[2], "POST", "/api/v2/sessions/archive", "[\"one\",\"two\"]")
            assertRequest(requests[3], "POST", "/api/v2/sessions/unarchive", "[\"two\",\"one\"]")
            assertRequest(requests[4], "POST", "/api/v2/sessions/read", "[\"one\",\"two\"]")
            requests.forEach { assertEquals("Bearer token", it.authorization) }

            assertEquals(10, meta.session.updatedSeq)
            assertEquals("2026-08-10T00:00:00Z", meta.serverTime)
            assertEquals(11, patched.session.updatedSeq)
            assertEquals(listOf("one", "two"), archived.sessions.map { it.id })
            assertEquals(listOf("missing"), archived.notFound)
            assertEquals(listOf("two", "one"), unarchived.sessions.map { it.id })
            assertEquals(listOf("one", "two"), read.sessions.map { it.id })
        }
    }

    @Test
    fun sessionViewKeepsV2MetaFieldsAndIgnoresUnknownFields() {
        withJsonServer(ArrayDeque(listOf(TestResponse(body = sessionResponse("session"))))) { serverUrl, _ ->
            val session = SessionsApi().getSessionMeta(serverUrl, "token", "session").session

            assertEquals("connector", session.connectorId)
            assertEquals("2026-08-09T00:00:00Z", session.pinnedAt)
            assertEquals("2026-08-08T00:00:00Z", session.archivedAt)
            assertEquals(7, session.lastReadSeq)
            assertEquals(9, session.lastItemOrderSeq)
            assertTrue(session.runtimeSettings.isEmpty())
            assertTrue(session.runtimeSettingsOverride.isEmpty())
        }
    }

    @Test
    fun takeoverAndConnectorArchiveAllRemainOnV2Paths() {
        val responses = ArrayDeque(
            listOf(
                TestResponse(body = sessionResponse("session one")),
                TestResponse(body = sessionResponse("session one")),
                TestResponse(body = archiveAllResponse("session one")),
            ),
        )
        withJsonServer(responses) { serverUrl, requests ->
            val api = SessionsApi()

            api.enableTakeover(serverUrl, "token", "session one")
            api.disableTakeover(serverUrl, "token", "session one")
            val sessions = api.archiveAllDeviceSessions(
                serverUrl = serverUrl,
                authorizationToken = "token",
                deviceId = "connector/one",
                archived = true,
                scope = "active",
            )

            assertRequest(requests[0], "POST", "/api/v2/sessions/session%20one/takeover", "{}")
            assertRequest(requests[1], "DELETE", "/api/v2/sessions/session%20one/takeover", "")
            assertEquals("POST", requests[2].method)
            assertEquals("/api/v2/connectors/connector%2Fone/sessions/archive-all", requests[2].path)
            assertEquals(true, JSONObject(requests[2].body).getBoolean("archived"))
            assertEquals("active", JSONObject(requests[2].body).getString("scope"))
            assertEquals(listOf("session one"), sessions.map { it.id })
        }
    }

    @Test
    fun singleReadRequiresItsSessionInTheBulkResponse() {
        withJsonServer(ArrayDeque(listOf(TestResponse(body = bulkResponse(listOf("different")))))) { serverUrl, requests ->
            val error = assertThrows(IllegalStateException::class.java) {
                SessionsApi().markSessionRead(serverUrl, "token", "expected")
            }

            assertEquals("Session read response did not include this session.", error.message)
            assertRequest(requests.single(), "POST", "/api/v2/sessions/read", "[\"expected\"]")
        }
    }

    @Test
    fun authNotFoundValidationAndNetworkFailuresRemainErrors() {
        listOf(401, 404, 422).forEach { status ->
            withJsonServer(
                ArrayDeque(listOf(TestResponse(status = status, body = "{\"detail\":\"failure $status\"}"))),
            ) { serverUrl, _ ->
                val error = assertThrows(ApiException::class.java) {
                    SessionsApi().getSessionMeta(serverUrl, "token", "session")
                }
                assertEquals(status, error.statusCode)
                assertEquals("failure $status", error.message)
            }
        }

        val unavailablePort = ServerSocket(0).use { it.localPort }
        val error = assertThrows(ApiException::class.java) {
            SessionsApi().getSessionMeta("http://127.0.0.1:$unavailablePort", "token", "session")
        }
        assertNull(error.statusCode)

        val invalidUrl = assertThrows(ApiException::class.java) {
            SessionsApi().getSessionMeta("not a server URL", "token", "session")
        }
        assertEquals("The server URL is invalid.", invalidUrl.message)
        assertNull(invalidUrl.statusCode)
    }

    private fun sessionResponse(id: String, updatedSeq: Int = 12): String {
        val session = JSONObject()
            .put("id", id)
            .put("connectorId", "connector")
            .put("connectorStatus", "online")
            .put("runtime", "codex")
            .put("externalSessionId", JSONObject.NULL)
            .put("title", "Title")
            .put("cwd", "/workspace")
            .put("status", "idle")
            .put("takeover", false)
            .put("pinned", true)
            .put("pinnedAt", "2026-08-09T00:00:00Z")
            .put("archived", true)
            .put("archivedAt", "2026-08-08T00:00:00Z")
            .put("unread", false)
            .put("lastReadSeq", 7)
            .put("lastSyncedAt", "2026-08-07T00:00:00Z")
            .put("sourceObservedAt", "2026-08-07T00:00:00Z")
            .put("lastActivityAt", "2026-08-07T00:00:00Z")
            .put("lastItemAt", "2026-08-07T00:00:00Z")
            .put("lastItemOrderSeq", 9)
            .put("sortAt", "2026-08-07T00:00:00Z")
            .put("updatedSeq", updatedSeq)
            .put("futureField", true)
        return JSONObject()
            .put("session", session)
            .put("serverTime", "2026-08-10T00:00:00Z")
            .put("futureTopLevel", true)
            .toString()
    }

    private fun bulkResponse(ids: List<String>, notFound: List<String> = emptyList()): String {
        return JSONObject()
            .put("sessions", ids.map { JSONObject(sessionResponse(it)).getJSONObject("session") })
            .put("notFound", notFound)
            .put("serverTime", "2026-08-10T00:00:01Z")
            .toString()
    }

    private fun archiveAllResponse(id: String): String {
        return JSONObject()
            .put("sessions", listOf(JSONObject(sessionResponse(id)).getJSONObject("session")))
            .put("affected", 1)
            .put("serverTime", "2026-08-10T00:00:02Z")
            .toString()
    }

    private fun assertRequest(request: RecordedRequest, method: String, path: String, body: String) {
        assertEquals(method, request.method)
        assertEquals(path, request.path)
        assertEquals(body, request.body)
    }

    private fun withJsonServer(
        responses: ArrayDeque<TestResponse>,
        block: (String, List<RecordedRequest>) -> Unit,
    ) {
        TestJsonServer(responses).use { server -> block(server.url, server.requests) }
    }

    private data class TestResponse(
        val status: Int = 200,
        val body: String,
    )

    private data class RecordedRequest(
        val method: String,
        val path: String,
        val body: String,
        val authorization: String?,
    )

    private class TestJsonServer(
        private val responses: ArrayDeque<TestResponse>,
    ) : Closeable {
        private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val requests = CopyOnWriteArrayList<RecordedRequest>()
        val url = "http://127.0.0.1:${socket.localPort}"
        private var failure: Throwable? = null
        private val worker = thread(name = "sessions-api-test-server") {
            runCatching {
                repeat(responses.size) {
                    socket.accept().use { client ->
                        val input = BufferedInputStream(client.getInputStream())
                        val headers = readHeaderBlock(input)
                        val lines = headers.split("\r\n")
                        val requestLine = lines.first().split(' ')
                        val headerValues = lines.drop(1).mapNotNull { line ->
                            val separator = line.indexOf(':')
                            if (separator <= 0) null else {
                                line.substring(0, separator).trim().lowercase() to
                                    line.substring(separator + 1).trim()
                            }
                        }.toMap()
                        val contentLength = headerValues["content-length"]?.toIntOrNull() ?: 0
                        val body = ByteArray(contentLength)
                        var offset = 0
                        while (offset < body.size) {
                            val read = input.read(body, offset, body.size - offset)
                            if (read < 0) break
                            offset += read
                        }
                        requests += RecordedRequest(
                            method = requestLine[0],
                            path = requestLine[1].substringBefore('?'),
                            body = body.copyOf(offset).toString(Charsets.UTF_8),
                            authorization = headerValues["authorization"],
                        )
                        val response = responses.removeFirst()
                        val responseBytes = response.body.toByteArray()
                        val reason = if (response.status in 200..299) "OK" else "Error"
                        client.getOutputStream().use { output ->
                            output.write(
                                (
                                    "HTTP/1.1 ${response.status} $reason\r\n" +
                                        "Content-Type: application/json\r\n" +
                                        "Content-Length: ${responseBytes.size}\r\n" +
                                        "Connection: close\r\n\r\n"
                                ).toByteArray(),
                            )
                            output.write(responseBytes)
                        }
                    }
                }
            }.onFailure { failure = it }
        }

        override fun close() {
            worker.join(5_000)
            socket.close()
            failure?.let { throw AssertionError("Test HTTP server failed", it) }
            assertFalse("Test HTTP server did not finish", worker.isAlive)
        }

        private fun readHeaderBlock(input: BufferedInputStream): String {
            val output = ByteArrayOutputStream()
            var matched = 0
            while (matched < 4) {
                val value = input.read()
                if (value < 0) break
                output.write(value)
                matched = when {
                    matched == 0 && value == '\r'.code -> 1
                    matched == 1 && value == '\n'.code -> 2
                    matched == 2 && value == '\r'.code -> 3
                    matched == 3 && value == '\n'.code -> 4
                    value == '\r'.code -> 1
                    else -> 0
                }
            }
            return output.toString(Charsets.UTF_8.name()).removeSuffix("\r\n\r\n")
        }
    }
}
