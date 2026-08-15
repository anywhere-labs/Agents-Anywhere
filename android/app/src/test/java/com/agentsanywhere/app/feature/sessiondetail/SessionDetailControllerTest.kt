package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.model.AgentDevice
import java.io.BufferedInputStream
import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionDetailControllerTest {
    @Test
    fun rpcOkFalseIsReportedAsActionFailure() {
        SessionDetailServer(expectedRequests = 3).use { server ->
            val controller = SessionDetailController(
                sessionsApi = SessionsApi(),
                sessionStore = object : AuthSessionReader {
                    override fun readServerUrl(): String = server.url
                    override fun readAccessToken(): String = "token"
                },
            )

            kotlinx.coroutines.runBlocking {
                assertEquals(
                    "Message rejected.",
                    controller.sendMessage("session", "hello", "client-message")
                        .exceptionOrNull()?.message,
                )
                assertEquals(
                    "Interrupt rejected.",
                    controller.interrupt("session").exceptionOrNull()?.message,
                )
                assertEquals(
                    "Notice was already resolved.",
                    controller.respondNotice("session", "notice", "approve", null)
                        .exceptionOrNull()?.message,
                )
            }
        }
    }

    @Test
    fun initialSnapshotHydratesOnceAndDomainRefreshPreservesFailedOwners() {
        SessionDetailServer(expectedRequests = 11).use { server ->
            val controller = SessionDetailController(
                sessionsApi = SessionsApi(),
                sessionStore = object : AuthSessionReader {
                    override fun readServerUrl(): String = server.url
                    override fun readAccessToken(): String = "token"
                },
            )
            val devices = listOf(
                AgentDevice(
                    id = "connector",
                    name = "Device",
                    subtitle = "",
                    online = true,
                ),
            )

            val initial = kotlinx.coroutines.runBlocking {
                controller.loadInitialSnapshot("session", devices).getOrThrow()
            }
            assertEquals("Initial", initial.session?.title)
            assertEquals(SessionRuntimeStatus.Running, initial.runtime.status)
            assertTrue(initial.runtimeCapabilities.isLoaded)
            assertEquals(1L, initial.runtimeCapabilities.revision)
            assertEquals("Initial message", initial.messages.single().text)
            assertEquals("Initial notice", initial.notices.notices.single().title)
            assertEquals(99L, initial.catalogs.model?.revision)
            assertEquals(100L, initial.catalogs.permission?.revision)

            val partiallyRefreshed = kotlinx.coroutines.runBlocking {
                controller.refreshDomains("session", devices, initial)
            }
            assertEquals("Initial", partiallyRefreshed.session?.title)
            assertNotNull(partiallyRefreshed.meta.errorMessage)
            assertEquals(SessionRuntimeStatus.Running, partiallyRefreshed.runtime.status)
            assertNotNull(partiallyRefreshed.runtime.errorMessage)
            assertEquals("Updated message", partiallyRefreshed.messages.single().text)
            assertFalse(partiallyRefreshed.capabilities.isUsable("session.send_message", "codex"))
            assertEquals("Initial notice", partiallyRefreshed.notices.notices.single().title)
            assertNotNull(partiallyRefreshed.notices.errorMessage)

            val recovered = kotlinx.coroutines.runBlocking {
                controller.refreshDomains("session", devices, partiallyRefreshed)
            }
            assertEquals("Refreshed", recovered.session?.title)
            assertNull(recovered.meta.errorMessage)
            assertEquals(SessionRuntimeStatus.Idle, recovered.runtime.status)
            assertNull(recovered.runtime.errorMessage)
            assertEquals("Updated notice", recovered.notices.notices.single().title)
            assertNull(recovered.notices.errorMessage)
            assertEquals(1, server.countFor("/api/v2/sessions/session/snapshot"))
            assertEquals(2, server.countFor("/api/v2/sessions/session/meta"))
            assertEquals(2, server.countFor("/api/v2/sessions/session/runtime/state"))
        }
    }

    private class SessionDetailServer(
        private val expectedRequests: Int,
    ) : Closeable {
        private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        private val counts = ConcurrentHashMap<String, Int>()
        val url = "http://127.0.0.1:${socket.localPort}"
        private var failure: Throwable? = null
        private val worker = thread(name = "session-detail-controller-test-server") {
            runCatching {
                repeat(expectedRequests) {
                    socket.accept().use { client ->
                        val input = BufferedInputStream(client.getInputStream())
                        val requestLine = readHeaderBlock(input).lineSequence().first().split(' ')
                        val target = requestLine[1]
                        val path = target.substringBefore('?')
                        val count = counts.merge(path, 1, Int::plus) ?: 1
                        val response = response(path, target, count)
                        val bytes = response.body.toByteArray()
                        val reason = if (response.status in 200..299) "OK" else "Error"
                        client.getOutputStream().use { output ->
                            output.write(
                                (
                                    "HTTP/1.1 ${response.status} $reason\r\n" +
                                        "Content-Type: application/json\r\n" +
                                        "Content-Length: ${bytes.size}\r\n" +
                                        "Connection: close\r\n\r\n"
                                ).toByteArray(),
                            )
                            output.write(bytes)
                        }
                    }
                }
            }.onFailure { failure = it }
        }

        fun countFor(path: String): Int = counts[path] ?: 0

        override fun close() {
            worker.join(5_000)
            socket.close()
            failure?.let { throw AssertionError("Test HTTP server failed", it) }
            assertFalse("Test HTTP server did not finish", worker.isAlive)
        }

        private fun response(path: String, target: String, count: Int): TestResponse {
            return when {
                path.endsWith("/snapshot") -> TestResponse(200, snapshot())
                path.endsWith("/meta") && count == 1 -> TestResponse(503, "{\"detail\":\"meta offline\"}")
                path.endsWith("/meta") -> TestResponse(200, meta("Refreshed"))
                path.endsWith("/timeline") -> {
                    assertTrue(target.contains("mode=changes"))
                    TestResponse(200, timeline(if (count == 1) "Updated message" else null, nextSeq = 2))
                }
                path.endsWith("/runtime/state") && count == 1 -> {
                    TestResponse(503, "{\"detail\":\"runtime offline\"}")
                }
                path.endsWith("/runtime/state") -> TestResponse(200, runtimeState("idle", 3))
                path.endsWith("/runtime/capabilities") -> TestResponse(200, capabilities(allowed = false))
                path.endsWith("/runtime/notices") && count == 1 -> {
                    TestResponse(503, "{\"detail\":\"notice offline\"}")
                }
                path.endsWith("/runtime/notices") -> TestResponse(200, notices("Updated notice", revision = 2))
                path.endsWith("/runtime/messages") -> rpcFailure("message_rejected", "Message rejected.")
                path.endsWith("/runtime/interrupt") -> rpcFailure("interrupt_rejected", "Interrupt rejected.")
                path.endsWith("/runtime/notices/notice/respond") -> {
                    rpcFailure("notice_not_found", "Notice was already resolved.")
                }
                else -> TestResponse(404, "{\"detail\":\"unexpected route\"}")
            }
        }

        private fun rpcFailure(code: String, message: String): TestResponse {
            return TestResponse(
                200,
                JSONObject()
                    .put("ok", false)
                    .put("error", JSONObject().put("code", code).put("message", message))
                    .toString(),
            )
        }

        private fun snapshot(): String {
            return JSONObject()
                .put("session", session("Initial"))
                .put("state", JSONObject(runtimeState("running", 1)).getJSONObject("state"))
                .put(
                    "timeline",
                    JSONObject()
                        .put("items", listOf(timelineItem("Initial message", revision = 1, updatedSeq = 1)))
                        .put("nextSeq", 1)
                        .put("hasMore", false),
                )
                .put("approvals", emptyList<Any>())
                .put("notices", JSONObject(notices("Initial notice", revision = 1)).getJSONArray("notices"))
                .put("effectiveCapabilities", JSONObject(capabilities(allowed = true)).getJSONObject("capabilitySet"))
                .put("runtimeCapabilities", JSONObject(capabilities(allowed = true)).getJSONObject("capabilitySet"))
                .put(
                    "catalogs",
                    JSONObject()
                        .put(
                            "model",
                            JSONObject()
                                .put("runtime", "codex")
                                .put("revision", 99)
                                .put("models", emptyList<Any>()),
                        )
                        .put(
                            "permission",
                            JSONObject()
                                .put("runtime", "codex")
                                .put("revision", 100)
                                .put("permissions", emptyList<Any>()),
                        ),
                )
                .put("eventCursor", "seq:1")
                .put("serverTime", "now")
                .toString()
        }

        private fun meta(title: String): String {
            return JSONObject().put("session", session(title)).put("serverTime", "now").toString()
        }

        private fun session(title: String): JSONObject {
            return JSONObject()
                .put("id", "session")
                .put("connectorId", "connector")
                .put("connectorStatus", "online")
                .put("runtime", "codex")
                .put("title", title)
                .put("cwd", "/workspace")
                .put("status", "idle")
                .put("takeover", true)
                .put("updatedSeq", 1)
        }

        private fun timeline(text: String?, nextSeq: Int): String {
            return JSONObject()
                .put("sessionId", "session")
                .put(
                    "items",
                    if (text == null) emptyList<Any>() else listOf(timelineItem(text, revision = 2, updatedSeq = 2)),
                )
                .put("nextSeq", nextSeq)
                .put("hasMore", false)
                .put("serverTime", "now")
                .toString()
        }

        private fun timelineItem(text: String, revision: Int, updatedSeq: Int): JSONObject {
            return JSONObject()
                .put("id", "item")
                .put("sessionId", "session")
                .put("type", "message")
                .put("status", "done")
                .put("role", "assistant")
                .put("content", JSONObject().put("text", text))
                .put("source", JSONObject().put("runtime", "codex"))
                .put("orderSeq", 1)
                .put("revision", revision)
                .put("updatedSeq", updatedSeq)
                .put("createdAt", "now")
                .put("updatedAt", "now")
        }

        private fun runtimeState(status: String, updatedSeq: Int): String {
            return JSONObject()
                .put(
                    "state",
                    JSONObject()
                        .put("sessionId", "session")
                        .put("runtime", "codex")
                        .put("status", status)
                        .put("selections", JSONObject())
                        .put("metadata", JSONObject())
                        .put("updatedSeq", updatedSeq)
                        .put("createdAt", "now")
                        .put("updatedAt", "now"),
                )
                .put("serverTime", "now")
                .toString()
        }

        private fun capabilities(allowed: Boolean): String {
            return JSONObject()
                .put("connectorId", "connector")
                .put(
                    "capabilitySet",
                    JSONObject()
                        .put("revision", if (allowed) 1 else 2)
                        .put(
                            "capabilities",
                            listOf(
                                JSONObject()
                                    .put("capabilityId", "session.send_message")
                                    .put("runtime", "codex")
                                    .put("supported", true)
                                    .put("available", true)
                                    .put("allowed", allowed),
                            ),
                        ),
                )
                .put("serverTime", "now")
                .toString()
        }

        private fun notices(title: String, revision: Int): String {
            return JSONObject()
                .put(
                    "notices",
                    listOf(
                        JSONObject()
                            .put("noticeId", "notice")
                            .put("type", "approval")
                            .put("sessionId", "session")
                            .put("source", JSONObject())
                            .put("title", title)
                            .put("severity", "info")
                            .put("status", "open")
                            .put("actions", emptyList<Any>())
                            .put("context", JSONObject())
                            .put("metadata", JSONObject())
                            .put("revision", revision)
                            .put("updatedSeq", revision),
                    ),
                )
                .put("serverTime", "now")
                .toString()
        }

        private fun readHeaderBlock(input: BufferedInputStream): String {
            val output = StringBuilder()
            var matched = 0
            while (matched < 4) {
                val value = input.read()
                if (value < 0) break
                output.append(value.toChar())
                matched = when {
                    matched == 0 && value == '\r'.code -> 1
                    matched == 1 && value == '\n'.code -> 2
                    matched == 2 && value == '\r'.code -> 3
                    matched == 3 && value == '\n'.code -> 4
                    value == '\r'.code -> 1
                    else -> 0
                }
            }
            return output.toString()
        }
    }

    private data class TestResponse(val status: Int, val body: String)
}
