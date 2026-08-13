package com.agentsanywhere.app.feature.auth

import android.app.Application
import android.os.Bundle
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.agentsanywhere.app.api.AuthApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

sealed interface WebLoginState {
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

    var state: WebLoginState by mutableStateOf(WebLoginState.ServerEntry(controller.savedServerUrl()))
        private set

    fun updateServerUrl(serverUrl: String) {
        val current = state
        if (current is WebLoginState.ServerEntry) {
            state = current.copy(serverUrl = serverUrl, errorMessage = null)
        } else if (current is WebLoginState.Error) {
            state = WebLoginState.ServerEntry(serverUrl)
        }
    }

    fun start(serverUrl: String) {
        operation?.cancel()
        savedWebViewState = null
        state = WebLoginState.Checking(serverUrl)
        operation = viewModelScope.launch {
            controller.createWebLoginSession(serverUrl)
                .onSuccess { session -> state = WebLoginState.WebLogin(session) }
                .onFailure { error ->
                    state = WebLoginState.Error(
                        serverUrl = serverUrl,
                        message = error.message ?: "Could not reach the server.",
                    )
                }
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
            WebLoginState.Success -> controller.savedServerUrl()
        }
        state = WebLoginState.ServerEntry(serverUrl)
    }

    fun resetForSignedOutEntry() {
        operation?.cancel()
        savedWebViewState = null
        state = WebLoginState.ServerEntry(controller.savedServerUrl())
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
}
