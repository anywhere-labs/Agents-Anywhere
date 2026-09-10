package com.agentsanywhere.app.ui.designsystem

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.RuntimePermissionTranslation
import com.agentsanywhere.app.feature.sessiondetail.runtimePermissionTranslation

internal data class LocalizedRuntimePermission(
    val label: String,
    val description: String?,
)

internal class RuntimePermissionLocalizer(
    private val translations: Map<RuntimePermissionTranslation, LocalizedRuntimePermission>,
) {
    fun localize(
        runtime: String?,
        permissionId: String,
        label: String,
        description: String?,
        metadata: Map<String, Any?> = emptyMap(),
    ): LocalizedRuntimePermission {
        val translated = translations[runtimePermissionTranslation(runtime, permissionId, metadata)]
            ?: return LocalizedRuntimePermission(label, description)
        return translated.copy(description = translated.description ?: description)
    }
}

@Composable
internal fun runtimePermissionLocalizer(): RuntimePermissionLocalizer {
    return RuntimePermissionLocalizer(
        mapOf(
            RuntimePermissionTranslation.DshReadOnly to LocalizedRuntimePermission(
                stringResource(R.string.runtime_permission_dsh_read_only),
                null,
            ),
            RuntimePermissionTranslation.DshWorkspaceWrite to LocalizedRuntimePermission(
                stringResource(R.string.runtime_permission_dsh_workspace_write),
                null,
            ),
            RuntimePermissionTranslation.DshFullAccess to LocalizedRuntimePermission(
                stringResource(R.string.runtime_permission_dsh_full_access),
                null,
            ),
            RuntimePermissionTranslation.RequestApproval to LocalizedRuntimePermission(
                stringResource(R.string.runtime_permission_request_approval),
                stringResource(R.string.runtime_permission_desc_request_approval),
            ),
            RuntimePermissionTranslation.AutoReview to LocalizedRuntimePermission(
                stringResource(R.string.runtime_permission_auto_review),
                stringResource(R.string.runtime_permission_desc_auto_review),
            ),
            RuntimePermissionTranslation.FullAccess to LocalizedRuntimePermission(
                stringResource(R.string.runtime_permission_full_access),
                stringResource(R.string.runtime_permission_desc_full_access),
            ),
            RuntimePermissionTranslation.ClaudeDefault to LocalizedRuntimePermission(
                stringResource(R.string.runtime_permission_claude_default),
                stringResource(R.string.runtime_permission_desc_claude_default),
            ),
            RuntimePermissionTranslation.ClaudeAcceptEdits to LocalizedRuntimePermission(
                stringResource(R.string.runtime_permission_claude_accept_edits),
                stringResource(R.string.runtime_permission_desc_claude_accept_edits),
            ),
            RuntimePermissionTranslation.ClaudePlan to LocalizedRuntimePermission(
                stringResource(R.string.runtime_permission_claude_plan),
                stringResource(R.string.runtime_permission_desc_claude_plan),
            ),
            RuntimePermissionTranslation.ClaudeAuto to LocalizedRuntimePermission(
                stringResource(R.string.runtime_permission_claude_auto),
                stringResource(R.string.runtime_permission_desc_claude_auto),
            ),
            RuntimePermissionTranslation.ClaudeDontAsk to LocalizedRuntimePermission(
                stringResource(R.string.runtime_permission_claude_dont_ask),
                stringResource(R.string.runtime_permission_desc_claude_dont_ask),
            ),
            RuntimePermissionTranslation.ClaudeBypassPermissions to LocalizedRuntimePermission(
                stringResource(R.string.runtime_permission_claude_bypass_permissions),
                stringResource(R.string.runtime_permission_desc_claude_bypass_permissions),
            ),
        ),
    )
}
