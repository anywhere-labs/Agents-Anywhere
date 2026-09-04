package com.agentsanywhere.app.api

data class RemoteWsTicket(
    val ticket: String,
    val expiresAt: String,
    val serverTime: String,
)

data class RemoteDashboardSnapshot(
    val devices: List<RemoteDevice>,
    val projects: List<RemoteProject>,
    val sessions: List<RemoteSession>,
    val activePage: RemoteSessionPageInfo,
    val archivedPage: RemoteSessionPageInfo,
    val serverTime: String?,
)

data class RemoteSessionPageInfo(
    val hasMore: Boolean,
    val nextCursor: String?,
)

data class RemoteSessionEventEnvelope(
    val protocolVersion: String,
    val eventId: String,
    val sequence: Long,
    val cursor: String,
    val type: String,
    val sessionId: String,
    val emittedAt: String?,
    val payload: RemoteSessionEventPayload,
)

data class RemoteSessionEventPayload(
    val session: RemoteSession? = null,
    val item: RemoteTimelineItem? = null,
    val items: List<RemoteTimelineItem> = emptyList(),
    val state: RemoteSessionRuntimeState? = null,
    val notice: RemoteRuntimeNotice? = null,
    val notices: List<RemoteRuntimeNotice> = emptyList(),
    val capabilitySet: RemoteRuntimeCapabilitySet? = null,
    val catalogType: String? = null,
    val modelCatalog: RemoteRuntimeModelCatalog? = null,
    val permissionCatalog: RemoteRuntimePermissionCatalog? = null,
    val eventCursor: String? = null,
)

data class RemoteEventRecoveryResponse(
    val events: List<RemoteSessionEventEnvelope>,
    val nextCursor: String,
    val snapshotRequired: Boolean,
    val serverTime: String?,
)

internal fun eventCursorSequence(cursor: String?): Long? {
    val value = cursor?.takeIf { it.startsWith("seq:") }?.removePrefix("seq:") ?: return null
    if (value.isBlank() || (value.length > 1 && value.startsWith('0'))) return null
    return value.toLongOrNull()?.takeIf { it >= 0L }
}
