package com.agentsanywhere.app.api

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
)

data class RemoteRuntimeModel(
    val id: String,
    val selectionId: String?,
    val displayName: String,
    val description: String?,
    val default: Boolean,
    val reasoningItems: List<RemoteRuntimeReasoning>,
    val metadata: Map<String, Any?>,
)

data class RemoteRuntimeReasoning(
    val id: String,
    val selectionId: String,
    val fullModelId: String?,
    val displayName: String,
    val description: String?,
    val default: Boolean,
    val metadata: Map<String, Any?>,
)

data class RemoteRuntimePermissionCatalogResponse(
    val catalog: RemoteRuntimePermissionCatalog,
    val serverTime: String?,
)

data class RemoteRuntimePermissionCatalog(
    val runtime: String,
    val revision: Long,
    val permissions: List<RemoteRuntimePermission>,
)

data class RemoteRuntimePermission(
    val id: String,
    val selectionId: String,
    val displayName: String,
    val description: String?,
    val default: Boolean,
    val metadata: Map<String, Any?>,
)
