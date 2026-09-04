package com.agentsanywhere.app.api

import org.json.JSONObject

data class AndroidAppRelease(
    val versionCode: Int,
    val versionName: String,
    val downloadUrl: String,
)

data class BackendHealth(
    val version: String,
)

class AppUpdatesApi(private val client: ApiClient = ApiClient()) {
    fun health(serverUrl: String): BackendHealth {
        val payload = client.getJson(serverUrl = serverUrl, path = "/health")
        if (payload.optString("status") != "ok") {
            throw ApiException("The update service is not healthy.")
        }
        return BackendHealth(version = payload.requireText("version"))
    }

    fun check(serverUrl: String, currentVersionCode: Int): AndroidAppRelease? {
        val payload = client.getJson(
            serverUrl = serverUrl,
            path = "/client-releases/check?platform=android&versionCode=$currentVersionCode",
        )
        if (!payload.optBoolean("updateAvailable")) return null
        val downloadUrl = payload.optString("downloadUrl").trim()
        if (downloadUrl.isBlank()) return null
        return AndroidAppRelease(
            versionCode = payload.requirePositiveInt("latestVersionCode"),
            versionName = payload.requireText("latestVersionName"),
            downloadUrl = downloadUrl,
        )
    }
}

private fun JSONObject.requirePositiveInt(name: String): Int {
    return optInt(name).takeIf { it > 0 }
        ?: throw ApiException("Update response is missing $name.")
}

private fun JSONObject.requireText(name: String): String {
    return optString(name).trim().takeIf(String::isNotBlank)
        ?: throw ApiException("Update response is missing $name.")
}
