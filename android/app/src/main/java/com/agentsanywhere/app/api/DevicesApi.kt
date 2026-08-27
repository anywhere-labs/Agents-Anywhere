package com.agentsanywhere.app.api

import org.json.JSONObject

class DevicesApi(
    private val client: ApiClient = ApiClient(),
) {
    fun listDevices(
        serverUrl: String,
        authorizationToken: String,
    ): List<RemoteDevice> {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/connectors",
            authorizationToken = authorizationToken,
        ).optJSONArray("connectors").toObjectList { toRemoteDevice() }
    }

    fun createDevice(
        serverUrl: String,
        authorizationToken: String,
        name: String,
    ): RemoteDeviceCredential {
        val response = client.postJson(
            serverUrl = serverUrl,
            path = "/connectors",
            body = JSONObject().put("name", name),
            authorizationToken = authorizationToken,
        )
        return RemoteDeviceCredential(
            device = response.getJSONObject("connector").toRemoteDevice(),
            deviceToken = response.getString("connectorToken"),
            tokenPrefix = response.optNullableString("tokenPrefix"),
        )
    }

    fun updateDevice(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        name: String,
    ): RemoteDevice {
        return client.patchJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}",
            body = JSONObject().put("name", name),
            authorizationToken = authorizationToken,
        ).getJSONObject("connector").toRemoteDevice()
    }

    fun deleteDevice(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
    ) {
        client.deleteJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}",
            authorizationToken = authorizationToken,
        )
    }

    fun revokeDevice(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
    ): RemoteDeviceCredential {
        val response = client.postJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/revoke",
            body = JSONObject(),
            authorizationToken = authorizationToken,
        )
        return RemoteDeviceCredential(
            device = response.getJSONObject("connector").toRemoteDevice(),
            deviceToken = response.getString("connectorToken"),
            tokenPrefix = response.optNullableString("tokenPrefix"),
        )
    }

    fun listDeviceRuntimes(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
    ): RemoteDeviceRuntimeList {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes",
            authorizationToken = authorizationToken,
        ).toRemoteDeviceRuntimeList(deviceId)
    }

    fun discoverDeviceRuntimes(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
    ): RemoteDeviceRuntimeList {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes/discover",
            authorizationToken = authorizationToken,
        ).toRemoteDeviceRuntimeList(deviceId)
    }

    fun putDeviceRuntimeConfig(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtime: String,
        config: Map<String, Any?>,
    ): RemoteDeviceRuntime {
        return client.putJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes/${runtime.urlEncode()}/config",
            body = JSONObject().put("config", config.toJsonObject()),
            authorizationToken = authorizationToken,
        ).toRemoteDeviceRuntime(deviceId)
    }

    fun setDeviceRuntimeActive(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtime: String,
        active: Boolean,
    ): RemoteDeviceRuntime {
        return client.putJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes/${runtime.urlEncode()}/active",
            body = JSONObject().put("active", active),
            authorizationToken = authorizationToken,
        ).toRemoteDeviceRuntime(deviceId)
    }

    fun deleteDeviceRuntimeConfig(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtime: String,
    ): RemoteDeviceRuntime {
        return client.deleteJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes/${runtime.urlEncode()}/config",
            authorizationToken = authorizationToken,
        ).toRemoteDeviceRuntime(deviceId)
    }

    fun getDeviceRuntimeCapabilities(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtime: String,
    ): RemoteRuntimeCapabilities {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes/${runtime.urlEncode()}/capabilities",
            authorizationToken = authorizationToken,
        ).toRemoteRuntimeCapabilities(deviceId)
    }

    fun getDeviceRuntimeModelCatalog(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtime: String,
    ): RemoteRuntimeModelCatalogResponse {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes/${runtime.urlEncode()}/catalogs/model",
            authorizationToken = authorizationToken,
        ).toRemoteRuntimeModelCatalogResponse()
    }

    fun getDeviceRuntimePermissionCatalog(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtime: String,
    ): RemoteRuntimePermissionCatalogResponse {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes/${runtime.urlEncode()}/catalogs/permission",
            authorizationToken = authorizationToken,
        ).toRemoteRuntimePermissionCatalogResponse()
    }

    fun getDeviceRuntimeAgentPresetCatalog(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtime: String,
    ): RemoteRuntimeAgentPresetCatalogResponse {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes/${runtime.urlEncode()}/catalogs/agent-preset",
            authorizationToken = authorizationToken,
        ).toRemoteRuntimeAgentPresetCatalogResponse()
    }

    fun claimPairing(
        serverUrl: String,
        authorizationToken: String,
        code: String,
        name: String,
        deviceId: String,
        deviceToken: String,
    ): RemoteDevice {
        val body = JSONObject().apply {
            put("code", code)
            put("name", name)
            put("serverUrl", serverUrl)
            put("connectorId", deviceId)
            put("connectorToken", deviceToken)
        }
        return client.postJson(
            serverUrl = serverUrl,
            path = "/pairing/claim",
            body = body,
            authorizationToken = authorizationToken,
        ).getJSONObject("connector").toRemoteDevice()
    }

    internal fun parseDevice(value: JSONObject): RemoteDevice = value.toRemoteDevice()

    private fun JSONObject.toRemoteDevice(): RemoteDevice {
        return RemoteDevice(
            id = getString("id"),
            name = optString("name", "Device").ifBlank { "Device" },
            deviceOs = optNullableString("deviceOs"),
            status = optString("status", "offline"),
            lastSeenAt = optNullableString("lastSeenAt"),
            createdAt = optNullableString("createdAt"),
            updatedAt = optNullableString("updatedAt"),
        )
    }

    private fun JSONObject.toRemoteDeviceRuntimeList(
        fallbackConnectorId: String,
    ): RemoteDeviceRuntimeList {
        val connectorId = optString("connectorId", fallbackConnectorId).ifBlank { fallbackConnectorId }
        return RemoteDeviceRuntimeList(
            connectorId = connectorId,
            runtimes = optJSONArray("runtimes")
                .toObjectList { toRemoteDeviceRuntime(connectorId) }
                .filter { it.runtimeId.isSupportedV2NativeRuntime() },
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject.toRemoteDeviceRuntime(
        fallbackConnectorId: String,
    ): RemoteDeviceRuntime {
        val runtimeId = optString("runtimeId", "")
        return RemoteDeviceRuntime(
            connectorId = optString("connectorId", fallbackConnectorId).ifBlank { fallbackConnectorId },
            runtimeId = runtimeId,
            runtimeType = optString("runtimeType", runtimeId).ifBlank { runtimeId },
            displayName = optString("displayName", runtimeId).ifBlank { runtimeId },
            present = optBoolean("present", false),
            configured = optBoolean("configured", false),
            active = optBoolean("active", false),
            status = RemoteDeviceRuntimeStatus.fromWireValue(optString("status", "unknown")),
            discovery = optJSONObject("discovery").toMap(),
            metadata = optJSONObject("metadata").toMap(),
            schema = optJSONObject("schema")?.toMap(),
            uiSchema = optJSONObject("uiSchema").toMap(),
            config = optJSONObject("config")?.toMap(),
            error = optJSONObject("error")?.toMap(),
            lastDiscoveredAt = optNullableString("lastDiscoveredAt"),
            updatedAt = optNullableString("updatedAt"),
        )
    }

    private fun JSONObject.toRemoteRuntimeCapabilities(
        fallbackConnectorId: String,
    ): RemoteRuntimeCapabilities {
        val capabilitySet = optJSONObject("capabilitySet")
        return RemoteRuntimeCapabilities(
            connectorId = optString("connectorId", fallbackConnectorId).ifBlank { fallbackConnectorId },
            capabilitySet = RemoteRuntimeCapabilitySet(
                revision = capabilitySet?.optLong("revision", 0L) ?: 0L,
                capabilities = capabilitySet
                    ?.optJSONArray("capabilities")
                    .toObjectList { toRemoteRuntimeCapability() },
            ),
            serverTime = optNullableString("serverTime"),
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

    private fun JSONObject.toRemoteRuntimeModelCatalogResponse(): RemoteRuntimeModelCatalogResponse {
        val catalog = optJSONObject("catalog") ?: JSONObject()
        return RemoteRuntimeModelCatalogResponse(
            catalog = RemoteRuntimeModelCatalog(
                runtime = catalog.optString("runtime", ""),
                revision = catalog.optLong("revision", 0L),
                models = catalog.optJSONArray("models").toObjectList { toRemoteRuntimeModel() },
            ),
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject.toRemoteRuntimeModel(): RemoteRuntimeModel {
        return RemoteRuntimeModel(
            id = optString("id", ""),
            selectionId = optNullableString("selectionId"),
            displayName = optString("displayName", ""),
            description = optNullableString("description"),
            default = optBoolean("default", false),
            reasoningItems = optJSONArray("reasoningItems")
                .toObjectList { toRemoteRuntimeReasoning() },
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

    private fun JSONObject.toRemoteRuntimePermissionCatalogResponse(): RemoteRuntimePermissionCatalogResponse {
        val catalog = optJSONObject("catalog") ?: JSONObject()
        return RemoteRuntimePermissionCatalogResponse(
            catalog = RemoteRuntimePermissionCatalog(
                runtime = catalog.optString("runtime", ""),
                revision = catalog.optLong("revision", 0L),
                permissions = catalog.optJSONArray("permissions")
                    .toObjectList { toRemoteRuntimePermission() },
            ),
            serverTime = optNullableString("serverTime"),
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

    private fun JSONObject.toRemoteRuntimeAgentPresetCatalogResponse(): RemoteRuntimeAgentPresetCatalogResponse {
        val catalog = optJSONObject("catalog") ?: JSONObject()
        return RemoteRuntimeAgentPresetCatalogResponse(
            catalog = RemoteRuntimeAgentPresetCatalog(
                runtime = catalog.optString("runtime", ""),
                revision = catalog.optLong("revision", 0L),
                presets = catalog.optJSONArray("presets")
                    .toObjectList { toRemoteRuntimeAgentPreset() },
            ),
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject.toRemoteRuntimeAgentPreset(): RemoteRuntimeAgentPreset {
        return RemoteRuntimeAgentPreset(
            id = optString("id", ""),
            agentPreset = optString("agentPreset", ""),
            displayName = optString("displayName", ""),
            description = optNullableString("description"),
            default = optBoolean("default", false),
            enabled = optBoolean("enabled", true),
            disabledReason = optNullableString("disabledReason"),
            metadata = optJSONObject("metadata").toMap(),
        )
    }
}
