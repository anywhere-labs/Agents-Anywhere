package com.agentsanywhere.app.api

import org.json.JSONObject

/*
 * Writes protocol documents back in their wire shape, so a stored copy is read
 * by the same parsers as a Server response. Used by the on-device session cache.
 */

internal fun RemoteSession.toProtocolJson(): JSONObject = JSONObject()
    .put("id", id)
    .put("connectorId", connectorId)
    .putNullable("projectId", projectId)
    .put("connectorStatus", connectorStatus)
    .put("runtime", runtime)
    .put("runtimeType", runtimeType)
    .put("runtimeId", runtimeId)
    .put("runtimeName", runtimeName)
    .putNullable("externalSessionId", externalSessionId)
    .putNullable("title", title)
    .putNullable("cwd", cwd)
    .put("status", status)
    .put("takeover", takeover)
    .put("pinned", pinned)
    .putNullable("pinnedAt", pinnedAt)
    .put("archived", archived)
    .putNullable("archivedAt", archivedAt)
    .put("unread", unread)
    .put("lastReadSeq", lastReadSeq)
    .putNullable("lastSyncedAt", lastSyncedAt)
    .putNullable("sourceObservedAt", sourceObservedAt)
    .putNullable("lastActivityAt", lastActivityAt)
    .putNullable("lastItemAt", lastItemAt)
    .putNullable("lastItemOrderSeq", lastItemOrderSeq)
    .putNullable("sortAt", sortAt)
    .put("updatedSeq", updatedSeq)
    .put("planState", planState)
    .put("goalState", goalState)
    .putNullable("displayDevice", displayDevice?.toProtocolJson())
    .putNullable("displayUser", displayUser?.toProtocolJson())

private fun RemoteDisplayEnvelope.toProtocolJson(): JSONObject = JSONObject()
    .put("mode", mode)
    .putNullable("keyId", keyId)
    .put("payload", if (isPlain) runCatching { JSONObject(payload) }.getOrDefault(payload) else payload)

internal fun RemoteTimelineItem.toProtocolJson(): JSONObject = JSONObject()
    .put("id", id)
    .put("sessionId", sessionId)
    .put("type", type)
    .put("status", status)
    .putNullable("role", role)
    // The parser derives `text` from the content, as it does for the Server.
    .put("content", content)
    .put("source", source)
    .put("orderSeq", if (orderSeq == MISSING_ORDER_SEQ) JSONObject.NULL else orderSeq)
    .put("revision", revision)
    .put("updatedSeq", updatedSeq)
    .put("createdAt", createdAt)
    .putNullable("updatedAt", updatedAt)
    .put("contentHash", contentHash)
    .apply { if (blobRefs.isNotEmpty()) put("blobRefs", blobRefs.toBlobRefsJson()) }

private fun JSONObject.putNullable(name: String, value: Any?): JSONObject = put(name, value ?: JSONObject.NULL)
