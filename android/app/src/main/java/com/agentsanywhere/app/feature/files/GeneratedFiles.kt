package com.agentsanywhere.app.feature.files

import org.commonmark.node.AbstractVisitor
import org.commonmark.node.Code
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.parser.Parser

/** Extensions an agent hands over as a deliverable: reports, decks, sheets, pages and archives. */
private val DeliverableExtensions = setOf(
    "pdf", "doc", "docx", "rtf", "odt", "pages",
    "ppt", "pptx", "pps", "ppsx", "odp", "key",
    "xls", "xlsx", "xlsm", "ods", "numbers", "csv", "tsv",
    "html", "htm", "epub", "zip",
)

private val referenceParser = Parser.builder().build()

/**
 * Files an agent message links to that look like documents it produced, in
 * order of first mention. Shown as tappable file cards under the message so
 * they are easy to open on a phone; source files and images are left to the
 * inline links and thumbnails.
 */
fun deliverableFileReferences(markdown: String, limit: Int = 4): List<String> {
    if (markdown.isBlank() || limit <= 0) return emptyList()
    val found = LinkedHashMap<String, String>()
    referenceParser.parse(normalizeSpacedLinkDestinations(markdown)).accept(object : AbstractVisitor() {
        override fun visit(link: Link) {
            sessionFileLinkPath(link.destination)?.let(::add)
            visitChildren(link)
        }

        override fun visit(code: Code) {
            inlineCodeFilePath(code.literal)?.let(::add)
        }

        // Paths inside code blocks are usually commands or examples, not results.
        override fun visit(fencedCodeBlock: FencedCodeBlock) = Unit

        override fun visit(indentedCodeBlock: IndentedCodeBlock) = Unit

        private fun add(path: String) {
            if (found.size >= limit || fileExtension(path) !in DeliverableExtensions) return
            val key = normalizeRemotePath(path).replace('\\', '/').lowercase()
            found.putIfAbsent(key, path)
        }
    })
    return found.values.toList()
}
