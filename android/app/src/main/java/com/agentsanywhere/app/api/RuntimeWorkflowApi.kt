package com.agentsanywhere.app.api

import org.json.JSONObject

class RuntimeWorkflowApi(private val client: ApiClient = ApiClient()) {
    fun operate(server: String, token: String, sessionId: String, body: JSONObject): JSONObject =
        client.postJson(serverUrl = server, authorizationToken = token, path = "/runtime-workflows/sessions/${sessionId.urlEncode()}/operations", body = body)
    fun recover(server: String, token: String, sessionId: String, body: JSONObject): JSONObject =
        client.postJson(serverUrl = server, authorizationToken = token, path = "/runtime-workflows/sessions/${sessionId.urlEncode()}/recover", body = body)
    fun configuration(server: String, token: String, sessionId: String): JSONObject =
        client.getJson(serverUrl = server, authorizationToken = token, path = "/runtime-workflows/sessions/${sessionId.urlEncode()}/configuration")
    fun updateConfiguration(server: String, token: String, sessionId: String, body: JSONObject): JSONObject =
        client.postJson(serverUrl = server, authorizationToken = token, path = "/runtime-workflows/sessions/${sessionId.urlEncode()}/configuration", body = body)
    fun components(server: String, token: String, connectorId: String, runtimeId: String, body: JSONObject): JSONObject =
        client.postJson(serverUrl = server, authorizationToken = token, path = "/connectors/${connectorId.urlEncode()}/runtimes/${runtimeId.urlEncode()}/components", body = body)
    fun post(server: String, token: String, path: String, body: JSONObject): JSONObject =
        client.postJson(serverUrl = server, authorizationToken = token, path = "/runtime-workflows/$path", body = body)
    fun get(server: String, token: String, kind: String, id: String): JSONObject =
        client.getJson(serverUrl = server, authorizationToken = token, path = "/runtime-workflows/$kind/${id.urlEncode()}")
}
