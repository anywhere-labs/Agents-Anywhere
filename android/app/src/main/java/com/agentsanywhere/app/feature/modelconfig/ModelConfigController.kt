package com.agentsanywhere.app.feature.modelconfig

import com.agentsanywhere.app.api.ModelConfigApi
import com.agentsanywhere.app.api.RemoteTokensAccount
import com.agentsanywhere.app.api.RemoteTokensUsage
import com.agentsanywhere.app.feature.auth.AuthSessionReader
import com.agentsanywhere.app.feature.devices.DeviceRuntime
import com.agentsanywhere.app.model.CHANNEL_NATIVE
import com.agentsanywhere.app.model.CHANNEL_TOKENS
import com.agentsanywhere.app.model.ModelChannelState
import com.agentsanywhere.app.model.ModelPreferences
import com.agentsanywhere.app.model.ModelProfile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext

/**
 * Writes to the model configuration. Results show up in the next dashboard
 * snapshot; channel writes also return the channel state to show until then.
 */
class ModelConfigController(
    private val api: ModelConfigApi,
    private val sessionStore: AuthSessionReader,
) {
    enum class ExitPhase { Idle, Switching, WaitingOnline, Waiting, Failed }
    private val exitState = MutableStateFlow(ExitPhase.Idle)
    val exitPhase = exitState.asStateFlow()
    private var observedChannel: ModelChannelState? = null
    fun resetExitFailure() {
        if (exitState.value == ExitPhase.Failed) exitState.value = ExitPhase.Idle
    }

    fun observeExitChannel(state: ModelChannelState) {
        if (state.revision >= (observedChannel?.revision ?: -1)) observedChannel = state
    }

    /** Runs in the page coroutine: closing the page cancels the unfinished exit. */
    suspend fun exitTokens(runtimes: List<DeviceRuntime>, onChannel: (ModelChannelState) -> Unit): Result<Boolean> {
        if (exitState.value !in listOf(ExitPhase.Idle, ExitPhase.Failed)) return Result.failure(IllegalStateException("Exit in progress"))
        val exitServer = sessionStore.readServerUrl()
        val exitUser = sessionStore.readUserId()
        val exitToken = sessionStore.readAccessToken()
        suspend fun checkSession() {
            currentCoroutineContext().ensureActive()
            if (sessionStore.readServerUrl() != exitServer || sessionStore.readUserId() != exitUser ||
                (exitUser.isBlank() && sessionStore.readAccessToken() != exitToken)) {
                throw CancellationException("Account changed during exit")
            }
        }
        observedChannel = null
        exitState.value = ExitPhase.Switching
        try {
            checkSession()
            var state = channel().getOrThrow()
            checkSession()
            if (state.channel == CHANNEL_TOKENS) state = setChannel(CHANNEL_NATIVE).getOrThrow()
            onChannel(state)
            for (row in state.runtimes.filter { it.override == CHANNEL_TOKENS }) {
                val global = runtimes.find { it.connectorId == row.connectorId && it.id == row.runtimeId }?.modelConnection?.scope == "native_global"
                checkSession()
                state = setRuntimeChannel(row.connectorId, row.runtimeId,
                    if (global && state.channel != CHANNEL_NATIVE) CHANNEL_NATIVE else null).getOrThrow()
                onChannel(state)
            }
            // A retry resumes failed switches as well as a previously interrupted exit.
            for (row in state.runtimes.filter { it.actual == CHANNEL_TOKENS && it.state in listOf("failed", "restored") }) {
                checkSession()
                state = retryChannel(row.connectorId, row.runtimeId).getOrThrow()
                onChannel(state)
            }
            while (true) {
                checkSession()
                observedChannel?.takeIf { it.revision > state.revision }?.let { state = it }
                val used = state.channel == CHANNEL_TOKENS || state.runtimes.any { it.desired == CHANNEL_TOKENS || it.actual == CHANNEL_TOKENS }
                if (!used) {
                    val result = unlinkTokens()
                    if (result.isSuccess) return result
                    if (modelConfigErrorCode(result.exceptionOrNull()!!) != "channel_in_use") throw result.exceptionOrNull()!!
                }
                if (state.runtimes.any { it.actual == CHANNEL_TOKENS && it.state in listOf("failed", "restored") }) {
                    throw IllegalStateException("Channel switch failed")
                }
                exitState.value = if (state.runtimes.any { it.actual == CHANNEL_TOKENS && it.state == "waiting_online" }) ExitPhase.WaitingOnline else ExitPhase.Waiting
                delay(2000)
                checkSession()
                state = channel().getOrThrow()
                onChannel(state)
            }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { exitState.value = ExitPhase.Failed; return Result.failure(error) }
        finally { if (exitState.value != ExitPhase.Failed) exitState.value = ExitPhase.Idle }
    }

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
