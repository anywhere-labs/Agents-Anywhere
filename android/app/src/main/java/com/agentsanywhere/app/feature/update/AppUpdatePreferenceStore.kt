package com.agentsanywhere.app.feature.update

import android.content.Context
import com.agentsanywhere.app.api.AndroidAppRelease
import org.json.JSONObject

internal enum class AppUpdateDecision(val storedValue: String) {
    Accepted("accepted"),
    Deferred("deferred"),
}

internal data class StoredUpdateArtifact(
    val serverOrigin: String,
    val release: AndroidAppRelease,
    val filePath: String,
    val sessionId: Int? = null,
    val installStatus: Int? = null,
    val installStatusMessage: String? = null,
)

internal class AppUpdatePreferenceStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    fun isDeferred(serverOrigin: String, versionCode: Int): Boolean {
        return preferences.getString(decisionKey(serverOrigin, versionCode), null) ==
            AppUpdateDecision.Deferred.storedValue
    }

    fun recordAccepted(serverOrigin: String, versionCode: Int) {
        recordDecision(serverOrigin, versionCode, AppUpdateDecision.Accepted)
    }

    fun recordDeferred(serverOrigin: String, versionCode: Int) {
        recordDecision(serverOrigin, versionCode, AppUpdateDecision.Deferred)
    }

    fun readRequiredBackendVersion(serverOrigin: String): String? {
        if (serverOrigin.isBlank()) return null
        return preferences.getString(requiredVersionKey(serverOrigin), null)
            ?.trim()
            ?.takeIf(String::isNotBlank)
    }

    fun recordRequiredBackendVersion(serverOrigin: String, version: String) {
        if (serverOrigin.isBlank() || version.isBlank()) return
        preferences.edit()
            .putString(requiredVersionKey(serverOrigin), version.trim())
            .commit()
    }

    fun clearRequiredBackendVersion(serverOrigin: String) {
        if (serverOrigin.isBlank()) return
        preferences.edit().remove(requiredVersionKey(serverOrigin)).commit()
    }

    fun recordDownloadedArtifact(
        serverOrigin: String,
        release: AndroidAppRelease,
        filePath: String,
    ) {
        if (serverOrigin.isBlank() || release.versionCode <= 0 || filePath.isBlank()) return
        writeArtifact(
            StoredUpdateArtifact(
                serverOrigin = normalizeOrigin(serverOrigin),
                release = release,
                filePath = filePath,
            ),
        )
    }

    fun recordInstallStarted(
        sessionId: Int,
        serverOrigin: String,
        versionCode: Int,
        filePath: String,
    ): Boolean {
        if (sessionId < 0) return false
        val artifact = readInstallArtifact() ?: return false
        if (!artifact.matches(serverOrigin, versionCode, filePath)) return false
        if (artifact.sessionId != null && artifact.sessionId != sessionId) return false
        if (artifact.sessionId == sessionId && artifact.installStatus != null) return true
        writeArtifact(
            artifact.copy(
                sessionId = sessionId,
                installStatus = null,
                installStatusMessage = null,
            ),
        )
        return true
    }

    fun recordInstallResult(
        sessionId: Int,
        status: Int,
        message: String?,
        serverOrigin: String,
        versionCode: Int,
        filePath: String,
    ) {
        if (sessionId < 0) return
        val artifact = readInstallArtifact() ?: return
        if (!artifact.matches(serverOrigin, versionCode, filePath)) return
        if (artifact.sessionId != sessionId) return
        writeArtifact(
            artifact.copy(
                sessionId = sessionId,
                installStatus = status,
                installStatusMessage = message?.trim()?.takeIf(String::isNotBlank),
            ),
        )
    }

    fun readInstallArtifact(): StoredUpdateArtifact? {
        val raw = preferences.getString(KEY_INSTALL_ARTIFACT, null) ?: return null
        return runCatching {
            val json = JSONObject(raw)
            val serverOrigin = normalizeOrigin(json.getString("serverOrigin"))
            val versionCode = json.getInt("versionCode")
            val versionName = json.getString("versionName").trim()
            val downloadUrl = json.getString("downloadUrl").trim()
            val filePath = json.getString("filePath").trim()
            require(serverOrigin.isNotBlank())
            require(versionCode > 0)
            require(versionName.isNotBlank())
            require(downloadUrl.isNotBlank())
            require(filePath.isNotBlank())
            StoredUpdateArtifact(
                serverOrigin = serverOrigin,
                release = AndroidAppRelease(
                    versionCode = versionCode,
                    versionName = versionName,
                    downloadUrl = downloadUrl,
                ),
                filePath = filePath,
                sessionId = json.optInt("sessionId", -1).takeIf { it >= 0 },
                installStatus = if (json.has("installStatus")) json.getInt("installStatus") else null,
                installStatusMessage = json.optString("installStatusMessage")
                    .trim()
                    .takeIf(String::isNotBlank),
            )
        }.getOrNull()
    }

    fun clearInstallArtifact(serverOrigin: String? = null, versionCode: Int? = null) {
        val artifact = readInstallArtifact()
        if (serverOrigin != null && artifact?.serverOrigin != normalizeOrigin(serverOrigin)) return
        if (versionCode != null && artifact?.release?.versionCode != versionCode) return
        preferences.edit().remove(KEY_INSTALL_ARTIFACT).commit()
    }

    private fun recordDecision(
        serverOrigin: String,
        versionCode: Int,
        decision: AppUpdateDecision,
    ) {
        if (serverOrigin.isBlank() || versionCode <= 0) return
        preferences.edit()
            .putString(decisionKey(serverOrigin, versionCode), decision.storedValue)
            .commit()
    }

    private fun decisionKey(serverOrigin: String, versionCode: Int): String {
        return "$DECISION_KEY_PREFIX${normalizeOrigin(serverOrigin)}|$versionCode"
    }

    private fun requiredVersionKey(serverOrigin: String): String {
        return "$REQUIRED_VERSION_KEY_PREFIX${normalizeOrigin(serverOrigin)}"
    }

    private fun writeArtifact(artifact: StoredUpdateArtifact) {
        val json = JSONObject()
            .put("serverOrigin", artifact.serverOrigin)
            .put("versionCode", artifact.release.versionCode)
            .put("versionName", artifact.release.versionName)
            .put("downloadUrl", artifact.release.downloadUrl)
            .put("filePath", artifact.filePath)
        artifact.sessionId?.let { json.put("sessionId", it) }
        artifact.installStatus?.let { json.put("installStatus", it) }
        artifact.installStatusMessage?.let { json.put("installStatusMessage", it) }
        preferences.edit().putString(KEY_INSTALL_ARTIFACT, json.toString()).commit()
    }

    private fun StoredUpdateArtifact.matches(
        serverOrigin: String,
        versionCode: Int,
        filePath: String,
    ): Boolean {
        return this.serverOrigin == normalizeOrigin(serverOrigin) &&
            release.versionCode == versionCode &&
            this.filePath == filePath
    }

    private fun normalizeOrigin(serverOrigin: String): String {
        return serverOrigin.trim().trimEnd('/')
    }

    private companion object {
        const val PREFERENCES_NAME = "agents_anywhere_app_updates"
        const val DECISION_KEY_PREFIX = "decision|"
        const val REQUIRED_VERSION_KEY_PREFIX = "required_backend_version|"
        const val KEY_INSTALL_ARTIFACT = "install_artifact"
    }
}
