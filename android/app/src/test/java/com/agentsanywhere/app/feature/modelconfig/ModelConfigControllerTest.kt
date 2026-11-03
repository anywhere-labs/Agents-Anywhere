package com.agentsanywhere.app.feature.modelconfig

import com.agentsanywhere.app.api.ApiClient
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.ModelConfigApi
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections

class ModelConfigControllerTest {
    private class Recorded(val method: String, val path: String, val body: String)

    private val channelState = """
        {"channel":"mpr_1","revision":8,"switch":{"revision":8,"state":"running","startedAt":"t","finishedAt":null},
         "runtimes":[{"connectorId":"dev 1","runtimeId":"codex","override":null,"desired":"mpr_1","actual":"native",
           "state":"pending","step":null,"reason":null,"message":null,"runningSessions":0,"updatedAt":"t"}]}
    """.trimIndent()

    private fun withServer(
        respond: (RecordedRequest) -> MockResponse = { MockResponse().setBody(channelState) },
        block: (ModelConfigController, List<Recorded>) -> Unit,
    ) {
        val requests = Collections.synchronizedList(mutableListOf<Recorded>())
        val server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += Recorded(request.method.orEmpty(), request.path.orEmpty(), request.body.readUtf8())
                return respond(request).setHeader("Content-Type", "application/json")
            }
        }
        server.start()
        try {
            val origin = server.url("/").toString().trimEnd('/')
            val session = object : AuthSessionReader {
                override fun readServerUrl(): String = origin
                override fun readAccessToken(): String = "token"
            }
            block(ModelConfigController(ModelConfigApi(ApiClient()), session), requests)
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun settingTheCurrentChannelReturnsTheNewState() = withServer { controller, requests ->
        val state = runBlocking { controller.setChannel("mpr_1") }.getOrThrow()

        assertEquals("mpr_1", state.channel)
        assertEquals("running", state.switch?.state)
        assertEquals("pending", state.runtimes.single().state)
        val request = requests.single()
        assertEquals("PUT", request.method)
        assertEquals("/api/v2/model-config/channel", request.path)
        assertEquals("mpr_1", JSONObject(request.body).getString("channel"))
    }

    @Test
    fun runtimeOverridesSendNullToFollowAndConfirmGlobalChanges() = withServer { controller, requests ->
        runBlocking {
            controller.setRuntimeChannel("dev 1", "codex", null).getOrThrow()
            controller.setRuntimeChannel("dev 1", "claude", "tokens", confirmNativeGlobal = true).getOrThrow()
        }

        val (follow, own) = requests
        assertEquals("PUT", follow.method)
        assertEquals("/api/v2/model-config/channel/runtimes/dev%201/codex", follow.path)
        val followBody = JSONObject(follow.body)
        assertTrue(followBody.has("channel") && followBody.isNull("channel"))
        assertFalse(followBody.has("confirmNativeGlobal"))
        val ownBody = JSONObject(own.body)
        assertEquals("tokens", ownBody.getString("channel"))
        assertTrue(ownBody.getBoolean("confirmNativeGlobal"))
    }

    @Test
    fun switchNowAndRetryTargetTheRightRuntimes() = withServer { controller, requests ->
        runBlocking {
            controller.switchNow("dev 1", "codex").getOrThrow()
            controller.retryChannel().getOrThrow()
            controller.retryChannel("dev 1", "codex").getOrThrow()
            controller.channel().getOrThrow()
        }

        assertEquals(listOf("POST", "POST", "POST", "GET"), requests.map { it.method })
        assertEquals(
            listOf(
                "/api/v2/model-config/channel/runtimes/dev%201/codex/switch-now",
                "/api/v2/model-config/channel/retry",
                "/api/v2/model-config/channel/retry",
                "/api/v2/model-config/channel",
            ),
            requests.map { it.path },
        )
        assertEquals(0, JSONObject(requests[1].body).length())
        val one = JSONObject(requests[2].body)
        assertEquals("dev 1", one.getString("connectorId"))
        assertEquals("codex", one.getString("runtimeId"))
    }

    @Test
    fun rotatingTheKeySendsOnlyTheInterruptChoice() = withServer(respond = { MockResponse().setBody("{}") }) { controller, requests ->
        runBlocking { controller.rotateTokensKey("mpr_t", allowInterrupt = true) }.getOrThrow()

        val request = requests.single()
        assertEquals("/api/v2/model-profiles/mpr_t/rotate-key", request.path)
        assertTrue(JSONObject(request.body).getBoolean("allowInterrupt"))
    }

    @Test
    fun unlinkingNoLongerAsksToInterrupt() = withServer(respond = { MockResponse().setBody("""{"revoked":true}""") }) { controller, requests ->
        assertTrue(runBlocking { controller.unlinkTokens() }.getOrThrow())
        assertEquals("DELETE", requests.single().method)
        assertEquals("/api/v2/integrations/tokens/link", requests.single().path)
    }

    @Test
    fun serverErrorsKeepTheirCode() = withServer(
        respond = {
            MockResponse().setResponseCode(409).setBody("""{"detail":{"code":"tokens_not_linked","message":"Link first."}}""")
        },
    ) { controller, _ ->
        val error = runBlocking { controller.setChannel("tokens") }.exceptionOrNull()
        assertTrue(error is ApiException)
        assertEquals("tokens_not_linked", modelConfigErrorCode(error!!))
    }
}
