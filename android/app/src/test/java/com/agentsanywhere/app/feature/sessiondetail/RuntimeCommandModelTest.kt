package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.ApiException
import java.io.IOException
import java.net.ConnectException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeCommandModelTest {
    private fun command(
        id: String,
        aliases: List<String> = emptyList(),
        enabled: Boolean = true,
        acceptsArgs: Boolean = false,
        argsSchema: Map<String, Any?>? = null,
        metadata: Map<String, Any?> = emptyMap(),
    ) = RuntimeCommand(
        id = id,
        title = id.replaceFirstChar(Char::uppercase),
        description = null,
        aliases = aliases,
        category = null,
        scope = "session",
        enabled = enabled,
        disabledReason = null,
        acceptsArgs = acceptsArgs,
        argsSchema = argsSchema,
        metadata = metadata,
    )

    private val catalog = listOf(
        command("compact"),
        command("review", aliases = listOf("r"), acceptsArgs = true),
    )

    @Test
    fun pathsAndProseAreNotCommands() {
        assertFalse(SlashIntent.parse("/Users/me/file.txt")!!.isCommandLike)
        assertNull(SlashIntent.parse("fix the /compact bug"))
        assertNull(catalog.exact(SlashIntent.parse("/compactx")!!))
        assertNull(catalog.exact(SlashIntent.parse("/tmp/log")!!))
    }

    @Test
    fun exactMatchUsesIdOrAliasCaseInsensitively() {
        assertEquals("compact", catalog.exact(SlashIntent.parse("  /COMPACT")!!)?.id)
        assertEquals("review", catalog.exact(SlashIntent.parse("/r main")!!)?.id)
    }

    @Test
    fun suggestionsMatchPrefixes() {
        assertEquals(listOf("compact"), catalog.filter { it.matchesPrefix("comp") }.map { it.id })
        assertEquals(2, catalog.count { it.matchesPrefix("") })
        assertTrue(catalog.none { it.matchesPrefix("act") })
    }

    @Test
    fun requestSplitsArgsUnlessSchemaIsString() {
        val review = catalog[1]
        assertEquals(listOf("main", "--fast"), review.request(SlashIntent.parse("/review main  --fast")!!)?.args)
        val goal = command("goal", acceptsArgs = true, argsSchema = mapOf("type" to "string"))
        assertEquals(listOf("ship  it "), goal.request(SlashIntent.parse("/goal ship  it ")!!)?.args)
    }

    @Test
    fun requestRejectsUnexpectedArgsAndMultiline() {
        assertNull(catalog[0].request(SlashIntent.parse("/compact now")!!))
        assertNull(catalog[1].request(SlashIntent.parse("/review a\nb")!!))
        val multiline = command(
            "note",
            acceptsArgs = true,
            argsSchema = mapOf("type" to "string"),
            metadata = mapOf("ui" to mapOf("kind" to "execute", "acceptsMultiline" to true)),
        )
        assertEquals(listOf("a\nb"), multiline.request(SlashIntent.parse("/note a\nb")!!)?.args)
    }

    @Test
    fun uiMetadataControlsStatusesAndSelectors() {
        val plain = catalog[0]
        assertTrue(plain.allowed(SessionRuntimeStatus.Idle))
        assertFalse(plain.allowed(SessionRuntimeStatus.Running))
        val busyOk = command(
            "stop",
            metadata = mapOf("ui" to mapOf("kind" to "execute", "allowedStatuses" to listOf("running"))),
        )
        assertTrue(busyOk.allowed(SessionRuntimeStatus.Running))
        assertFalse(busyOk.allowed(SessionRuntimeStatus.Idle))
        val selector = command("model", metadata = mapOf("ui" to mapOf("kind" to "selector", "target" to "model")))
        assertEquals(RuntimeCommandUi.Selector("model"), selector.ui)
        val unknown = command("x", metadata = mapOf("ui" to mapOf("kind" to "wizard")))
        assertEquals(RuntimeCommandBlock.Disabled, unknown.block(SessionRuntimeStatus.Idle, true, true, true))
    }

    @Test
    fun blockOrderPrefersDisabledThenOfflineThenCapability() {
        val disabled = command("compact", enabled = false)
        assertEquals(RuntimeCommandBlock.Disabled, disabled.block(SessionRuntimeStatus.Running, false, false, false))
        val plain = catalog[0]
        assertEquals(RuntimeCommandBlock.Offline, plain.block(SessionRuntimeStatus.Running, false, false, false))
        assertEquals(RuntimeCommandBlock.Unavailable, plain.block(SessionRuntimeStatus.Running, false, false, true))
        assertEquals(RuntimeCommandBlock.ReadOnly, plain.block(SessionRuntimeStatus.Running, true, false, true))
        assertEquals(RuntimeCommandBlock.Busy, plain.block(SessionRuntimeStatus.Running, true, true, true))
        assertNull(plain.block(SessionRuntimeStatus.Idle, true, true, true))
    }

    @Test
    fun outcomeDistinguishesUnknownResults() {
        val completed = RuntimeCommandOutcome.fromResponse(true, null, "ok", mapOf("executionState" to "completed", "text" to "done"))
        assertTrue(completed.ok)
        assertEquals(RuntimeCommandExecutionState.Completed, completed.state)
        assertEquals("done", completed.message)

        val unknown = RuntimeCommandOutcome.fromResponse(true, null, null, mapOf("executionState" to "unknown"))
        assertFalse(unknown.ok)
        assertEquals(RuntimeCommandExecutionState.Unknown, unknown.state)

        val rejected = RuntimeCommandOutcome.fromTransportFailure(ApiException("bad", statusCode = 400))
        assertEquals(RuntimeCommandExecutionState.Completed, rejected.state)
        val unsent = RuntimeCommandOutcome.fromTransportFailure(IOException("x", ConnectException()))
        assertEquals(RuntimeCommandExecutionState.Completed, unsent.state)
        val timeout = RuntimeCommandOutcome.fromTransportFailure(ApiException("timeout", statusCode = 504))
        assertEquals(RuntimeCommandExecutionState.Unknown, timeout.state)
        assertEquals("command_outcome_unknown", timeout.code)
    }
}
