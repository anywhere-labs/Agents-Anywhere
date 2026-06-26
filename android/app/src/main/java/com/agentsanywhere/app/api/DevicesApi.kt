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

    fun deleteDeviceRuntime(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtime: String,
    ): List<String> {
        return client.deleteJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtime-capabilities/${runtime.urlEncode()}",
            authorizationToken = authorizationToken,
        ).getJSONObject("runtimeCapabilities").attachedRuntimes()
    }

    fun scanDeviceRuntime(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtime: String,
        path: String?,
    ): RemoteDeviceRuntimeScan {
        val body = JSONObject().put("runtime", runtime)
        if (!path.isNullOrBlank()) body.put("path", path)
        val response = client.postJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/runtime-capabilities/scan",
            body = body,
            authorizationToken = authorizationToken,
        )
        val scanned = response.getJSONObject("scanned")
        return RemoteDeviceRuntimeScan(
            attachedRuntimes = response.getJSONObject("runtimeCapabilities").attachedRuntimes(),
            scannedRuntime = scanned.optString("runtime", runtime),
            report = scanned.optJSONObject("report").toMap(),
        )
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

    fun getDeviceAgentSettings(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtime: String,
    ): RemoteRuntimeSettings {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/agents/${runtime.urlEncode()}/settings",
            authorizationToken = authorizationToken,
        ).toRemoteRuntimeSettings()
    }

    fun patchDeviceAgentSettings(
        serverUrl: String,
        authorizationToken: String,
        deviceId: String,
        runtime: String,
        settings: Map<String, Any?>,
    ): RemoteRuntimeSettings {
        val body = JSONObject().put("settings", settings.toJsonObject())
        return client.patchJson(
            serverUrl = serverUrl,
            path = "/connectors/${deviceId.urlEncode()}/agents/${runtime.urlEncode()}/settings",
            body = body,
            authorizationToken = authorizationToken,
        ).toRemoteRuntimeSettings()
    }

    private fun JSONObject.toRemoteDevice(): RemoteDevice {
        return RemoteDevice(
            id = getString("id"),
            name = optString("name", "Device").ifBlank { "Device" },
            deviceOs = optNullableString("deviceOs"),
            status = optString("status", "offline"),
            lastSeenAt = optNullableString("lastSeenAt"),
            attachedRuntimes = optJSONObject("runtimeCapabilities").attachedRuntimes(),
            createdAt = optNullableString("createdAt"),
            updatedAt = optNullableString("updatedAt"),
        )
    }

    private fun JSONObject?.attachedRuntimes(): List<String> {
        return this
            ?.optJSONObject("attached")
            ?.keys()
            ?.asSequence()
            ?.toList()
            .orEmpty()
            .sorted()
    }

    private fun JSONObject.toRemoteRuntimeSettings(): RemoteRuntimeSettings {
        return RemoteRuntimeSettings(
            runtime = optString("runtime", ""),
            settings = (optJSONObject("runtimeSettings") ?: optJSONObject("settings")).toMap(),
            runtimeSettingsOverride = optJSONObject("runtimeSettingsOverride").toMap(),
            effectiveRunMode = optNullableString("effectiveRunMode"),
            defaultRunModeConfigured = optBoolean("defaultRunModeConfigured", false),
            schemaVersion = optInt("schemaVersion", 0),
        )
    }
}
