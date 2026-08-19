package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteRuntimeModel
import com.agentsanywhere.app.api.RemoteRuntimeModelCatalog
import com.agentsanywhere.app.api.RemoteRuntimePermission
import com.agentsanywhere.app.api.RemoteRuntimePermissionCatalog
import com.agentsanywhere.app.api.RemoteRuntimeReasoning
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
    fun permissionSelectionOptionsExcludeCustomState() {
        val options = RemoteRuntimePermissionCatalog(
            runtime = "dsh",
            revision = 1,
            permissions = listOf(
                RemoteRuntimePermission(
                    "read-only",
                    "permission:read-only",
                    "read-only",
                    null,
                    false,
                    emptyMap(),
                ),
                RemoteRuntimePermission(
                    "custom",
                    "permission:custom",
                    "Custom",
                    "Current settings",
                    false,
                    emptyMap(),
                ),
                RemoteRuntimePermission(
                    "workspace-write",
                    "permission:workspace-write",
                    "workspace-write",
                    null,
                    true,
                    emptyMap(),
                ),
            ),
        ).selectionOptions()

        assertEquals(
            listOf("permission:read-only", "permission:workspace-write"),
            options.map { it.selectionId },
        )
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
