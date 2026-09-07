package com.agentsanywhere.app.config

import com.agentsanywhere.app.BuildConfig
import com.agentsanywhere.app.api.normalizeServerOrigin

object AppConfig {
    // Debug builds can override the backend in android/local.properties.
    val OFFICIAL_SERVER_URL: String = BuildConfig.OFFICIAL_SERVER_URL
    val UPDATE_SERVICE_URL: String = OFFICIAL_SERVER_URL
    // Replace this placeholder with the fixed APK address before distribution.
    const val UPDATE_DOWNLOAD_URL = "https://downloads.example.invalid/agents-anywhere.apk"

    fun isOfficialServer(serverUrl: String): Boolean {
        val officialOrigin = normalizeServerOrigin(OFFICIAL_SERVER_URL) ?: return false
        return normalizeServerOrigin(serverUrl) == officialOrigin
    }
}
