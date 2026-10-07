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
        // The server may publish the APK address alongside its version; that
        // wins over the address baked into this build so releases can move
        // the download without shipping a new client first.
        val serverDownloadUrl = payload.optString("androidUpdateUrl").trim()
        return AndroidAppRelease(
            versionName = latestVersion,
            downloadUrl = serverDownloadUrl.ifBlank { AppConfig.UPDATE_DOWNLOAD_URL },
        )
    }
}
