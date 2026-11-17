package com.agentsanywhere.app.feature.preview

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.PORT_CLOSED_EVENT
import com.agentsanywhere.app.api.PORT_LISTENING_EVENT
import com.agentsanywhere.app.api.RemoteListeningPort
import com.agentsanywhere.app.api.RemoteSessionEventPayload

/** The card shows at most this many ports. */
const val MAX_VISIBLE_PORTS = 3

/**
 * The ports this session's Agent or terminals serve (preview 1.0, 09-port-preview §5.1).
 * `port.listening` carries the device's whole current list, so this session's
 * ports replace the previous ones; `port.closed` removes one port. An unchanged
 * report returns [current] itself.
 */
fun applySessionPortEvent(
    current: Map<Int, RemoteListeningPort>,
    type: String,
    payload: RemoteSessionEventPayload,
    sessionId: String,
): Map<Int, RemoteListeningPort> = when (type) {
    PORT_LISTENING_EVENT -> {
        val next = LinkedHashMap<Int, RemoteListeningPort>()
        payload.ports.forEach { port -> if (port.sessionId == sessionId) next[port.port] = port }
        if (next == current) current else next
    }
    PORT_CLOSED_EVENT -> {
        val port = payload.closedPort
        if (port == null || port !in current) current else current - port
    }
    else -> current
}

/** What the card shows for a port: the URL the Agent printed, or localhost. */
fun localPortUrl(port: RemoteListeningPort): String =
    port.url?.takeIf(String::isNotBlank) ?: "http://localhost:${port.port}"

/** The ports the card lists, lowest first. */
fun visibleListeningPorts(ports: Map<Int, RemoteListeningPort>): List<RemoteListeningPort> =
    ports.values.sortedBy { it.port }.take(MAX_VISIBLE_PORTS)

/** Why a preview could not be created, opened or stopped (codes from runtime-errors 1.1). */
enum class PortPreviewError {
    /** `preview_port_not_allowed`: the port is not listening, or not on a local address. */
    PortNotAllowed,
    /** `preview_limit_reached`. */
    LimitReached,
    /** `preview_domain_not_configured`: the instance has no port preview. */
    DomainNotConfigured,
    /** `preview_unavailable`: the device's preview tunnel is down (not in the contract yet). */
    PreviewUnavailable,
    /** `connector_offline`. */
    ConnectorOffline,
    Failed,
}

/** Server error codes with their own text; everything else is [PortPreviewError.Failed]. */
fun portPreviewError(error: Throwable): PortPreviewError {
    val api = error as? ApiException ?: return PortPreviewError.Failed
    return when (api.errorCode) {
        "preview_port_not_allowed" -> PortPreviewError.PortNotAllowed
        "preview_limit_reached" -> PortPreviewError.LimitReached
        "preview_domain_not_configured" -> PortPreviewError.DomainNotConfigured
        "preview_unavailable" -> PortPreviewError.PreviewUnavailable
        "connector_offline" -> PortPreviewError.ConnectorOffline
        else -> PortPreviewError.Failed
    }
}

/**
 * The instance has no port preview (no preview domain): the API answers 404 or
 * `preview_domain_not_configured`. The card then hides for the rest of the run.
 */
fun isPortPreviewDisabled(error: Throwable): Boolean =
    error is ApiException && (error.statusCode == 404 || error.errorCode == "preview_domain_not_configured")
