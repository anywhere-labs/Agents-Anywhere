package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentSession

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
) {
    fun previewSession(): AgentSession {
        return AgentSession(
            id = LOCAL_NEW_SESSION_ID,
            connectorId = connectorId,
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
    }
}

internal fun NewSessionDraft.firstMessageRequest(
    content: String,
    selections: NewSessionSelections,
    clientMessageId: String,
): NewSessionCreateDraft = NewSessionCreateDraft(
    connectorId = connectorId,
    runtime = runtimeType,
    title = title,
    cwd = cwd,
    content = content.trim(),
    selections = selections,
    attachments = emptyList(),
    clientMessageId = clientMessageId,
    knownSessionIds = knownSessionIds,
    runtimeId = runtimeId,
    runtimeType = runtimeType,
)
