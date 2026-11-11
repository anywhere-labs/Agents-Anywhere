package com.agentsanywhere.app.api

import com.agentsanywhere.app.model.ModelChannelState
import com.agentsanywhere.app.model.ModelOffer
import com.agentsanywhere.app.model.ModelPreferences
import com.agentsanywhere.app.model.ModelProfile
import org.json.JSONArray
import org.json.JSONObject

/**
 * Model profiles, the channel runtimes use and the Tokens Anywhere link.
 * Keys go in and never come back; the overview arrives with the dashboard snapshot.
 */
class ModelConfigApi(
    private val client: ApiClient = ApiClient(),
) {
    /**
     * Creates a manual profile from either [baseUrl], whose protocols and models the Server
     * detects (failing with a `gateway_*` code), or the [offers] the user entered.
     */
    fun createProfile(
        serverUrl: String,
        authorizationToken: String,
        name: String,
        apiKey: String,
        offers: List<ModelOffer>? = null,
        baseUrl: String? = null,
    ): ModelProfile {
        require((offers == null) != (baseUrl == null)) { "Give either offers or baseUrl." }
        val body = JSONObject()
            .put("name", name)
            .put("apiKey", apiKey)
        if (offers != null) body.put("offers", JSONArray().apply { offers.forEach { put(it.toJson()) } })
        if (baseUrl != null) body.put("baseUrl", baseUrl)
        return client.postJson(
            serverUrl = serverUrl,
            path = "/model-profiles",
            body = body,
            authorizationToken = authorizationToken,
            // Detection calls the gateway and can take about 15 seconds.
            readTimeoutSeconds = if (baseUrl != null) DETECT_READ_TIMEOUT_SECONDS else null,
        ).toModelProfile()
    }

    fun deleteProfile(
        serverUrl: String,
        authorizationToken: String,
        profileId: String,
    ) {
        client.deleteJson(
            serverUrl = serverUrl,
            path = "/model-profiles/${profileId.urlEncode()}",
            authorizationToken = authorizationToken,
        )
    }

    fun getChannel(serverUrl: String, authorizationToken: String): ModelChannelState =
        client.getJson(
            serverUrl = serverUrl,
            path = "/model-config/channel",
            authorizationToken = authorizationToken,
        ).toModelChannelState()

    /** Sets the current channel; runtimes switch in the background. */
    fun setChannel(serverUrl: String, authorizationToken: String, channel: String): ModelChannelState =
        client.putJson(
            serverUrl = serverUrl,
            path = "/model-config/channel",
            body = JSONObject().put("channel", channel),
            authorizationToken = authorizationToken,
        ).toModelChannelState()

    /** A runtime's own channel; null follows the current channel. */
    fun setRuntimeChannel(
        serverUrl: String,
        authorizationToken: String,
        connectorId: String,
        runtimeId: String,
        channel: String?,
        confirmNativeGlobal: Boolean,
    ): ModelChannelState {
        val body = JSONObject().put("channel", channel ?: JSONObject.NULL)
        if (confirmNativeGlobal) body.put("confirmNativeGlobal", true)
        return client.putJson(
            serverUrl = serverUrl,
            path = runtimePath(connectorId, runtimeId),
            body = body,
            authorizationToken = authorizationToken,
        ).toModelChannelState()
    }

    /** Retries one runtime, or every restored and failed one when no runtime is given. */
    fun retryChannel(
        serverUrl: String,
        authorizationToken: String,
        connectorId: String? = null,
        runtimeId: String? = null,
    ): ModelChannelState {
        val body = JSONObject()
        if (connectorId != null && runtimeId != null) body.put("connectorId", connectorId).put("runtimeId", runtimeId)
        return client.postJson(
            serverUrl = serverUrl,
            path = "/model-config/channel/retry",
            body = body,
            authorizationToken = authorizationToken,
        ).toModelChannelState()
    }

    private fun runtimePath(connectorId: String, runtimeId: String): String =
        "/model-config/channel/runtimes/${connectorId.urlEncode()}/${runtimeId.urlEncode()}"

    /** A one-time address to open in the browser; the link finishes there. */
    fun beginTokensLink(
        serverUrl: String,
        authorizationToken: String,
    ): String {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/integrations/tokens/link",
            authorizationToken = authorizationToken,
        ).getString("startUrl")
    }

    fun syncTokens(
        serverUrl: String,
        authorizationToken: String,
    ): ModelProfile {
        return client.postJson(
            serverUrl = serverUrl,
            path = "/integrations/tokens/sync",
            authorizationToken = authorizationToken,
        ).toModelProfile()
    }

    /** Revokes and removes the link; refused with `channel_in_use` while runtimes want or use it. */
    fun unlinkTokens(
        serverUrl: String,
        authorizationToken: String,
    ): Boolean {
        return client.deleteJson(
            serverUrl = serverUrl,
            path = "/integrations/tokens/link",
            authorizationToken = authorizationToken,
        ).optBoolean("revoked", false)
    }

    /** The linked account, its balance and its console pages. */
    fun tokensAccount(
        serverUrl: String,
        authorizationToken: String,
    ): RemoteTokensAccount {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/integrations/tokens/account",
            authorizationToken = authorizationToken,
        ).toTokensAccount()
    }

    /** The whole Tokens account's settled usage over the last [days] Beijing days. */
    fun tokensUsage(
        serverUrl: String,
        authorizationToken: String,
        days: Int,
    ): RemoteTokensUsage {
        return client.getJson(
            serverUrl = serverUrl,
            path = "/integrations/tokens/usage?days=$days",
            authorizationToken = authorizationToken,
        ).toTokensUsage()
    }

    /**
     * Turns models off and renames them; runtimes using Tokens get the change in
     * the background. Returns whether any runtime is being updated.
     */
    fun saveTokensModels(
        serverUrl: String,
        authorizationToken: String,
        preferences: ModelPreferences,
    ): Boolean {
        return client.putJson(
            serverUrl = serverUrl,
            path = "/integrations/tokens/models",
            body = preferences.toJson(),
            authorizationToken = authorizationToken,
        ).optBoolean("applying", false)
    }

    /**
     * Rotates the managed key; runtimes using Anywhere get it through the channel
     * switch. Refused with `busy` while tasks run, unless [allowInterrupt].
     */
    fun rotateTokensKey(
        serverUrl: String,
        authorizationToken: String,
        profileId: String,
        allowInterrupt: Boolean,
    ) {
        client.postJson(
            serverUrl = serverUrl,
            path = "/model-profiles/${profileId.urlEncode()}/rotate-key",
            body = JSONObject().put("allowInterrupt", allowInterrupt),
            authorizationToken = authorizationToken,
        )
    }

    private companion object {
        const val DETECT_READ_TIMEOUT_SECONDS = 45L
    }
}
