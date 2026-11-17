package com.agentsanywhere.app.feature.preview

import com.agentsanywhere.app.api.CreatePreviewRequest
import com.agentsanywhere.app.api.PreviewsApi
import com.agentsanywhere.app.api.RemotePreviewView
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.ConcurrentHashMap

/**
 * Opens a session's listening port in the app's in-app browser (PV-5).
 * Creating a preview asks the Server to tunnel the port; each open exchanges a
 * fresh one-time ticket for the preview domain's own cookie.
 */
class PortPreviewController(
    private val api: PreviewsApi,
    private val sessionStore: AuthSessionReader,
) {
    fun isDisabled(): Boolean = sessionStore.readServerUrl() in disabledServers

    suspend fun create(deviceId: String, port: Int, sessionId: String): RemotePreviewView = call { server, token ->
        try {
            api.create(server, token, CreatePreviewRequest(deviceId = deviceId, port = port, sessionId = sessionId))
        } catch (error: Exception) {
            if (isPortPreviewDisabled(error)) disabledServers += server
            throw error
        }
    }

    /** The one-time address to open now; never reused. */
    suspend fun ticketUrl(previewId: String): String = call { server, token ->
        api.ticket(server, token, previewId).ticketUrl
    }

    suspend fun close(previewId: String) {
        call { server, token -> api.close(server, token, previewId) }
    }

    private suspend fun <T> call(block: (server: String, token: String) -> T): T = withContext(Dispatchers.IO) {
        val server = sessionStore.readServerUrl()
        val token = sessionStore.readAccessToken()
        check(server.isNotBlank() && token.isNotBlank()) { "Sign in again to preview this port." }
        block(server, token)
    }

    private companion object {
        /** Servers that answered without port preview; the card stays hidden there until the app restarts. */
        val disabledServers: MutableSet<String> = ConcurrentHashMap.newKeySet()
    }
}
