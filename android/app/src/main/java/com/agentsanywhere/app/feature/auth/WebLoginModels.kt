package com.agentsanywhere.app.feature.auth

import com.agentsanywhere.app.api.normalizeServerOrigin
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

class WebLoginSession internal constructor(
    val serverUrl: String,
    val authorizeUrl: String,
    val state: String,
    internal val codeVerifier: String,
) {
    private val callbackConsumed = AtomicBoolean(false)

    internal fun consumeCallback(): Boolean = callbackConsumed.compareAndSet(false, true)
}

sealed interface WebLoginCallback {
    data class Success(val code: String) : WebLoginCallback
    data class Error(val message: String) : WebLoginCallback
    data class Invalid(val message: String) : WebLoginCallback
}

internal fun createWebLoginSession(
    serverUrl: String,
    codeVerifier: String = randomUrlSafeString(32),
    state: String = randomUrlSafeString(24),
): WebLoginSession {
    val origin = requireNotNull(normalizeServerOrigin(serverUrl)) {
        "Server URL must be an HTTP(S) origin."
    }
    require(codeVerifier.isNotBlank()) { "PKCE verifier must not be blank." }
    require(state.isNotBlank()) { "OAuth state must not be blank." }

    val query = listOf(
        "response_type" to "code",
        "client_id" to WEB_LOGIN_CLIENT_ID,
        "redirect_uri" to WEB_LOGIN_CALLBACK_URI,
        "code_challenge" to pkceChallenge(codeVerifier),
        "code_challenge_method" to "S256",
        "scope" to "profile",
        "state" to state,
    ).joinToString("&") { (name, value) ->
        "${name.urlEncoded()}=${value.urlEncoded()}"
    }
    return WebLoginSession(
        serverUrl = origin,
        authorizeUrl = "$origin/#/mobile-oauth?$query",
        state = state,
        codeVerifier = codeVerifier,
    )
}

internal fun parseWebLoginCallback(
    callbackUrl: String,
    session: WebLoginSession,
): WebLoginCallback {
    val uri = runCatching { URI(callbackUrl) }.getOrNull()
        ?: return WebLoginCallback.Invalid("The sign-in callback was invalid.")
    if (!uri.scheme.equals(WEB_LOGIN_CALLBACK_SCHEME, ignoreCase = true) ||
        !uri.host.equals(WEB_LOGIN_CALLBACK_HOST, ignoreCase = true) ||
        uri.path != WEB_LOGIN_CALLBACK_PATH ||
        uri.port != -1 ||
        uri.rawUserInfo != null ||
        uri.rawFragment != null
    ) {
        return WebLoginCallback.Invalid("The sign-in callback was invalid.")
    }

    val parameters = runCatching { uri.rawQuery.queryParameters() }.getOrElse {
        return WebLoginCallback.Invalid("The sign-in callback was invalid.")
    }
    if (parameters["state"] != session.state) {
        return WebLoginCallback.Invalid("The sign-in callback did not match this login session.")
    }
    if (!session.consumeCallback()) {
        return WebLoginCallback.Invalid("This sign-in callback was already handled.")
    }

    val error = parameters["error"].orEmpty()
    if (error.isNotBlank()) {
        val message = if (error == "access_denied") {
            "Sign in was cancelled."
        } else {
            parameters["error_description"].takeUnless { it.isNullOrBlank() } ?: error
        }
        return WebLoginCallback.Error(message)
    }

    val code = parameters["code"].orEmpty()
    if (code.isBlank()) {
        return WebLoginCallback.Invalid("The sign-in callback did not include an authorization code.")
    }
    return WebLoginCallback.Success(code)
}

internal fun pkceChallenge(codeVerifier: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(codeVerifier.toByteArray(Charsets.UTF_8))
    return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
}

internal fun webLoginApiOriginBridgeScript(serverUrl: String): String {
    val origin = requireNotNull(normalizeServerOrigin(serverUrl)) {
        "Server URL must be an HTTP(S) origin."
    }
       return """
         (() => {
           const serverOrigin = ${JSONObject.quote(origin)};
           const viewportHeightProperty = "--agents-anywhere-android-viewport-height";
           const installViewportHeightFix = () => {
             const root = document.documentElement;
             if (!root) {
               window.setTimeout(installViewportHeightFix, 0);
               return;
             }

             const style = document.createElement("style");
             style.textContent = `
               html, body {
                 height: var(${'$'}{viewportHeightProperty}) !important;
                 min-height: var(${'$'}{viewportHeightProperty}) !important;
               }
             `;
             root.appendChild(style);

             const updateViewportHeight = () => {
               const height = window.visualViewport?.height || window.innerHeight;
               if (height > 0) {
                 root.style.setProperty(viewportHeightProperty, `${'$'}{Math.round(height)}px`);
               }
             };
             updateViewportHeight();
             window.addEventListener("resize", updateViewportHeight);
             window.visualViewport?.addEventListener("resize", updateViewportHeight);
           };
           installViewportHeightFix();

           const rewriteApiUrl = (value) => {
            try {
              const url = new URL(String(value), window.location.href);
              if (url.pathname !== "/api/v2" && !url.pathname.startsWith("/api/v2/")) return value;
              return serverOrigin + url.pathname + url.search + url.hash;
            } catch (_) {
              return value;
            }
          };

          const nativeFetch = window.fetch.bind(window);
          window.fetch = (input, init) => {
            if (typeof input === "string" || input instanceof URL) {
              return nativeFetch(rewriteApiUrl(input), init);
            }
            if (input instanceof Request) {
              const rewritten = rewriteApiUrl(input.url);
              if (rewritten !== input.url) return nativeFetch(new Request(rewritten, input), init);
            }
            return nativeFetch(input, init);
          };

          const nativeOpen = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            return nativeOpen.call(this, method, rewriteApiUrl(url), ...rest);
          };
        })();
    """.trimIndent()
}

private fun randomUrlSafeString(byteCount: Int): String {
    val bytes = ByteArray(byteCount)
    SecureRandom().nextBytes(bytes)
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}

private fun String.urlEncoded(): String = URLEncoder.encode(this, Charsets.UTF_8.name())
    .replace("+", "%20")

private fun String?.queryParameters(): Map<String, String> {
    if (this.isNullOrBlank()) return emptyMap()
    val parameters = linkedMapOf<String, String>()
    split('&').forEach { part ->
        val name = part.substringBefore('=', missingDelimiterValue = part)
        if (name.isBlank()) return@forEach
        val value = part.substringAfter('=', missingDelimiterValue = "")
        val decodedName = URLDecoder.decode(name, Charsets.UTF_8.name())
        require(decodedName !in parameters) { "Duplicate callback parameter." }
        parameters[decodedName] = URLDecoder.decode(value, Charsets.UTF_8.name())
    }
    return parameters
}

const val WEB_LOGIN_CALLBACK_URI = "agents-anywhere://oauth/callback"
const val WEB_LOGIN_CLIENT_ID = "agents-anywhere-mobile"
private const val WEB_LOGIN_CALLBACK_SCHEME = "agents-anywhere"
private const val WEB_LOGIN_CALLBACK_HOST = "oauth"
private const val WEB_LOGIN_CALLBACK_PATH = "/callback"
