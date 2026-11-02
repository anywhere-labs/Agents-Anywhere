package com.agentsanywhere.app.feature.modelconfig

import com.agentsanywhere.app.api.RemoteModelOperation
import com.agentsanywhere.app.api.RemoteModelOperationResult
import com.agentsanywhere.app.api.RemoteModelPreviewTarget
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.DeviceRuntimeStatus
import com.agentsanywhere.app.model.ModelAssignment
import com.agentsanywhere.app.model.ModelConnectionCapability
import com.agentsanywhere.app.model.ModelConnectionStatus
import com.agentsanywhere.app.model.ModelOffer
import com.agentsanywhere.app.model.ModelProfile
import com.agentsanywhere.app.model.ModelSpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelConfigStateTest {
    private val capability = ModelConnectionCapability(
        maturity = "experimental",
        configField = "modelGateway",
        modelsField = null,
        protocols = listOf("openai_chat"),
        modes = emptyList(),
        modeField = null,
        scope = "instance",
        catalogAuto = false,
        catalogManual = true,
        apply = "restart",
    )

    private fun runtime(
        id: String,
        type: String = id,
        connection: ModelConnectionCapability? = capability,
        maturity: String? = null,
        status: ModelConnectionStatus? = null,
    ) = DeviceRuntime(
        connectorId = "dev",
        id = id,
        type = type,
        displayName = id,
        present = true,
        configured = true,
        active = true,
        status = DeviceRuntimeStatus.Running,
        discovery = emptyMap(),
        schema = null,
        uiSchema = emptyMap(),
        config = null,
        error = null,
        lastDiscoveredAt = null,
        updatedAt = null,
        maturity = maturity,
        modelConnection = connection,
        modelConnectionStatus = status,
    )

    private fun target(
        id: String,
        decision: String = "apply",
        requiresConfirmation: Boolean = false,
        tooManyModels: Boolean = false,
        effect: String? = "immediate",
        runningSessions: Int = 0,
    ) = RemoteModelPreviewTarget(
        connectorId = "dev",
        runtimeId = id,
        runtimeType = id,
        name = id,
        maturity = null,
        decision = decision,
        reason = if (decision == "skip") "not_installed" else null,
        offerFormat = "openai_chat",
        effect = effect,
        scope = if (requiresConfirmation) "native_global" else "instance",
        requiresConfirmation = requiresConfirmation,
        runningSessions = runningSessions,
        replacesHost = null,
        modelLimit = 64,
        tooManyModels = tooManyModels,
        capabilityMaturity = null,
    )

    private fun profile(source: String = "manual", state: String = "active") = ModelProfile(
        id = "p",
        source = source,
        name = "P",
        originHost = "gate.example",
        offers = listOf(
            ModelOffer("openai_chat", "https://gate.example/v1", listOf(ModelSpec("a"), ModelSpec("b"))),
            ModelOffer("anthropic", "https://gate.example", listOf(ModelSpec("a"))),
        ),
        keyHint = null,
        strategyName = null,
        state = state,
        etag = "1",
        updatedAt = null,
    )

    @Test
    fun stableRuntimesShowNoMaturityBadge() {
        assertEquals(RuntimeMaturityBadge.Beta, runtimeMaturityBadge("beta"))
        assertEquals(RuntimeMaturityBadge.Experimental, runtimeMaturityBadge("experimental"))
        assertNull(runtimeMaturityBadge("stable"))
        assertNull(runtimeMaturityBadge(null))
        assertNull(runtimeMaturityBadge("future"))
    }

    @Test
    fun statusTonesFollowTheWebClient() {
        assertEquals(ModelStatusTone.Ok, connectionStateTone("applied"))
        assertEquals(ModelStatusTone.Progress, connectionStateTone("saved_pending"))
        assertEquals(ModelStatusTone.Error, connectionStateTone("failed"))
        assertEquals(ModelStatusTone.Warning, connectionStateTone("managed_externally"))
        assertEquals(ModelStatusTone.Neutral, connectionStateTone("not_configured"))
        assertEquals(ModelStatusTone.Progress, assignmentStatusTone("applying"))
        assertEquals(ModelStatusTone.Warning, assignmentStatusTone("outdated"))
    }

    @Test
    fun deviceRowsListOnlyRuntimesThatDeclareAModelConnection() {
        val assignment = ModelAssignment(
            connectorId = "dev",
            runtimeId = "pi",
            profileId = "p",
            offerFormat = "openai_chat",
            createdRuntime = false,
            status = "applied",
            errorCode = null,
            errorMessage = null,
            appliedAt = null,
            modelConnectionStatus = ModelConnectionStatus("applied", null, null, null, null, null),
        )
        val rows = modelConfigDeviceRows(
            runtimes = listOf(
                runtime("pi", status = ModelConnectionStatus("saved_pending", null, null, null, null, null)),
                runtime("codex", connection = null),
                runtime("custom", maturity = "beta"),
            ),
            assignments = listOf(assignment),
        )

        assertEquals(listOf("pi", "custom"), rows.map { it.runtime.id })
        assertEquals("applied", rows[0].status?.state)
        assertNull(rows[1].assignment)
        assertEquals("experimental", rows[1].maturity)
    }

    @Test
    fun applySelectionNeverPreselectsGlobalChangesOrTooManyModels() {
        val selection = ApplySelection.initial(
            listOf(
                target("pi"),
                target("claude", requiresConfirmation = true),
                target("dsh", tooManyModels = true),
                target("codex", decision = "skip"),
            ),
        )

        assertEquals(setOf("dev/pi"), selection.selected)
        assertFalse(selection.needsNativeGlobalConfirmation)
        assertTrue(selection.canSubmit(confirmedNativeGlobal = false))
    }

    @Test
    fun choosingAGlobalChangeRequiresConfirmation() {
        val claude = target("claude", requiresConfirmation = true, effect = "restart", runningSessions = 3)
        val selection = ApplySelection.initial(listOf(target("pi"), claude)).toggle(claude, true)

        assertTrue(selection.needsNativeGlobalConfirmation)
        assertFalse(selection.canSubmit(confirmedNativeGlobal = false))
        assertTrue(selection.canSubmit(confirmedNativeGlobal = true))
        assertEquals(3, selection.runningSessions)
    }

    @Test
    fun skippedAndOversizedTargetsCannotBeChosen() {
        val dsh = target("dsh", tooManyModels = true)
        val codex = target("codex", decision = "skip")
        val selection = ApplySelection.initial(listOf(dsh, codex)).toggle(dsh, true).toggle(codex, true)

        assertTrue(selection.selected.isEmpty())
        assertFalse(selection.canSubmit(confirmedNativeGlobal = true))
    }

    @Test
    fun modelIdsAreSplitByLinesOrCommasAndDeduplicated() {
        assertEquals(listOf("gpt-5", "claude", "qwen"), parseModelIds(" gpt-5\nclaude, qwen,,\ngpt-5 \n"))
        assertTrue(parseModelIds("  \n ,").isEmpty())
    }

    @Test
    fun manualProfileNeedsANameKeyAndHttpAddressForEveryChosenProtocol() {
        val empty = ManualProfileDraft()
        assertEquals(listOf("openai_chat"), empty.chosenProtocols)
        assertFalse(empty.valid)

        val draft = empty.copy(name = "Gate", apiKey = "sk-1")
            .withOffer("openai_chat") { it.copy(baseUrl = " https://gate.example/v1 ", models = "a\nb") }
        assertTrue(draft.valid)
        assertFalse(draft.withOffer("anthropic") { it.copy(enabled = true, baseUrl = "gate.example") }.valid)

        val offer = draft.toOffers().single()
        assertEquals("https://gate.example/v1", offer.baseUrl)
        assertEquals(listOf("a", "b"), offer.models.map { it.id })
    }

    @Test
    fun profileModelCountAndDeletion() {
        assertEquals(2, profile().modelCount())
        assertTrue(profile().canDelete(usedBy = 0))
        assertFalse(profile().canDelete(usedBy = 1))
        assertFalse(profile(source = "tokens").canDelete(usedBy = 0))
        assertTrue(profile(source = "tokens", state = "detached").canDelete(usedBy = 0))
    }

    @Test
    fun operationSummaryCountsAppliedResults() {
        val operation = RemoteModelOperation(
            operationId = "op",
            kind = "apply",
            finished = true,
            results = listOf(
                RemoteModelOperationResult("dev", "pi", "applied", null),
                RemoteModelOperationResult("dev", "dsh", "failed", "busy"),
                RemoteModelOperationResult("dev", "codex", "skipped", null),
            ),
        )
        assertEquals(OperationSummary(applied = 1, other = 2), operation.summary())
    }

    @Test
    fun idempotencyKeysAreUnique() {
        assertFalse(newIdempotencyKey() == newIdempotencyKey())
    }
}
