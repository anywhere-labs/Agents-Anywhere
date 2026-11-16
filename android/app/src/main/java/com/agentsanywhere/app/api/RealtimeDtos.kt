package com.agentsanywhere.app.api

import com.agentsanywhere.app.model.ModelConfigOverview

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
    /** Every runtime instance the user can see, across devices. */
    val runtimes: List<RemoteDeviceRuntime> = emptyList(),
    /** Null when the Server does not send model configuration. */
    val modelConfig: ModelConfigOverview? = null,
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
    val goal: RemoteGoalState? = null,
    val planning: RemotePlanningState? = null,
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
    val queue: RemoteSessionQueueState? = null,
)

data class RemoteEventRecoveryResponse(
    val events: List<RemoteSessionEventEnvelope>,
    val nextCursor: String,
    val snapshotRequired: Boolean,
    val serverTime: String?,
    /** Protocol 1.2: the device is offline, nothing after the cursor is readable now. */
    val deviceOffline: Boolean = false,
)

/** Event envelopes are unchanged across protocol versions; 1.2 only adds event types. */
val ACCEPTED_EVENT_PROTOCOL_VERSIONS: Set<String> = setOf("1.0", "1.1", "1.2")

/** Protocol 1.2: the device link was rebuilt; each client recovers its own gap from its cursor. */
const val SESSION_CATCHUP_REQUIRED = "session.catchup_required"

internal fun eventCursorSequence(cursor: String?): Long? {
    val value = cursor?.takeIf { it.startsWith("seq:") }?.removePrefix("seq:") ?: return null
    if (value.isBlank() || (value.length > 1 && value.startsWith('0'))) return null
    return value.toLongOrNull()?.takeIf { it >= 0L }
}
