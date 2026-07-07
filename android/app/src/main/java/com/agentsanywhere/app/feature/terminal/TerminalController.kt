package com.agentsanywhere.app.feature.terminal

import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.api.RemoteTerminal
import com.agentsanywhere.app.api.TerminalApi
import com.agentsanywhere.app.feature.auth.AuthSessionStore
import com.agentsanywhere.app.model.AgentSession
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class TerminalController(
    private val terminalApi: TerminalApi,
    private val sessionStore: AuthSessionStore,
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
                val terminal = findReusableTerminal(
                    auth = auth,
                    connectorId = session.connectorId,
                    expectedRoot = root,
                    labelPrefix = WORKSPACE_LABEL_PREFIX,
                ) ?: terminalApi.createTerminal(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = session.connectorId,
                    root = root,
                    cols = cols,
                    rows = rows,
                    ephemeralGroupId = ephemeralGroupId,
                    label = WORKSPACE_LABEL,
                )
                WorkspaceTerminalConnection(
                    connectorId = session.connectorId,
                    terminal = terminal,
                    streamUrl = terminalApi.streamUrl(auth.serverUrl, auth.accessToken, session.connectorId, terminal.terminalId),
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
                val terminal = findReusableTerminal(
                    auth = auth,
                    connectorId = connectorId,
                    expectedRoot = null,
                    labelPrefix = DEVICE_LABEL_PREFIX,
                ) ?: terminalApi.createTerminal(
                    serverUrl = auth.serverUrl,
                    authorizationToken = auth.accessToken,
                    deviceId = connectorId,
                    root = "~",
                    cols = cols,
                    rows = rows,
                    ephemeralGroupId = ephemeralGroupId,
                    label = DEVICE_LABEL,
                )
                WorkspaceTerminalConnection(
                    connectorId = connectorId,
                    terminal = terminal,
                    streamUrl = terminalApi.streamUrl(auth.serverUrl, auth.accessToken, connectorId, terminal.terminalId),
                )
            }.recoverCatching { error ->
                if (error is ApiException) throw error
                throw IllegalStateException(error.message ?: "Could not open terminal.", error)
            }
        }
    }

    private fun findReusableTerminal(
        auth: ApiAuth,
        connectorId: String,
        expectedRoot: String?,
        labelPrefix: String,
    ): RemoteTerminal? {
        return runCatching {
            terminalApi.listTerminals(
                serverUrl = auth.serverUrl,
                authorizationToken = auth.accessToken,
                deviceId = connectorId,
            )
                .asSequence()
                .filter { it.status != "exited" }
                .filter { terminal ->
                    if (expectedRoot == null) {
                        terminal.label.startsWith(labelPrefix)
                    } else {
                        samePath(terminal.cwd, expectedRoot)
                    }
                }
                .sortedByDescending { it.scrollbackSeq }
                .firstOrNull()
        }.getOrNull()
    }

    private fun samePath(left: String, right: String): Boolean {
        val a = left.trim().trimEnd('/', '\\')
        val b = right.trim().trimEnd('/', '\\')
        if (a.isBlank() || b.isBlank()) return false
        val ignoreCase = a.getOrNull(1) == ':' || b.getOrNull(1) == ':'
        return a.equals(b, ignoreCase = ignoreCase)
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

    private data class ApiAuth(
        val serverUrl: String,
        val accessToken: String,
    )

    private companion object {
        private const val WORKSPACE_LABEL_PREFIX = "Agents Anywhere Session"
        private const val DEVICE_LABEL_PREFIX = "Agents Anywhere Device"
        private const val WORKSPACE_LABEL = "Agents Anywhere Session"
        private const val DEVICE_LABEL = "Agents Anywhere Device"
    }
}

data class WorkspaceTerminalConnection(
    val connectorId: String,
    val terminal: RemoteTerminal,
    val streamUrl: String,
)
