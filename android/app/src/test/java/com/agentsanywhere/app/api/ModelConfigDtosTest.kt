package com.agentsanywhere.app.api

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelConfigDtosTest {
    private val api = RealtimeApi()

    private fun snapshot(extra: String) = """
        {"type":"dashboard.snapshot","connectors":[],"projects":[],"sessions":[],
         "sessionPages":{"active":{"hasMore":false,"nextCursor":null},"archived":{"hasMore":false,"nextCursor":null}},
         "serverTime":"2026-11-02T00:00:00Z"$extra}
    """.trimIndent()

    private val piRuntime = """
        {"connectorId":"dev1","runtimeId":"pi","runtimeType":"pi","name":"Pi","displayName":"Pi",
         "present":true,"configured":true,"active":true,"status":"running","discovery":{},"uiSchema":{},
         "config":{"modelGateway":{"baseUrl":"https://gate.example/v1","protocol":"openai_chat"}},
         "secretFields":{"modelGateway.apiKey":{"set":true,"hint":"sk-gate…1234"}},
         "maturity":"beta","managedBy":"model-config","futureField":{"x":1},
         "modelConnection":{"maturity":"experimental","configField":"modelGateway","modelsField":"models",
           "protocols":["openai_chat","anthropic"],"modes":[{"id":"gateway","supported":true,"reason":null}],
           "modeField":"mode","scope":"instance","catalog":{"auto":true,"manual":false},"apply":"restart","later":true},
         "modelConnectionStatus":{"state":"applied","protocol":"openai_chat","scope":"instance","mode":null,
           "reason":null,"externalOwner":null},
         "error":null,"lastDiscoveredAt":"t","createdAt":"t","updatedAt":"t"}
    """.trimIndent()

    @Test
    fun snapshotCarriesRuntimesWithModelConnectionFields() {
        val parsed = api.parseDashboardMessage(snapshot(""","runtimes":[$piRuntime]"""))!!

        val runtime = parsed.runtimes.single()
        assertEquals("beta", runtime.maturity)
        assertEquals("model-config", runtime.managedBy)
        assertEquals("modelGateway", runtime.modelConnection?.configField)
        assertEquals("experimental", runtime.modelConnection?.maturity)
        assertEquals(listOf("openai_chat", "anthropic"), runtime.modelConnection?.protocols)
        assertTrue(runtime.modelConnection!!.catalogAuto)
        assertFalse(runtime.modelConnection!!.catalogManual)
        assertEquals("applied", runtime.modelConnectionStatus?.state)
        assertEquals(true, runtime.secretFields["modelGateway.apiKey"]?.set)
        assertEquals("sk-gate…1234", runtime.secretFields["modelGateway.apiKey"]?.hint)
        val gateway = runtime.config?.get("modelGateway") as Map<*, *>
        assertFalse("apiKey" in gateway)
    }

    @Test
    fun runtimesWithoutModelConnectionParseAsNull() {
        val plain = """{"connectorId":"dev1","runtimeId":"codex","runtimeType":"codex","status":"stopped",
            "modelConnection":null,"modelConnectionStatus":null,"maturity":null}"""
        val parsed = api.parseDashboardMessage(snapshot(""","runtimes":[$plain]"""))!!

        val runtime = parsed.runtimes.single()
        assertNull(runtime.maturity)
        assertNull(runtime.modelConnection)
        assertNull(runtime.modelConnectionStatus)
        assertTrue(runtime.secretFields.isEmpty())
    }

    @Test
    fun olderSnapshotsWithoutRuntimesOrModelConfigStillParse() {
        val parsed = api.parseDashboardMessage(snapshot(""))!!

        assertTrue(parsed.runtimes.isEmpty())
        assertNull(parsed.modelConfig)
    }

    @Test
    fun snapshotCarriesModelConfigOverview() {
        val modelConfig = """
            ,"modelConfig":{"secretConfigured":true,
              "profiles":[{"id":"p1","source":"tokens","name":"Tokens","originHost":"tokens.example",
                "offers":[{"format":"openai_chat","baseUrl":"https://tokens.example/v1",
                  "models":[{"id":"m1","name":"M1","efforts":["low"],"input":["text"]},{"id":"m2"}]}],
                "keyHint":"sk-…abcd","strategyName":null,"state":"active","etag":"3","updatedAt":"t"}],
              "assignments":[{"connectorId":"dev1","runtimeId":"pi","profileId":"p1","offerFormat":"openai_chat",
                "createdRuntime":false,"status":"outdated","error":{"code":"busy","message":"running"},"appliedAt":null,
                "modelConnectionStatus":{"state":"failed","reason":"gateway refused"}}],
              "tokens":{"available":true,"tokensUrl":"https://tokens.example","secretConfigured":true,
                "link":{"status":"reauth_required","issuer":"https://tokens.example",
                  "account":{"id":"acc","displayName":null,"email":"a@example.com"},"linkedAt":"t","relinkSoon":true}}}
        """.trimIndent()
        val overview = api.parseDashboardMessage(snapshot(modelConfig))!!.modelConfig!!

        assertTrue(overview.secretConfigured)
        val profile = overview.profiles.single()
        assertTrue(profile.isTokens)
        assertEquals("3", profile.etag)
        assertEquals(listOf("m1", "m2"), profile.offers.single().models.map { it.id })
        val assignment = overview.assignments.single()
        assertEquals("outdated", assignment.status)
        assertEquals("busy", assignment.errorCode)
        assertEquals("gateway refused", assignment.modelConnectionStatus?.reason)
        val link = overview.tokens!!.link!!
        assertFalse(link.linked)
        assertTrue(link.relinkSoon)
        assertEquals("a@example.com", link.accountLabel)
    }

    @Test
    fun snapshotCarriesChannelState() {
        val modelConfig = """
            ,"modelConfig":{"secretConfigured":true,"profiles":[],"assignments":[],
              "channel":{"channel":"tokens","revision":7,
                "switch":{"revision":7,"state":"running","startedAt":"t1","finishedAt":null},
                "runtimes":[
                  {"connectorId":"dev1","runtimeId":"codex","override":null,"desired":"tokens","actual":"native",
                   "state":"waiting_idle","step":null,"reason":null,"message":null,"runningSessions":2,"updatedAt":"t2"},
                  {"connectorId":"dev1","runtimeId":"claude","override":"mpr_1","desired":"mpr_1","actual":"native",
                   "state":"switching","step":"verifying","reason":null,"message":"checking","runningSessions":0,"updatedAt":"t3",
                   "later":true},
                  {"connectorId":"","runtimeId":"ghost","state":"applied"}]}}
        """.trimIndent()
        val channel = api.parseDashboardMessage(snapshot(modelConfig))!!.modelConfig!!.channel!!

        assertEquals("tokens", channel.channel)
        assertEquals(7L, channel.revision)
        assertEquals("running", channel.switch?.state)
        assertNull(channel.switch?.finishedAt)
        assertEquals(listOf("dev1/codex", "dev1/claude"), channel.runtimes.map { it.key })
        val codex = channel.runtimes[0]
        assertNull(codex.override)
        assertEquals("tokens", codex.desired)
        assertEquals("native", codex.actual)
        assertEquals(2, codex.runningSessions)
        val claude = channel.runtimes[1]
        assertEquals("mpr_1", claude.override)
        assertEquals("verifying", claude.step)
        assertEquals("checking", claude.message)
    }

    @Test
    fun channelStateToleratesMissingAndUnknownValues() {
        val channel = JSONObject(
            """{"switch":{"state":"paused"},"runtimes":[{"connectorId":"d","runtimeId":"r","state":"hibernating"},
                {"connectorId":"d","runtimeId":"s"}]}""",
        ).toModelChannelState()

        assertEquals("native", channel.channel)
        assertEquals(0L, channel.revision)
        assertEquals("paused", channel.switch?.state)
        assertEquals("hibernating", channel.runtimes[0].state)
        assertEquals("pending", channel.runtimes[1].state)
        assertNull(channel.runtimes[1].desired)
        assertEquals(0, channel.runtimes[1].runningSessions)

        val fresh = JSONObject("""{"channel":"native","revision":0,"switch":null,"runtimes":[]}""").toModelChannelState()
        assertNull(fresh.switch)
        assertTrue(fresh.runtimes.isEmpty())
    }

    @Test
    fun overviewFromOlderServersHasNoChannel() {
        val overview = JSONObject("""{"secretConfigured":true,"profiles":[],"assignments":[],
            "tokens":{"available":true,"channelEnabled":true,"quickSetup":{"state":"done"}}}""").toModelConfigOverview()
        assertNull(overview.channel)
        assertTrue(overview.tokens!!.available)
    }

    @Test
    fun tokensProfileCarriesPreferencesAndModelDetails() {
        val profile = JSONObject(
            """{"id":"p1","source":"tokens","name":"Tokens","originHost":"t","state":"active",
                "offers":[{"format":"openai_chat","baseUrl":"https://t/v1","models":[
                  {"id":"m1","vendor":"openai","contextWindow":400000,"maxOutputTokens":128000,"input":["text","image"]},
                  {"id":"m2","vendor":null,"contextWindow":null}]}],
                "preferences":{"disabled":["m2","m2"],"names":{"m1":"Fast","m3":null}}}""",
        ).toModelProfile()

        val (m1, m2) = profile.offers.single().models
        assertEquals("openai", m1.vendor)
        assertEquals(400_000L, m1.contextWindow)
        assertEquals(128_000L, m1.maxOutputTokens)
        assertNull(m2.vendor)
        assertNull(m2.contextWindow)
        assertEquals(listOf("m2"), profile.preferences.disabled)
        assertEquals(mapOf("m1" to "Fast"), profile.preferences.names)

        val older = JSONObject("""{"id":"p2","offers":[]}""").toModelProfile()
        assertTrue(older.preferences.disabled.isEmpty())
        assertTrue(older.preferences.names.isEmpty())

        val body = profile.preferences.toJson()
        assertEquals("m2", body.getJSONArray("disabled").getString(0))
        assertEquals("Fast", body.getJSONObject("names").getString("m1"))
    }

    @Test
    fun tokensAccountAndUsageParse() {
        val account = JSONObject(
            """{"account":{"id":"acc","displayName":null,"email":"a@example.com"},
                "balance":{"balance":"115.5000","available":"100.0000","held":"0.0000","bonus":"15.5000"},
                "links":{"console":"https://t/console","billing":"https://t/billing","usage":"https://t/usage"}}""",
        ).toTokensAccount()
        assertEquals("a@example.com", account.label)
        assertEquals("115.5000", account.balance.balance)
        assertEquals("15.5000", account.balance.bonus)
        assertEquals("https://t/billing", account.billingUrl)
        assertEquals("https://t/usage", account.usageUrl)

        val usage = JSONObject(
            """{"from":"2026-10-28","to":"2026-11-03","items":[
                {"date":"2026-11-01","model":"m1","requests":3,"inputTokens":10,"outputTokens":5,"cacheReadTokens":1,
                 "cacheWrite5mTokens":2,"cacheWrite1hTokens":3,"amountCharged":"0.0123"},
                {"date":"2026-11-02","model":null,"requests":1,"amountCharged":"0.0001"}]}""",
        ).toTokensUsage()
        assertEquals("2026-10-28", usage.from)
        assertEquals(2, usage.items.size)
        assertEquals(3L, usage.items[0].cacheWrite1hTokens)
        assertNull(usage.items[1].model)
        assertEquals(0L, usage.items[1].inputTokens)
    }
}
