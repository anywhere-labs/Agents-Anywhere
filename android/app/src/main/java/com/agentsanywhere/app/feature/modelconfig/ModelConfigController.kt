package com.agentsanywhere.app.feature.modelconfig

import com.agentsanywhere.app.api.ModelConfigApi
import com.agentsanywhere.app.api.RemoteTokensAccount
import com.agentsanywhere.app.api.RemoteTokensUsage
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.model.ModelChannelState
import com.agentsanywhere.app.model.ModelPreferences
import com.agentsanywhere.app.model.ModelProfile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Writes to the model configuration. Results show up in the next dashboard
 * snapshot; channel writes also return the channel state to show until then.
 */
class ModelConfigController(
    private val api: ModelConfigApi,
    private val sessionStore: AuthSessionReader,
) {
    /** Automatic drafts send only the address; the Server detects the protocols and models. */
    suspend fun createProfile(draft: ManualProfileDraft): Result<ModelProfile> = call { server, token ->
        if (draft.manual) {
            api.createProfile(server, token, draft.name.trim(), draft.apiKey.trim(), offers = draft.toOffers())
        } else {
            api.createProfile(server, token, draft.name.trim(), draft.apiKey.trim(), baseUrl = draft.baseUrl.trim())
        }
    }

    suspend fun deleteProfile(profileId: String): Result<Unit> = call { server, token ->
        api.deleteProfile(server, token, profileId)
    }

    suspend fun channel(): Result<ModelChannelState> = call { server, token -> api.getChannel(server, token) }

    /** Makes [channel] the current channel: "native", "tokens" or a manual profile ID. */
    suspend fun setChannel(channel: String): Result<ModelChannelState> =
        call { server, token -> api.setChannel(server, token, channel) }

    /** Gives a runtime its own channel, or null to follow the current one. */
    suspend fun setRuntimeChannel(
        connectorId: String,
        runtimeId: String,
        channel: String?,
        confirmNativeGlobal: Boolean = false,
    ): Result<ModelChannelState> = call { server, token ->
        api.setRuntimeChannel(server, token, connectorId, runtimeId, channel, confirmNativeGlobal)
    }

    /** Retries one runtime, or every restored and failed one when none is given. */
    suspend fun retryChannel(connectorId: String? = null, runtimeId: String? = null): Result<ModelChannelState> =
        call { server, token -> api.retryChannel(server, token, connectorId, runtimeId) }

    suspend fun beginTokensLink(): Result<String> = call { server, token -> api.beginTokensLink(server, token) }

    suspend fun syncTokens(): Result<ModelProfile> = call { server, token -> api.syncTokens(server, token) }

    /** True when the authorization was revoked as well. */
    suspend fun unlinkTokens(): Result<Boolean> = call { server, token -> api.unlinkTokens(server, token) }

    suspend fun tokensAccount(): Result<RemoteTokensAccount> = call { server, token -> api.tokensAccount(server, token) }

    suspend fun tokensUsage(days: Int): Result<RemoteTokensUsage> = call { server, token -> api.tokensUsage(server, token, days) }

    /** True when runtimes using Tokens are being updated. */
    suspend fun saveTokensModels(preferences: ModelPreferences): Result<Boolean> =
        call { server, token -> api.saveTokensModels(server, token, preferences) }

    suspend fun rotateTokensKey(profileId: String, allowInterrupt: Boolean): Result<Unit> =
        call { server, token -> api.rotateTokensKey(server, token, profileId, allowInterrupt) }

    private suspend fun <T> call(block: (String, String) -> T): Result<T> {
        val serverUrl = sessionStore.readServerUrl()
        val accessToken = sessionStore.readAccessToken()
        if (serverUrl.isBlank() || accessToken.isBlank()) {
            return Result.failure(IllegalStateException("Sign in again to change model configuration."))
        }
        return withContext(Dispatchers.IO) {
            try {
                Result.success(block(serverUrl, accessToken))
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Result.failure(error)
            }
        }
    }
}
