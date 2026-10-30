package com.agentsanywhere.app.api

import com.agentsanywhere.app.feature.auth.MobileAuthSession
import com.agentsanywhere.app.feature.auth.MobileAuthSessionRefresher
import com.agentsanywhere.app.feature.auth.MobileAuthSessionStore
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class ApiClientMobileRefreshTest {
    @Test
    fun expiredAccessTokenRefreshesAndRetries() = withServer { server ->
        val client = server.client()
        assertTrue(client.getJson(server.origin, "/sessions", "expired").getBoolean("ok"))
        assertEquals(listOf("Bearer expired", "Bearer renewed"), server.authorizations)
        assertEquals(1, server.refreshCalls.get())
        assertEquals("renewed", server.store.readMobileAuthSession().accessToken)
        assertEquals("refresh", server.store.readMobileAuthSession().refreshToken)
        assertTrue(server.unauthorized.isEmpty())
        assertEquals("refresh", JSONObject(server.refreshBodies.single()).getString("refreshToken"))
        assertEquals(listOf<String?>(null), server.refreshAuthorizations)
    }

    @Test
    fun retryPreservesJsonMethodAndBody() = withServer { server ->
        val body = JSONObject().put("message", "hello")
        server.client().postJson(server.origin, "/sessions", body, "expired")
        assertEquals(listOf("POST", "POST"), server.methods)
        assertEquals(listOf(body.toString(), body.toString()), server.bodies)
    }

    @Test
    fun multipartAlsoRefreshesAndRetries() = withServer { server ->
        server.client().postMultipart(
            server.origin, "/upload", listOf(UploadFilePart("note.txt", "text/plain", "hello".toByteArray())), "expired",
        )
        assertEquals(listOf("Bearer expired", "Bearer renewed"), server.authorizations)
        assertEquals(1, server.refreshCalls.get())
        assertTrue(server.bodies.all { it.contains("filename=\"note.txt\"") && it.contains("hello") })
        assertTrue(server.unauthorized.isEmpty())
    }

    @Test
    fun concurrent401sShareOneRefresh() = withServer { server ->
        server.expiredRequests = CountDownLatch(2)
        val client = server.client()
        val workers = Executors.newFixedThreadPool(2)
        try {
            val requests = (1..2).map {
                workers.submit<Boolean> { client.getJson(server.origin, "/sessions", "expired").getBoolean("ok") }
            }
            requests.forEach { assertTrue(it.get(10, TimeUnit.SECONDS)) }
        } finally {
            workers.shutdownNow()
        }
        assertEquals(1, server.refreshCalls.get())
        assertEquals(2, server.authorizations.count { it == "Bearer renewed" })
        assertTrue(server.unauthorized.isEmpty())
    }

    @Test
    fun missingRefreshTokenNotifiesUnauthorizedWithoutRetry() = withServer { server ->
        server.store.session = server.store.session.copy(refreshToken = "")
        assertEquals(401, failure { server.client().getJson(server.origin, "/sessions", "expired") }.statusCode)
        assertEquals(0, server.refreshCalls.get())
        assertEquals(listOf("expired"), server.unauthorized)
        assertEquals(1, server.authorizations.size)
    }

    @Test
    fun rejectedRefreshNotifiesUnauthorized() {
        listOf(401, 403).forEach { status ->
            withServer { server ->
                server.refreshStatus = status
                assertEquals(401, failure { server.client().getJson(server.origin, "/sessions", "expired") }.statusCode)
                assertEquals(listOf("expired"), server.unauthorized)
                assertEquals(1, server.refreshCalls.get())
                assertEquals(1, server.authorizations.size)
            }
        }
    }

    @Test
    fun retry401StopsAndNotifiesForRenewedToken() = withServer { server ->
        server.renewedStatus = 401
        assertEquals(401, failure { server.client().getJson(server.origin, "/sessions", "expired") }.statusCode)
        assertEquals(1, server.refreshCalls.get())
        assertEquals(listOf("Bearer expired", "Bearer renewed"), server.authorizations)
        assertEquals(listOf("renewed"), server.unauthorized)
    }

    @Test
    fun temporaryRefreshFailurePreservesSession() = withServer { server ->
        val original = server.store.session
        server.refreshStatus = 503
        assertEquals(503, failure { server.client().getJson(server.origin, "/sessions", "expired") }.statusCode)
        assertEquals(original, server.store.session)
        assertTrue(server.unauthorized.isEmpty())
    }

    @Test
    fun networkRefreshFailurePreservesSession() = withServer { server ->
        val original = server.store.session
        server.disconnectRefresh = true
        assertNull(failure { server.client().getJson(server.origin, "/sessions", "expired") }.statusCode)
        assertEquals(original, server.store.session)
        assertTrue(server.unauthorized.isEmpty())
    }

    @Test
    fun anonymous401DoesNotRefreshOrSignOut() = withServer { server ->
        assertEquals(401, failure { server.client().getJson(server.origin, "/sessions") }.statusCode)
        assertEquals(0, server.refreshCalls.get())
        assertTrue(server.unauthorized.isEmpty())
    }

    @Test
    fun permissionFailureDoesNotRefreshOrSignOut() = withServer { server ->
        server.expiredStatus = 403
        assertEquals(403, failure { server.client().getJson(server.origin, "/sessions", "expired") }.statusCode)
        assertEquals(0, server.refreshCalls.get())
        assertTrue(server.unauthorized.isEmpty())
    }

    @Test
    fun refreshCannotRestoreSessionAfterSignOut() = withServer { server ->
        server.onRefresh = { server.store.session = MobileAuthSession(server.origin, "", "") }
        assertEquals(401, failure { server.client().getJson(server.origin, "/sessions", "expired") }.statusCode)
        assertEquals("", server.store.session.accessToken)
        assertEquals(1, server.authorizations.size)
    }

    @Test
    fun refreshCannotOverwriteNewLogin() = withServer { server ->
        val newLogin = server.store.session.copy(accessToken = "other-account", refreshToken = "other-refresh")
        server.onRefresh = { server.store.session = newLogin }
        assertEquals(401, failure { server.client().getJson(server.origin, "/sessions", "expired") }.statusCode)
        assertEquals(newLogin, server.store.session)
        assertEquals(1, server.authorizations.size)
    }

    @Test
    fun refreshCannotOverwriteChangedServer() = withServer { server ->
        val newServer = server.store.session.copy(serverUrl = "https://other.example")
        server.onRefresh = { server.store.session = newServer }
        assertEquals(401, failure { server.client().getJson(server.origin, "/sessions", "expired") }.statusCode)
        assertEquals(newServer, server.store.session)
    }

    @Test
    fun differentServerDoesNotReceiveRefreshToken() = withServer { server ->
        val refresher = MobileAuthSessionRefresher(server.store)
        assertNull(refresher.refreshAccessToken("https://other.example", "expired"))
        assertEquals(0, server.refreshCalls.get())
    }

    @Test
    fun delayed401AfterAccountSwitchDoesNotRetryWithOtherAccount() = withServer { server ->
        val client = server.client()
        client.getJson(server.origin, "/sessions", "expired")
        server.store.session = server.store.session.copy(accessToken = "other-account")
        assertEquals(401, failure { client.getJson(server.origin, "/sessions", "expired") }.statusCode)
        assertEquals(1, server.refreshCalls.get())
        assertFalse(server.authorizations.contains("Bearer other-account"))
        assertEquals("other-account", server.store.session.accessToken)
    }

    private fun failure(request: () -> Unit): ApiException {
        val error = runCatching(request).exceptionOrNull()
        assertTrue("Expected ApiException, got $error", error is ApiException)
        return error as ApiException
    }

    private fun withServer(test: (TestServer) -> Unit) {
        val server = TestServer()
        try {
            test(server)
        } finally {
            server.close()
        }
    }

    private class MemorySessionStore(@Volatile var session: MobileAuthSession) : MobileAuthSessionStore {
        override fun readMobileAuthSession(): MobileAuthSession = session

        @Synchronized
        override fun saveRefreshedAuthSession(session: MobileAuthSession, auth: AuthResponse): Boolean {
            if (this.session != session) return false
            this.session = session.copy(accessToken = auth.accessToken)
            return true
        }
    }

    private class TestServer {
        private val http = MockWebServer().apply { start() }
        val origin = http.url("/").toString().trimEnd('/')
        val store = MemorySessionStore(MobileAuthSession(origin, "expired", "refresh"))
        val refreshCalls = AtomicInteger()
        val authorizations = Collections.synchronizedList(mutableListOf<String?>())
        val refreshAuthorizations = Collections.synchronizedList(mutableListOf<String?>())
        val methods = Collections.synchronizedList(mutableListOf<String>())
        val bodies = Collections.synchronizedList(mutableListOf<String>())
        val refreshBodies = Collections.synchronizedList(mutableListOf<String>())
        val unauthorized = Collections.synchronizedList(mutableListOf<String>())
        var refreshStatus = 200
        var expiredStatus = 401
        var renewedStatus = 200
        var disconnectRefresh = false
        var expiredRequests: CountDownLatch? = null
        var onRefresh: () -> Unit = {}

        init {
            http.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    val authorization = request.getHeader("Authorization")
                    val requestBody = request.body.readUtf8()
                    val status: Int
                    val response: String
                    if (request.path.orEmpty().endsWith("/auth/mobile-login/refresh")) {
                        refreshCalls.incrementAndGet()
                        refreshBodies.add(requestBody)
                        refreshAuthorizations.add(authorization)
                        onRefresh()
                        if (disconnectRefresh) {
                            return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                        }
                        status = refreshStatus
                        response = if (status == 200) {
                            """{"userId":"user","role":"member","accessToken":"renewed","tokenType":"bearer","serverTime":"2026-10-03T00:00:00Z"}"""
                        } else {
                            """{"detail":"refresh failed"}"""
                        }
                    } else {
                        authorizations.add(authorization)
                        methods.add(request.method.orEmpty())
                        bodies.add(requestBody)
                        if (authorization == "Bearer expired") {
                            expiredRequests?.let { barrier ->
                                barrier.countDown()
                                check(barrier.await(5, TimeUnit.SECONDS))
                            }
                        }
                        status = if (authorization == "Bearer renewed") renewedStatus else expiredStatus
                        response = if (status == 200) """{"ok":true}""" else """{"detail":"unauthorized"}"""
                    }
                    return MockResponse().setResponseCode(status)
                        .setHeader("Content-Type", "application/json")
                        .setBody(response)
                }
            }
        }

        fun client(): ApiClient {
            val refresher = MobileAuthSessionRefresher(store)
            return ApiClient(
                onUnauthorized = { unauthorized.add(it) },
                refreshAccessToken = refresher::refreshAccessToken,
            )
        }

        fun close() {
            http.shutdown()
        }
    }
}
