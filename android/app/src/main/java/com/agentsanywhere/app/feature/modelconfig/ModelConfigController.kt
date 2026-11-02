package com.agentsanywhere.app.feature.modelconfig

import com.agentsanywhere.app.api.ModelConfigApi
import com.agentsanywhere.app.api.RemoteModelOperation
import com.agentsanywhere.app.api.RemoteModelOperationResult
import com.agentsanywhere.app.api.RemoteModelPreviewTarget
import com.agentsanywhere.app.api.RemoteModelTarget
import com.agentsanywhere.app.api.RemoteTokensUnlinkResult
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.model.ModelProfile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Writes to the model configuration. Results show up in the next dashboard
 * snapshot, so callers only report success or failure.
 */
class ModelConfigController(
    private val api: ModelConfigApi,
    private val sessionStore: AuthSessionReader,
) {
    suspend fun createProfile(draft: ManualProfileDraft): Result<ModelProfile> = call { server, token ->
        api.createProfile(server, token, draft.name.trim(), draft.apiKey.trim(), draft.toOffers())
    }

    suspend fun deleteProfile(profileId: String): Result<Unit> = call { server, token ->
        api.deleteProfile(server, token, profileId)
    }

    suspend fun preview(profileId: String): Result<List<RemoteModelPreviewTarget>> = call { server, token ->
        api.preview(server, token, profileId)
    }

    suspend fun apply(
        profileId: String,
        targets: List<RemoteModelPreviewTarget>,
        allowInterrupt: Boolean,
        confirmNativeGlobal: Boolean,
        idempotencyKey: String,
    ): Result<RemoteModelOperation> = call { server, token ->
        api.apply(
            serverUrl = server,
            authorizationToken = token,
            profileId = profileId,
            targets = targets.map { RemoteModelTarget(it.connectorId, it.runtimeId) },
            allowInterrupt = allowInterrupt,
            confirmNativeGlobal = confirmNativeGlobal,
            idempotencyKey = idempotencyKey,
        )
    }

    suspend fun restore(connectorId: String, runtimeId: String, allowInterrupt: Boolean): Result<RemoteModelOperationResult> =
        call { server, token -> api.restore(server, token, connectorId, runtimeId, allowInterrupt) }

    suspend fun beginTokensLink(): Result<String> = call { server, token -> api.beginTokensLink(server, token) }

    suspend fun syncTokens(): Result<ModelProfile> = call { server, token -> api.syncTokens(server, token) }

    suspend fun unlinkTokens(allowInterrupt: Boolean): Result<RemoteTokensUnlinkResult> =
        call { server, token -> api.unlinkTokens(server, token, allowInterrupt) }

    suspend fun rotateTokensKey(profileId: String, allowInterrupt: Boolean, idempotencyKey: String): Result<RemoteModelOperation> =
        call { server, token -> api.rotateTokensKey(server, token, profileId, allowInterrupt, idempotencyKey) }

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
