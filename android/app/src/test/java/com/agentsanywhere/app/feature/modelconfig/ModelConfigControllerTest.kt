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
    fun retryTargetsTheRightRuntimes() = withServer { controller, requests ->
        runBlocking {
            controller.retryChannel().getOrThrow()
            controller.retryChannel("dev 1", "codex").getOrThrow()
            controller.channel().getOrThrow()
        }

        assertEquals(listOf("POST", "POST", "GET"), requests.map { it.method })
        assertEquals(
            listOf(
                "/api/v2/model-config/channel/retry",
                "/api/v2/model-config/channel/retry",
                "/api/v2/model-config/channel",
            ),
            requests.map { it.path },
        )
        assertEquals(0, JSONObject(requests[0].body).length())
        val one = JSONObject(requests[1].body)
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

    private val createdProfile = """
        {"id":"mpr_1","name":"Gate","source":"manual","state":"active","revision":1,"keyHint":"sk-…1",
         "offers":[{"format":"openai_chat","baseUrl":"https://gate.example/v1","models":[{"id":"gpt-5"}]}]}
    """.trimIndent()

    @Test
    fun automaticProfilesSendOnlyTheAddress() = withServer(
        respond = { MockResponse().setResponseCode(201).setBody(createdProfile) },
    ) { controller, requests ->
        val draft = ManualProfileDraft(name = " Gate ", apiKey = " sk-1 ", baseUrl = " https://gate.example/v1 ")
        runBlocking { controller.createProfile(draft) }.getOrThrow()

        val request = requests.single()
        assertEquals("POST", request.method)
        assertEquals("/api/v2/model-profiles", request.path)
        val body = JSONObject(request.body)
        assertEquals(setOf("name", "apiKey", "baseUrl"), body.keys().asSequence().toSet())
        assertEquals("Gate", body.getString("name"))
        assertEquals("sk-1", body.getString("apiKey"))
        assertEquals("https://gate.example/v1", body.getString("baseUrl"))
    }

    @Test
    fun manualProfilesSendTheOffersWithoutAnAddress() = withServer(
        respond = { MockResponse().setResponseCode(201).setBody(createdProfile) },
    ) { controller, requests ->
        val draft = ManualProfileDraft(name = "Gate", apiKey = "sk-1", baseUrl = "https://gate.example/v1")
            .toManual()
            .withOffer("anthropic") { it.copy(enabled = true, models = "claude\nhaiku") }
        runBlocking { controller.createProfile(draft) }.getOrThrow()

        val body = JSONObject(requests.single().body)
        assertEquals(setOf("name", "apiKey", "offers"), body.keys().asSequence().toSet())
        val offers = body.getJSONArray("offers")
        assertEquals(2, offers.length())
        val chat = offers.getJSONObject(0)
        assertEquals("openai_chat", chat.getString("format"))
        assertEquals("https://gate.example/v1", chat.getString("baseUrl"))
        assertEquals(0, chat.getJSONArray("models").length())
        val anthropic = offers.getJSONObject(1)
        assertEquals("anthropic", anthropic.getString("format"))
        assertEquals("https://gate.example", anthropic.getString("baseUrl"))
        assertEquals("claude", anthropic.getJSONArray("models").getJSONObject(0).getString("id"))
    }

    @Test
    fun detectionFailuresKeepTheirCode() = withServer(
        respond = {
            MockResponse().setResponseCode(422)
                .setBody("""{"detail":{"code":"gateway_unreachable","message":"Could not reach it."}}""")
        },
    ) { controller, _ ->
        val draft = ManualProfileDraft(name = "Gate", apiKey = "sk-1", baseUrl = "https://gate.example/v1")
        val error = runBlocking { controller.createProfile(draft) }.exceptionOrNull()
        val code = modelConfigErrorCode(error!!)
        assertEquals("gateway_unreachable", code)
        assertTrue(code in GATEWAY_MANUAL_FALLBACK_CODES)
        assertFalse("gateway_key_rejected" in GATEWAY_MANUAL_FALLBACK_CODES)
        assertTrue("gateway_key_rejected" in GATEWAY_ERROR_CODES)
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
