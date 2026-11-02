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
                "createdRuntime":false,"status":"failed","error":{"code":"busy","message":"running"},"appliedAt":null,
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
        assertEquals("failed", assignment.status)
        assertEquals("busy", assignment.errorCode)
        assertEquals("gateway refused", assignment.modelConnectionStatus?.reason)
        val link = overview.tokens!!.link!!
        assertFalse(link.linked)
        assertTrue(link.relinkSoon)
        assertEquals("a@example.com", link.accountLabel)
    }

    @Test
    fun previewTargetsKeepConfirmationAndModelLimits() {
        val target = JSONObject(
            """{"connectorId":"dev1","runtimeId":"claude","runtimeType":"claude","name":"Claude","maturity":"stable",
                "decision":"apply","offerFormat":"anthropic","effect":"restart","scope":"native_global",
                "requiresConfirmation":true,"runningSessions":2,"replaces":{"kind":"manual","profileId":null,"host":"old.example"},
                "models":{"importing":70,"existing":0,"limit":64},"tooManyModels":true,"capabilityMaturity":"beta"}""",
        ).toModelPreviewTarget()

        assertEquals("dev1/claude", target.key)
        assertTrue(target.canApply)
        assertTrue(target.requiresConfirmation)
        assertEquals(2, target.runningSessions)
        assertEquals("old.example", target.replacesHost)
        assertEquals(64, target.modelLimit)
        assertTrue(target.tooManyModels)
    }
}
