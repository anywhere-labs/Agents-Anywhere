package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteRuntimeCapability
import com.agentsanywhere.app.api.RemoteRuntimeCapabilitySet
import com.agentsanywhere.app.api.RemoteRuntimeNotice
import com.agentsanywhere.app.api.RemoteSessionRuntimeState

internal fun mergeRuntimeNotices(
    current: List<RuntimeNotice>,
    incoming: List<RemoteRuntimeNotice>,
    replace: Boolean,
): List<RuntimeNotice> {
    val currentById = current.associateBy { it.noticeId }
    val incomingById = incoming.map { it.toRuntimeNotice() }.associateBy { it.noticeId }
    val noticeIds = if (replace) incomingById.keys else currentById.keys + incomingById.keys
    return noticeIds.mapNotNull { noticeId ->
        val existing = currentById[noticeId]
        val observed = incomingById[noticeId]
        when {
            observed == null -> existing
            existing == null -> observed
            observed.revision > existing.revision -> observed
            observed.updatedSeq >= existing.updatedSeq -> observed
            else -> existing
        }
    }.sortedWith(compareBy<RuntimeNotice> { it.updatedSeq }.thenBy { it.noticeId })
}

private fun RemoteRuntimeNotice.toRuntimeNotice(): RuntimeNotice {
    return RuntimeNotice(
        noticeId = noticeId,
        type = type,
        sessionId = sessionId,
        title = title,
        message = message,
        severity = severity,
        status = status,
        interactionType = interactionType,
        blocking = blocking?.let { RuntimeNoticeBlocking(scope = it.scope, targetId = it.targetId) },
        responseRequired = responseRequired,
        revision = revision,
        updatedSeq = updatedSeq,
        source = source,
        actions = actions.map { it.toRuntimeNoticeAction() },
        context = context,
        metadata = metadata,
        expiresAt = expiresAt,
        createdAt = createdAt,
        updatedAt = updatedAt,
        resolvedAt = resolvedAt,
    )
}

internal fun RemoteSessionRuntimeState?.toSessionRuntimeState(serverTime: String?): SessionRuntimeState {
    if (this == null) {
        return SessionRuntimeState(
            serverTime = serverTime,
            isLoaded = true,
        )
    }
    return SessionRuntimeState(
        sessionId = sessionId,
        runtime = runtime,
        externalSessionId = externalSessionId,
        status = when (status) {
            "idle" -> SessionRuntimeStatus.Idle
            "running" -> SessionRuntimeStatus.Running
            "waiting_approval" -> SessionRuntimeStatus.WaitingApproval
            "error" -> SessionRuntimeStatus.Error
            else -> SessionRuntimeStatus.Unknown
        },
        selections = selections,
        statusReason = statusReason,
        error = error,
        metadata = metadata,
        updatedSeq = updatedSeq,
        createdAt = createdAt,
        updatedAt = updatedAt,
        serverTime = serverTime,
        isLoaded = true,
    )
}

internal fun RemoteRuntimeCapabilitySet.toEffectiveCapabilities(
    connectorId: String?,
    serverTime: String?,
): EffectiveCapabilities {
    return EffectiveCapabilities(
        revision = revision,
        capabilities = capabilities.map { it.toEffectiveCapability() },
        connectorId = connectorId,
        serverTime = serverTime,
        isLoaded = true,
    )
}

internal fun RemoteRuntimeCapabilitySet.toRuntimeCapabilities(): RuntimeCapabilities {
    return RuntimeCapabilities(
        revision = revision,
        capabilities = capabilities.map { it.toEffectiveCapability() },
        isLoaded = true,
    )
}

private fun RemoteRuntimeCapability.toEffectiveCapability(): EffectiveCapability {
    return EffectiveCapability(
        capabilityId = capabilityId,
        version = version,
        scope = scope,
        runtime = runtime,
        sessionId = sessionId,
        supported = supported,
        available = available,
        allowed = allowed,
        unavailableReason = unavailableReason,
        parameters = parameters,
    )
}
