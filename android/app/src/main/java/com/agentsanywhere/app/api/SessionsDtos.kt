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
    val archived: Boolean,
    val unread: Boolean,
    val lastSyncedAt: String?,
    val sourceObservedAt: String?,
    val lastActivityAt: String?,
    val lastItemAt: String?,
    val sortAt: String?,
    val updatedSeq: Int,
    val runtimeSettings: Map<String, Any?>,
    val runtimeSettingsOverride: Map<String, Any?>,
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

data class RemoteRuntimeSettings(
    val runtime: String,
    val settings: Map<String, Any?>,
    val runtimeSettingsOverride: Map<String, Any?>,
    val schemaVersion: Int,
)

data class RemoteSessionState(
    val session: RemoteSession,
    val items: List<RemoteTimelineItem>,
    val approvals: List<RemoteApproval>,
    val nextSeq: Int,
    val hasMore: Boolean,
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
    val updatedSeq: Int,
    val createdAt: String,
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
)
