package com.agentsanywhere.app.ui.designsystem

import android.content.Context
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.ProjectOperationException

internal fun Throwable.localizedProjectMessage(context: Context): String? {
    val projectError = generateSequence(this) { it.cause }.filterIsInstance<ProjectOperationException>().firstOrNull()
    return projectError?.let { error ->
        val label = context.getString(error.messageRes)
        error.detail?.takeIf { it.isNotBlank() }?.let { "$label: $it" } ?: label
    } ?: message
}

internal fun Context.projectSyncReasonLabel(reason: String): String? = when (reason) {
    "native_project_missing" -> R.string.project_reason_native_missing
    "project_directory_missing" -> R.string.project_reason_root_missing
    "session_directory_missing" -> R.string.project_reason_session_missing
    "directory_unknown" -> R.string.project_reason_directory_unknown
    "awaiting_native_inventory" -> R.string.project_reason_awaiting_inventory
    "no_native_membership" -> R.string.project_reason_no_membership
    else -> null
}?.let { getString(it) }
