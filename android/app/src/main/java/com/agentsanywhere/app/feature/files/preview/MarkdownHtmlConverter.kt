package com.agentsanywhere.app.feature.files.preview

import com.agentsanywhere.app.feature.files.fileExtension
import com.agentsanywhere.app.feature.files.resolveDocumentLinkPath
import org.commonmark.ext.autolink.AutolinkExtension
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.ext.task.list.items.TaskListItemsExtension
import org.commonmark.node.Image
import org.commonmark.node.Link
import org.commonmark.parser.Parser
import org.commonmark.renderer.html.AttributeProvider
import org.commonmark.renderer.html.HtmlRenderer

/** Host the preview WebView intercepts; it never reaches the network. */
const val PREVIEW_HOST = "appassets.androidplatform.net"
const val PREVIEW_BASE_URL = "https://$PREVIEW_HOST/preview/"

/** `https://<preview host>/fs?path=...` serves an image from the work device. */
const val PREVIEW_FILE_PATH = "/fs"

/** `https://<preview host>/open?path=...` opens another work-device file in the preview. */
const val PREVIEW_OPEN_PATH = "/open"

private val ImageExtensions = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "svg")

private val extensions = listOf(
    AutolinkExtension.create(),
    StrikethroughExtension.create(),
    TablesExtension.create(),
    TaskListItemsExtension.create(),
)

private val markdownParser = Parser.builder().extensions(extensions).build()

/**
 * Renders a Markdown document as a preview page. Images and links that point
 * at files on the work device are rewritten to preview-host URLs so the
 * viewer can fetch the images and open linked files in place. Raw HTML in
 * the document is kept; the viewer runs with JavaScript disabled.
 */
object MarkdownHtmlConverter {
    fun convert(markdown: String, documentPath: String, darkCanvas: Boolean = false): String {
        val renderer = HtmlRenderer.builder()
            .extensions(extensions)
            .sanitizeUrls(true)
            .attributeProviderFactory { _ -> WorkDeviceLinkAttributes(documentPath) }
            .build()
        val (frontMatter, content) = splitFrontMatter(markdown)
        val body = renderer.render(markdownParser.parse(content))
        return previewHtmlPage("<article class=\"page markdown\">${frontMatterTable(frontMatter)}$body</article>", darkCanvas)
    }
}

private val FrontMatterRegex = Regex(
    "^\\uFEFF?---[ \\t]*\\r?\\n(.*?)\\r?\\n(?:---|\\.\\.\\.)[ \\t]*(?:\\r?\\n|$)",
    RegexOption.DOT_MATCHES_ALL,
)
private val FrontMatterLineRegex = Regex("^([A-Za-z0-9_\\-\\u4e00-\\u9fff ]+):\\s*(.*)$")

/**
 * Splits YAML front matter (`---` ... `---`) off the top of a document so it
 * shows as a small key/value table, like GitHub does, instead of a heading.
 */
internal fun splitFrontMatter(markdown: String): Pair<List<Pair<String, String>>, String> {
    val match = FrontMatterRegex.find(markdown) ?: return emptyList<Pair<String, String>>() to markdown
    val lines = match.groupValues[1].lines().filter { it.isNotBlank() }
    val topLevel = lines.filter { !it.startsWith(" ") && !it.startsWith("\t") && !it.startsWith("-") }
    val entries = topLevel.mapNotNull { line ->
        FrontMatterLineRegex.matchEntire(line.trimEnd())?.let { it.groupValues[1].trim() to it.groupValues[2].trim().trim('"', '\'') }
    }
    // Only treat it as front matter when every top-level line reads like `key: value`.
    if (entries.isEmpty() || entries.size != topLevel.size) return emptyList<Pair<String, String>>() to markdown
    return entries to markdown.substring(match.range.last + 1)
}

private fun frontMatterTable(entries: List<Pair<String, String>>): String {
    if (entries.isEmpty()) return ""
    return buildString {
        append("<table class=\"front-matter\">")
        entries.forEach { (key, value) ->
            append("<tr><th>").append(key.htmlEscape()).append("</th><td>").append(value.htmlEscape()).append("</td></tr>")
        }
        append("</table>")
    }
}

private class WorkDeviceLinkAttributes(private val documentPath: String) : AttributeProvider {
    override fun setAttributes(node: org.commonmark.node.Node, tagName: String, attributes: MutableMap<String, String>) {
        when (node) {
            is Image -> {
                val source = attributes["src"].orEmpty()
                if (node.destination.trim().lowercase().startsWith("data:image/")) {
                    attributes["src"] = node.destination.trim()
                } else if (!isWebUrl(source)) {
                    val path = resolveDocumentLinkPath(documentPath, node.destination)
                    attributes["src"] = if (path != null && fileExtension(path) in ImageExtensions) {
                        previewUrl(PREVIEW_FILE_PATH, path)
                    } else {
                        ""
                    }
                }
                attributes["loading"] = "lazy"
            }
            is Link -> {
                val href = attributes["href"].orEmpty()
                if (!isWebUrl(href) && !href.startsWith("#")) {
                    val path = resolveDocumentLinkPath(documentPath, node.destination)
                    if (path != null) attributes["href"] = previewUrl(PREVIEW_OPEN_PATH, path)
                }
            }
        }
    }
}

private fun isWebUrl(value: String): Boolean {
    val lower = value.trim().lowercase()
    return lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:")
}

internal fun previewUrl(endpoint: String, path: String): String {
    val encoded = java.net.URLEncoder.encode(path, "UTF-8").replace("+", "%20")
    return "https://$PREVIEW_HOST$endpoint?path=$encoded"
}
