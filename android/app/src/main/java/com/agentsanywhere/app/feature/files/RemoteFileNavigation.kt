package com.agentsanywhere.app.feature.files

data class RemoteFileRequest(
    val root: String,
    val path: String,
)

fun isWindowsDeviceOs(deviceOs: String?): Boolean {
    return deviceOs.equals("windows", ignoreCase = true)
}

fun initialRemoteFilePath(deviceOs: String?): String {
    return if (isWindowsDeviceOs(deviceOs)) "" else "."
}

fun remoteFileRequest(
    targetPath: String,
    deviceOs: String?,
    fallbackRoot: String?,
): RemoteFileRequest {
    val normalizedPath = normalizeRemotePath(targetPath)
    val rootFallback = fallbackRoot?.takeIf { it.isNotBlank() } ?: "~"
    if (isWindowsDeviceOs(deviceOs) && normalizedPath.isBlank()) {
        return RemoteFileRequest(root = rootFallback, path = "")
    }

    val root = if (isWindowsDeviceOs(deviceOs)) {
        windowsDriveRoot(normalizedPath) ?: rootFallback
    } else {
        rootFallback
    }
    return RemoteFileRequest(
        root = root,
        path = normalizedPath.ifBlank { "." },
    )
}

fun remoteRootForPath(
    targetPath: String,
    deviceOs: String?,
    fallbackRoot: String?,
): String {
    return remoteFileRequest(
        targetPath = targetPath,
        deviceOs = deviceOs,
        fallbackRoot = fallbackRoot,
    ).root
}

fun canonicalRemoteDirectoryPath(
    request: RemoteFileRequest,
    returnedPath: String,
    deviceOs: String?,
): String {
    val requested = normalizeRemotePath(request.path).trim()
    val returned = normalizeRemotePath(returnedPath).trim()
    if (isWindowsDeviceOs(deviceOs)) {
        if (requested.isBlank()) return ""
        return canonicalWindowsPath(
            if (returned.isBlank() || returned == ".") requested else returned,
        )
    }

    if (requested == "/") return "/"
    if (requested.startsWith("/") && (returned.isBlank() || returned == ".")) return requested
    if (returned.isBlank()) return requested.ifBlank { "." }
    if (returned == "." && requested != ".") return requested
    return returned
}

fun remoteParentPath(
    rawPath: String,
    deviceOs: String?,
    allowWindowsDriveOverview: Boolean = true,
): String? {
    val normalized = normalizeRemotePath(rawPath).trim()
    if (normalized.isBlank()) return null
    return if (isWindowsDeviceOs(deviceOs)) {
        windowsParentPath(normalized, allowWindowsDriveOverview)
    } else {
        posixParentPath(normalized)
    }
}

fun isWindowsDriveOverview(
    rawPath: String,
    deviceOs: String?,
): Boolean {
    return isWindowsDeviceOs(deviceOs) && normalizeRemotePath(rawPath).trim().isBlank()
}

fun isSelectableRemoteDirectory(
    rawPath: String,
    deviceOs: String?,
): Boolean {
    return normalizeRemotePath(rawPath).trim().isNotBlank() &&
        !isWindowsDriveOverview(rawPath, deviceOs)
}

fun displayRemotePath(
    root: String?,
    rawPath: String,
    deviceOs: String?,
    windowsDriveOverviewLabel: String = ".",
): String {
    if (isWindowsDriveOverview(rawPath, deviceOs)) return windowsDriveOverviewLabel
    val base = root.orEmpty().trim().trimEnd('/', '\\')
    val path = normalizeRemotePath(rawPath).trim().replace('\\', '/')
    if (path.isBlank() || path == ".") return base.ifBlank { "." }
    if (path == "/") return "/"
    if (path.startsWith("/") || Regex("^[A-Za-z]:/.*").matches(path)) return path
    return if (base.isBlank()) path else "$base/${path.trimStart('/')}"
}

fun fileNameFromRemotePath(rawPath: String): String {
    val normalized = normalizeRemotePath(rawPath).trim().trimEnd('/', '\\').replace('\\', '/')
    return normalized.substringAfterLast('/').ifBlank { normalized.ifBlank { "Untitled" } }
}

fun FilesDirectory.normalizedRemotePaths(): FilesDirectory {
    return copy(
        path = normalizeRemotePath(path),
        entries = entries.map { entry -> entry.copy(path = normalizeRemotePath(entry.path)) },
    )
}

fun FilesDirectory.canonicalRemotePaths(
    request: RemoteFileRequest,
    deviceOs: String?,
): FilesDirectory {
    return normalizedRemotePaths().copy(
        path = canonicalRemoteDirectoryPath(
            request = request,
            returnedPath = path,
            deviceOs = deviceOs,
        ),
    )
}

fun normalizeRemotePath(rawPath: String): String {
    return rawPath.replace(Regex("^/([A-Za-z]:)(?=$|[\\\\/])"), "$1")
}

fun windowsDriveRoot(rawPath: String): String? {
    val normalized = normalizeRemotePath(rawPath).trim()
    val match = Regex("^([A-Za-z]:)(?:[\\\\/].*)?$").find(normalized) ?: return null
    return "${match.groupValues[1]}\\"
}

private fun canonicalWindowsPath(rawPath: String): String {
    val normalized = normalizeRemotePath(rawPath).trim().replace('/', '\\')
    val drive = Regex("^([A-Za-z]:)\\\\?$").matchEntire(normalized)
    if (drive != null) return "${drive.groupValues[1]}\\"
    return normalized
}

private fun posixParentPath(rawPath: String): String? {
    val clean = rawPath.trim().trimEnd('/').ifBlank { "." }
    if (clean == "." || clean == "/" || clean == "~") return null
    val slash = clean.lastIndexOf("/")
    return when {
        slash < 0 -> "."
        slash == 0 -> "/"
        else -> clean.take(slash)
    }
}

private fun windowsParentPath(
    rawPath: String,
    allowDriveOverview: Boolean,
): String? {
    val clean = rawPath.replace('\\', '/').trimEnd('/').ifBlank { "." }
    if (clean == "." || clean == "~") return null
    if (Regex("^[A-Za-z]:$").matches(clean)) {
        return if (allowDriveOverview) "" else null
    }
    if (!Regex("^[A-Za-z]:/").containsMatchIn(clean)) {
        return posixParentPath(clean)?.replace('/', '\\')
    }

    val slash = clean.lastIndexOf("/")
    return when {
        slash < 0 -> null
        slash == 2 -> "${clean.take(2)}\\"
        else -> clean.take(slash).replace('/', '\\')
    }
}
