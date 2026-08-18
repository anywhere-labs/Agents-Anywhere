package com.agentsanywhere.app.api

import java.net.URI
import java.util.concurrent.ConcurrentHashMap

private const val API_NAMESPACE = "/api/v2"

private enum class ApiRouteStyle {
    Namespaced,
    Legacy,
}

private val apiRouteStyles = ConcurrentHashMap<String, ApiRouteStyle>()

internal fun apiPath(path: String): String {
    val normalized = if (path.startsWith("/")) path else "/$path"
    val pathEnd = normalized.indexOfFirst { it == '?' || it == '#' }
        .takeIf { it >= 0 }
        ?: normalized.length
    val pathname = normalized.substring(0, pathEnd)
    return if (pathname == API_NAMESPACE || pathname.startsWith("$API_NAMESPACE/")) {
        normalized
    } else {
        "$API_NAMESPACE$normalized"
    }
}

internal fun apiUrl(serverUrl: String, path: String): String {
    val origin = requireNotNull(normalizeServerOrigin(serverUrl)) {
        "Server URL must be an HTTP(S) origin."
    }
    return when (apiRouteStyles[origin]) {
        ApiRouteStyle.Legacy -> "$origin${legacyApiPath(path)}"
        else -> "$origin${apiPath(path)}"
    }
}

internal fun apiUrlCandidates(serverUrl: String, path: String): List<String> {
    val origin = requireNotNull(normalizeServerOrigin(serverUrl)) {
        "Server URL must be an HTTP(S) origin."
    }
    return when (apiRouteStyles[origin]) {
        ApiRouteStyle.Namespaced -> listOf("$origin${apiPath(path)}")
        ApiRouteStyle.Legacy -> listOf("$origin${legacyApiPath(path)}")
        null -> listOf(
            "$origin${apiPath(path)}",
            "$origin${legacyApiPath(path)}",
        )
    }
}

internal fun rememberApiUrl(serverUrl: String, resolvedUrl: String) {
    val origin = normalizeServerOrigin(serverUrl) ?: return
    val resolvedPath = runCatching { URI(resolvedUrl).rawPath.orEmpty() }.getOrDefault("")
    apiRouteStyles[origin] = if (
        resolvedPath == API_NAMESPACE || resolvedPath.startsWith("$API_NAMESPACE/")
    ) {
        ApiRouteStyle.Namespaced
    } else {
        ApiRouteStyle.Legacy
    }
}

internal fun usesLegacyApiRoute(serverUrl: String): Boolean {
    val origin = normalizeServerOrigin(serverUrl) ?: return false
    return apiRouteStyles[origin] == ApiRouteStyle.Legacy
}

internal fun webSocketApiUrl(serverUrl: String, path: String): String {
    val httpUrl = apiUrl(serverUrl, path)
    return when {
        httpUrl.startsWith("https://") -> "wss://${httpUrl.removePrefix("https://")}"
        else -> "ws://${httpUrl.removePrefix("http://")}"
    }
}

internal fun normalizeServerOrigin(serverUrl: String): String? {
    val trimmed = serverUrl.trim().trimEnd('/')
    if (trimmed.isBlank()) return null

    val candidate = if (trimmed.contains("://")) {
        trimmed
    } else {
        val host = trimmed.substringBefore('/').substringBefore(':').lowercase()
        if (host.isBlank()) return null
        val scheme = if (usesLocalNetworkHost(host) || trimmed.substringBefore('/').contains(':')) {
            "http"
        } else {
            "https"
        }
        "$scheme://$trimmed"
    }

    val parsed = runCatching { URI(candidate) }.getOrNull() ?: return null
    val scheme = parsed.scheme?.lowercase()
    if (scheme != "http" && scheme != "https") return null
    if (parsed.rawUserInfo != null || parsed.rawQuery != null || parsed.rawFragment != null) return null

    val host = parsed.host?.lowercase()?.takeIf { it.isNotBlank() } ?: return null
    val path = parsed.rawPath.orEmpty().trimEnd('/')
    if (path.isNotEmpty() && path != API_NAMESPACE) return null

    return runCatching {
        URI(scheme, null, host, parsed.port, null, null, null).toString().trimEnd('/')
    }.getOrNull()
}

private fun legacyApiPath(path: String): String {
    val normalized = if (path.startsWith("/")) path else "/$path"
    return when {
        normalized == API_NAMESPACE -> "/"
        normalized.startsWith("$API_NAMESPACE/") -> normalized.removePrefix(API_NAMESPACE)
        else -> normalized
    }
}

private fun usesLocalNetworkHost(host: String): Boolean {
    if (host == "localhost" || host.endsWith(".local")) return true
    val parts = host.split('.')
    if (parts.size != 4) return false
    val octets = parts.map { it.toIntOrNull() ?: return false }
    return when {
        octets.any { it !in 0..255 } -> false
        octets[0] == 10 -> true
        octets[0] == 127 -> true
        octets[0] == 192 && octets[1] == 168 -> true
        octets[0] == 172 && octets[1] in 16..31 -> true
        else -> false
    }
}
