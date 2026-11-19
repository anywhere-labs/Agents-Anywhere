package dev.agentsanywhere.v3poc.model

import android.content.Context
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient

/** App-private account and workspace configuration for the development build. */
@Serializable
class DevContentProfile(
    val serverUrl: String,
    val accessToken: String,
    val pairingUri: String? = null,
    val workspace: Workspace,
) {
    fun sessionsClient(context: Context): SessionsClient {
        val device = workspace.devices.single()
        val http = OkHttpClient.Builder().followRedirects(false).build()
        val pairing = ContentPairing(context, serverUrl.toHttpUrl(), workspace.account.email, device.id, pairingUri, http) { accessToken }
        return MeshSessionsClient(device, workspace.sessions.associate { it.id to it.title }, connect = pairing::connect)
    }

    companion object {
        fun read(context: Context): DevContentProfile? {
            val file = context.filesDir.resolve("content-profile.json")
            if (!file.isFile) return null
            return runCatching { AAJson.decodeFromString(serializer(), file.readText()) }.getOrNull()
        }
    }
}
