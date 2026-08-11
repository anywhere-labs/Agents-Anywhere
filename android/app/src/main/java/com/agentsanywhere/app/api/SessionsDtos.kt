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
    val connectorResult: Any?,
    val attachments: List<RemoteUploadedAttachment>,
)

data class RemoteRuntimeConfigSchema(
    val runtime: String,
    val schemaVersion: Int,
    val fields: List<RemoteRuntimeConfigField>,
)

data class RemoteRuntimeConfigField(
    val key: String,
    val label: String,
    val type: String,
    val description: String?,
    val options: List<RemoteRuntimeConfigOption>,
    val visibleWhen: Map<String, Any?>,
    val allowSessionOverride: Boolean,
    val hidden: Boolean,
)

data class RemoteRuntimeConfigOption(
    val value: String,
    val label: String,
    val description: String?,
    val efforts: List<RemoteRuntimeConfigOption>?,
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
    val updatedAt: String?,
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
    val blocking: Map<String, Any?>?,
    val responseRequired: Boolean,
    val actions: List<Map<String, Any?>>,
    val context: Map<String, Any?>,
    val metadata: Map<String, Any?>,
    val expiresAt: String?,
    val revision: Int,
    val updatedSeq: Int,
    val createdAt: String?,
    val resolvedAt: String?,
)

data class RemoteSessionSnapshot(
    val session: RemoteSession,
    val state: RemoteSessionRuntimeState?,
    val timeline: RemoteSessionTimelineSnapshot,
    val approvals: List<RemoteApproval>,
    val notices: List<RemoteRuntimeNotice>,
    val effectiveCapabilities: RemoteRuntimeCapabilitySet,
    val runtimeCapabilities: RemoteRuntimeCapabilitySet,
    val catalogs: RemoteSessionRuntimeCatalogs,
    val eventCursor: String,
    val serverTime: String?,
)

data class RemoteSessionTimelineSnapshot(
    val items: List<RemoteTimelineItem>,
    val nextSeq: Int,
    val hasMore: Boolean,
)

data class RemoteSessionRuntimeCatalogs(
    val model: RemoteRuntimeModelCatalog?,
    val permission: RemoteRuntimePermissionCatalog?,
    val unknown: Map<String, Any?>,
)

data class RemoteTimelineItem(
    val id: String,
    val sessionId: String,
    val turnId: String?,
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

data class RemoteApproval(
    val id: String,
    val sessionId: String,
    val turnId: String?,
    val status: String,
    val kind: String,
    val targetItemId: String?,
    val title: String,
    val description: String?,
    val choices: List<String>,
    val updatedSeq: Int,
    val createdAt: String,
)

data class RemoteSessionEvent(
    val sessionId: String,
    val items: List<RemoteTimelineItem>,
    val approvals: List<RemoteApproval>?,
    val session: RemoteSession?,
    val nextSeq: Int,
    val refetch: Boolean,
)

data class RemoteRpcResponse(
    val ok: Boolean,
    val turnId: String?,
)

data class RemoteUploadedAttachment(
    val fileId: String,
    val name: String,
    val mediaType: String,
    val size: Long,
    val sha256: String? = null,
)
