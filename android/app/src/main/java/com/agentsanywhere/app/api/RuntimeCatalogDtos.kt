package com.agentsanywhere.app.api

import org.json.JSONObject

data class RemoteRuntimeCapabilities(
    val connectorId: String,
    val capabilitySet: RemoteRuntimeCapabilitySet,
    val serverTime: String?,
)

data class RemoteRuntimeCapabilitySet(
    val revision: Long,
    val capabilities: List<RemoteRuntimeCapability>,
)

data class RemoteRuntimeCapability(
    val capabilityId: String,
    val version: String,
    val scope: String,
    val runtime: String?,
    val sessionId: String?,
    val supported: Boolean,
    val available: Boolean,
    val allowed: Boolean,
    val unavailableReason: String?,
    val parameters: Map<String, Any?>,
    val runtimeId: String? = null,
    val runtimeType: String? = runtime,
) {
    val usable: Boolean
        get() = supported && available && allowed
}

data class RemoteRuntimeModelCatalogResponse(
    val catalog: RemoteRuntimeModelCatalog,
    val serverTime: String?,
)

data class RemoteRuntimeModelCatalog(
    val runtime: String,
    val revision: Long,
    val models: List<RemoteRuntimeModel>,
    val runtimeId: String = runtime,
    val runtimeType: String = runtime,
)

data class RemoteRuntimeModel(
    val id: String,
    val selectionId: String?,
    val displayName: String,
    val description: String?,
    val default: Boolean,
    val reasoningItems: List<RemoteRuntimeReasoning>,
    val metadata: Map<String, Any?>,
    val enabled: Boolean = true,
    val disabledReason: String? = null,
)

data class RemoteRuntimeReasoning(
    val id: String,
    val selectionId: String,
    val fullModelId: String?,
    val displayName: String,
    val description: String?,
    val default: Boolean,
    val metadata: Map<String, Any?>,
    val enabled: Boolean = true,
    val disabledReason: String? = null,
)

data class RemoteRuntimePermissionCatalogResponse(
    val catalog: RemoteRuntimePermissionCatalog,
    val serverTime: String?,
)

data class RemoteRuntimePermissionCatalog(
    val runtime: String,
    val revision: Long,
    val permissions: List<RemoteRuntimePermission>,
    val runtimeId: String = runtime,
    val runtimeType: String = runtime,
)

data class RemoteRuntimePermission(
    val id: String,
    val selectionId: String,
    val displayName: String,
    val description: String?,
    val default: Boolean,
    val metadata: Map<String, Any?>,
    val enabled: Boolean = true,
    val disabledReason: String? = null,
)

internal fun JSONObject.parseRemoteRuntimeModelCatalog(
    fallbackRuntimeId: String? = null,
): RemoteRuntimeModelCatalog {
    val runtime = optNullableString("runtime")
        ?: optNullableString("runtimeType")
        ?: ""
    val runtimeType = optNullableString("runtimeType") ?: runtime
    val runtimeId = optNullableString("runtimeId")
        ?: fallbackRuntimeId?.takeIf(String::isNotBlank)
        ?: runtime
    return RemoteRuntimeModelCatalog(
        runtime = runtimeType,
        revision = optLong("revision", 0L),
        models = optJSONArray("models").toObjectList { parseRemoteRuntimeModel() },
        runtimeId = runtimeId,
        runtimeType = runtimeType,
    )
}

internal fun JSONObject.parseRemoteRuntimePermissionCatalog(
    fallbackRuntimeId: String? = null,
): RemoteRuntimePermissionCatalog {
    val runtime = optNullableString("runtime")
        ?: optNullableString("runtimeType")
        ?: ""
    val runtimeType = optNullableString("runtimeType") ?: runtime
    val runtimeId = optNullableString("runtimeId")
        ?: fallbackRuntimeId?.takeIf(String::isNotBlank)
        ?: runtime
    return RemoteRuntimePermissionCatalog(
        runtime = runtimeType,
        revision = optLong("revision", 0L),
        permissions = optJSONArray("permissions").toObjectList { parseRemoteRuntimePermission() },
        runtimeId = runtimeId,
        runtimeType = runtimeType,
    )
}

private fun JSONObject.parseRemoteRuntimeModel(): RemoteRuntimeModel {
    val metadata = optJSONObject("metadata").toMap()
    return RemoteRuntimeModel(
        id = optString("id", ""),
        selectionId = optNullableString("selectionId"),
        displayName = optString("displayName", ""),
        description = optNullableString("description"),
        default = optBoolean("default", false),
        reasoningItems = optJSONArray("reasoningItems").toObjectList { parseRemoteRuntimeReasoning() },
        metadata = metadata,
        enabled = catalogItemEnabled(metadata),
        disabledReason = catalogItemDisabledReason(metadata),
    )
}

private fun JSONObject.parseRemoteRuntimeReasoning(): RemoteRuntimeReasoning {
    val metadata = optJSONObject("metadata").toMap()
    return RemoteRuntimeReasoning(
        id = optString("id", ""),
        selectionId = optString("selectionId", ""),
        fullModelId = optNullableString("fullModelId"),
        displayName = optString("displayName", ""),
        description = optNullableString("description"),
        default = optBoolean("default", false),
        metadata = metadata,
        enabled = catalogItemEnabled(metadata),
        disabledReason = catalogItemDisabledReason(metadata),
    )
}

private fun JSONObject.parseRemoteRuntimePermission(): RemoteRuntimePermission {
    val metadata = optJSONObject("metadata").toMap()
    return RemoteRuntimePermission(
        id = optString("id", ""),
        selectionId = optString("selectionId", ""),
        displayName = optString("displayName", ""),
        description = optNullableString("description"),
        default = optBoolean("default", false),
        metadata = metadata,
        enabled = catalogItemEnabled(metadata),
        disabledReason = catalogItemDisabledReason(metadata),
    )
}

private fun JSONObject.catalogItemEnabled(metadata: Map<String, Any?>): Boolean {
    return optNullableBoolean("enabled") ?: (metadata["enabled"] as? Boolean) ?: true
}

private fun JSONObject.catalogItemDisabledReason(metadata: Map<String, Any?>): String? {
    return optNullableString("disabledReason")?.takeIf(String::isNotBlank)
        ?: (metadata["disabledReason"] as? String)?.takeIf(String::isNotBlank)
}
