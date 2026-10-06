package com.agentsanywhere.app.config

import com.agentsanywhere.app.BuildConfig
import com.agentsanywhere.app.api.normalizeServerOrigin

object AppConfig {
    // Debug builds can override the backend in android/local.properties.
    val OFFICIAL_SERVER_URL: String = BuildConfig.OFFICIAL_SERVER_URL
    const val DESKTOP_DOWNLOAD_URL = "https://agents-anywhere.com/download"
    // Injected at build time via the agentsAnywhere.updateDownloadUrl gradle or
    // local property; the repository default stays a non-routable placeholder.
    val UPDATE_DOWNLOAD_URL: String = BuildConfig.UPDATE_DOWNLOAD_URL

    fun isOfficialServer(serverUrl: String): Boolean {
        val officialOrigin = normalizeServerOrigin(OFFICIAL_SERVER_URL) ?: return false
        return normalizeServerOrigin(serverUrl) == officialOrigin
    }
}
