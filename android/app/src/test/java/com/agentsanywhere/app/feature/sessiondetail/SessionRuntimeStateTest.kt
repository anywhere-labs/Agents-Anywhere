package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteRuntimeModel
import com.agentsanywhere.app.api.RemoteRuntimeModelCatalog
import com.agentsanywhere.app.api.RemoteRuntimeReasoning
import com.agentsanywhere.app.api.RemoteRuntimePermission
import com.agentsanywhere.app.api.RemoteRuntimePermissionCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionRuntimeStateTest {
    @Test
    fun capabilityRequiresAllThreeServerConditions() {
        fun capability(supported: Boolean, available: Boolean, allowed: Boolean) = EffectiveCapability(
            capabilityId = SESSION_SEND_MESSAGE_CAPABILITY,
            version = "1",
            scope = "session",
            runtime = "codex",
            sessionId = "session",
            supported = supported,
            available = available,
            allowed = allowed,
            unavailableReason = null,
            parameters = emptyMap(),
        )
        assertTrue(capability(true, true, true).usable)
        assertFalse(capability(false, true, true).usable)
        assertFalse(capability(true, false, true).usable)
        assertFalse(capability(true, true, false).usable)
    }

    @Test
    fun modelSelectionUsesReasoningSelectionIdsAndValidHint() {
        val catalog = RemoteRuntimeModelCatalog(
            runtime = "codex",
            revision = 1,
            models = listOf(
                RemoteRuntimeModel(
                    id = "model",
                    selectionId = null,
                    displayName = "Model",
                    description = null,
                    default = true,
                    reasoningItems = listOf(
                        RemoteRuntimeReasoning("low", "model-low", null, "Low", null, true, emptyMap()),
                        RemoteRuntimeReasoning("high", "model-high", null, "High", null, false, emptyMap()),
                    ),
                    metadata = emptyMap(),
                ),
            ),
        )
        val options = catalog.selectionOptions()
        assertEquals("model-high", options.validatedSelection("model-high"))
        assertEquals("Model · High", options.first { it.selectionId == "model-high" }.label)
        assertEquals("model-low", options.validatedSelection(null))
        assertNull(options.validatedSelection("missing"))
    }

    @Test
    fun takeoverGatesComposerAndRuntimeSelectionInteraction() {
        assertFalse(sessionComposerEnabled(false, true, true, true, true))
        assertTrue(sessionComposerEnabled(true, true, true, false, false))
        assertFalse(sessionComposerEnabled(true, false, true, true, true))
        assertFalse(runtimeSelectionEnabled(false, true))
        assertTrue(runtimeSelectionEnabled(true, true))
        assertFalse(runtimeSelectionEnabled(true, false))
    }

    @Test
    fun providerScopedCapabilityMatchesDynamicRuntimeInstance() {
        val capabilities = EffectiveCapabilities(
            capabilities = listOf(
                EffectiveCapability(
                    capabilityId = SESSION_SEND_MESSAGE_CAPABILITY,
                    version = "1",
                    scope = "runtime",
                    runtime = "codex",
                    sessionId = null,
                    supported = true,
                    available = true,
                    allowed = true,
                    unavailableReason = null,
                    parameters = emptyMap(),
                    runtimeType = "codex",
                ),
            ),
        )

        assertTrue(capabilities.isUsable(SESSION_SEND_MESSAGE_CAPABILITY, "rti_codex_work_01", "codex"))
        assertFalse(capabilities.isUsable(SESSION_SEND_MESSAGE_CAPABILITY, "rti_claude_work_01", "claude"))
    }

    @Test
    fun instanceScopedCapabilityWinsOverEarlierProviderFallback() {
        val runtimeId = "rti_codex_work_01"
        val provider = EffectiveCapability(
            capabilityId = SESSION_SEND_MESSAGE_CAPABILITY,
            version = "1",
            scope = "runtime",
            runtime = "codex",
            sessionId = null,
            supported = true,
            available = false,
            allowed = true,
            unavailableReason = "provider unavailable",
            parameters = emptyMap(),
            runtimeType = "codex",
        )
        val instance = provider.copy(
            available = true,
            unavailableReason = null,
            runtimeId = runtimeId,
        )
        val capabilities = EffectiveCapabilities(capabilities = listOf(provider, instance))

        assertTrue(capabilities.isUsable(SESSION_SEND_MESSAGE_CAPABILITY, runtimeId, "codex"))
        val wrongTypeOnly = EffectiveCapabilities(
            capabilities = listOf(
                provider.copy(runtime = null, runtimeType = "claude"),
            ),
        )
        assertNull(wrongTypeOnly.find(SESSION_SEND_MESSAGE_CAPABILITY, runtimeId, "codex"))
    }

    @Test
    fun disabledCatalogOptionsRemainVisibleButCannotValidate() {
        val modelOptions = RemoteRuntimeModelCatalog(
            runtime = "codex",
            revision = 1,
            models = listOf(
                RemoteRuntimeModel(
                    id = "disabled",
                    selectionId = "model:disabled",
                    displayName = "Disabled",
                    description = null,
                    default = true,
                    reasoningItems = emptyList(),
                    metadata = emptyMap(),
                    enabled = false,
                    disabledReason = "account policy",
                ),
                RemoteRuntimeModel(
                    id = "enabled",
                    selectionId = "model:enabled",
                    displayName = "Enabled",
                    description = null,
                    default = false,
                    reasoningItems = emptyList(),
                    metadata = emptyMap(),
                ),
            ),
        ).selectionOptions()
        val permissionOptions = RemoteRuntimePermissionCatalog(
            runtime = "dsh",
            revision = 1,
            permissions = listOf(
                RemoteRuntimePermission(
                    id = "custom",
                    selectionId = "permission:custom",
                    displayName = "Custom",
                    description = null,
                    default = true,
                    metadata = emptyMap(),
                    enabled = false,
                    disabledReason = "not configured",
                ),
            ),
        ).selectionOptions()

        assertEquals(listOf("model:disabled", "model:enabled"), modelOptions.map { it.selectionId })
        assertEquals("account policy", modelOptions.first().disabledReason)
        assertNull(modelOptions.validatedSelection("model:disabled"))
        assertEquals("model:enabled", modelOptions.validatedSelection(null))
        assertEquals("permission:custom", permissionOptions.single().selectionId)
        assertEquals("not configured", permissionOptions.single().disabledReason)
        assertNull(permissionOptions.validatedSelection(null))
    }

    @Test
    fun codexPermissionIdsMapToWebTranslationsAndExtensionsRemainUntranslated() {
        assertEquals(RuntimePermissionTranslation.RequestApproval, runtimePermissionTranslation("codex", "request_approval"))
        assertEquals(RuntimePermissionTranslation.AutoReview, runtimePermissionTranslation("codex", "auto_review"))
        assertEquals(RuntimePermissionTranslation.FullAccess, runtimePermissionTranslation("codex", "full_access"))
        assertNull(runtimePermissionTranslation("custom", "custom_permission"))
    }

    @Test
    fun claudePermissionsMapByRuntimeOrWebI18nKey() {
        assertEquals(
            RuntimePermissionTranslation.ClaudeDefault,
            runtimePermissionTranslation("claude", "default"),
        )
        assertEquals(
            RuntimePermissionTranslation.ClaudeAcceptEdits,
            runtimePermissionTranslation("claude-code", "acceptEdits"),
        )
        assertEquals(
            RuntimePermissionTranslation.ClaudePlan,
            runtimePermissionTranslation(
                runtime = "future-runtime",
                permissionId = "future-id",
                metadata = mapOf(
                    "i18n" to mapOf(
                        "labelKey" to "dashboard.new.permissionModes.claude.plan.label",
                    ),
                ),
            ),
        )
        assertNull(runtimePermissionTranslation("codex", "default"))
    }

    @Test
    fun connectorImplementationErrorsAreClassifiedAsInternal() {
        assertTrue(
            isInternalRuntimeError(
                "openai_codex.errors.InvalidRequestError: JSON-RPC error -32600: " +
                    "thread id already has an active writer",
            ),
        )
        assertTrue(isInternalRuntimeError("Traceback (most recent call last):"))
        assertFalse(isInternalRuntimeError("The device is offline."))
        assertFalse(isInternalRuntimeError(null))
    }
}
