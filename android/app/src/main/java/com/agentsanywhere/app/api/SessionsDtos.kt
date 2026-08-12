package com.agentsanywhere.app.api

import org.json.JSONObject

data class RemoteSession(
    val id: String,
    val connectorId: String,
    val connectorStatus: String,
    val runtime: String,
    val externalSessionId: String?,
    val title: String?,
    val cwd: String?,
    val status: String,
    val takeover: Boolean,
    val pinned: Boolean,
    val pinnedAt: String?,
    val archived: Boolean,
    val archivedAt: String?,
    val unread: Boolean,
    val lastReadSeq: Int,
    val lastSyncedAt: String?,
    val sourceObservedAt: String?,
    val lastActivityAt: String?,
    val lastItemAt: String?,
    val lastItemOrderSeq: Int?,
    val sortAt: String?,
    val updatedSeq: Int,
)

data class RemoteSessionResponse(
    val session: RemoteSession,
    val serverTime: String?,
)

data class RemoteSessionsMutationResponse(
    val sessions: List<RemoteSession>,
    val notFound: List<String>,
    val serverTime: String?,
)

data class RemoteSessionCreateAndStartRequest(
    val connectorId: String,
    val runtime: String,
    val title: String?,
    val cwd: String?,
    val content: String,
    val selections: Map<String, String>,
    val attachments: List<RemoteInlineAttachmentRef>,
    val clientMessageId: String?,
)

data class RemoteInlineAttachmentRef(
    val fileId: String,
    val name: String,
    val mediaType: String,
    val size: Long,
    val sha256: String,
    val contentBase64: String,
)

data class RemoteSessionCreateResponse(
    val session: RemoteSession,
)

data class RemoteSessionTimelinePage(
    val sessionId: String,
    val items: List<RemoteTimelineItem>,
    val nextSeq: Int,
    val hasMore: Boolean,
    val serverTime: String?,
)

data class RemoteSessionRuntimeStateResponse(
    val state: RemoteSessionRuntimeState,
    val serverTime: String?,
)

data class RemoteSessionRuntimeState(
    val sessionId: String,
    val runtime: String,
    val externalSessionId: String?,
    val status: String,
    val selections: Map<String, String?>,
    val statusReason: String?,
    val error: Map<String, Any?>?,
    val metadata: Map<String, Any?>,
    val updatedSeq: Int,
    val createdAt: String?,
    val updatedAt: String? = null,
)

data class RemoteRuntimeNoticeListResponse(
    val notices: List<RemoteRuntimeNotice>,
    val serverTime: String?,
)

data class RemoteRuntimeNotice(
    val noticeId: String,
    val type: String,
    val sessionId: String,
    val source: Map<String, Any?>,
    val title: String,
    val message: String?,
    val severity: String,
    val status: String,
    val interactionType: String?,
    val blocking: RemoteRuntimeNoticeBlocking?,
    val responseRequired: Boolean,
    val actions: List<RemoteRuntimeNoticeAction>,
    val context: Map<String, Any?>,
    val metadata: Map<String, Any?>,
    val expiresAt: String?,
    val revision: Int,
    val updatedSeq: Int,
    val createdAt: String?,
    val updatedAt: String? = null,
    val resolvedAt: String?,
)

data class RemoteRuntimeNoticeBlocking(
    val scope: String,
    val targetId: String,
)

data class RemoteRuntimeNoticeAction(
    val actionId: String,
    val label: String,
    val style: String,
    val input: RemoteRuntimeNoticeActionInput,
    val unknown: Map<String, Any?>,
)

data class RemoteRuntimeNoticeActionInput(
    val required: Boolean,
    val schema: Map<String, Any?>?,
    val uiSchema: Map<String, Any?>?,
)

data class RemoteSessionSnapshot(
    val session: RemoteSession,
    val state: RemoteSessionRuntimeState?,
    val timeline: RemoteSessionTimelineSnapshot,
    val notices: List<RemoteRuntimeNotice>,
    val effectiveCapabilities: RemoteRuntimeCapabilitySet,
    val runtimeCapabilities: RemoteRuntimeCapabilitySet,
    val eventCursor: String,
    val serverTime: String?,
)

data class RemoteSessionTimelineSnapshot(
    val items: List<RemoteTimelineItem>,
    val nextSeq: Int,
    val hasMore: Boolean,
)

data class RemoteTimelineItem(
    val id: String,
    val sessionId: String,
    val type: String,
    val status: String,
    val role: String?,
    val text: String,
    val content: JSONObject,
    val source: JSONObject,
    val orderSeq: Int,
    val revision: Int,
    val updatedSeq: Int,
    val createdAt: String,
    val updatedAt: String?,
)

data class RemoteRpcResponse(
    val ok: Boolean,
    val errorCode: String?,
    val errorMessage: String?,
)

data class RemoteSessionSelectionPatchResponse(
    val ok: Boolean,
    val state: RemoteSessionRuntimeState?,
    val connectorResult: Map<String, Any?>?,
    val serverTime: String?,
)

data class RemoteSessionCommandListResponse(
    val commands: List<RemoteSessionCommand>,
    val serverTime: String?,
)

data class RemoteSessionCommand(
    val id: String,
    val title: String,
    val description: String?,
    val aliases: List<String>,
    val category: String?,
    val scope: String,
    val enabled: Boolean,
    val disabledReason: String?,
    val acceptsArgs: Boolean,
    val argsSchema: Map<String, Any?>?,
    val metadata: Map<String, Any?>,
)

data class RemoteSessionCommandResponse(
    val command: String,
    val ok: Boolean,
    val code: String?,
    val message: String?,
    val result: Any?,
    val session: RemoteSession?,
    val serverTime: String?,
)

data class RemoteUploadedAttachment(
    val fileId: String,
    val name: String,
    val mediaType: String,
    val size: Long,
    val sha256: String? = null,
)

data class RemoteAttachmentRef(
    val fileId: String,
)

data class RemoteDownloadedAttachment(
    val fileId: String,
    val sessionId: String,
    val path: String,
    val name: String,
    val size: Long,
    val sha256: String,
    val bytes: ByteArray,
    val createdAt: String?,
    val serverTime: String?,
)

enum class AttachmentTransferFailure {
    InvalidBase64,
    IncompleteUpload,
    SizeMismatch,
    Sha256Mismatch,
}

class AttachmentTransferException(
    val failure: AttachmentTransferFailure,
    val attachmentName: String? = null,
    cause: Throwable? = null,
) : IllegalStateException(failure.name, cause)
