package com.agentsanywhere.app.feature.terminal

import android.os.Looper
import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.api.AuthResponse
import com.agentsanywhere.app.api.MobileLoginExchangeResponse
import com.agentsanywhere.app.api.TerminalApi
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.feature.auth.MobileAuthSessionRefresher
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.SessionStatus
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicInteger
import java.util.Collections
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class TerminalControllerAuthTest {
    @Test
    fun remoteTerminalReconnectOpensSocketWithRefreshedToken() = withServer { server ->
        server.store.saveRefreshedAuthSession(server.store.readMobileAuthSession(), server.auth.copy(accessToken = "renewed"))
        val remote = RemoteTerminalController(server.controller)
        val device = AgentDevice("device", "Device", online = true)
        try {
            runBlocking { remote.ensureStarted(device) }
            awaitSocketCount(server, remote, 1)
            server.validAccessToken = "next"
            runBlocking { remote.reconnect(device) }
            awaitSocketCount(server, remote, 2)
            assertEquals(listOf("renewed", "next"), server.streamTokens)
            assertEquals(listOf("0", "17"), server.streamCursors)
            assertEquals(1, server.refreshCalls.get())
        } finally {
            remote.disposeLocal()
        }
    }

    @Test
    fun openingDeviceTerminalAfterRefreshUsesNewToken() = withServer { server ->
        val connection = runBlocking { server.controller.openDeviceTerminal("device", 80, 24, "group") }.getOrThrow()
        assertEquals("renewed", connection.authorizationToken)
        assertEquals("renewed", Request.Builder().url(connection.streamUrl).build().url.queryParameter("token"))
        assertEquals(1, server.refreshCalls.get())
    }

    @Test
    fun openingWorkspaceTerminalAfterRefreshUsesNewToken() = withServer { server ->
        val session = AgentSession(
            id = "session", connectorId = "device", projectId = null, deviceName = "Device",
            title = "Session", summary = "", cwd = "/workspace", workspaceLabel = "Workspace",
            runtime = "codex", runtimeLabel = "Codex", status = SessionStatus.Idle,
            statusLabel = "Idle", updatedAtLabel = "", metaLabel = "", pinned = false,
            archived = false, unread = false, lastReadSeq = 0, takeover = false,
            connectorOnline = true, live = false, sortKey = "", updatedSeq = 0,
        )
        val connection = runBlocking { server.controller.openWorkspaceTerminal(session, 80, 24, "group") }.getOrThrow()
        assertEquals("renewed", connection.authorizationToken)
        assertEquals("renewed", Request.Builder().url(connection.streamUrl).build().url.queryParameter("token"))
    }

    @Test
    fun reconnectRefreshesExpiredTokenAndPreservesReplayCursor() = withServer { server ->
        val connection = runBlocking { server.controller.prepareStreamConnection(server.streamUrl) }.getOrThrow()
        val url = Request.Builder().url(connection.streamUrl).build().url
        assertEquals("renewed", connection.authorizationToken)
        assertEquals("renewed", url.queryParameter("token"))
        assertEquals("17", url.queryParameter("fromSeq"))
        assertEquals(1, server.refreshCalls.get())
        assertTrue(server.store.hasAuthSession())
    }

    @Test
    fun reconnectUsesTokenAlreadyRefreshedByAnotherRequest() = withServer { server ->
        server.store.saveRefreshedAuthSession(server.store.readMobileAuthSession(), server.auth.copy(accessToken = "renewed"))
        val connection = runBlocking { server.controller.prepareStreamConnection(server.streamUrl) }.getOrThrow()
        assertEquals("renewed", connection.authorizationToken)
        assertEquals(0, server.refreshCalls.get())
    }

    @Test
    fun reconnectDoesNotSendCredentialsToPreviousServer() = withServer { server ->
        server.store.saveMobileAuthSession("https://other.test", server.exchange)
        assertTrue(runBlocking { server.controller.prepareStreamConnection(server.streamUrl) }.isFailure)
        assertEquals(0, server.http.requestCount)
    }

    @Test
    fun reconnectRejectsAccountChangedDuringValidation() = withServer { server ->
        server.store.saveRefreshedAuthSession(server.store.readMobileAuthSession(), server.auth.copy(accessToken = "renewed"))
        server.onMe = { server.store.saveMobileAuthSession(server.origin, server.exchange.copy(auth = server.auth.copy(userId = "other", accessToken = "other-token"))) }
        assertTrue(runBlocking { server.controller.prepareStreamConnection(server.streamUrl) }.isFailure)
        assertEquals("other-token", server.store.readAccessToken())
    }

    @Test
    fun rejectedRefreshClearsCurrentSessionBeforeOpeningSocket() = withServer { server ->
        server.refreshStatus = 401
        assertTrue(runBlocking { server.controller.prepareStreamConnection(server.streamUrl) }.isFailure)
        assertFalse(server.store.hasAuthSession())
        assertEquals(1, server.refreshCalls.get())
    }

    private fun withServer(test: (TestServer) -> Unit) {
        val server = TestServer()
        try {
            test(server)
        } finally {
            server.http.shutdown()
        }
    }

    private fun awaitSocketCount(server: TestServer, remote: RemoteTerminalController, count: Int) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while ((server.streamTokens.size < count || remote.state.value.status != RemoteTerminalStatus.Open) && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(20, TimeUnit.MILLISECONDS)
            Thread.sleep(20)
        }
        assertEquals(count, server.streamTokens.size)
        assertEquals(RemoteTerminalStatus.Open, remote.state.value.status)
    }

    private class TestServer {
        val http = MockWebServer().apply { start() }
        val origin = http.url("/").toString().trimEnd('/')
        val auth = AuthResponse("user", "member", "expired", "bearer", "now")
        val exchange = MobileLoginExchangeResponse(auth, "refresh", "expires", "now")
        val store = AuthSessionStore(RuntimeEnvironment.getApplication()).apply {
            clearAuthSession()
            saveMobileAuthSession(origin, exchange)
        }
        val refreshCalls = AtomicInteger()
        var refreshStatus = 200
        @Volatile var validAccessToken = "renewed"
        val streamTokens = Collections.synchronizedList(mutableListOf<String>())
        val streamCursors = Collections.synchronizedList(mutableListOf<String?>())
        var onMe: () -> Unit = {}
        private val refresher = MobileAuthSessionRefresher(store)
        private val client = ApiClient(
            onUnauthorized = { store.clearAuthSessionIfTokenMatches(it) },
            refreshAccessToken = refresher::refreshAccessToken,
        )
        private val terminalApi = TerminalApi(client)
        val controller = TerminalController(terminalApi, store, AuthApi(client))
        val streamUrl = terminalApi.streamUrl(origin, "expired", "device", "terminal", 17)

        init {
            http.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.requestUrl?.encodedPath.orEmpty().endsWith("/stream")) {
                        val token = request.requestUrl?.queryParameter("token")
                        if (token != validAccessToken) return MockResponse().setResponseCode(401)
                        streamTokens.add(token)
                        streamCursors.add(request.requestUrl?.queryParameter("fromSeq"))
                        return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                            override fun onOpen(webSocket: WebSocket, response: Response) {
                                webSocket.send("""{"type":"replay","seq":17,"data":""}""")
                            }
                            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                                webSocket.close(code, reason)
                            }
                        })
                    }
                    if (request.path.orEmpty().endsWith("/auth/mobile-login/refresh")) {
                        refreshCalls.incrementAndGet()
                        return MockResponse().setResponseCode(refreshStatus).setBody(
                            """{"userId":"user","role":"member","accessToken":"$validAccessToken","tokenType":"bearer","serverTime":"now"}""",
                        )
                    }
                    if (request.getHeader("Authorization") != "Bearer $validAccessToken") {
                        return MockResponse().setResponseCode(401).setBody("""{"detail":"expired"}""")
                    }
                    val body = when {
                        request.path.orEmpty().endsWith("/auth/me") -> {
                            onMe()
                            """{"userId":"user","role":"member","serverTime":"now"}"""
                        }
                        request.method == "GET" -> """{"result":{"terminals":[]}}"""
                        else -> """{"result":{"terminalId":"terminal","label":"Terminal","cwd":".","cols":80,"rows":24}}"""
                    }
                    return MockResponse().setBody(body)
                }
            }
        }
    }
}
