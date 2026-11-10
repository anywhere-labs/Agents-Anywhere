package com.agentsanywhere.app.feature.terminal

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.api.RemoteTerminal
import com.agentsanywhere.app.api.TerminalApi
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.model.AgentSession
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request

class TerminalController(
    private val terminalApi: TerminalApi,
    private val sessionStore: AuthSessionStore,
    private val authApi: AuthApi,
) {
    suspend fun openWorkspaceTerminal(
        session: AgentSession,
        cols: Int,
        rows: Int,
        ephemeralGroupId: String,
    ): Result<WorkspaceTerminalConnection> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val root = session.cwd?.takeIf { it.isNotBlank() }
                    ?: throw IllegalStateException("This session has no workspace.")
                val auth = authSession()
                val label = sessionTerminalLabel(session.id)
                val terminal = findReusableTerminal(
                    auth = auth,
                    connectorId = session.connectorId,
                    label = label,
                ) ?: terminalApi.createTerminal(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = session.connectorId,
                    root = root,
                    cols = cols,
                    rows = rows,
                    ephemeralGroupId = ephemeralGroupId,
                    label = label,
                )
                val streamAuth = authSession()
                WorkspaceTerminalConnection(
                    connectorId = session.connectorId,
                    terminal = terminal,
                    streamUrl = terminalApi.streamUrl(streamAuth.serverUrl, streamAuth.accessToken, session.connectorId, terminal.terminalId),
                    authorizationToken = streamAuth.accessToken,
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not open terminal.", error)
            }
        }
    }

    suspend fun openDeviceTerminal(
        connectorId: String,
        cols: Int,
        rows: Int,
        ephemeralGroupId: String,
    ): Result<WorkspaceTerminalConnection> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                val label = deviceTerminalLabel(connectorId)
                val terminal = findReusableTerminal(
                    auth = auth,
                    connectorId = connectorId,
                    label = label,
                ) ?: terminalApi.createTerminal(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    root = "~",
                    cols = cols,
                    rows = rows,
                    ephemeralGroupId = ephemeralGroupId,
                    label = label,
                )
                val streamAuth = authSession()
                WorkspaceTerminalConnection(
                    connectorId = connectorId,
                    terminal = terminal,
                    streamUrl = terminalApi.streamUrl(streamAuth.serverUrl, streamAuth.accessToken, connectorId, terminal.terminalId),
                    authorizationToken = streamAuth.accessToken,
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not open terminal.", error)
            }
        }
    }

    internal suspend fun prepareStreamConnection(streamUrl: String): Result<TerminalStreamConnection> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val endpoint = Request.Builder().url(streamUrl).build().url
                val auth = authSession()
                val streamOrigin = endpoint.newBuilder().encodedPath("/").query(null).fragment(null).build()
                check(streamOrigin == Request.Builder().url(auth.serverUrl).build().url) {
                    "The terminal belongs to a different server."
                }
                val user = authApi.me(auth.serverUrl, auth.accessToken)
                val current = authSession()
                check(current.serverUrl == auth.serverUrl && sessionStore.readUserId() == user.userId) {
                    "The auth session changed while connecting to the terminal."
                }
                TerminalStreamConnection(
                    streamUrl = endpoint.newBuilder()
                        .setQueryParameter("token", current.accessToken)
                        .build().toString(),
                    authorizationToken = current.accessToken,
                )
            }
        }
    }

    private fun findReusableTerminal(
        auth: ApiAuth,
        connectorId: String,
        label: String,
    ): RemoteTerminal? {
        return runCatching {
            terminalApi.listTerminals(
                serverUrl = auth.serverUrl,
                authorizationToken = auth.accessToken,
                deviceId = connectorId,
            )
                .asSequence()
                .filter { it.status != "exited" }
                .filter { it.label == label }
                .sortedByDescending { it.scrollbackSeq }
                .firstOrNull()
        }.getOrNull()
    }

    suspend fun closeTerminal(
        connectorId: String,
        terminalId: String,
    ): Result<Unit> {
        return withContext(Dispatchers.IO) {
            runCatching {
                val auth = authSession()
                terminalApi.closeTerminal(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    terminalId = terminalId,
                )
                Unit
            }
        }
    }

    private fun authSession(): ApiAuth {
        val serverUrl = sessionStore.readServerUrl()
        val accessToken = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || accessToken.isBlank()) {
            throw IllegalStateException("Sign in again to open terminal.")
        }
        return ApiAuth(serverUrl = serverUrl, accessToken = accessToken)
    }

    internal fun notifyUnauthorized(authorizationToken: String) {
        terminalApi.notifyUnauthorized(authorizationToken)
    }

    private data class ApiAuth(
        val serverUrl: String,
        val accessToken: String,
    )

    private companion object {
        private const val TERMINAL_LABEL_MAX_CHARS = 64

        private fun sessionTerminalLabel(sessionId: String): String {
            return uniqueTerminalLabel("AA Session", sessionId)
        }

        private fun deviceTerminalLabel(connectorId: String): String {
            return uniqueTerminalLabel("AA Device", connectorId)
        }

        private fun uniqueTerminalLabel(prefix: String, id: String): String {
            val hash = id.hashCode().toUInt().toString(16)
            val maxIdLength = TERMINAL_LABEL_MAX_CHARS - prefix.length - hash.length - 2
            val trimmedId = id.take(maxIdLength.coerceAtLeast(8))
            return "$prefix $trimmedId $hash"
        }
    }
}

data class WorkspaceTerminalConnection(
    val connectorId: String,
    val terminal: RemoteTerminal,
    val streamUrl: String,
    val authorizationToken: String,
)

internal data class TerminalStreamConnection(
    val streamUrl: String,
    val authorizationToken: String,
)
