package com.agentsanywhere.app.api

import java.io.BufferedInputStream
import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RealtimeApiTest {
    @Test
    fun ticketScopesAndRecoveryUseExactV2Contracts() {
        RealtimeHttpServer(
            responses = ArrayDeque(
                listOf(
                    ticketResponse("dashboard-ticket"),
                    ticketResponse("session-ticket"),
                    JSONObject()
                        .put("events", emptyList<Any>())
                        .put("nextCursor", "seq:12")
                        .put("snapshotRequired", false)
                        .put("serverTime", "now")
                        .toString(),
                ),
            ),
        ).use { server ->
            val api = RealtimeApi()
            val dashboard = api.createDashboardTicket(server.url, "access", "android-install")
            val session = api.createSessionTicket(server.url, "access", "android-install", "session/one")
            val recovery = api.recoverSessionEvents(server.url, "access", "session/one", "seq:10")

            assertEquals("dashboard-ticket", dashboard.ticket)
            assertEquals("session-ticket", session.ticket)
            assertEquals("seq:12", recovery.nextCursor)
            assertFalse(recovery.snapshotRequired)

            assertEquals("POST", server.requests[0].method)
            assertEquals("/api/v2/ws-ticket", server.requests[0].path)
            assertEquals("Bearer access", server.requests[0].authorization)
            val dashboardBody = JSONObject(server.requests[0].body)
            assertEquals("android-install", dashboardBody.getString("clientId"))
            assertTrue(dashboardBody.getJSONObject("scope").getBoolean("dashboard"))
            assertFalse(dashboardBody.getJSONObject("scope").has("sessionId"))

            val sessionBody = JSONObject(server.requests[1].body)
            assertEquals("session/one", sessionBody.getJSONObject("scope").getString("sessionId"))
            assertFalse(sessionBody.getJSONObject("scope").has("dashboard"))
            assertEquals("GET", server.requests[2].method)
            assertEquals("/api/v2/sessions/session%2Fone/events", server.requests[2].path)
            assertEquals("after=seq%3A10", server.requests[2].query)
        }
    }

    @Test
    fun websocketUrlsEncodeSensitiveQueryValuesAndUseOneNamespace() {
        val api = RealtimeApi()
        assertEquals(
            "ws://localhost:8000/api/v2/dashboard/ws?ticket=ticket%20value",
            api.dashboardWebSocketUrl("http://localhost:8000/api/v2", "ticket value"),
        )
        assertEquals(
            "wss://server.example/api/v2/sessions/session%2Fone/ws?ticket=t%3F%26",
            api.sessionWebSocketUrl("https://server.example/", "session/one", "t?&"),
        )
    }

    @Test
    fun dashboardAndSessionMessagesParseOnlyTheirOwnWireShapes() {
        val api = RealtimeApi()
        val dashboard = api.parseDashboardMessage(
            JSONObject()
                .put("type", "dashboard.snapshot")
                .put("connectors", listOf(connectorJson()))
                .put("sessions", listOf(sessionJson()))
                .put("serverTime", "now")
                .toString(),
        )
        assertEquals("connector", dashboard?.devices?.single()?.id)
        assertEquals("session", dashboard?.sessions?.single()?.id)
        assertNull(api.parseDashboardMessage("{\"type\":\"keepalive\"}"))

        val event = api.parseSessionMessage(
            protocolEvent(
                type = "runtime.catalog.updated",
                payload = JSONObject()
                    .put("catalogType", "model")
                    .put("catalog", JSONObject().put("runtime", "codex").put("revision", 4).put("models", emptyList<Any>())),
            ).toString(),
        )
        assertEquals("evt-1", event?.eventId)
        assertEquals(4L, event?.payload?.modelCatalog?.revision)
        assertNull(event?.payload?.permissionCatalog)
        assertNull(api.parseSessionMessage("{\"type\":\"keepalive\",\"serverTime\":\"now\"}"))
    }

    private fun ticketResponse(ticket: String): String = JSONObject()
        .put("ticket", ticket)
        .put("expiresAt", "later")
        .put("serverTime", "now")
        .toString()

    private fun protocolEvent(type: String, payload: JSONObject): JSONObject = JSONObject()
        .put("protocolVersion", "1.0")
        .put("eventId", "evt-1")
        .put("sequence", 12)
        .put("cursor", "seq:12")
        .put("type", type)
        .put("sessionId", "session")
        .put("emittedAt", "now")
        .put("payload", payload)

    private fun connectorJson(): JSONObject = JSONObject()
        .put("id", "connector")
        .put("name", "Device")
        .put("status", "online")
        .put("runtimeCapabilities", JSONObject())

    private fun sessionJson(): JSONObject = JSONObject()
        .put("id", "session")
        .put("connectorId", "connector")
        .put("connectorStatus", "online")
        .put("runtime", "codex")
        .put("status", "idle")
        .put("updatedSeq", 1)

    private class RealtimeHttpServer(
        private val responses: ArrayDeque<String>,
    ) : Closeable {
        private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val url = "http://127.0.0.1:${socket.localPort}"
        val requests = CopyOnWriteArrayList<CapturedRequest>()
        private var failure: Throwable? = null
        private val worker = thread(name = "realtime-api-test") {
            runCatching {
                while (responses.isNotEmpty()) {
                    socket.accept().use { client ->
                        val input = BufferedInputStream(client.getInputStream())
                        val header = readHeader(input)
                        val lines = header.lineSequence().toList()
                        val request = lines.first().split(' ')
                        val contentLength = lines.firstOrNull { it.startsWith("Content-Length:", true) }
                            ?.substringAfter(':')?.trim()?.toIntOrNull() ?: 0
                        val body = ByteArray(contentLength).also { bytes ->
                            var offset = 0
                            while (offset < bytes.size) offset += input.read(bytes, offset, bytes.size - offset)
                        }.toString(Charsets.UTF_8)
                        val target = request[1]
                        requests += CapturedRequest(
                            method = request[0],
                            path = target.substringBefore('?'),
                            query = target.substringAfter('?', ""),
                            authorization = lines.firstOrNull { it.startsWith("Authorization:", true) }
                                ?.substringAfter(':')?.trim(),
                            body = body,
                        )
                        val response = responses.removeFirst().toByteArray()
                        client.getOutputStream().use { output ->
                            output.write(
                                ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
                                    "Content-Length: ${response.size}\r\nConnection: close\r\n\r\n").toByteArray(),
                            )
                            output.write(response)
                        }
                    }
                }
            }.onFailure { failure = it }
        }

        override fun close() {
            worker.join(5_000)
            socket.close()
            failure?.let { throw AssertionError("Realtime test server failed", it) }
            assertFalse(worker.isAlive)
        }

        private fun readHeader(input: BufferedInputStream): String {
            val bytes = mutableListOf<Byte>()
            while (true) {
                val next = input.read()
                if (next < 0) break
                bytes += next.toByte()
                if (bytes.size >= 4 && bytes.takeLast(4) == listOf(13, 10, 13, 10).map(Int::toByte)) break
            }
            return bytes.toByteArray().toString(Charsets.UTF_8)
        }
    }

    private data class CapturedRequest(
        val method: String,
        val path: String,
        val query: String,
        val authorization: String?,
        val body: String,
    )
}
