package com.agentsanywhere.app.api

import org.json.JSONArray
import org.json.JSONObject

class SessionsApi(
    private val client: ApiClient = ApiClient(),
) {
    fun listSessions(
        serverUrl: String,
        authorizationToken: String,
    ): List<RemoteSession> {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/sessions",
            authorizationToken = authorizationToken,
        ).optJSONArray("sessions").toObjectList { toRemoteSession() }
    }

    fun bindSession(
        serverUrl: String,
        authorizationToken: String,
        connectorId: String,
        runtime: String,
        externalSessionId: String,
        title: String?,
        cwd: String?,
        selections: Map<String, String> = emptyMap(),
    ): RemoteSessionCreateResponse {
        val body = JSONObject().apply {
            put("connectorId", connectorId)
            put("runtime", runtime)
            put("externalSessionId", externalSessionId)
            title?.takeIf { it.isNotBlank() }?.let { put("title", it) }
            cwd?.takeIf { it.isNotBlank() }?.let { put("cwd", it) }
            selections.filterValues(String::isNotBlank).takeIf { it.isNotEmpty() }?.let {
                put("selections", JSONObject(it))
            }
        }
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions",
            body = body,
            authorizationToken = authorizationToken,
        ).toRemoteSessionCreateResponse()
    }

    fun createAndStartSession(
        serverUrl: String,
        authorizationToken: String,
        request: RemoteSessionCreateAndStartRequest,
    ): RemoteSessionCreateResponse {
        val body = JSONObject().apply {
            put("connectorId", request.connectorId)
            put("runtime", request.runtime)
            put("content", request.content)
            request.title?.takeIf(String::isNotBlank)?.let { put("title", it) }
            request.cwd?.takeIf(String::isNotBlank)?.let { put("cwd", it) }
            request.selections.filterValues(String::isNotBlank).takeIf { it.isNotEmpty() }?.let {
                put("selections", JSONObject(it))
            }
            request.attachments.takeIf { it.isNotEmpty() }?.let { attachments ->
                put(
                    "attachments",
                    JSONArray(
                        attachments.map { attachment ->
                            JSONObject()
                                .put("fileId", attachment.fileId)
                                .put("name", attachment.name)
                                .put("mediaType", attachment.mediaType)
                                .put("size", attachment.size)
                                .put("sha256", attachment.sha256)
                                .put("contentBase64", attachment.contentBase64)
                        },
                    ),
                )
            }
            request.clientMessageId?.takeIf(String::isNotBlank)?.let { put("clientMessageId", it) }
        }
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions/create-and-start",
            body = body,
            authorizationToken = authorizationToken,
            readTimeoutSeconds = CREATE_AND_START_READ_TIMEOUT_SECONDS,
        ).toRemoteSessionCreateResponse()
    }

    fun patchSession(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        title: String? = null,
        pinned: Boolean? = null,
        archived: Boolean? = null,
    ): RemoteSessionResponse {
        val body = JSONObject().apply {
            title?.let { put("title", it) }
            pinned?.let { put("pinned", it) }
            archived?.let { put("archived", it) }
        }
        return client.patchJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/meta",
            body = body,
            authorizationToken = authorizationToken,
        ).toRemoteSessionResponse()
    }

    fun getSessionMeta(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteSessionResponse {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/meta",
            authorizationToken = authorizationToken,
        ).toRemoteSessionResponse()
    }

    fun archiveSessions(
        serverUrl: String,
        authorizationToken: String,
        ids: List<String>,
    ): RemoteSessionsMutationResponse {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions/archive",
            body = JSONArray(ids),
            authorizationToken = authorizationToken,
        ).toRemoteSessionsMutationResponse()
    }

    fun unarchiveSessions(
        serverUrl: String,
        authorizationToken: String,
        ids: List<String>,
    ): RemoteSessionsMutationResponse {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions/unarchive",
            body = JSONArray(ids),
            authorizationToken = authorizationToken,
        ).toRemoteSessionsMutationResponse()
    }

    fun markSessionsRead(
        serverUrl: String,
        authorizationToken: String,
        ids: List<String>,
    ): RemoteSessionsMutationResponse {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions/read",
            body = JSONArray(ids),
            authorizationToken = authorizationToken,
        ).toRemoteSessionsMutationResponse()
    }

    fun markSessionRead(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteSessionResponse {
        val response = markSessionsRead(serverUrl, authorizationToken, listOf(sessionId))
        val session = response.sessions.firstOrNull { it.id == sessionId }
            ?: throw IllegalStateException("Session read response did not include this session.")
        return RemoteSessionResponse(session = session, serverTime = response.serverTime)
    }

    fun archiveAllDeviceSessions(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        archived: Boolean,
        scope: String,
    ): List<RemoteSession> {
        val body = JSONObject().apply {
            put("archived", archived)
            put("scope", scope)
        }
        return client.postJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/sessions/archive-all",
            body = body,
            authorizationToken = authorizationToken,
        ).optJSONArray("sessions").toObjectList { toRemoteSession() }
    }

    fun getRuntimeConfigSchema(
        serverUrl: String,
        authorizationToken: String,
        runtime: String,
    ): RemoteRuntimeConfigSchema {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/agents/${runtime.urlEncode()}/config-schema",
            authorizationToken = authorizationToken,
        ).getJSONObject("schema").toRemoteRuntimeConfigSchema()
    }

    fun getSessionTimelineLatest(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        limit: Int = 100,
    ): RemoteSessionTimelinePage {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/timeline?mode=latest&limit=$limit",
            authorizationToken = authorizationToken,
        ).toRemoteSessionTimelinePage()
    }

    fun getSessionTimelineHistory(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        beforeOrderSeq: Int,
        limit: Int = 100,
    ): RemoteSessionTimelinePage {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/timeline" +
                "?mode=history&beforeOrderSeq=$beforeOrderSeq&limit=$limit",
            authorizationToken = authorizationToken,
        ).toRemoteSessionTimelinePage()
    }

    fun getSessionTimelineChanges(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        afterSeq: Int = 0,
        limit: Int = 100,
    ): RemoteSessionTimelinePage {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/timeline" +
                "?mode=changes&afterSeq=$afterSeq&limit=$limit",
            authorizationToken = authorizationToken,
        ).toRemoteSessionTimelinePage()
    }

    fun getSessionSnapshot(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        limit: Int = 100,
    ): RemoteSessionSnapshot {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/snapshot?limit=$limit",
            authorizationToken = authorizationToken,
        ).toRemoteSessionSnapshot()
    }

    fun getSessionRuntimeState(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteSessionRuntimeStateResponse {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/runtime/state",
            authorizationToken = authorizationToken,
        ).toRemoteSessionRuntimeStateResponse()
    }

    fun getSessionRuntimeCapabilities(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteRuntimeCapabilities {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/runtime/capabilities",
            authorizationToken = authorizationToken,
        ).toRemoteRuntimeCapabilities()
    }

    fun getSessionRuntimeNotices(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteRuntimeNoticeListResponse {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/runtime/notices",
            authorizationToken = authorizationToken,
        ).toRemoteRuntimeNoticeListResponse()
    }

    fun streamSessionEvents(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        onOpen: () -> Unit = {},
        onEvent: (RemoteSessionEvent) -> Unit,
    ) {
        client.streamSse(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/events?token=${authorizationToken.urlEncode()}",
            authorizationToken = authorizationToken,
            onOpen = onOpen,
        ) { event ->
            onEvent(event.toRemoteSessionEvent())
        }
    }

    fun sendSessionMessage(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        content: String,
        clientMessageId: String,
        attachments: List<RemoteUploadedAttachment> = emptyList(),
    ): RemoteRpcResponse {
        val body = JSONObject()
            .put("content", content)
            .put("clientMessageId", clientMessageId)
        if (attachments.isNotEmpty()) {
            body.put(
                "attachments",
                JSONArray(attachments.map { JSONObject().put("fileId", it.fileId) }),
            )
        }
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/messages",
            body = body,
            authorizationToken = authorizationToken,
        ).toRemoteRpcResponse()
    }

    fun uploadSessionAttachments(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        files: List<UploadFilePart>,
    ): List<RemoteUploadedAttachment> {
        return client.postMultipart(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/attachments",
            files = files,
            authorizationToken = authorizationToken,
        ).optJSONArray("attachments").toObjectList { toRemoteUploadedAttachment() }
    }

    fun attachmentOpenUrl(
        serverUrl: String,
        sessionId: String,
        fileId: String,
    ): String {
        return apiUrl(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/attachments/${fileId.urlEncode()}/open",
        )
    }

    fun interruptSession(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteRpcResponse {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/interrupt",
            body = JSONObject(),
            authorizationToken = authorizationToken,
        ).toRemoteRpcResponse()
    }

    fun enableTakeover(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteSession {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/takeover",
            body = JSONObject(),
            authorizationToken = authorizationToken,
        ).getJSONObject("session").toRemoteSession()
    }

    fun disableTakeover(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteSession {
        return client.deleteJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/takeover",
            authorizationToken = authorizationToken,
        ).getJSONObject("session").toRemoteSession()
    }

    fun resolveApproval(
        serverUrl: String,
        authorizationToken: String,
        approvalId: String,
        status: String,
    ): RemoteRpcResponse {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/approvals/${approvalId.urlEncode()}/resolve",
            body = JSONObject().put("status", status),
            authorizationToken = authorizationToken,
        ).toRemoteRpcResponse()
    }

    private fun JSONObject.toRemoteSession(): RemoteSession {
        return RemoteSession(
            id = getString("id"),
            connectorId = getString("connectorId"),
            connectorStatus = optString("connectorStatus", "offline"),
            runtime = optString("runtime", "codex"),
            externalSessionId = optNullableString("externalSessionId"),
            title = optNullableString("title"),
            cwd = optNullableString("cwd"),
            status = optString("status", "idle"),
            takeover = optBoolean("takeover", false),
            pinned = optBoolean("pinned", false),
            pinnedAt = optNullableString("pinnedAt"),
            archived = optBoolean("archived", false),
            archivedAt = optNullableString("archivedAt"),
            unread = optBoolean("unread", false),
            lastReadSeq = optInt("lastReadSeq", 0),
            lastSyncedAt = optNullableString("lastSyncedAt"),
            sourceObservedAt = optNullableString("sourceObservedAt"),
            lastActivityAt = optNullableString("lastActivityAt"),
            lastItemAt = optNullableString("lastItemAt"),
            lastItemOrderSeq = optNullableInt("lastItemOrderSeq"),
            sortAt = optNullableString("sortAt"),
            updatedSeq = optInt("updatedSeq", 0),
        )
    }

    private fun JSONObject.toRemoteSessionResponse(): RemoteSessionResponse {
        return RemoteSessionResponse(
            session = getJSONObject("session").toRemoteSession(),
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject.toRemoteSessionCreateResponse(): RemoteSessionCreateResponse {
        return RemoteSessionCreateResponse(
            session = getJSONObject("session").toRemoteSession(),
            connectorResult = opt("connectorResult").takeUnless { it == JSONObject.NULL },
            attachments = optJSONArray("attachments").toObjectList { toRemoteUploadedAttachment() },
        )
    }

    private fun JSONObject.toRemoteSessionsMutationResponse(): RemoteSessionsMutationResponse {
        return RemoteSessionsMutationResponse(
            sessions = optJSONArray("sessions").toObjectList { toRemoteSession() },
            notFound = optJSONArray("notFound").toStringList(),
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject.toRemoteSessionTimelinePage(): RemoteSessionTimelinePage {
        return RemoteSessionTimelinePage(
            sessionId = optString("sessionId", ""),
            items = optJSONArray("items").toObjectList { toRemoteTimelineItem() },
            nextSeq = optInt("nextSeq", 0),
            hasMore = optBoolean("hasMore", false),
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject.toRemoteSessionSnapshot(): RemoteSessionSnapshot {
        val timeline = optJSONObject("timeline") ?: JSONObject()
        val catalogs = optJSONObject("catalogs") ?: JSONObject()
        val knownCatalogKeys = setOf("model", "permission")
        return RemoteSessionSnapshot(
            session = getJSONObject("session").toRemoteSession(),
            state = optJSONObject("state")?.toRemoteSessionRuntimeState(),
            timeline = RemoteSessionTimelineSnapshot(
                items = timeline.optJSONArray("items").toObjectList { toRemoteTimelineItem() },
                nextSeq = timeline.optInt("nextSeq", 0),
                hasMore = timeline.optBoolean("hasMore", false),
            ),
            approvals = optJSONArray("approvals").toObjectList { toRemoteApproval() },
            notices = optJSONArray("notices").toObjectList { toRemoteRuntimeNotice() },
            effectiveCapabilities = optJSONObject("effectiveCapabilities").toRemoteRuntimeCapabilitySet(),
            runtimeCapabilities = optJSONObject("runtimeCapabilities").toRemoteRuntimeCapabilitySet(),
            catalogs = RemoteSessionRuntimeCatalogs(
                model = catalogs.optJSONObject("model")?.toRemoteRuntimeModelCatalog(),
                permission = catalogs.optJSONObject("permission")?.toRemoteRuntimePermissionCatalog(),
                unknown = catalogs.toMap().filterKeys { it !in knownCatalogKeys },
            ),
            eventCursor = optString("eventCursor", "seq:0"),
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject.toRemoteSessionRuntimeStateResponse(): RemoteSessionRuntimeStateResponse {
        return RemoteSessionRuntimeStateResponse(
            state = getJSONObject("state").toRemoteSessionRuntimeState(),
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject.toRemoteSessionRuntimeState(): RemoteSessionRuntimeState {
        return RemoteSessionRuntimeState(
            sessionId = optString("sessionId", ""),
            runtime = optString("runtime", ""),
            externalSessionId = optNullableString("externalSessionId"),
            status = optString("status", "unknown").ifBlank { "unknown" },
            selections = optJSONObject("selections").toMap().mapValues { (_, value) -> value as? String },
            statusReason = optNullableString("statusReason"),
            error = optJSONObject("error")?.toMap(),
            metadata = optJSONObject("metadata").toMap(),
            updatedSeq = optInt("updatedSeq", 0),
            createdAt = optNullableString("createdAt"),
            updatedAt = optNullableString("updatedAt"),
        )
    }

    private fun JSONObject.toRemoteRuntimeCapabilities(): RemoteRuntimeCapabilities {
        return RemoteRuntimeCapabilities(
            connectorId = optString("connectorId", ""),
            capabilitySet = optJSONObject("capabilitySet").toRemoteRuntimeCapabilitySet(),
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject?.toRemoteRuntimeCapabilitySet(): RemoteRuntimeCapabilitySet {
        return RemoteRuntimeCapabilitySet(
            revision = this?.optLong("revision", 0L) ?: 0L,
            capabilities = this?.optJSONArray("capabilities")
                .toObjectList { toRemoteRuntimeCapability() },
        )
    }

    private fun JSONObject.toRemoteRuntimeCapability(): RemoteRuntimeCapability {
        return RemoteRuntimeCapability(
            capabilityId = optString("capabilityId", ""),
            version = optString("version", "1").ifBlank { "1" },
            scope = optString("scope", "runtime").ifBlank { "runtime" },
            runtime = optNullableString("runtime"),
            sessionId = optNullableString("sessionId"),
            supported = optBoolean("supported", true),
            available = optBoolean("available", true),
            allowed = optBoolean("allowed", true),
            unavailableReason = optNullableString("unavailableReason"),
            parameters = optJSONObject("parameters").toMap(),
        )
    }

    private fun JSONObject.toRemoteRuntimeModelCatalog(): RemoteRuntimeModelCatalog {
        return RemoteRuntimeModelCatalog(
            runtime = optString("runtime", ""),
            revision = optLong("revision", 0L),
            models = optJSONArray("models").toObjectList { toRemoteRuntimeModel() },
        )
    }

    private fun JSONObject.toRemoteRuntimeModel(): RemoteRuntimeModel {
        return RemoteRuntimeModel(
            id = optString("id", ""),
            selectionId = optNullableString("selectionId"),
            displayName = optString("displayName", ""),
            description = optNullableString("description"),
            default = optBoolean("default", false),
            reasoningItems = optJSONArray("reasoningItems").toObjectList { toRemoteRuntimeReasoning() },
            metadata = optJSONObject("metadata").toMap(),
        )
    }

    private fun JSONObject.toRemoteRuntimeReasoning(): RemoteRuntimeReasoning {
        return RemoteRuntimeReasoning(
            id = optString("id", ""),
            selectionId = optString("selectionId", ""),
            fullModelId = optNullableString("fullModelId"),
            displayName = optString("displayName", ""),
            description = optNullableString("description"),
            default = optBoolean("default", false),
            metadata = optJSONObject("metadata").toMap(),
        )
    }

    private fun JSONObject.toRemoteRuntimePermissionCatalog(): RemoteRuntimePermissionCatalog {
        return RemoteRuntimePermissionCatalog(
            runtime = optString("runtime", ""),
            revision = optLong("revision", 0L),
            permissions = optJSONArray("permissions").toObjectList { toRemoteRuntimePermission() },
        )
    }

    private fun JSONObject.toRemoteRuntimePermission(): RemoteRuntimePermission {
        return RemoteRuntimePermission(
            id = optString("id", ""),
            selectionId = optString("selectionId", ""),
            displayName = optString("displayName", ""),
            description = optNullableString("description"),
            default = optBoolean("default", false),
            metadata = optJSONObject("metadata").toMap(),
        )
    }

    private fun JSONObject.toRemoteRuntimeNoticeListResponse(): RemoteRuntimeNoticeListResponse {
        return RemoteRuntimeNoticeListResponse(
            notices = optJSONArray("notices").toObjectList { toRemoteRuntimeNotice() },
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject.toRemoteRuntimeNotice(): RemoteRuntimeNotice {
        return RemoteRuntimeNotice(
            noticeId = optString("noticeId", ""),
            type = optString("type", "unknown"),
            sessionId = optString("sessionId", ""),
            source = optJSONObject("source").toMap(),
            title = optString("title", ""),
            message = optNullableString("message"),
            severity = optString("severity", "info"),
            status = optString("status", "open"),
            interactionType = optNullableString("interactionType"),
            blocking = optJSONObject("blocking")?.toMap(),
            responseRequired = optBoolean("responseRequired", false),
            actions = optJSONArray("actions").toObjectList { toMap() },
            context = optJSONObject("context").toMap(),
            metadata = optJSONObject("metadata").toMap(),
            expiresAt = optNullableString("expiresAt"),
            revision = optInt("revision", 1),
            updatedSeq = optInt("updatedSeq", 0),
            createdAt = optNullableString("createdAt"),
            resolvedAt = optNullableString("resolvedAt"),
        )
    }

    private fun JSONObject.toRemoteRuntimeConfigSchema(): RemoteRuntimeConfigSchema {
        return RemoteRuntimeConfigSchema(
            runtime = optString("runtime", ""),
            schemaVersion = optInt("schemaVersion", 0),
            fields = optJSONArray("fields").toObjectList { toRemoteRuntimeConfigField() },
        )
    }

    private fun JSONObject.toRemoteRuntimeConfigField(): RemoteRuntimeConfigField {
        return RemoteRuntimeConfigField(
            key = optString("key", ""),
            label = optString("label", ""),
            type = optString("type", "string"),
            description = optNullableString("description"),
            options = optJSONArray("options").toObjectList { toRemoteRuntimeConfigOption() },
            visibleWhen = optJSONObject("visibleWhen").toMap(),
            allowSessionOverride = optBoolean("allowSessionOverride", false),
            hidden = optBoolean("hidden", false),
        )
    }

    private fun JSONObject.toRemoteRuntimeConfigOption(): RemoteRuntimeConfigOption {
        return RemoteRuntimeConfigOption(
            value = opt("value")?.toString().orEmpty(),
            label = optString("label", ""),
            description = optNullableString("description"),
            efforts = if (has("efforts") && !isNull("efforts")) {
                optJSONArray("efforts").toObjectList { toRemoteRuntimeConfigOption() }
            } else {
                null
            },
        )
    }

    private fun JSONObject.toRemoteTimelineItem(): RemoteTimelineItem {
        val content = optJSONObject("content") ?: JSONObject()
        return RemoteTimelineItem(
            id = getString("id"),
            sessionId = optString("sessionId", ""),
            turnId = optNullableString("turnId"),
            type = optString("type", "message"),
            status = optString("status", "done"),
            role = optNullableString("role"),
            text = content.optNullableString("text")
                ?: content.optNullableString("message")
                ?: content.optNullableString("description")
                ?: "",
            content = content,
            source = optJSONObject("source") ?: JSONObject(),
            orderSeq = optInt("orderSeq", 0),
            revision = optInt("revision", 1),
            updatedSeq = optInt("updatedSeq", 0),
            createdAt = optString("createdAt", ""),
            updatedAt = optNullableString("updatedAt"),
        )
    }

    private fun JSONObject.toRemoteApproval(): RemoteApproval {
        return RemoteApproval(
            id = getString("id"),
            sessionId = optString("sessionId", ""),
            turnId = optNullableString("turnId"),
            status = optString("status", "pending"),
            kind = optString("kind", "unknown"),
            targetItemId = optNullableString("targetItemId"),
            title = optString("title", "Permission request"),
            description = optNullableString("description"),
            choices = optJSONArray("choices").toStringList(),
            updatedSeq = optInt("updatedSeq", 0),
            createdAt = optString("createdAt", ""),
        )
    }

    private fun JSONObject.toRemoteSessionEvent(): RemoteSessionEvent {
        return RemoteSessionEvent(
            sessionId = optString("sessionId", ""),
            items = optJSONArray("items").toObjectList { toRemoteTimelineItem() },
            approvals = if (has("approvals")) {
                optJSONArray("approvals").toObjectList { toRemoteApproval() }
            } else {
                null
            },
            session = optJSONObject("session")?.toRemoteSession(),
            nextSeq = optInt("nextSeq", 0),
            refetch = optBoolean("refetch", false),
        )
    }

    private fun JSONObject.toRemoteRpcResponse(): RemoteRpcResponse {
        val result = optJSONObject("result")
        return RemoteRpcResponse(
            ok = optBoolean("ok", false),
            turnId = result?.optNullableString("turnId"),
        )
    }

    private fun JSONObject.toRemoteUploadedAttachment(): RemoteUploadedAttachment {
        return RemoteUploadedAttachment(
            fileId = getString("fileId"),
            name = optString("name", "attachment"),
            mediaType = optString("mediaType", ""),
            size = optLong("size", 0L),
            sha256 = optNullableString("sha256"),
        )
    }

    private companion object {
        const val CREATE_AND_START_READ_TIMEOUT_SECONDS = 75L
    }

}
