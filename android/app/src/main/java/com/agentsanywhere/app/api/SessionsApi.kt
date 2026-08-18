package com.agentsanywhere.app.api

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.Base64

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

    fun getSessionRuntimeModelCatalog(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteRuntimeModelCatalogResponse {
        val response = client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/runtime/catalogs/model",
            authorizationToken = authorizationToken,
        )
        return RemoteRuntimeModelCatalogResponse(
            catalog = response.getJSONObject("catalog").toRemoteRuntimeModelCatalog(),
            serverTime = response.optNullableString("serverTime"),
        )
    }

    fun getSessionRuntimePermissionCatalog(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteRuntimePermissionCatalogResponse {
        val response = client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/runtime/catalogs/permission",
            authorizationToken = authorizationToken,
        )
        return RemoteRuntimePermissionCatalogResponse(
            catalog = response.getJSONObject("catalog").toRemoteRuntimePermissionCatalog(),
            serverTime = response.optNullableString("serverTime"),
        )
    }

    fun patchSessionRuntimeSelections(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        selections: Map<String, String?>,
    ): RemoteSessionSelectionPatchResponse {
        val selectionBody = JSONObject().apply {
            selections.forEach { (scope, selectionId) ->
                put(scope, selectionId ?: JSONObject.NULL)
            }
        }
        return client.patchJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/runtime/selections",
            body = JSONObject().put("selections", selectionBody),
            authorizationToken = authorizationToken,
        ).toRemoteSessionSelectionPatchResponse()
    }

    fun getSessionRuntimeCommands(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteSessionCommandListResponse {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/runtime/commands",
            authorizationToken = authorizationToken,
        ).toRemoteSessionCommandListResponse()
    }

    fun executeSessionRuntimeCommand(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        command: String,
        args: List<String> = emptyList(),
        raw: String? = null,
    ): RemoteSessionCommandResponse {
        val body = JSONObject().put("command", command)
        if (args.isNotEmpty()) body.put("args", JSONArray(args))
        raw?.takeIf(String::isNotBlank)?.let { body.put("raw", it) }
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/runtime/commands",
            body = body,
            authorizationToken = authorizationToken,
        ).toRemoteSessionCommandResponse()
    }

    fun sendSessionMessage(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        content: String,
        clientMessageId: String,
        attachments: List<RemoteAttachmentRef> = emptyList(),
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
            path = "/sessions/${sessionId.urlEncode()}/runtime/messages",
            body = body,
            authorizationToken = authorizationToken,
        ).toRemoteRpcResponse()
    }

    fun steerSession(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        content: String,
        clientMessageId: String,
        attachments: List<RemoteAttachmentRef> = emptyList(),
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
            path = "/sessions/${sessionId.urlEncode()}/runtime/steer",
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

    fun downloadSessionAttachment(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        fileId: String,
    ): RemoteDownloadedAttachment {
        val response = client.getJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/attachments/${fileId.urlEncode()}",
            authorizationToken = authorizationToken,
        )
        val contentBase64 = response.optString("contentBase64", "")
        val expectedSize = response.optLong("size", -1L)
        if (expectedSize !in 0..MAX_ATTACHMENT_DOWNLOAD_BYTES ||
            contentBase64.length > MAX_ATTACHMENT_DOWNLOAD_BASE64_CHARS
        ) {
            throw AttachmentTransferException(AttachmentTransferFailure.SizeMismatch)
        }
        val bytes = try {
            Base64.getDecoder().decode(contentBase64)
        } catch (error: IllegalArgumentException) {
            throw AttachmentTransferException(AttachmentTransferFailure.InvalidBase64, cause = error)
        }
        if (bytes.size.toLong() != expectedSize) {
            throw AttachmentTransferException(AttachmentTransferFailure.SizeMismatch)
        }
        val expectedSha256 = response.optString("sha256", "").lowercase()
        val actualSha256 = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { byte -> "%02x".format(byte) }
        if (expectedSha256.length != 64 || actualSha256 != expectedSha256) {
            throw AttachmentTransferException(AttachmentTransferFailure.Sha256Mismatch)
        }
        return RemoteDownloadedAttachment(
            fileId = response.optString("fileId", fileId),
            sessionId = response.optString("sessionId", sessionId),
            path = response.optString("path", ""),
            name = response.optString("name", fileId).ifBlank { fileId },
            size = expectedSize,
            sha256 = expectedSha256,
            bytes = bytes,
            createdAt = response.optNullableString("createdAt"),
            serverTime = response.optNullableString("serverTime"),
        )
    }

    fun interruptSession(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
    ): RemoteRpcResponse {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/runtime/interrupt",
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

    fun respondRuntimeNotice(
        serverUrl: String,
        authorizationToken: String,
        sessionId: String,
        noticeId: String,
        actionId: String,
        input: Map<String, Any?>? = null,
    ): RemoteRpcResponse {
        val body = JSONObject().put("actionId", actionId)
        input?.let { body.put("input", JSONObject(it)) }
        return client.postJson(
            serverUrl = serverUrl,
            path = "/sessions/${sessionId.urlEncode()}/runtime/notices/${noticeId.urlEncode()}/respond",
            body = body,
            authorizationToken = authorizationToken,
        ).toRemoteRpcResponse()
    }

    internal fun parseSession(value: JSONObject): RemoteSession = value.toRemoteSession()

    internal fun parseSessionEvent(value: JSONObject): RemoteSessionEventEnvelope {
        val payload = value.optJSONObject("payload") ?: JSONObject()
        val catalogType = payload.optNullableString("catalogType")
        val catalog = payload.optJSONObject("catalog")
        return RemoteSessionEventEnvelope(
            protocolVersion = value.optString("protocolVersion", ""),
            eventId = value.getString("eventId"),
            sequence = value.getLong("sequence"),
            cursor = value.getString("cursor"),
            type = value.getString("type"),
            sessionId = value.getString("sessionId"),
            emittedAt = value.optNullableString("emittedAt"),
            payload = RemoteSessionEventPayload(
                session = payload.optJSONObject("session")?.toRemoteSession(),
                item = payload.optJSONObject("item")?.toRemoteTimelineItem(),
                items = payload.optJSONArray("items").toObjectList { toRemoteTimelineItem() },
                state = payload.optJSONObject("state")?.toRemoteSessionRuntimeState(),
                notice = payload.optJSONObject("notice")?.toRemoteRuntimeNotice(),
                notices = payload.optJSONArray("notices").toObjectList { toRemoteRuntimeNotice() },
                capabilitySet = payload.optJSONObject("capabilitySet")?.toRemoteRuntimeCapabilitySet(),
                catalogType = catalogType,
                modelCatalog = catalog?.takeIf { catalogType == "model" }?.toRemoteRuntimeModelCatalog(),
                permissionCatalog = catalog?.takeIf { catalogType == "permission" }
                    ?.toRemoteRuntimePermissionCatalog(),
                eventCursor = payload.optNullableString("eventCursor"),
            ),
        )
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
        val catalogs = optJSONObject("catalogs")
        return RemoteSessionSnapshot(
            session = getJSONObject("session").toRemoteSession(),
            state = optJSONObject("state")?.toRemoteSessionRuntimeState(),
            timeline = RemoteSessionTimelineSnapshot(
                items = timeline.optJSONArray("items").toObjectList { toRemoteTimelineItem() },
                nextSeq = timeline.optInt("nextSeq", 0),
                hasMore = timeline.optBoolean("hasMore", false),
            ),
            notices = optJSONArray("notices").toObjectList { toRemoteRuntimeNotice() },
            effectiveCapabilities = optJSONObject("effectiveCapabilities").toRemoteRuntimeCapabilitySet(),
            runtimeCapabilities = optJSONObject("runtimeCapabilities").toRemoteRuntimeCapabilitySet(),
            catalogs = RemoteSessionRuntimeCatalogs(
                model = catalogs?.optJSONObject("model")?.toRemoteRuntimeModelCatalog(),
                permission = catalogs?.optJSONObject("permission")?.toRemoteRuntimePermissionCatalog(),
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
            blocking = optJSONObject("blocking")?.let {
                RemoteRuntimeNoticeBlocking(
                    scope = it.optString("scope", ""),
                    targetId = it.optString("targetId", ""),
                )
            },
            responseRequired = optBoolean("responseRequired", false),
            actions = optJSONArray("actions").toObjectList { toRemoteRuntimeNoticeAction() },
            context = optJSONObject("context").toMap(),
            metadata = optJSONObject("metadata").toMap(),
            expiresAt = optNullableString("expiresAt"),
            revision = optInt("revision", 1),
            updatedSeq = optInt("updatedSeq", 0),
            createdAt = optNullableString("createdAt"),
            updatedAt = optNullableString("updatedAt"),
            resolvedAt = optNullableString("resolvedAt"),
        )
    }

    private fun JSONObject.toRemoteRuntimeNoticeAction(): RemoteRuntimeNoticeAction {
        val input = optJSONObject("input") ?: JSONObject()
        val knownKeys = setOf("actionId", "label", "style", "input")
        return RemoteRuntimeNoticeAction(
            actionId = optString("actionId", ""),
            label = optString("label", ""),
            style = optString("style", "secondary"),
            input = RemoteRuntimeNoticeActionInput(
                required = input.optBoolean("required", false),
                schema = input.optJSONObject("schema")?.toMap(),
                uiSchema = input.optJSONObject("uiSchema")?.toMap(),
            ),
            unknown = toMap().filterKeys { it !in knownKeys },
        )
    }

    private fun JSONObject.toRemoteSessionSelectionPatchResponse(): RemoteSessionSelectionPatchResponse {
        return RemoteSessionSelectionPatchResponse(
            ok = optBoolean("ok", false),
            state = optJSONObject("state")?.toRemoteSessionRuntimeState(),
            connectorResult = optJSONObject("connectorResult")?.toMap(),
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject.toRemoteSessionCommandListResponse(): RemoteSessionCommandListResponse {
        return RemoteSessionCommandListResponse(
            commands = optJSONArray("commands").toObjectList { toRemoteSessionCommand() },
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject.toRemoteSessionCommand(): RemoteSessionCommand {
        return RemoteSessionCommand(
            id = optString("id", ""),
            title = optString("title", ""),
            description = optNullableString("description"),
            aliases = optJSONArray("aliases").toStringList(),
            category = optNullableString("category"),
            scope = optString("scope", "session"),
            enabled = optBoolean("enabled", true),
            disabledReason = optNullableString("disabledReason"),
            acceptsArgs = optBoolean("acceptsArgs", false),
            argsSchema = optJSONObject("argsSchema")?.toMap(),
            metadata = optJSONObject("metadata").toMap(),
        )
    }

    private fun JSONObject.toRemoteSessionCommandResponse(): RemoteSessionCommandResponse {
        return RemoteSessionCommandResponse(
            command = optString("command", ""),
            ok = optBoolean("ok", true),
            code = optNullableString("code"),
            message = optNullableString("message"),
            result = opt("result").takeUnless { it == JSONObject.NULL },
            session = optJSONObject("session")?.toRemoteSession(),
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject.toRemoteTimelineItem(): RemoteTimelineItem {
        val content = optJSONObject("content") ?: JSONObject()
        return RemoteTimelineItem(
            id = getString("id"),
            sessionId = optString("sessionId", ""),
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
            contentHash = optString("contentHash", ""),
        )
    }

    private fun JSONObject.toRemoteRpcResponse(): RemoteRpcResponse {
        val error = optJSONObject("error")
        return RemoteRpcResponse(
            ok = optBoolean("ok", false),
            errorCode = error?.optNullableString("code"),
            errorMessage = error?.optNullableString("message"),
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
        const val MAX_ATTACHMENT_DOWNLOAD_BYTES = 25L * 1024L * 1024L
        const val MAX_ATTACHMENT_DOWNLOAD_BASE64_CHARS = 34_952_536
    }

}
