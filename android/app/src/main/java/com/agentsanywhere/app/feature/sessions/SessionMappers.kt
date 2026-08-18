package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.api.RemoteSession
import com.agentsanywhere.app.model.AgentDevice
import com.agentsanywhere.app.model.AgentSession
import com.agentsanywhere.app.model.SessionStatus
import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeParseException

internal fun RemoteSession.toAgentSession(devicesById: Map<String, AgentDevice>): AgentSession {
    val workspace = cwd.workspaceName()
    val statusValue = status.toSessionStatus()
    val displayTitle = title?.takeIf { it.isNotBlank() }
        ?: externalSessionId?.takeIf { it.isNotBlank() }
        ?: "Untitled session"
    val activityAt = lastActivityAt ?: lastItemAt ?: sortAt ?: sourceObservedAt ?: lastSyncedAt
    val runtimeText = runtime.runtimeLabel()
    val deviceName = devicesById[connectorId]?.name ?: connectorId.take(8).ifBlank { "Device" }
    val metaParts = listOfNotNull(
        runtimeText,
        deviceName.takeIf { it.isNotBlank() },
        workspace.takeIf { it.isNotBlank() },
    )

    return AgentSession(
        id = id,
        connectorId = connectorId,
        deviceName = deviceName,
        title = displayTitle,
        summary = summaryText(statusValue, cwd, connectorStatus),
        cwd = cwd,
        workspaceLabel = workspace,
        runtime = runtime,
        runtimeLabel = runtimeText,
        status = statusValue,
        statusLabel = statusValue.statusLabel(),
        updatedAtLabel = activityAt.relativeTimeLabel(),
        metaLabel = metaParts.joinToString("  ·  "),
        pinned = pinned,
        archived = archived,
        unread = unread,
        lastReadSeq = lastReadSeq,
        takeover = takeover,
        connectorOnline = connectorStatus == "online",
        live = statusValue in setOf(
            SessionStatus.Waiting,
            SessionStatus.Pending,
            SessionStatus.Running,
            SessionStatus.WaitingApproval,
        ),
        sortKey = sortAt ?: lastActivityAt ?: lastItemAt ?: "",
        updatedSeq = updatedSeq,
    )
}

private fun summaryText(status: SessionStatus, cwd: String?, connectorStatus: String): String {
    return when {
        status == SessionStatus.WaitingApproval -> "Waiting for approval."
        status in setOf(SessionStatus.Waiting, SessionStatus.Pending, SessionStatus.Running) -> "Running now."
        status == SessionStatus.Error -> "Needs attention."
        !cwd.isNullOrBlank() -> cwd
        connectorStatus == "offline" -> "Device is offline."
        else -> "Ready for the next update."
    }
}

private fun String.toSessionStatus(): SessionStatus {
    return when (this) {
        "idle" -> SessionStatus.Idle
        "waiting" -> SessionStatus.Waiting
        "pending" -> SessionStatus.Pending
        "running" -> SessionStatus.Running
        "stopping" -> SessionStatus.Stopping
        "waiting_approval" -> SessionStatus.WaitingApproval
        "error" -> SessionStatus.Error
        "blocked" -> SessionStatus.Blocked
        else -> SessionStatus.Unknown
    }
}

private fun SessionStatus.statusLabel(): String {
    return when (this) {
        SessionStatus.Idle -> "Idle"
        SessionStatus.Waiting -> "Waiting"
        SessionStatus.Pending -> "Pending"
        SessionStatus.Running -> "Running"
        SessionStatus.Stopping -> "Stopping"
        SessionStatus.WaitingApproval -> "Approval"
        SessionStatus.Error -> "Error"
        SessionStatus.Blocked -> "Blocked"
        SessionStatus.Unknown -> "Unknown"
    }
}

private fun String?.workspaceName(): String {
    val trimmed = this?.trim()?.trimEnd('/') ?: return ""
    if (trimmed.isBlank()) return ""
    return trimmed.substringAfterLast('/').ifBlank { trimmed }
}

private fun String?.relativeTimeLabel(): String {
    if (isNullOrBlank()) return ""
    val instant = try {
        Instant.parse(this)
    } catch (_: DateTimeParseException) {
        return ""
    }
    val elapsed = Duration.between(instant, Instant.now()).coerceAtLeast(Duration.ZERO)
    val minutes = elapsed.toMinutes()
    val hours = elapsed.toHours()
    val days = elapsed.toDays()
    return when {
        minutes < 1 -> "now"
        minutes < 60 -> "${minutes}m"
        hours < 24 -> "${hours}h"
        days == 1L -> "Yest."
        days < 7 -> "${days}d"
        days < 365 -> "${days / 7}w"
        else -> "${days / 365}y"
    }
}
