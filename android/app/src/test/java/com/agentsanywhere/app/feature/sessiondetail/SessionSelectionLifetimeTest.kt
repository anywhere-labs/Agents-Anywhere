package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.SessionsApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class SessionSelectionLifetimeTest {
    @Test
    fun returningSendWaitsForASelectionWrittenByTheDepartedView() = runBlocking {
        val server = MockWebServer()
        val releaseSelection = CountDownLatch(1)
        val selectionStarted = CountDownLatch(1)
        val messageStarted = CountDownLatch(1)
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path.orEmpty().endsWith("/runtime/selections")) {
                    selectionStarted.countDown()
                    releaseSelection.await(5, TimeUnit.SECONDS)
                } else if (request.path.orEmpty().endsWith("/runtime/messages")) {
                    messageStarted.countDown()
                }
                return MockResponse().setHeader("Content-Type", "application/json").setBody("""{"ok":true}""")
            }
        }
        server.start()
        val controller = SessionDetailController(SessionsApi(), object : AuthSessionReader {
            override fun readServerUrl() = "http://127.0.0.1:${server.port}"
            override fun readAccessToken() = "token"
        })
        try {
            withTimeout(5_000) {
                val departed = launch { controller.updateSelections("a", mapOf("model" to "new-model")) }
                assertTrue(withContext(Dispatchers.IO) { selectionStarted.await(3, TimeUnit.SECONDS) })
                departed.cancelAndJoin()
                val send = async(Dispatchers.IO) { controller.sendMessage("a", "hello", "message-id") }
                assertFalse(withContext(Dispatchers.IO) { messageStarted.await(150, TimeUnit.MILLISECONDS) })
                releaseSelection.countDown()
                assertTrue(send.await().isSuccess)
                assertTrue(messageStarted.await(1, TimeUnit.SECONDS))
            }
        } finally {
            releaseSelection.countDown()
            controller.dispose()
            server.shutdown()
        }
    }
}
