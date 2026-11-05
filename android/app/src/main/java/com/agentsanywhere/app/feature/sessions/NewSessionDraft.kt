package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentSession
import java.util.UUID

/**
 * A locally prepared session. The Server session and runtime thread are created only when the
 * user sends the first real message from the conversation screen.
 */
data class NewSessionDraft(
    val connectorId: String,
    val runtime: String,
    val title: String?,
    val cwd: String?,
    val deviceName: String,
    val runtimeLabel: String,
    val knownSessionIds: Set<String>,
    val selections: NewSessionSelections = NewSessionSelections(),
    val runtimeId: String = runtime,
    val runtimeType: String = runtime,
    val runtimeName: String = runtimeLabel,
    val attachmentsEnabled: Boolean = true,
    val localSessionId: String = newLocalSessionId(),
    val projectId: String = "",
    val preparedWorkspace: PreparedRuntimeWorkspace? = null,
) {
    fun previewSession(): AgentSession {
        return AgentSession(
            id = localSessionId,
            connectorId = connectorId,
            projectId = projectId,
            deviceName = deviceName,
            title = title.orEmpty(),
            summary = "",
            cwd = cwd,
            workspaceLabel = cwd.orEmpty(),
            runtime = runtimeType,
            runtimeLabel = runtimeLabel,
            status = com.agentsanywhere.app.model.SessionStatus.Idle,
            statusLabel = "",
            updatedAtLabel = "",
            metaLabel = "",
            pinned = false,
            archived = false,
            unread = false,
            lastReadSeq = 0,
            takeover = true,
            connectorOnline = true,
            live = true,
            sortKey = "",
            updatedSeq = 0,
            runtimeId = runtimeId,
            runtimeType = runtimeType,
            runtimeName = runtimeName,
        )
    }

    companion object {
        const val LOCAL_NEW_SESSION_ID = "local:new-session"

        fun newLocalSessionId(): String = "$LOCAL_NEW_SESSION_ID:${UUID.randomUUID()}"
    }
}

/**
 * The title to send when creating a session. The title field starts out showing the localized
 * placeholder ("New Session"); sending it unchanged would pin every session to that placeholder
 * and stop the runtime (e.g. Claude Code) from naming the session itself. Only a title the user
 * actually typed is sent, matching iOS which sends no create-time title.
 */
internal fun explicitSessionTitle(input: String, placeholder: String): String? =
    input.trim().takeIf { it.isNotBlank() && it != placeholder.trim() }

internal fun NewSessionDraft.firstMessageRequest(
    content: String,
    selections: NewSessionSelections,
    attachments: List<NewSessionAttachmentPart>,
    clientMessageId: String,
): NewSessionCreateDraft = NewSessionCreateDraft(
    connectorId = connectorId,
    runtime = runtimeType,
    title = title,
    cwd = cwd,
    content = content.trim(),
    selections = selections,
    attachments = attachments,
    clientMessageId = clientMessageId,
    knownSessionIds = knownSessionIds,
    runtimeId = runtimeId,
    runtimeType = runtimeType,
    projectId = projectId,
    preparedWorkspace = preparedWorkspace,
)
