package com.agentsanywhere.app.feature.auth

import java.net.URI
import java.net.URLDecoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebLoginModelsTest {
    @Test
    fun authorizeUrlMatchesIosMobileOAuthContract() {
        val session = createWebLoginSession(
            serverUrl = "https://Example.COM/api/v2/",
            codeVerifier = RFC_7636_VERIFIER,
            state = "state value",
        )

        assertEquals("https://example.com", session.serverUrl)
        val uri = URI(session.authorizeUrl)
        assertEquals("https", uri.scheme)
        assertEquals("example.com", uri.host)
        assertEquals("/", uri.path)
        val fragment = uri.rawFragment
        assertTrue(fragment.startsWith("/mobile-oauth?"))
        val params = fragment.substringAfter('?').decodeQuery()
        assertEquals("code", params["response_type"])
        assertEquals(WEB_LOGIN_CLIENT_ID, params["client_id"])
        assertEquals(WEB_LOGIN_CALLBACK_URI, params["redirect_uri"])
        assertEquals(RFC_7636_CHALLENGE, params["code_challenge"])
        assertEquals("S256", params["code_challenge_method"])
        assertEquals("profile", params["scope"])
        assertEquals("state value", params["state"])
        assertFalse(session.authorizeUrl.contains(RFC_7636_VERIFIER))
    }

    @Test
    fun callbackRequiresExactUriStateAndCode() {
        val wrongScheme = newSession()
        assertTrue(
            parseWebLoginCallback("https://oauth/callback?state=expected&code=code", wrongScheme) is
                WebLoginCallback.Invalid,
        )
        val wrongHost = newSession()
        assertTrue(
            parseWebLoginCallback("agents-anywhere://other/callback?state=expected&code=code", wrongHost) is
                WebLoginCallback.Invalid,
        )
        val wrongPath = newSession()
        assertTrue(
            parseWebLoginCallback("agents-anywhere://oauth/other?state=expected&code=code", wrongPath) is
                WebLoginCallback.Invalid,
        )
        val wrongState = newSession()
        assertTrue(
            parseWebLoginCallback("agents-anywhere://oauth/callback?state=old&code=code", wrongState) is
                WebLoginCallback.Invalid,
        )
        val missingCode = newSession()
        assertTrue(
            parseWebLoginCallback("agents-anywhere://oauth/callback?state=expected", missingCode) is
                WebLoginCallback.Invalid,
        )
    }

    @Test
    fun callbackMapsSuccessCancellationAndServerError() {
        val success = parseWebLoginCallback(
            "agents-anywhere://oauth/callback?state=expected&code=authorization-code",
            newSession(),
        )
        assertEquals(WebLoginCallback.Success("authorization-code"), success)

        val cancelled = parseWebLoginCallback(
            "agents-anywhere://oauth/callback?state=expected&error=access_denied",
            newSession(),
        )
        assertEquals(WebLoginCallback.Error("Sign in was cancelled."), cancelled)

        val serverError = parseWebLoginCallback(
            "agents-anywhere://oauth/callback?state=expected&error=server_error&error_description=Try%20again",
            newSession(),
        )
        assertEquals(WebLoginCallback.Error("Try again"), serverError)
    }

    @Test
    fun callbackCanOnlyBeConsumedOnce() {
        val session = newSession()
        val callback = "agents-anywhere://oauth/callback?state=expected&code=authorization-code"

        assertTrue(parseWebLoginCallback(callback, session) is WebLoginCallback.Success)
        assertTrue(parseWebLoginCallback(callback, session) is WebLoginCallback.Invalid)
    }

    @Test
    fun callbackRejectsDuplicateOrMalformedParameters() {
        assertTrue(
            parseWebLoginCallback(
                "agents-anywhere://oauth/callback?state=old&state=expected&code=code",
                newSession(),
            ) is WebLoginCallback.Invalid,
        )
        assertTrue(
            parseWebLoginCallback(
                "agents-anywhere://oauth/callback?state=expected&code=%ZZ",
                newSession(),
            ) is WebLoginCallback.Invalid,
        )
    }

    @Test
    fun apiBridgePinsWebApiRequestsToConfirmedServerOrigin() {
        val script = webLoginApiOriginBridgeScript("http://10.0.2.2:5174/api/v2")

        assertTrue(script.contains("const serverOrigin = \"http://10.0.2.2:5174\""))
        assertTrue(script.contains("url.pathname.startsWith(\"/api/v2/\")"))
        assertTrue(script.contains("window.fetch"))
        assertTrue(script.contains("XMLHttpRequest.prototype.open"))
        assertTrue(script.contains("--agents-anywhere-android-viewport-height"))
        assertTrue(script.contains("window.visualViewport?.height || window.innerHeight"))
        assertFalse(script.contains("#/mobile-oauth"))
        assertFalse(script.contains(WEB_LOGIN_CALLBACK_URI))
    }

    private fun newSession() = createWebLoginSession(
        serverUrl = "http://192.168.1.10:8000",
        codeVerifier = RFC_7636_VERIFIER,
        state = "expected",
    )

    private fun String.decodeQuery(): Map<String, String> = split('&').associate { part ->
        URLDecoder.decode(part.substringBefore('='), Charsets.UTF_8.name()) to
            URLDecoder.decode(part.substringAfter('='), Charsets.UTF_8.name())
    }

    private companion object {
        const val RFC_7636_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        const val RFC_7636_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    }
}
