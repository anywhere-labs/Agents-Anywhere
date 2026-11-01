package com.agentsanywhere.app.ui.designsystem

import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.sessiondetail.PlanningFailure
import com.agentsanywhere.app.feature.sessions.RuntimeWorkflowFailure
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.feature.sessiondetail.NativeHistoryRejected
import com.agentsanywhere.app.feature.sessions.NewSessionDraftInvalid
import com.agentsanywhere.app.feature.sessions.RuntimeOperationFailure

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
    } else if (error is NewSessionDraftInvalid) {
        when (error.reason) {
            NewSessionDraftInvalid.Reason.ConnectorRequired -> context.getString(R.string.new_session_connector_required)
            NewSessionDraftInvalid.Reason.WorkspaceRequired -> context.getString(R.string.new_session_workspace_required)
            NewSessionDraftInvalid.Reason.RuntimeTypeInvalid -> context.getString(R.string.new_session_runtime_type_invalid)
            NewSessionDraftInvalid.Reason.RuntimeInstanceInvalid -> context.getString(R.string.new_session_runtime_instance_invalid)
            NewSessionDraftInvalid.Reason.ContentRequired -> context.getString(R.string.new_session_content_required)
            NewSessionDraftInvalid.Reason.ClientMessageMissing -> context.getString(R.string.new_session_client_message_missing)
            NewSessionDraftInvalid.Reason.ImageInputUnsupported -> context.getString(R.string.session_image_input_unsupported)
            NewSessionDraftInvalid.Reason.AttachmentLimit -> context.getString(R.string.new_session_attachment_limit, error.argument as Int)
            NewSessionDraftInvalid.Reason.AttachmentNameMissing -> context.getString(R.string.new_session_attachment_name_missing)
            NewSessionDraftInvalid.Reason.AttachmentEmpty -> context.getString(R.string.new_session_attachment_empty, error.argument)
            NewSessionDraftInvalid.Reason.AttachmentTooLarge -> context.getString(R.string.new_session_attachment_too_large, error.argument)
        }
    } else runtimeErrorText(context, runtimeErrorCode(error), error.message) ?: context.getString(fallback)

/** The stable code an API, workflow or native-history failure carries, if any. */
internal fun runtimeErrorCode(error: Throwable): String? = when (error) {
    is ApiException -> error.errorCode
    is RuntimeOperationFailure -> error.code
    is NativeHistoryRejected -> error.code
    else -> null
}

/** Localized text for a known code; otherwise the server or Connector [fallback] message. */
internal fun runtimeErrorText(context: android.content.Context, code: String?, fallback: String?): String? =
    runtimeErrorRes(code)?.let(context::getString) ?: fallback
