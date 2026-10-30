package com.agentsanywhere.app.ui.designsystem

import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.PlanningFailure
import com.agentsanywhere.app.feature.sessions.RuntimeWorkflowFailure

internal fun runtimeOperationErrorMessage(context: android.content.Context, error: Throwable, @androidx.annotation.StringRes fallback: Int = R.string.planning_operation_failed): String =
    if (error is PlanningFailure) {
        context.getString(when (error.reason) {
            PlanningFailure.Reason.TaskRequired -> R.string.planning_task_required
            PlanningFailure.Reason.WorkspaceRequired -> R.string.planning_workspace_unsupported
            PlanningFailure.Reason.WorkspaceUnavailable -> R.string.planning_workspace_unavailable
            PlanningFailure.Reason.OutcomeUnknown -> R.string.planning_operation_unknown
        })
    } else if (error is RuntimeWorkflowFailure) {
        context.getString(when (error.reason) {
            RuntimeWorkflowFailure.Reason.TargetChanged -> R.string.planning_workflow_target_changed
            RuntimeWorkflowFailure.Reason.BindingInProgress -> R.string.planning_workflow_binding
            RuntimeWorkflowFailure.Reason.CreationMissing -> R.string.planning_workflow_creation_missing
            RuntimeWorkflowFailure.Reason.SessionMismatch -> R.string.planning_workflow_session_mismatch
        })
    } else error.message ?: context.getString(fallback)
