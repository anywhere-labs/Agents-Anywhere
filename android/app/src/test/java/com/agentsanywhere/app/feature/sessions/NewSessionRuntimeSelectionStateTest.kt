package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.feature.devices.DeviceRuntimeList
import com.agentsanywhere.app.feature.devices.DeviceRuntimeStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NewSessionRuntimeSelectionStateTest {
    @Test
    fun capabilityRequiresSupportedAvailableAndAllowed() {
        val capabilities = NewSessionRuntimeCapabilities(
            connectorId = "connector",
            revision = 1,
            capabilities = listOf(
                capability("supported", supported = false),
                capability("available", available = false),
                capability("allowed", allowed = false),
                capability("usable"),
            ),
            serverTime = null,
        )

        assertFalse(capabilities.find("supported", "codex")!!.usable)
        assertFalse(capabilities.find("available", "codex")!!.usable)
        assertFalse(capabilities.find("allowed", "codex")!!.usable)
        assertTrue(capabilities.find("usable", "codex")!!.usable)
    }

    @Test
    fun modelHintWinsThenReasoningDefaultPrecedesDefaultModel() {
        val state = stateWithCapabilities()
        val request = state.requestKey!!
        val catalog = modelCatalog(
            models = listOf(
                model("default-model", default = true, selectionId = "model:default"),
                model(
                    "reasoning-model",
                    reasoning = listOf(
                        reasoning("low", "model:reasoning:low"),
                        reasoning("high", "model:reasoning:high", default = true),
                    ),
                ),
            ),
        )

        val defaulted = state.applyModelCatalog(request, catalog)
        assertEquals("reasoning-model", defaulted.selectedModelId)
        assertEquals("high", defaulted.selectedReasoningId)
        assertEquals("model:reasoning:high", defaulted.selectedModelSelectionId)

        val hinted = defaulted
            .selectModel("default-model")
            .beginRuntimeDetails()
        val hintedRequest = hinted.requestKey!!
        val refreshed = hinted
            .applyCapabilities(hintedRequest, capabilities())
            .applyModelCatalog(hintedRequest, catalog)
        assertEquals("default-model", refreshed.selectedModelId)
        assertNull(refreshed.selectedReasoningId)
        assertEquals("model:default", refreshed.selectedModelSelectionId)
    }

    @Test
    fun parentModelWithReasoningAlwaysUsesReasoningSelectionId() {
        val state = stateWithCapabilities()
        val request = state.requestKey!!
        val catalog = modelCatalog(
            listOf(
                model(
                    id = "model",
                    selectionId = "parent-selection",
                    default = true,
                    reasoning = listOf(reasoning("medium", "reasoning-selection")),
                ),
            ),
        )

        val next = state.applyModelCatalog(request, catalog)

        assertEquals("medium", next.selectedReasoningId)
        assertEquals("reasoning-selection", next.selectedModelSelectionId)
    }

    @Test
    fun permissionHintFallsBackToDefaultThenFirstValidItem() {
        val state = stateWithCapabilities()
        val request = state.requestKey!!
        val catalog = permissionCatalog(
            listOf(
                permission("invalid", ""),
                permission("ask", "permission:ask"),
                permission("write", "permission:write", default = true),
            ),
        )

        val defaulted = state.applyPermissionCatalog(request, catalog)
        assertEquals("write", defaulted.selectedPermissionId)
        assertEquals("permission:write", defaulted.selectedPermissionSelectionId)

        val hinted = defaulted
            .selectPermission("ask")
            .beginRuntimeDetails()
        val hintedRequest = hinted.requestKey!!
        val refreshed = hinted
            .applyCapabilities(hintedRequest, capabilities())
            .applyPermissionCatalog(hintedRequest, catalog)
        assertEquals("ask", refreshed.selectedPermissionId)
        assertEquals("permission:ask", refreshed.selectedPermissionSelectionId)
    }

    @Test
    fun staleResponseCannotOverwriteNewRuntimeRequest() {
        val first = baseState().beginRuntimeDetails()
        val oldRequest = first.requestKey!!
        val switched = first
            .selectRuntime("claude")
            .beginRuntimeDetails()
        val newRequest = switched.requestKey!!

        val afterOldResponse = switched.applyCapabilities(oldRequest, capabilities(runtime = "codex"))

        assertEquals(newRequest, afterOldResponse.requestKey)
        assertTrue(afterOldResponse.capabilities.loading)
        assertNull(afterOldResponse.capabilities.data)
    }

    @Test
    fun refreshFailureKeepsDisplayedCatalogButMarksItStale() {
        val loaded = fullyLoadedState()
        assertTrue(loaded.readyForCreate)
        val refreshing = loaded.beginRuntimeDetails()
        val request = refreshing.requestKey!!

        val failed = refreshing
            .applyCapabilities(request, capabilities())
            .failModelCatalog(request, "catalog offline")

        assertEquals("gpt", failed.modelCatalog.data!!.models.single().id)
        assertTrue(failed.modelCatalog.stale)
        assertEquals("catalog offline", failed.modelCatalog.errorMessage)
        assertFalse(failed.readyForCreate)
    }

    @Test
    fun runtimeSwitchClearsVisibleSelectionAndRestoresScopedHint() {
        val codex = fullyLoadedState().selectModel("gpt")
        val claude = codex.selectRuntime("claude")

        assertNull(claude.selectedModelId)
        assertNull(claude.modelCatalog.data)

        val returned = claude
            .selectRuntime("codex")
            .beginRuntimeDetails()
        val request = returned.requestKey!!
        val restored = returned
            .applyCapabilities(request, capabilities())
            .applyModelCatalog(request, modelCatalog(listOf(model("gpt", selectionId = "model:gpt"))))

        assertEquals("gpt", restored.selectedModelId)
        assertEquals("model:gpt", restored.selectedModelSelectionId)
    }

    @Test
    fun unavailableCapabilitiesSkipCatalogSelectionsWithoutInventingValues() {
        val state = baseState().beginRuntimeDetails()
        val request = state.requestKey!!
        val unavailable = capabilities(
            modelUsable = false,
            permissionUsable = false,
        )

        val next = state.applyCapabilities(request, unavailable)

        assertTrue(next.capabilities.fresh)
        assertTrue(next.modelCatalog.fresh)
        assertTrue(next.permissionCatalog.fresh)
        assertFalse(next.canUseModelCatalog)
        assertFalse(next.canUsePermissionCatalog)
        assertNull(next.selectedModelSelectionId)
        assertNull(next.selectedPermissionSelectionId)
        assertTrue(next.selections.toMap().isEmpty())
        assertTrue(next.readyForCreate)
    }

    @Test
    fun emptyCatalogsRemainNullAndActiveRuntimeCanContinue() {
        val state = stateWithCapabilities()
        val request = state.requestKey!!
        val next = state
            .applyModelCatalog(request, modelCatalog(emptyList()))
            .applyPermissionCatalog(request, permissionCatalog(emptyList()))

        assertNull(next.selectedModelSelectionId)
        assertNull(next.selectedPermissionSelectionId)
        assertTrue(next.readyForCreate)
    }

    @Test
    fun inactiveRuntimeCannotCreateEvenWithFreshCatalogs() {
        val state = fullyLoadedState(active = false)

        assertFalse(state.readyForCreate)
    }

    private fun fullyLoadedState(active: Boolean = true): NewSessionRuntimeSelectionState {
        val state = stateWithCapabilities(active)
        val request = state.requestKey!!
        return state
            .applyModelCatalog(
                request,
                modelCatalog(listOf(model("gpt", selectionId = "model:gpt", default = true))),
            )
            .applyPermissionCatalog(
                request,
                permissionCatalog(listOf(permission("ask", "permission:ask", default = true))),
            )
    }

    private fun stateWithCapabilities(active: Boolean = true): NewSessionRuntimeSelectionState {
        val state = baseState(active).beginRuntimeDetails()
        return state.applyCapabilities(state.requestKey!!, capabilities())
    }

    private fun baseState(active: Boolean = true): NewSessionRuntimeSelectionState {
        val runtimes = listOf(runtime("codex", active), runtime("claude", active))
        return NewSessionRuntimeSelectionState()
            .beginRuntimeInventory("connector")
            .replaceRuntimeInventory(DeviceRuntimeList("connector", runtimes, null))
    }

    private fun capabilities(
        runtime: String = "codex",
        modelUsable: Boolean = true,
        permissionUsable: Boolean = true,
    ): NewSessionRuntimeCapabilities {
        return NewSessionRuntimeCapabilities(
            connectorId = "connector",
            revision = 1,
            capabilities = listOf(
                capability(MODEL_CATALOG_CAPABILITY, runtime, available = modelUsable),
                capability(PERMISSION_CATALOG_CAPABILITY, runtime, allowed = permissionUsable),
                capability("future.capability", runtime),
            ),
            serverTime = null,
        )
    }

    private fun capability(
        id: String,
        runtime: String? = "codex",
        supported: Boolean = true,
        available: Boolean = true,
        allowed: Boolean = true,
    ): NewSessionRuntimeCapability {
        return NewSessionRuntimeCapability(
            capabilityId = id,
            version = "1",
            scope = "runtime",
            runtime = runtime,
            sessionId = null,
            supported = supported,
            available = available,
            allowed = allowed,
            unavailableReason = if (available && allowed) null else "unavailable",
            parameters = emptyMap(),
        )
    }

    private fun modelCatalog(models: List<NewSessionModel>): NewSessionModelCatalog {
        return NewSessionModelCatalog("codex", 1, models, null)
    }

    private fun model(
        id: String,
        selectionId: String? = null,
        default: Boolean = false,
        reasoning: List<NewSessionReasoning> = emptyList(),
    ): NewSessionModel {
        return NewSessionModel(
            id = id,
            selectionId = selectionId,
            displayName = id,
            description = null,
            default = default,
            reasoningItems = reasoning,
            metadata = emptyMap(),
        )
    }

    private fun reasoning(
        id: String,
        selectionId: String,
        default: Boolean = false,
    ): NewSessionReasoning {
        return NewSessionReasoning(
            id = id,
            selectionId = selectionId,
            fullModelId = null,
            displayName = id,
            description = null,
            default = default,
            metadata = emptyMap(),
        )
    }

    private fun permissionCatalog(
        permissions: List<NewSessionPermission>,
    ): NewSessionPermissionCatalog {
        return NewSessionPermissionCatalog("codex", 1, permissions, null)
    }

    private fun permission(
        id: String,
        selectionId: String,
        default: Boolean = false,
    ): NewSessionPermission {
        return NewSessionPermission(
            id = id,
            selectionId = selectionId,
            displayName = id,
            description = null,
            default = default,
            metadata = emptyMap(),
        )
    }

    private fun runtime(id: String, active: Boolean): DeviceRuntime {
        return DeviceRuntime(
            connectorId = "connector",
            id = id,
            type = "native",
            displayName = id,
            present = true,
            configured = true,
            active = active,
            status = if (active) DeviceRuntimeStatus.Running else DeviceRuntimeStatus.Stopped,
            discovery = emptyMap(),
            schema = null,
            uiSchema = emptyMap(),
            config = null,
            error = null,
            lastDiscoveredAt = null,
            updatedAt = null,
        )
    }
}
