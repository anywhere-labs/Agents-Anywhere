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
        runtimeId: String,
        config: Map<String, Any?>,
    ): RemoteDeviceRuntime {
        return client.putJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes/${runtimeId.urlEncode()}/config",
            body = JSONObject().put("config", config.toJsonObject()),
            authorizationToken = authorizationToken,
        ).toRemoteDeviceRuntime(deviceId)
    }

    fun setDeviceRuntimeActive(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtimeId: String,
        active: Boolean,
    ): RemoteDeviceRuntime {
        return client.putJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes/${runtimeId.urlEncode()}/active",
            body = JSONObject().put("active", active),
            authorizationToken = authorizationToken,
        ).toRemoteDeviceRuntime(deviceId)
    }

    fun deleteDeviceRuntimeConfig(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtimeId: String,
    ): RemoteDeviceRuntime {
        return client.deleteJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes/${runtimeId.urlEncode()}/config",
            authorizationToken = authorizationToken,
        ).toRemoteDeviceRuntime(deviceId)
    }

    fun getDeviceRuntimeCapabilities(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtimeId: String,
    ): RemoteRuntimeCapabilities {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes/${runtimeId.urlEncode()}/capabilities",
            authorizationToken = authorizationToken,
        ).toRemoteRuntimeCapabilities(deviceId)
    }

    fun getDeviceRuntimeModelCatalog(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtimeId: String,
    ): RemoteRuntimeModelCatalogResponse {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes/${runtimeId.urlEncode()}/catalogs/model",
            authorizationToken = authorizationToken,
        ).toRemoteRuntimeModelCatalogResponse(runtimeId)
    }

    fun getDeviceRuntimePermissionCatalog(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtimeId: String,
    ): RemoteRuntimePermissionCatalogResponse {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtimes/${runtimeId.urlEncode()}/catalogs/permission",
            authorizationToken = authorizationToken,
        ).toRemoteRuntimePermissionCatalogResponse(runtimeId)
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
                .filter { runtime ->
                    runtime.runtimeType.isValidRuntimeType() &&
                        runtime.runtimeId.isValidRuntimeInstanceId(runtime.runtimeType)
                },
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject.toRemoteDeviceRuntime(
        fallbackConnectorId: String,
    ): RemoteDeviceRuntime {
        val legacyRuntime = optNullableString("runtime")
        val runtimeId = optNullableString("runtimeId") ?: legacyRuntime.orEmpty()
        val reportedRuntimeType = optNullableString("runtimeType")
        val runtimeType = legacyRuntime ?: when {
            runtimeId.isValidRuntimeType() -> runtimeId
            else -> reportedRuntimeType.orEmpty()
        }
        val displayName = optNullableString("displayName")
            ?: optNullableString("name")
            ?: runtimeType
        return RemoteDeviceRuntime(
            connectorId = optString("connectorId", fallbackConnectorId).ifBlank { fallbackConnectorId },
            runtimeId = runtimeId,
            runtimeType = runtimeType,
            displayName = displayName,
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
            runtimeId = optNullableString("runtimeId"),
            runtimeType = optNullableString("runtimeType") ?: optNullableString("runtime"),
        )
    }

    private fun JSONObject.toRemoteRuntimeModelCatalogResponse(
        fallbackRuntimeId: String,
    ): RemoteRuntimeModelCatalogResponse {
        val catalog = optJSONObject("catalog") ?: JSONObject()
        return RemoteRuntimeModelCatalogResponse(
            catalog = catalog.parseRemoteRuntimeModelCatalog(fallbackRuntimeId),
            serverTime = optNullableString("serverTime"),
        )
    }

    private fun JSONObject.toRemoteRuntimePermissionCatalogResponse(
        fallbackRuntimeId: String,
    ): RemoteRuntimePermissionCatalogResponse {
        val catalog = optJSONObject("catalog") ?: JSONObject()
        return RemoteRuntimePermissionCatalogResponse(
            catalog = catalog.parseRemoteRuntimePermissionCatalog(fallbackRuntimeId),
            serverTime = optNullableString("serverTime"),
        )
    }
}
