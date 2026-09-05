package com.agentsanywhere.app.api

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

interface RealtimeTransport {
    fun createDashboardTicket(serverUrl: String, authorizationToken: String, clientId: String): RemoteWsTicket
    fun createSessionTicket(
        serverUrl: String,
        authorizationToken: String,
        clientId: String,
        sessionId: String,
    ): RemoteWsTicket
    fun dashboardWebSocketUrl(serverUrl: String, ticket: String): String
    fun sessionWebSocketUrl(serverUrl: String, sessionId: String, ticket: String): String
    fun recoverSessionEvents(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        after: String,
    ): RemoteEventRecoveryResponse
    fun parseDashboardMessage(text: String): RemoteDashboardSnapshot?
    fun parseSessionMessage(text: String): RemoteSessionEventEnvelope?
    fun openWebSocket(url: String, listener: WebSocketListener): WebSocket
}

class RealtimeApi(
    private val client: ApiClient = ApiClient(),
    private val sessionsApi: SessionsApi = SessionsApi(client),
    private val devicesApi: DevicesApi = DevicesApi(client),
    private val socketClient: OkHttpClient = DEFAULT_SOCKET_CLIENT,
) : RealtimeTransport {
    override fun createDashboardTicket(
        serverUrl: String,
        authorizationToken: String,
        clientId: String,
    ): RemoteWsTicket = createTicket(
        serverUrl = serverUrl,
        authorizationToken = authorizationToken,
        clientId = clientId,
        scope = JSONObject().put("dashboard", true),
    )

    override fun createSessionTicket(
        serverUrl: String,
        authorizationToken: String,
        clientId: String,
        sessionId: String,
    ): RemoteWsTicket = createTicket(
        serverUrl = serverUrl,
        authorizationToken = authorizationToken,
        clientId = clientId,
        scope = JSONObject().put("sessionId", sessionId),
    )

    override fun dashboardWebSocketUrl(serverUrl: String, ticket: String): String = webSocketApiUrl(
        serverUrl,
        "/dashboard/ws?ticket=${ticket.urlEncode()}",
    )

    override fun sessionWebSocketUrl(serverUrl: String, sessionId: String, ticket: String): String = webSocketApiUrl(
        serverUrl,
        "/sessions/${sessionId.urlEncode()}/ws?ticket=${ticket.urlEncode()}",
    )

    override fun recoverSessionEvents(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        after: String,
    ): RemoteEventRecoveryResponse {
        val response = client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/events?after=${after.urlEncode()}",
            authorizationToken = authorizationToken,
        )
        return RemoteEventRecoveryResponse(
            events = response.optJSONArray("events").toObjectList { sessionsApi.parseSessionEvent(this) },
            nextCursor = response.optString("nextCursor", after),
            snapshotRequired = response.optBoolean("snapshotRequired", false),
            serverTime = response.optNullableString("serverTime"),
        )
    }

    override fun parseDashboardMessage(text: String): RemoteDashboardSnapshot? {
        val message = runCatching { JSONObject(text) }.getOrNull() ?: return null
        if (message.optString("type") != "dashboard.snapshot") return null
        val sessionPages = message.optJSONObject("sessionPages") ?: return null
        val activePage = sessionPages.optJSONObject("active") ?: return null
        val archivedPage = sessionPages.optJSONObject("archived") ?: return null
        return RemoteDashboardSnapshot(
            devices = message.optJSONArray("connectors").toObjectList { devicesApi.parseDevice(this) },
            projects = message.optJSONArray("projects").toObjectList { sessionsApi.parseProject(this) },
            sessions = message.optJSONArray("sessions").toObjectList { sessionsApi.parseSession(this) },
            activePage = activePage.toRemoteSessionPageInfo(),
            archivedPage = archivedPage.toRemoteSessionPageInfo(),
            serverTime = message.optNullableString("serverTime"),
        )
    }

    override fun parseSessionMessage(text: String): RemoteSessionEventEnvelope? {
        val message = runCatching { JSONObject(text) }.getOrNull() ?: return null
        if (message.optString("type") == "keepalive") return null
        return runCatching { sessionsApi.parseSessionEvent(message) }.getOrNull()
    }

    override fun openWebSocket(url: String, listener: WebSocketListener): WebSocket {
        return socketClient.newWebSocket(Request.Builder().url(url).build(), listener)
    }

    private fun createTicket(
        serverUrl: String,
        authorizationToken: String,
        clientId: String,
        scope: JSONObject,
    ): RemoteWsTicket {
        val response = client.postJson(
            serverUrl = serverUrl,
            path = "/ws-ticket",
            body = JSONObject().put("clientId", clientId).put("scope", scope),
            authorizationToken = authorizationToken,
        )
        return RemoteWsTicket(
            ticket = response.getString("ticket"),
            expiresAt = response.getString("expiresAt"),
            serverTime = response.getString("serverTime"),
        )
    }

    private companion object {
        val DEFAULT_SOCKET_CLIENT: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }
}

private fun JSONObject.toRemoteSessionPageInfo(): RemoteSessionPageInfo = RemoteSessionPageInfo(
    hasMore = optBoolean("hasMore", false),
    nextCursor = optNullableString("nextCursor"),
)
