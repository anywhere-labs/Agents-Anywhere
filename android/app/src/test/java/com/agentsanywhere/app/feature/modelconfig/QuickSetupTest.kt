package com.agentsanywhere.app.feature.modelconfig

import com.agentsanywhere.app.api.RemoteModelPreviewTarget
import com.agentsanywhere.app.api.toQuickSetupProgress
import com.agentsanywhere.app.model.ModelTarget
import com.agentsanywhere.app.model.QuickSetupProgress
import com.agentsanywhere.app.model.QuickSetupRequest
import com.agentsanywhere.app.model.TokensLink
import com.agentsanywhere.app.model.TokensLinkStatus
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QuickSetupTest {
    private fun link(status: String) = TokensLink(status, null, "acc", null, null, null, relinkSoon = false)

    private fun tokens(linkStatus: String?, state: String? = null, step: String? = null) = TokensLinkStatus(
        available = true,
        tokensUrl = null,
        secretConfigured = true,
        link = linkStatus?.let(::link),
        quickSetup = state?.let {
            QuickSetupProgress(it, QuickSetupRequest(emptyList(), false), null, step, null, emptyList())
        },
    )

    private fun candidate(
        connectorId: String,
        runtimeId: String,
        decision: String = "apply",
        requiresConfirmation: Boolean = false,
        effect: String? = "restart",
        runningSessions: Int = 0,
        reason: String? = null,
    ) = RemoteModelPreviewTarget(
        connectorId = connectorId,
        runtimeId = runtimeId,
        runtimeType = runtimeId,
        name = null,
        maturity = null,
        decision = decision,
        reason = reason,
        offerFormat = null,
        effect = effect,
        scope = null,
        requiresConfirmation = requiresConfirmation,
        runningSessions = runningSessions,
        replacesHost = null,
        modelLimit = null,
        tooManyModels = false,
        capabilityMaturity = null,
    )

    @Test
    fun theCardShowsChoosingProgressOrDone() {
        assertEquals(QuickSetupPhase.Setup, quickSetupPhase(tokens(null), configured = false, authorizing = false))
        assertEquals(QuickSetupPhase.Progress, quickSetupPhase(tokens(null), configured = false, authorizing = true))
        assertEquals(QuickSetupPhase.Progress, quickSetupPhase(tokens("linked", "syncing"), configured = false, authorizing = false))
        assertEquals(QuickSetupPhase.Progress, quickSetupPhase(tokens("linked", "failed", "apply"), configured = true, authorizing = false))
        assertEquals(QuickSetupPhase.Done, quickSetupPhase(tokens("linked", "done"), configured = false, authorizing = false))
        assertEquals(QuickSetupPhase.Done, quickSetupPhase(tokens("linked"), configured = true, authorizing = false))
        // A linked account shows its page even before any runtime uses it.
        assertEquals(QuickSetupPhase.Done, quickSetupPhase(tokens("linked"), configured = false, authorizing = false))
        // Changing models on a configured account keeps the account page in view.
        assertEquals(QuickSetupPhase.Done, quickSetupPhase(tokens("linked", "applying"), configured = true, authorizing = false))
        assertEquals(QuickSetupPhase.Setup, quickSetupPhase(tokens("reauth_required"), configured = true, authorizing = false))
    }

    @Test
    fun aSetupOrModelChangeRunsWhileSyncingOrApplying() {
        assertTrue(quickSetupRunning(tokens("linked", "syncing")))
        assertTrue(quickSetupRunning(tokens("linked", "applying")))
        assertFalse(quickSetupRunning(tokens("linked", "done")))
        assertFalse(quickSetupRunning(tokens("linked", "failed", "apply")))
        assertFalse(quickSetupRunning(tokens("linked")))
    }

    @Test
    fun eachStepReadsFromTheLinkAndItsProgress() {
        fun steps(vararg values: QuickStepStatus) = QuickSetupSteps(values[0], values[1], values[2])
        assertEquals(steps(QuickStepStatus.Active, QuickStepStatus.Pending, QuickStepStatus.Pending), quickSetupSteps(tokens(null), authorizing = true))
        assertEquals(steps(QuickStepStatus.Done, QuickStepStatus.Active, QuickStepStatus.Pending), quickSetupSteps(tokens("linked", "syncing"), false))
        assertEquals(steps(QuickStepStatus.Done, QuickStepStatus.Failed, QuickStepStatus.Pending), quickSetupSteps(tokens("linked", "failed", "sync"), false))
        assertEquals(steps(QuickStepStatus.Done, QuickStepStatus.Done, QuickStepStatus.Active), quickSetupSteps(tokens("linked", "applying"), false))
        assertEquals(steps(QuickStepStatus.Done, QuickStepStatus.Done, QuickStepStatus.Failed), quickSetupSteps(tokens("linked", "failed", "apply"), false))
        assertEquals(steps(QuickStepStatus.Done, QuickStepStatus.Pending, QuickStepStatus.Pending), quickSetupSteps(tokens("linked"), false))
    }

    @Test
    fun runtimesChangingTheirOwnSettingsAreNotTickedByDefault() {
        val candidates = listOf(
            candidate("c", "codex"),
            candidate("c", "dsh", requiresConfirmation = true),
            candidate("d", "codex", decision = "skip", reason = "device_offline"),
        )
        assertEquals(setOf("c/codex"), defaultQuickSelection(candidates))
    }

    @Test
    fun aRuntimeServedByAManagedInstanceIsNotNew() {
        val candidates = listOf(
            candidate("c", "codex"),
            candidate("c", "pi", effect = "new_instance"),
            candidate("c", "claude"),
        )
        val assigned = listOf(
            QuickAssigned("c", "codex", null, createdRuntime = false),
            QuickAssigned("c", "pi-managed", "pi", createdRuntime = true),
        )
        assertEquals(listOf("claude"), newQuickCandidates(candidates, assigned).map { it.runtimeId })
    }

    @Test
    fun tickingAGlobalChangeConfirmsIt() {
        val candidates = listOf(
            candidate("c", "codex"),
            candidate("c", "claude", requiresConfirmation = true),
            candidate("d", "pi", decision = "skip"),
        )
        val plain = quickSetupRequest(candidates, setOf("c/codex", "d/pi"))
        assertEquals(listOf(ModelTarget("c", "codex")), plain.targets)
        assertFalse(plain.confirmNativeGlobal)

        val global = quickSetupRequest(candidates, setOf("c/codex", "c/claude"))
        assertEquals(2, global.targets.size)
        assertTrue(global.confirmNativeGlobal)
    }

    @Test
    fun candidateNotesFollowTheirFields() {
        assertEquals(QuickCandidateNote.Skipped("device_offline"), quickCandidateNote(candidate("c", "x", decision = "skip", reason = "device_offline")))
        assertEquals(QuickCandidateNote.ChangesOwnSettings, quickCandidateNote(candidate("c", "x", requiresConfirmation = true)))
        assertEquals(QuickCandidateNote.ManagedInstance, quickCandidateNote(candidate("c", "x", effect = "new_instance")))
        assertEquals(QuickCandidateNote.AppliesWhenIdle, quickCandidateNote(candidate("c", "x", runningSessions = 2)))
        assertEquals(QuickCandidateNote.Effect("restart"), quickCandidateNote(candidate("c", "x")))
        assertEquals(QuickCandidateNote.Effect("immediate"), quickCandidateNote(candidate("c", "x", effect = "immediate")))
    }

    @Test
    fun snapshotProgressParsesRequestAndResults() {
        val progress = JSONObject(
            """{"state":"done","request":{"targets":[{"connectorId":"c","runtimeId":"codex"}],"confirmNativeGlobal":true},
                "startedAt":"t","results":[{"connectorId":"c","runtimeId":"codex","result":"deferred"},
                {"connectorId":"c","runtimeId":"pi","result":"applied","modelsTrimmed":12,"servesRuntimeId":"pi-managed"},
                {"connectorId":"d","runtimeId":"dsh","result":"skipped","reason":"device_offline"}]}""",
        ).toQuickSetupProgress()!!

        assertEquals("done", progress.state)
        assertEquals(listOf(ModelTarget("c", "codex")), progress.request.targets)
        assertTrue(progress.request.confirmNativeGlobal)
        assertEquals(listOf("deferred", "applied", "skipped"), progress.results.map { it.result })
        assertEquals(12, progress.results[1].modelsTrimmed)
        assertEquals("device_offline", progress.results[2].reason)
    }
}
