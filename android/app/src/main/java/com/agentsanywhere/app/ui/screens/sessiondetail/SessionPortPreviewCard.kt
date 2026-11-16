package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.RemoteListeningPort
import com.agentsanywhere.app.api.RemotePreviewView
import com.agentsanywhere.app.feature.preview.PortPreviewController
import com.agentsanywhere.app.feature.preview.PortPreviewError
import com.agentsanywhere.app.feature.preview.isPortPreviewDisabled
import com.agentsanywhere.app.feature.preview.localPortUrl
import com.agentsanywhere.app.feature.preview.portPreviewError
import com.agentsanywhere.app.feature.preview.visibleListeningPorts
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.screens.modelconfig.openExternalLink
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

private sealed interface PortPreviewPhase {
    data object Idle : PortPreviewPhase
    data object Busy : PortPreviewPhase
    data class Open(val view: RemotePreviewView, val busy: Boolean = false) : PortPreviewPhase
}

/** The text for a preview failure: contract codes use their runtime-errors 1.1 text. */
@StringRes
internal fun portPreviewErrorText(error: PortPreviewError): Int = when (error) {
    PortPreviewError.PortNotAllowed -> R.string.runtime_error_preview_port_not_allowed
    PortPreviewError.LimitReached -> R.string.runtime_error_preview_limit_reached
    PortPreviewError.DomainNotConfigured -> R.string.runtime_error_preview_domain_not_configured
    PortPreviewError.PreviewUnavailable -> R.string.port_preview_error_preview_unavailable
    PortPreviewError.ConnectorOffline -> R.string.port_preview_error_connector_offline
    PortPreviewError.Failed -> R.string.port_preview_error_failed
}

/**
 * "检测到 http://localhost:5173 · 预览" above the composer (09-port-preview §5.2, PV-5).
 * Shown only while this session's processes listen on a port and the instance
 * has port preview: without it the API answers 404 and the card hides for the
 * rest of the app run. "预览" opens the page in a Custom Tab with a fresh
 * one-time ticket each time.
 */
@Composable
internal fun SessionPortPreviewCard(
    sessionId: String,
    deviceId: String,
    ports: Map<Int, RemoteListeningPort>,
    canPreview: Boolean,
    controller: PortPreviewController,
    onError: (String) -> Unit,
    onMessage: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    val colors = LocalAAColors.current
    val phases = remember(sessionId) { mutableStateMapOf<Int, PortPreviewPhase>() }
    val errors = remember(sessionId) { mutableStateMapOf<Int, PortPreviewError>() }
    var disabled by remember { mutableStateOf(controller.isDisabled()) }
    /** Previews whose plain-text notice the user has seen. */
    val acknowledged = remember(sessionId) { mutableStateMapOf<String, Boolean>() }
    var pendingNotice by remember(sessionId) { mutableStateOf<Pair<Int, RemotePreviewView>?>(null) }
    // A port that stopped listening takes its preview with it (the Server closes it as `port_closed`).
    LaunchedEffect(sessionId, ports.keys) {
        phases.keys.retainAll(ports.keys)
        errors.keys.retainAll(ports.keys)
        if (pendingNotice?.first?.let { it !in ports } == true) pendingNotice = null
    }

    val visible = visibleListeningPorts(ports)
    if (disabled || visible.isEmpty()) return

    fun fail(port: Int, error: Throwable) {
        errors[port] = portPreviewError(error)
    }

    fun launchTicket(port: Int, view: RemotePreviewView) {
        phases[port] = PortPreviewPhase.Open(view, busy = true)
        scope.launch {
            try {
                // One-time ticket: exchanged by the preview domain for its own cookie.
                val ticketUrl = controller.ticketUrl(view.previewId)
                if (!openExternalLink(context, ticketUrl)) onError(context.getString(R.string.port_preview_no_browser))
                phases[port] = PortPreviewPhase.Open(view)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                // The preview is gone (closed by the Server or expired): start over next time.
                phases[port] = if (error is ApiException && error.statusCode == 404) PortPreviewPhase.Idle
                    else PortPreviewPhase.Open(view)
                fail(port, error)
            }
        }
    }

    fun openPreview(port: Int, view: RemotePreviewView) {
        if (view.plaintextNotice && acknowledged[view.previewId] != true) {
            pendingNotice = port to view
        } else {
            launchTicket(port, view)
        }
    }

    fun preview(port: Int) {
        errors.remove(port)
        when (val phase = phases[port]) {
            is PortPreviewPhase.Open -> openPreview(port, phase.view)
            PortPreviewPhase.Busy -> Unit
            else -> {
                phases[port] = PortPreviewPhase.Busy
                scope.launch {
                    try {
                        val view = controller.create(deviceId = deviceId, port = port, sessionId = sessionId)
                        phases[port] = PortPreviewPhase.Open(view)
                        openPreview(port, view)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        phases[port] = PortPreviewPhase.Idle
                        if (isPortPreviewDisabled(error)) disabled = true else fail(port, error)
                    }
                }
            }
        }
    }

    fun stop(port: Int, view: RemotePreviewView) {
        errors.remove(port)
        phases[port] = PortPreviewPhase.Open(view, busy = true)
        scope.launch {
            try {
                controller.close(view.previewId)
                phases[port] = PortPreviewPhase.Idle
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (error is ApiException && error.statusCode == 404) {
                    phases[port] = PortPreviewPhase.Idle
                } else {
                    phases[port] = PortPreviewPhase.Open(view)
                    onError(context.getString(portPreviewErrorText(portPreviewError(error))))
                }
            }
        }
    }

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(colors.raisedSurface)
            .padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        visible.forEach { listening ->
            val port = listening.port
            val phase = phases[port] ?: PortPreviewPhase.Idle
            val busy = phase == PortPreviewPhase.Busy || (phase as? PortPreviewPhase.Open)?.busy == true
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = stringResource(R.string.port_preview_detected, localPortUrl(listening)),
                    color = colors.ink,
                    fontSize = 12.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                if (busy) {
                    CircularProgressIndicator(
                        modifier = Modifier.padding(horizontal = 8.dp).size(14.dp),
                        strokeWidth = 1.5.dp,
                        color = colors.muted,
                    )
                }
                TextButton(onClick = { preview(port) }, enabled = canPreview && !busy) {
                    Text(stringResource(R.string.port_preview_open), fontSize = 12.sp)
                }
            }
            if (phase is PortPreviewPhase.Open) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.End,
                ) {
                    val url = phase.view.url
                    TextButton(
                        onClick = {
                            if (url != null) {
                                clipboard.setText(AnnotatedString(url))
                                onMessage(context.getString(R.string.port_preview_copied))
                            }
                        },
                        enabled = url != null,
                    ) {
                        Text(stringResource(R.string.port_preview_copy), fontSize = 12.sp)
                    }
                    TextButton(onClick = { stop(port, phase.view) }, enabled = !phase.busy) {
                        Text(stringResource(R.string.port_preview_stop), fontSize = 12.sp)
                    }
                }
            }
            errors[port]?.let { error ->
                Text(
                    text = stringResource(portPreviewErrorText(error)),
                    color = colors.errorText,
                    fontSize = 12.sp,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(bottom = 4.dp),
                )
            }
        }
        if (!canPreview) {
            Text(
                text = stringResource(R.string.port_preview_offline),
                color = colors.muted,
                fontSize = 12.sp,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(bottom = 4.dp),
            )
        }
    }

    pendingNotice?.let { (port, view) ->
        AlertDialog(
            onDismissRequest = { pendingNotice = null },
            title = { Text(stringResource(R.string.port_preview_plaintext_title)) },
            text = { Text(stringResource(R.string.port_preview_plaintext_description)) },
            confirmButton = {
                TextButton(onClick = {
                    pendingNotice = null
                    acknowledged[view.previewId] = true
                    launchTicket(port, view)
                }) {
                    Text(stringResource(R.string.port_preview_plaintext_continue))
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingNotice = null }) {
                    Text(stringResource(R.string.port_preview_cancel))
                }
            },
        )
    }
}
