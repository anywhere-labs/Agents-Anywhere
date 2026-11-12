package com.agentsanywhere.app.feature.files

/** How the file preview page renders a downloaded file. */
enum class FilePreviewKind {
    Pdf,
    Markdown,
    Html,
    Svg,
    Docx,
    Pptx,
    Xlsx,
    Csv,
    LegacyWord,
    LegacyPowerPoint,
    Image,
    Text,
    Unsupported,
}

/** Files above this size wait for an explicit tap before the preview downloads them. */
const val AUTO_PREVIEW_MAX_BYTES = 32L * 1024 * 1024

/** Text and Markdown previews render at most this many bytes. */
const val TEXT_PREVIEW_MAX_BYTES = 2L * 1024 * 1024

private val MarkdownExtensions = setOf("md", "markdown", "mdown", "mkd")
private val HtmlExtensions = setOf("html", "htm", "xhtml")
private val PreviewImageExtensions = setOf("png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "heif")
private val PlainTextExtensions = setOf("txt", "text", "log", "rst", "adoc", "tex")

/**
 * Source and configuration files keep opening in the session's code browser,
 * which has syntax highlighting and in-file search. Every other file with an
 * extension opens the file preview page.
 */
private val CodeBrowserExtensions = setOf(
    "bash", "bat", "c", "cc", "cfg", "cjs", "clj", "cmake", "cmd", "conf", "cpp", "cs", "css",
    "cxx", "dart", "diff", "dockerfile", "env", "erl", "ex", "exs", "fish", "go", "gradle",
    "graphql", "groovy", "h", "hh", "hpp", "hs", "ini", "ipynb", "java", "js", "json", "json5",
    "jsonc", "jsonl", "jsx", "kt", "kts", "less", "lock", "log", "lua", "m", "make", "mjs", "mk",
    "ml", "mm", "mts", "patch", "php", "pl", "properties", "proto", "ps1", "py", "pyi", "r", "rb",
    "rs", "sass", "scala", "scss", "sh", "sql", "svelte", "swift", "toml", "ts", "tsx", "vim",
    "vue", "xml", "yaml", "yml", "zsh",
)

private val KnownMimeTypes = mapOf(
    "pdf" to "application/pdf",
    "doc" to "application/msword",
    "dot" to "application/msword",
    "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "docm" to "application/vnd.ms-word.document.macroEnabled.12",
    "dotx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    "ppt" to "application/vnd.ms-powerpoint",
    "pps" to "application/vnd.ms-powerpoint",
    "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "ppsx" to "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
    "pptm" to "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
    "xls" to "application/vnd.ms-excel",
    "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xlsm" to "application/vnd.ms-excel.sheet.macroEnabled.12",
    "odt" to "application/vnd.oasis.opendocument.text",
    "ods" to "application/vnd.oasis.opendocument.spreadsheet",
    "odp" to "application/vnd.oasis.opendocument.presentation",
    "rtf" to "application/rtf",
    "epub" to "application/epub+zip",
    "csv" to "text/csv",
    "tsv" to "text/tab-separated-values",
    "html" to "text/html",
    "htm" to "text/html",
    "xhtml" to "application/xhtml+xml",
    "md" to "text/markdown",
    "markdown" to "text/markdown",
    "txt" to "text/plain",
    "log" to "text/plain",
    "json" to "application/json",
    "xml" to "text/xml",
    "svg" to "image/svg+xml",
    "png" to "image/png",
    "jpg" to "image/jpeg",
    "jpeg" to "image/jpeg",
    "gif" to "image/gif",
    "webp" to "image/webp",
    "bmp" to "image/bmp",
    "heic" to "image/heic",
    "heif" to "image/heif",
    "zip" to "application/zip",
    "mp3" to "audio/mpeg",
    "m4a" to "audio/mp4",
    "wav" to "audio/wav",
    "mp4" to "video/mp4",
    "mov" to "video/quicktime",
)

/** Lower-case extension of [name] without the dot, or an empty string. */
fun fileExtension(name: String): String {
    val fileName = name.substringAfterLast('/').substringAfterLast('\\')
    val dot = fileName.lastIndexOf('.')
    if (dot <= 0 || dot == fileName.lastIndex) return ""
    return fileName.substring(dot + 1).lowercase()
}

/**
 * Chooses the renderer by extension first: the Connector reports
 * `application/octet-stream` for formats its platform does not know, such as
 * Markdown on some Python builds.
 */
fun filePreviewKind(name: String, mediaType: String? = null): FilePreviewKind {
    val extension = fileExtension(name)
    when (extension) {
        "pdf" -> return FilePreviewKind.Pdf
        "docx", "docm", "dotx" -> return FilePreviewKind.Docx
        "pptx", "pptm", "ppsx" -> return FilePreviewKind.Pptx
        "xlsx", "xlsm" -> return FilePreviewKind.Xlsx
        "csv", "tsv" -> return FilePreviewKind.Csv
        "doc", "dot" -> return FilePreviewKind.LegacyWord
        "ppt", "pps" -> return FilePreviewKind.LegacyPowerPoint
        "svg" -> return FilePreviewKind.Svg
    }
    if (extension in MarkdownExtensions) return FilePreviewKind.Markdown
    if (extension in HtmlExtensions) return FilePreviewKind.Html
    if (extension in PreviewImageExtensions) return FilePreviewKind.Image
    if (extension in PlainTextExtensions || extension in CodeBrowserExtensions) return FilePreviewKind.Text
    val type = mediaType.orEmpty().substringBefore(';').trim().lowercase()
    return when {
        type == "application/pdf" -> FilePreviewKind.Pdf
        type == "text/markdown" -> FilePreviewKind.Markdown
        type == "text/html" -> FilePreviewKind.Html
        type.startsWith("image/") && type != "image/svg+xml" -> FilePreviewKind.Image
        type.startsWith("text/") || type == "application/json" -> FilePreviewKind.Text
        else -> FilePreviewKind.Unsupported
    }
}

/**
 * True when tapping a file reference in a session should open the file
 * preview page instead of the session's code browser.
 */
fun opensInFilePreview(path: String): Boolean {
    val extension = fileExtension(path.trimEnd('/', '\\'))
    return extension.isNotEmpty() && extension !in CodeBrowserExtensions
}

/**
 * MIME type used when handing a file to other apps or MediaStore. The
 * extension wins so the receiving app and the Downloads collection agree with
 * the file name; [platformMimeType] lets the caller consult Android's table.
 */
fun fileMimeType(
    name: String,
    serverMediaType: String? = null,
    platformMimeType: (String) -> String? = { null },
): String {
    val extension = fileExtension(name)
    if (extension.isNotEmpty()) {
        KnownMimeTypes[extension]?.let { return it }
        platformMimeType(extension)?.takeIf { it.isNotBlank() }?.let { return it }
    }
    val declared = serverMediaType.orEmpty().substringBefore(';').trim()
    return declared.ifBlank { "application/octet-stream" }
}

/**
 * MIME type for a MediaStore Downloads entry. MediaStore appends an extension
 * when the MIME type and the display name disagree (`app.log` becomes
 * `app.log.txt` for `text/plain`), so only the platform's own mapping is used
 * and unknown extensions fall back to `application/octet-stream`, which keeps
 * the original name.
 */
fun downloadsMimeType(name: String, platformMimeType: (String) -> String?): String {
    val extension = fileExtension(name)
    if (extension.isEmpty()) return "application/octet-stream"
    return platformMimeType(extension)?.takeIf { it.isNotBlank() } ?: "application/octet-stream"
}
