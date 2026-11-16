package com.agentsanywhere.app.api

/** Port preview control API (preview 1.0, `/api/v3/previews`, used as written without the v2 prefix). */
class PreviewsApi(
    private val client: ApiClient = ApiClient(),
) {
    fun list(serverUrl: String, authorizationToken: String): List<RemotePreviewView> {
        val response = client.getJson(
            serverUrl = serverUrl,
            path = PREVIEWS_PATH,
            authorizationToken = authorizationToken,
        )
        return response.optJSONArray("previews").toObjectList { toRemotePreviewView() }
    }

    fun create(serverUrl: String, authorizationToken: String, request: CreatePreviewRequest): RemotePreviewView =
        client.postJson(
            serverUrl = serverUrl,
            path = PREVIEWS_PATH,
            body = request.toJson(),
            authorizationToken = authorizationToken,
        ).toRemotePreviewView()

    /** Stops the preview. The Server answers with the closed view, or with nothing. */
    fun close(serverUrl: String, authorizationToken: String, previewId: String): RemotePreviewView? {
        val response = client.deleteJson(
            serverUrl = serverUrl,
            path = "$PREVIEWS_PATH/${previewId.urlEncode()}",
            authorizationToken = authorizationToken,
        )
        return if (response.has("previewId")) response.toRemotePreviewView() else null
    }

    /** A one-time ticket that the preview domain exchanges for its own cookie; ask again for every open. */
    fun ticket(serverUrl: String, authorizationToken: String, previewId: String): RemotePreviewTicket =
        client.postJson(
            serverUrl = serverUrl,
            path = "$PREVIEWS_PATH/${previewId.urlEncode()}/ticket",
            authorizationToken = authorizationToken,
        ).toRemotePreviewTicket()
}
