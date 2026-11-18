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

    private fun confirmationResult(confirmation: Map<String, Any?>) = mapOf(
        "executionState" to "completed",
        "confirmation" to confirmation,
    )

    private val ownerRelease = mapOf(
        "kind" to "owner_release",
        "planId" to "plan-1",
        "expiresAt" to "2026-11-18T10:00:00Z",
        "appName" to "Codex App",
        "processCount" to 3,
        "releasesOtherSessions" to true,
        "gracePeriodMs" to 10_500,
        "confirmArgs" to listOf("confirm", "plan-1"),
        "forceArgs" to listOf("confirm", "plan-1", "--force"),
        "cancelArgs" to listOf("cancel", "plan-1"),
    )

    @Test
    fun confirmationRequiredIsParsedInsteadOfShownAsFailure() {
        val outcome = RuntimeCommandOutcome.fromResponse(
            ok = false,
            code = "confirmation_required",
            message = "summary",
            result = confirmationResult(ownerRelease),
            command = "quit-codex-app",
        )
        val confirmation = outcome.confirmation!!
        assertFalse(outcome.ok)
        assertEquals("quit-codex-app", confirmation.command)
        assertEquals("plan-1", confirmation.planId)
        assertEquals("Codex App", confirmation.appName)
        assertEquals(3, confirmation.processCount)
        assertTrue(confirmation.releasesOtherSessions)
        assertEquals(11, confirmation.gracePeriodSeconds)
        assertEquals("2026-11-18T10:00:00Z", confirmation.expiresAt)
        assertTrue(confirmation.canForce)
    }

    @Test
    fun confirmationNeedsTheCodeAndAKnownPlan() {
        val otherCode = RuntimeCommandOutcome.fromResponse(false, "app_not_running", "x", confirmationResult(ownerRelease), "quit-codex-app")
        assertNull(otherCode.confirmation)
        val notNeeded = RuntimeCommandOutcome.fromResponse(true, null, "x", mapOf("status" to "not_needed"), "quit-codex-app")
        assertNull(notNeeded.confirmation)
        assertNull(RuntimeCommandConfirmation.parse("quit-codex-app", "confirmation_required", mapOf("executionState" to "completed")))
        assertNull(RuntimeCommandConfirmation.parse("quit-codex-app", "confirmation_required", confirmationResult(ownerRelease + ("kind" to "wizard"))))
        assertNull(RuntimeCommandConfirmation.parse("quit-codex-app", "confirmation_required", confirmationResult(ownerRelease - "planId")))
        assertNull(RuntimeCommandConfirmation.parse("quit-codex-app", "confirmation_required", confirmationResult(ownerRelease + ("confirmArgs" to emptyList<String>()))))
        assertNull(RuntimeCommandConfirmation.parse("", "confirmation_required", confirmationResult(ownerRelease)))
    }

    @Test
    fun confirmationFollowUpsRepeatTheCommandWithDeviceArgs() {
        val confirmation = RuntimeCommandConfirmation.parse("quit-codex-app", "confirmation_required", confirmationResult(ownerRelease))!!
        assertEquals(
            RuntimeCommandRequest("quit-codex-app", listOf("confirm", "plan-1"), ""),
            confirmation.confirmRequest(force = false),
        )
        assertEquals(
            RuntimeCommandRequest("quit-codex-app", listOf("confirm", "plan-1", "--force"), ""),
            confirmation.confirmRequest(force = true),
        )
        assertEquals(
            RuntimeCommandRequest("quit-codex-app", listOf("cancel", "plan-1"), ""),
            confirmation.cancelRequest(),
        )

        val noForce = RuntimeCommandConfirmation.parse(
            "quit-codex-app",
            "confirmation_required",
            confirmationResult(ownerRelease - "forceArgs" - "cancelArgs"),
        )!!
        assertFalse(noForce.canForce)
        assertEquals(listOf("confirm", "plan-1"), noForce.confirmRequest(force = true).args)
        assertNull(noForce.cancelRequest())
    }
}
