package com.agentsanywhere.app.api

import com.agentsanywhere.app.config.AppConfig

data class AndroidAppRelease(
    val versionName: String,
    val downloadUrl: String,
)

class AppUpdatesApi(private val client: ApiClient = ApiClient()) {
    fun check(serverUrl: String, currentVersionName: String): AndroidAppRelease? {
        val payload = client.getJson(
            serverUrl = serverUrl,
            path = "/health",
        )
        if (payload.optString("status") != "ok") throw ApiException("Server health check failed.")
        val latestVersion = payload.optString("version").trim()
        val comparison = compareUpdateVersions(latestVersion, currentVersionName)
            ?: throw ApiException("Server health response has no valid version.")
        if (comparison <= 0) return null
        return AndroidAppRelease(
            versionName = latestVersion,
            downloadUrl = AppConfig.UPDATE_DOWNLOAD_URL,
        )
    }
}
