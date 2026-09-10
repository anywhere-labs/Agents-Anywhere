package com.agentsanywhere.app.feature.auth

import android.app.Application
import android.os.Bundle
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentsanywhere.app.api.AuthApi
import com.agentsanywhere.app.config.AppConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

sealed interface WebLoginState {
    data class HostChoice(
        val officialServiceAvailable: Boolean,
        val serverUrl: String = "",
        val selfHostExpanded: Boolean = false,
        val openingOfficial: Boolean = false,
        val checkingSelfHost: Boolean = false,
        val errorMessage: String? = null,
    ) : WebLoginState {
        val isBusy: Boolean get() = openingOfficial || checkingSelfHost
    }
    data class WebLogin(val session: WebLoginSession) : WebLoginState
    data class Exchanging(val session: WebLoginSession) : WebLoginState
    data object Success : WebLoginState
}

class WebLoginViewModel(application: Application) : AndroidViewModel(application) {
    private val controller = AuthController(
        api = AuthApi(),
        sessionStore = AuthSessionStore(application),
    )
    private var operation: Job? = null
    private var savedWebViewState: Bundle? = null
    private var hostChoice = hostChoiceState()

    var state: WebLoginState by mutableStateOf(hostChoice)
        private set

    fun selectSelfHost() {
        val current = state as? WebLoginState.HostChoice ?: return
        if (current.isBusy) return
        showHostChoice(current.copy(selfHostExpanded = true, errorMessage = null))
    }

    fun startOfficialLogin() {
        val officialUrl = AppConfig.OFFICIAL_SERVER_URL.trim()
        if (officialUrl.isBlank()) return
        start(officialUrl, official = true)
    }

    fun returnToHostChoice() {
        operation?.cancel()
        savedWebViewState = null
        showHostChoice(hostChoiceState())
    }

    fun updateServerUrl(serverUrl: String) {
        val current = state as? WebLoginState.HostChoice ?: return
        if (current.isBusy) return
        showHostChoice(current.copy(serverUrl = serverUrl, errorMessage = null))
    }

    fun start(serverUrl: String) {
        if (serverUrl.isNotBlank()) start(serverUrl, official = false)
    }

    private fun start(serverUrl: String, official: Boolean) {
        val current = state as? WebLoginState.HostChoice ?: return
        if (current.isBusy) return
        operation?.cancel()
        savedWebViewState = null
        hostChoice = current.copy(errorMessage = null).let { form ->
            if (official) form else form.copy(serverUrl = serverUrl, selfHostExpanded = true)
        }
        state = hostChoice.copy(openingOfficial = official, checkingSelfHost = !official)
        operation = viewModelScope.launch {
            controller.createWebLoginSession(serverUrl)
                .onSuccess { session -> state = WebLoginState.WebLogin(session) }
                .onFailure { error ->
                    if (error is CancellationException) throw error
                    showHostChoice(hostChoice.copy(errorMessage = error.message ?: "Could not reach the server."))
                }
        }
    }

    fun returnFromWebLogin() {
        operation?.cancel()
        savedWebViewState = null
        showHostChoice(hostChoice.copy(errorMessage = null))
    }

    fun handleCallback(callbackUrl: String) {
        val session = when (val current = state) {
            is WebLoginState.WebLogin -> current.session
            else -> return
        }
        when (val callback = controller.parseWebLoginCallback(callbackUrl, session)) {
            is WebLoginCallback.Success -> exchange(session, callback.code)
            is WebLoginCallback.Error -> fail(callback.message)
            is WebLoginCallback.Invalid -> fail(callback.message)
        }
    }

    fun reportWebError(message: String) {
        if (state !is WebLoginState.WebLogin) return
        fail(message)
    }

    fun resetForSignedOutEntry() {
        returnToHostChoice()
    }

    fun takeWebViewState(session: WebLoginSession): Bundle? {
        if (activeSession() !== session) return null
        return savedWebViewState.also { savedWebViewState = null }
    }

    fun saveWebViewState(session: WebLoginSession, webState: Bundle) {
        if (activeSession() === session) savedWebViewState = webState
    }

    private fun exchange(session: WebLoginSession, code: String) {
        operation?.cancel()
        state = WebLoginState.Exchanging(session)
        operation = viewModelScope.launch {
            controller.completeWebLogin(session, code)
                .onSuccess { state = WebLoginState.Success }
                .onFailure { error ->
                    if (error is CancellationException) throw error
                    fail(error.message ?: "Could not complete web sign-in.")
                }
        }
    }

    private fun fail(message: String) {
        operation?.cancel()
        operation = null
        savedWebViewState = null
        showHostChoice(hostChoice.copy(errorMessage = message))
    }

    private fun activeSession(): WebLoginSession? = when (val current = state) {
        is WebLoginState.WebLogin -> current.session
        is WebLoginState.Exchanging -> current.session
        else -> null
    }

    private fun hostChoiceState() = WebLoginState.HostChoice(
        officialServiceAvailable = AppConfig.OFFICIAL_SERVER_URL.isNotBlank(),
        serverUrl = controller.savedServerUrl(),
    )

    private fun showHostChoice(form: WebLoginState.HostChoice) {
        hostChoice = form.copy(openingOfficial = false, checkingSelfHost = false)
        state = hostChoice
    }
}
