package com.agentsanywhere.app.feature.terminal

import android.os.SystemClock
import android.util.Log
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
                val label = sessionTerminalLabel(session.id)
                val startedAt = SystemClock.uptimeMillis()
                terminalRouteDiag("open workspace begin connector=${session.connectorId} session=${session.id} label=\"$label\"")
                val reusableTerminal = findReusableTerminal(
                    auth = auth,
                    connectorId = session.connectorId,
                    label = label,
                )
                val terminal = if (reusableTerminal != null) {
                    terminalRouteDiag("open workspace reuse connector=${session.connectorId} terminal=${reusableTerminal.terminalId}")
                    reusableTerminal
                } else {
                    val createStartedAt = SystemClock.uptimeMillis()
                    terminalRouteDiag("open workspace create begin connector=${session.connectorId} root=\"$root\"")
                    terminalApi.createTerminal(
                        serverUrl = auth.serverUrl,
                        authorizationToken = auth.accessToken,
                        deviceId = session.connectorId,
                        root = root,
                        cols = cols,
                        rows = rows,
                        ephemeralGroupId = ephemeralGroupId,
                        label = label,
                    ).also {
                        terminalRouteDiag("open workspace create done connector=${session.connectorId} terminal=${it.terminalId} dt=${SystemClock.uptimeMillis() - createStartedAt}ms")
                    }
                }
                terminalRouteDiag(
                    "open workspace connector=${session.connectorId} session=${session.id} label=\"$label\" " +
                        "root=\"$root\" requested=${cols}x$rows reused=${reusableTerminal != null} dt=${SystemClock.uptimeMillis() - startedAt}ms ${terminal.routeSummary()}",
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
                val label = deviceTerminalLabel(connectorId)
                val startedAt = SystemClock.uptimeMillis()
                terminalRouteDiag("open device begin connector=$connectorId label=\"$label\"")
                val reusableTerminal = findReusableTerminal(
                    auth = auth,
                    connectorId = connectorId,
                    label = label,
                )
                val terminal = if (reusableTerminal != null) {
                    terminalRouteDiag("open device reuse connector=$connectorId terminal=${reusableTerminal.terminalId}")
                    reusableTerminal
                } else {
                    val createStartedAt = SystemClock.uptimeMillis()
                    terminalRouteDiag("open device create begin connector=$connectorId root=\"~\"")
                    terminalApi.createTerminal(
                        serverUrl = auth.serverUrl,
                        authorizationToken = auth.accessToken,
                        deviceId = connectorId,
                        root = "~",
                        cols = cols,
                        rows = rows,
                        ephemeralGroupId = ephemeralGroupId,
                        label = label,
                    ).also {
                        terminalRouteDiag("open device create done connector=$connectorId terminal=${it.terminalId} dt=${SystemClock.uptimeMillis() - createStartedAt}ms")
                    }
                }
                terminalRouteDiag(
                    "open device connector=$connectorId label=\"$label\" root=\"~\" requested=${cols}x$rows " +
                        "reused=${reusableTerminal != null} dt=${SystemClock.uptimeMillis() - startedAt}ms ${terminal.routeSummary()}",
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
        label: String,
    ): RemoteTerminal? {
        val startedAt = SystemClock.uptimeMillis()
        terminalRouteDiag("list begin connector=$connectorId label=\"$label\"")
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
                .toList()
                .also {
                    terminalRouteDiag("list done connector=$connectorId label=\"$label\" matched=${it.size} dt=${SystemClock.uptimeMillis() - startedAt}ms")
                }
                .firstOrNull()
        }.onFailure { error ->
            terminalRouteDiag("list failed connector=$connectorId label=\"$label\" error=${error::class.java.simpleName}: ${error.message}")
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

    private data class ApiAuth(
        val serverUrl: String,
        val accessToken: String,
    )

    private fun terminalRouteDiag(message: String) {
        Log.d(LOG_TAG, "route $message")
    }

    private fun RemoteTerminal.routeSummary(): String {
        return "terminal=$terminalId status=$status cwd=\"$cwd\" size=${cols}x$rows " +
            "scrollbackSeq=$scrollbackSeq scrollbackBytes=$scrollbackBytes pid=$pid"
    }

    private companion object {
        private const val LOG_TAG = "AATerminalSwitch"
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
)
