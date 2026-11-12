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

/**
 * Resolves [path] against [workspaceRoot] the way the Server does (relative
 * paths join the root, `.` and `..` collapse, Windows accepts `\` and `/`) and
 * returns the absolute path only when it stays inside the workspace. Paths
 * starting with `~` are rejected because the client cannot expand them.
 */
fun resolvePathInWorkspace(workspaceRoot: String, path: String): String? {
    val root = parseAbsoluteRemotePath(normalizeRemotePath(workspaceRoot).trim(), base = null) ?: return null
    val target = parseAbsoluteRemotePath(normalizeRemotePath(path).trim(), base = root) ?: return null
    val sameText: (String, String) -> Boolean = { a, b -> a.equals(b, ignoreCase = root.windows) }
    if (target.windows != root.windows || !sameText(target.prefix, root.prefix)) return null
    if (target.segments.size < root.segments.size) return null
    if (!root.segments.indices.all { sameText(target.segments[it], root.segments[it]) }) return null
    val separator = if (target.windows) "\\" else "/"
    return target.prefix.replace("/", separator) + target.segments.joinToString(separator)
}

private data class AbsoluteRemotePath(
    val windows: Boolean,
    // "/" on POSIX, "C:/" for a drive, "//" for a UNC share.
    val prefix: String,
    val segments: List<String>,
)

private fun parseAbsoluteRemotePath(raw: String, base: AbsoluteRemotePath?): AbsoluteRemotePath? {
    if (raw.isBlank() || raw.startsWith("~")) return null
    val windows = base?.windows ?: (windowsDriveRoot(raw) != null || raw.startsWith("\\\\") || raw.startsWith("//"))
    val value = if (windows) raw.replace('\\', '/') else raw
    val drive = Regex("^([A-Za-z]:)(/|$)").find(value)
    val (prefix, rest, inherited) = when {
        windows && value.startsWith("//") -> Triple("//", value.removePrefix("//"), emptyList())
        windows && drive != null -> Triple("${drive.groupValues[1].uppercase()}/", value.substring(drive.value.length), emptyList())
        // A drive-relative path such as `C:foo` depends on per-drive state the client cannot see.
        windows && Regex("^[A-Za-z]:").containsMatchIn(value) -> return null
        windows && value.startsWith("/") -> {
            val basePrefix = base?.prefix?.takeIf { it.endsWith(":/") } ?: return null
            Triple(basePrefix, value, emptyList())
        }
        !windows && value.startsWith("/") -> Triple("/", value, emptyList())
        base != null -> Triple(base.prefix, value, base.segments)
        else -> return null
    }
    val segments = ArrayDeque(inherited)
    rest.split('/').forEach { part ->
        when (part) {
            "", "." -> Unit
            ".." -> segments.removeLastOrNull() ?: return null
            else -> segments.addLast(part)
        }
    }
    return AbsoluteRemotePath(windows = windows, prefix = prefix, segments = segments.toList())
}
