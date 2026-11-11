package com.agentsanywhere.app.feature.files

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

private val UriSchemeRegex = Regex("^([A-Za-z][A-Za-z0-9+.-]+):")
private val PercentEscapeRegex = Regex("%[0-9A-Fa-f]{2}")
private val LineAnchorRegex = Regex("#L\\d+(?:C\\d+)?(?:-L?\\d+(?:C\\d+)?)?$")
private val LineSuffixRegex = Regex(":\\d+(?:-\\d+)?(?::\\d+)?$")
private val PathRootRegex = Regex("^(?:/|~[/\\\\]|\\.{1,2}[/\\\\]|[A-Za-z]:[/\\\\]|\\\\\\\\)")
private val ShellSyntaxRegex = Regex("[|&;<>`*?\"]|\\$\\(|(?:^|\\s)-{1,2}[A-Za-z]")
private val ExtensionRegex = Regex("^[a-z0-9]+$")

/** First words that turn `open report.pdf` into a command rather than a file name. */
private val CommandWords = setOf(
    "bash", "cat", "cd", "code", "cp", "echo", "explorer", "git", "head", "less", "libreoffice",
    "ls", "more", "mv", "nano", "node", "npm", "npx", "open", "pandoc", "pnpm", "python",
    "python3", "rm", "sh", "soffice", "start", "tail", "touch", "type", "vi", "vim",
    "xdg-open", "yarn", "zsh",
)

/**
 * Extensions an agent typically means as a generated file even without a
 * directory, e.g. `报告.pdf`. Bare code names such as `console.log` or
 * `index.ts` stay plain inline code.
 */
private val StandaloneFileExtensions = setOf(
    "pdf", "doc", "docx", "docm", "dot", "dotx", "rtf", "odt", "pages",
    "ppt", "pptx", "pptm", "pps", "ppsx", "odp", "key",
    "xls", "xlsx", "xlsm", "ods", "numbers", "csv", "tsv",
    "html", "htm", "xhtml", "md", "markdown", "txt", "epub",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "svg",
    "zip", "mp3", "mp4", "mov", "wav", "m4a",
)

/**
 * Turns a Markdown link destination from an agent message into a path on the
 * work device, or returns null when the destination is a web URL, an anchor or
 * another URI scheme.
 *
 * Accepts absolute, workspace-relative and `~` paths, `file://` URIs, percent
 * encoded paths (`My%20Docs/%E6%8A%A5%E5%91%8A.pdf`), angle-bracket
 * destinations and the `:12`, `:12:3` and `#L12` line suffixes agents append.
 */
fun sessionFileLinkPath(destination: String): String? {
    var value = destination.trim()
    if (value.length >= 2 && value.startsWith("<") && value.endsWith(">")) {
        value = value.substring(1, value.length - 1).trim()
    }
    if (value.isBlank() || value.startsWith("#") || value.startsWith("//")) return null
    val scheme = UriSchemeRegex.find(value)?.groupValues?.get(1)
    if (scheme != null) {
        if (!scheme.equals("file", ignoreCase = true)) return null
        return fileUriPath(value.substring(scheme.length + 1))
    }
    value = value.replace(LineAnchorRegex, "")
    value = decodePercentEscapes(value) ?: value
    return cleanFilePath(value)
}

/**
 * Returns the path an inline code span such as `` `docs/报告 终稿.pdf:3` ``
 * refers to, or null when the code is not a file reference.
 *
 * Code with a directory separator and an extension keeps working as before.
 * Bare names and paths containing spaces only count as files when they end
 * with a document, image or media extension and contain no shell syntax, so
 * commands like `ls -la out/report.pdf` stay plain code.
 */
fun inlineCodeFilePath(code: String): String? {
    val text = code.trim()
    if (text.isBlank()) return null
    if (text.startsWith("file:", ignoreCase = true)) return sessionFileLinkPath(text)
    if (text.contains("://") || text.contains('\n')) return null
    val candidate = text.replace(LineSuffixRegex, "")
    val name = candidate.substringAfterLast('/').substringAfterLast('\\')
    val extension = name.substringAfterLast('.', "").lowercase()
    if (extension.isBlank() || name.substringBeforeLast('.').isBlank()) return null
    if (!ExtensionRegex.matches(extension)) return null
    val hasSeparator = candidate.contains('/') || candidate.contains('\\')
    val hasWhitespace = candidate.any(Char::isWhitespace)
    if (hasWhitespace || !hasSeparator) {
        if (extension !in StandaloneFileExtensions) return null
        if (ShellSyntaxRegex.containsMatchIn(candidate)) return null
        if (hasWhitespace && candidate.substringBefore(' ').lowercase() in CommandWords) return null
        val firstSegment = candidate.substringBefore('/').substringBefore('\\')
        if (hasWhitespace && hasSeparator && !PathRootRegex.containsMatchIn(candidate) &&
            firstSegment.any(Char::isWhitespace)
        ) {
            // `open out/a.pdf`: the first word reads like a command, not a folder.
            return null
        }
    }
    return cleanFilePath(candidate)
}

private val SpacedFileDestinationRegex = Regex(
    "\\]\\((?!<)([^()<>\"\\n]*?\\s[^()<>\"\\n]*?\\.[A-Za-z0-9]{1,8}(?::\\d+(?:[-:]\\d+)*)?(?:#L\\d+[^()\\s]*)?)\\)",
)
private val FenceRegex = Regex("^\\s{0,3}(`{3,}|~{3,})")

/**
 * CommonMark only allows spaces in a link destination inside `<...>`, but
 * agents often write `[报告](out/季度 报告.pdf)`. Wraps such destinations in
 * angle brackets when they end with a file extension, outside code blocks and
 * inline code, so they still render as file links.
 */
fun normalizeSpacedLinkDestinations(markdown: String): String {
    if (!markdown.contains("](")) return markdown
    val output = StringBuilder(markdown.length + 16)
    var fence: String? = null
    markdown.split('\n').forEachIndexed { index, line ->
        if (index > 0) output.append('\n')
        val marker = FenceRegex.find(line)?.groupValues?.get(1)
        val open = fence
        when {
            open != null -> {
                output.append(line)
                if (marker != null && marker[0] == open[0] && marker.length >= open.length) fence = null
            }
            marker != null -> {
                fence = marker
                output.append(line)
            }
            else -> output.append(wrapOutsideInlineCode(line))
        }
    }
    return output.toString()
}

private fun wrapOutsideInlineCode(line: String): String {
    if (!line.contains("](")) return line
    val output = StringBuilder(line.length + 8)
    var index = 0
    var plainStart = 0
    while (index < line.length) {
        if (line[index] != '`') {
            index += 1
            continue
        }
        var runEnd = index
        while (runEnd < line.length && line[runEnd] == '`') runEnd += 1
        val run = line.substring(index, runEnd)
        val close = Regex("(?<!`)${Regex.escape(run)}(?!`)").find(line, runEnd)
        if (close == null) {
            index = runEnd
            continue
        }
        output.append(wrapSpacedDestinations(line.substring(plainStart, index)))
        output.append(line, index, close.range.last + 1)
        index = close.range.last + 1
        plainStart = index
    }
    output.append(wrapSpacedDestinations(line.substring(plainStart)))
    return output.toString()
}

private fun wrapSpacedDestinations(text: String): String {
    return SpacedFileDestinationRegex.replace(text) { match ->
        val destination = match.groupValues[1].trim()
        val scheme = UriSchemeRegex.find(destination)?.groupValues?.get(1)
        if (scheme != null && !scheme.equals("file", ignoreCase = true)) match.value else "](<$destination>)"
    }
}

/**
 * Resolves a link found inside a document (Markdown image or link) against
 * the document's own path on the work device. Absolute and `~` paths are
 * returned unchanged; `.` and `..` segments collapse.
 */
fun resolveDocumentLinkPath(documentPath: String, link: String): String? {
    val path = sessionFileLinkPath(link) ?: return null
    val windows = windowsDriveRoot(documentPath) != null || documentPath.startsWith("\\\\")
    if (path.startsWith("/") || path.startsWith("~") || windowsDriveRoot(path) != null || path.startsWith("\\\\")) {
        return path
    }
    val separator = if (windows) '\\' else '/'
    val normalizedDocument = if (windows) documentPath.replace('/', '\\') else documentPath
    val directory = normalizedDocument.substringBeforeLast(separator, "")
    if (directory.isEmpty()) return path
    val segments = ArrayDeque(directory.split(separator))
    path.replace('\\', '/').split('/').forEach { segment ->
        when (segment) {
            "", "." -> Unit
            ".." -> if (segments.size > 1) segments.removeLast()
            else -> segments.addLast(segment)
        }
    }
    return segments.joinToString(separator.toString())
}

private fun fileUriPath(afterScheme: String): String? {
    // URIs percent-encode a literal `#` or `?`, so both start a suffix here.
    val rest = afterScheme.substringBefore('?').substringBefore('#')
    val path = if (rest.startsWith("//")) {
        val authorityEnd = rest.indexOf('/', startIndex = 2)
        val authority = if (authorityEnd < 0) rest.substring(2) else rest.substring(2, authorityEnd)
        val remainder = if (authorityEnd < 0) "" else rest.substring(authorityEnd)
        if (authority.isEmpty() || authority.equals("localhost", ignoreCase = true)) {
            remainder
        } else {
            // file://server/share/report.pdf is a Windows UNC path.
            "//$authority$remainder"
        }
    } else {
        rest
    }
    return cleanFilePath(decodePercentEscapes(path) ?: path)
}

private fun cleanFilePath(raw: String): String? {
    val withoutLine = raw.trim().replace(LineSuffixRegex, "")
    return normalizeRemotePath(withoutLine).trim().takeIf { it.isNotBlank() }
}

/**
 * Decodes `%XX` escapes as UTF-8. Returns null when the text has no escapes or
 * the bytes are not valid UTF-8, in which case the caller keeps the raw text:
 * a file may legitimately be named `100%.md`.
 */
internal fun decodePercentEscapes(value: String): String? {
    if (!PercentEscapeRegex.containsMatchIn(value)) return null
    val bytes = ByteArrayOutputStream(value.length)
    var index = 0
    while (index < value.length) {
        val char = value[index]
        if (char == '%' && index + 2 <= value.lastIndex &&
            value[index + 1].isHexDigit() && value[index + 2].isHexDigit()
        ) {
            bytes.write(value.substring(index + 1, index + 3).toInt(16))
            index += 3
            continue
        }
        val end = if (char.isHighSurrogate() && index + 1 < value.length) index + 2 else index + 1
        bytes.write(value.substring(index, end).toByteArray(Charsets.UTF_8))
        index = end
    }
    val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
    return try {
        decoder.decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
    } catch (_: CharacterCodingException) {
        null
    }
}

private fun Char.isHexDigit(): Boolean = this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'
