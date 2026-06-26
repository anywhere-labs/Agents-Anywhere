package com.agentsanywhere.app.api

import org.json.JSONObject

class TerminalApi(
    private val client: ApiClient = ApiClient(),
) {
    fun createTerminal(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        root: String,
        cols: Int,
        rows: Int,
        cwd: String = ".",
        ephemeralGroupId: String,
    ): RemoteTerminal {
        val body = JSONObject().apply {
            put("cols", cols)
            put("rows", rows)
            put("cwd", cwd)
            put("ephemeralGroupId", ephemeralGroupId)
        }
        return client.postJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/terminals?root=${root.urlEncode()}",
            body = body,
            authorizationToken = authorizationToken,
        ).getJSONObject("terminal").toRemoteTerminal()
    }

    fun closeTerminal(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        terminalId: String,
    ) {
        client.deleteJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/terminals/${terminalId.urlEncode()}",
            authorizationToken = authorizationToken,
        )
    }

    fun streamUrl(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        terminalId: String,
        fromSeq: Long = 0,
    ): String {
        return serverUrl.toWebSocketBase() +
            "/connectors/${deviceId.urlEncode()}/terminals/${terminalId.urlEncode()}/stream" +
            "?fromSeq=$fromSeq&token=${authorizationToken.urlEncode()}"
    }

    private fun JSONObject.toRemoteTerminal(): RemoteTerminal {
        return RemoteTerminal(
            terminalId = getString("terminalId"),
            sessionId = optString("sessionId", ""),
            label = optString("label", "zsh").ifBlank { "zsh" },
            cwd = optString("cwd", ""),
            cols = optInt("cols", 80),
            rows = optInt("rows", 24),
            purpose = optString("purpose", "user"),
            pid = if (has("pid") && !isNull("pid")) optInt("pid") else null,
            status = optString("status", "starting"),
            exitCode = if (has("exitCode") && !isNull("exitCode")) optInt("exitCode") else null,
            scrollbackSeq = optInt("scrollbackSeq", 0),
        )
    }

    private fun String.toWebSocketBase(): String {
        val base = trimEnd('/')
        return when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
            else -> base
        }
    }
}
