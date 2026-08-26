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
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

sealed interface WebLoginState {
    data class HostChoice(
        val officialServiceAvailable: Boolean,
        val openingOfficial: Boolean = false,
        val errorMessage: String? = null,
    ) : WebLoginState
    data class ServerEntry(val serverUrl: String, val errorMessage: String? = null) : WebLoginState
    data class Checking(val serverUrl: String) : WebLoginState
    data class WebLogin(val session: WebLoginSession) : WebLoginState
    data class Exchanging(val session: WebLoginSession) : WebLoginState
    data class Error(val serverUrl: String, val message: String) : WebLoginState
    data object Success : WebLoginState
}

class WebLoginViewModel(application: Application) : AndroidViewModel(application) {
    private val controller = AuthController(
        api = AuthApi(),
        sessionStore = AuthSessionStore(application),
    )
    private var operation: Job? = null
    private var savedWebViewState: Bundle? = null
    private var webLoginReturnTarget = WebLoginReturnTarget.ServerEntry

    var state: WebLoginState by mutableStateOf(hostChoiceState())
        private set

    fun selectSelfHost() {
        operation?.cancel()
        savedWebViewState = null
        state = WebLoginState.ServerEntry(controller.savedServerUrl())
    }

    fun startOfficialLogin() {
        val officialUrl = AppConfig.OFFICIAL_WEB_LOGIN_URL.trim()
        if (officialUrl.isBlank()) {
            state = hostChoiceState()
            return
        }
        start(officialUrl, WebLoginReturnTarget.HostChoice)
    }

    fun returnToHostChoice() {
        operation?.cancel()
        savedWebViewState = null
        state = hostChoiceState()
    }

    fun updateServerUrl(serverUrl: String) {
        val current = state
        if (current is WebLoginState.ServerEntry) {
            state = current.copy(serverUrl = serverUrl, errorMessage = null)
        } else if (current is WebLoginState.Error) {
            state = WebLoginState.ServerEntry(serverUrl)
        }
    }

    fun start(serverUrl: String) {
        start(serverUrl, WebLoginReturnTarget.ServerEntry)
    }

    private fun start(serverUrl: String, returnTarget: WebLoginReturnTarget) {
        operation?.cancel()
        savedWebViewState = null
        webLoginReturnTarget = returnTarget
        state = when (returnTarget) {
            WebLoginReturnTarget.ServerEntry -> WebLoginState.Checking(serverUrl)
            WebLoginReturnTarget.HostChoice -> hostChoiceState(openingOfficial = true)
        }
        operation = viewModelScope.launch {
            controller.createWebLoginSession(serverUrl)
                .onSuccess { session -> state = WebLoginState.WebLogin(session) }
                .onFailure { error ->
                    val message = error.message ?: "Could not reach the server."
                    state = when (returnTarget) {
                        WebLoginReturnTarget.ServerEntry -> WebLoginState.Error(serverUrl, message)
                        WebLoginReturnTarget.HostChoice -> hostChoiceState(errorMessage = message)
                    }
                }
        }
    }

    fun returnFromWebLogin() {
        when (webLoginReturnTarget) {
            WebLoginReturnTarget.ServerEntry -> returnToServerEntry()
            WebLoginReturnTarget.HostChoice -> returnToHostChoice()
        }
    }

    fun handleCallback(callbackUrl: String) {
        val session = when (val current = state) {
            is WebLoginState.WebLogin -> current.session
            else -> return
        }
        when (val callback = controller.parseWebLoginCallback(callbackUrl, session)) {
            is WebLoginCallback.Success -> exchange(session, callback.code)
            is WebLoginCallback.Error -> fail(session.serverUrl, callback.message)
            is WebLoginCallback.Invalid -> fail(session.serverUrl, callback.message)
        }
    }

    fun reportWebError(message: String) {
        val current = state as? WebLoginState.WebLogin ?: return
        fail(current.session.serverUrl, message)
    }

    fun returnToServerEntry() {
        operation?.cancel()
        savedWebViewState = null
        val serverUrl = when (val current = state) {
            is WebLoginState.ServerEntry -> current.serverUrl
            is WebLoginState.Checking -> current.serverUrl
            is WebLoginState.WebLogin -> current.session.serverUrl
            is WebLoginState.Exchanging -> current.session.serverUrl
            is WebLoginState.Error -> current.serverUrl
            is WebLoginState.HostChoice -> controller.savedServerUrl()
            WebLoginState.Success -> controller.savedServerUrl()
        }
        state = WebLoginState.ServerEntry(serverUrl)
    }

    fun resetForSignedOutEntry() {
        operation?.cancel()
        savedWebViewState = null
        state = hostChoiceState()
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
                    fail(session.serverUrl, error.message ?: "Could not complete web sign-in.")
                }
        }
    }

    private fun fail(serverUrl: String, message: String) {
        operation?.cancel()
        operation = null
        savedWebViewState = null
        state = WebLoginState.Error(serverUrl, message)
    }

    private fun activeSession(): WebLoginSession? = when (val current = state) {
        is WebLoginState.WebLogin -> current.session
        is WebLoginState.Exchanging -> current.session
        else -> null
    }

    private fun hostChoiceState(
        openingOfficial: Boolean = false,
        errorMessage: String? = null,
    ) = WebLoginState.HostChoice(
        officialServiceAvailable = AppConfig.OFFICIAL_WEB_LOGIN_URL.isNotBlank(),
        openingOfficial = openingOfficial,
        errorMessage = errorMessage,
    )

    private enum class WebLoginReturnTarget {
        ServerEntry,
        HostChoice,
    }
}
