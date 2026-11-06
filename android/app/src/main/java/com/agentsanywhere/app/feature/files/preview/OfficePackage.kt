package com.agentsanywhere.app.feature.files.preview

import org.w3c.dom.Document
import org.w3c.dom.Element
import org.w3c.dom.Node
import java.io.ByteArrayInputStream
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.util.zip.ZipFile
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory

internal const val MAX_XML_PART_BYTES = 48L * 1024 * 1024
internal const val MAX_MEDIA_PART_BYTES = 24L * 1024 * 1024

/** Raised when a file cannot be turned into a preview; the message is shown as-is. */
class PreviewUnavailableException(message: String) : IOException(message)

/**
 * HTML produced for an Office document. [media] maps the relative URLs used in
 * [html] to entries of the source ZIP package, which the viewer serves on
 * demand instead of inlining them as base64.
 */
data class OfficeHtml(
    val html: String,
    val media: Map<String, String> = emptyMap(),
)

/** Localized strings the converters place into generated HTML. */
data class PreviewLabels(
    val slide: (Int) -> String = { "Slide $it" },
    val chart: String = "Chart",
    val emptyDocument: String = "This document has no content to show.",
    val textOnlyNotice: String = "Text-only preview. Layout may differ from the original file.",
    val simplifiedNotice: String = "Simplified preview. Open the file in another app for full formatting.",
    val rowsTruncated: (Int) -> String = { "Showing the first $it rows." },
    val columnsTruncated: (Int) -> String = { "Showing the first $it columns." },
)

internal data class Relationship(
    val id: String,
    val type: String,
    val target: String,
    val external: Boolean,
)

/** Read-only view of an OOXML ZIP package with size limits on every part. */
internal class OfficePackage(file: File) : Closeable {
    private val zip = try {
        ZipFile(file)
    } catch (error: IOException) {
        throw PreviewUnavailableException("The file is damaged or not a valid Office document.")
    }

    fun has(name: String): Boolean = zip.getEntry(name) != null

    fun readBytes(name: String, limit: Long): ByteArray? {
        val entry = zip.getEntry(name) ?: return null
        if (entry.size > limit) throw PreviewUnavailableException("The document is too large to preview.")
        return zip.getInputStream(entry).use { input ->
            val output = java.io.ByteArrayOutputStream(entry.size.coerceIn(0, 1L shl 20).toInt())
            val buffer = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                if (total > limit) throw PreviewUnavailableException("The document is too large to preview.")
                output.write(buffer, 0, read)
            }
            output.toByteArray()
        }
    }

    fun xml(name: String): Element? {
        val bytes = readBytes(name, MAX_XML_PART_BYTES) ?: return null
        return parseXml(bytes).documentElement
    }

    fun relationships(partName: String): Map<String, Relationship> {
        val directory = partName.substringBeforeLast('/', "")
        val relsName = if (directory.isEmpty()) {
            "_rels/${partName}.rels"
        } else {
            "$directory/_rels/${partName.substringAfterLast('/')}.rels"
        }
        val root = xml(relsName) ?: return emptyMap()
        return root.childElements("Relationship").mapNotNull { element ->
            val id = element.getAttribute("Id").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val target = element.getAttribute("Target")
            val external = element.getAttribute("TargetMode").equals("External", ignoreCase = true)
            Relationship(
                id = id,
                type = element.getAttribute("Type"),
                target = if (external) target else resolvePartTarget(partName, target),
                external = external,
            )
        }.associateBy { it.id }
    }

    override fun close() {
        zip.close()
    }
}

/** Resolves a relationship target relative to the part that declares it. */
internal fun resolvePartTarget(sourcePart: String, target: String): String {
    if (target.startsWith("/")) return target.trimStart('/')
    val segments = sourcePart.substringBeforeLast('/', "").split('/').filter { it.isNotEmpty() }.toMutableList()
    target.split('/').forEach { segment ->
        when (segment) {
            "", "." -> Unit
            ".." -> segments.removeLastOrNull()
            else -> segments.add(segment)
        }
    }
    return segments.joinToString("/")
}

internal fun parseXml(bytes: ByteArray): Document {
    val factory = DocumentBuilderFactory.newInstance().apply {
        isNamespaceAware = true
        isExpandEntityReferences = false
        isIgnoringComments = true
        runCatching { setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true) }
        runCatching { setFeature("http://apache.org/xml/features/disallow-doctype-decl", true) }
        runCatching { setFeature("http://xml.org/sax/features/external-general-entities", false) }
        runCatching { setFeature("http://xml.org/sax/features/external-parameter-entities", false) }
    }
    return try {
        factory.newDocumentBuilder().parse(ByteArrayInputStream(bytes))
    } catch (error: Exception) {
        throw PreviewUnavailableException("The file is damaged or not a valid Office document.")
    }
}

internal val Node.localNameOrName: String
    get() = localName ?: nodeName.substringAfter(':')

internal fun Element.childElements(localName: String? = null): List<Element> {
    val result = ArrayList<Element>()
    var node = firstChild
    while (node != null) {
        if (node is Element && (localName == null || node.localNameOrName == localName)) result.add(node)
        node = node.nextSibling
    }
    return result
}

internal fun Element.child(localName: String): Element? {
    var node = firstChild
    while (node != null) {
        if (node is Element && node.localNameOrName == localName) return node
        node = node.nextSibling
    }
    return null
}

internal fun Element.descendants(localName: String): List<Element> {
    val nodes = getElementsByTagNameNS("*", localName)
    return List(nodes.length) { nodes.item(it) as Element }
}

internal fun Element.hasAncestor(localName: String, stopAt: Element): Boolean {
    var node = parentNode
    while (node != null && node !== stopAt) {
        if (node is Element && node.localNameOrName == localName) return true
        node = node.parentNode
    }
    return false
}

/** Attribute value by local name in any namespace, or null when missing. */
internal fun Element.attr(localName: String): String? {
    val attributes = attributes ?: return null
    for (index in 0 until attributes.length) {
        val attribute = attributes.item(index)
        if (attribute.localNameOrName == localName) return attribute.nodeValue
    }
    return null
}

/**
 * Relationship reference such as `r:id` or `r:embed`. Elements like
 * `p:sldId` also carry a plain `id`, so the namespace has to match.
 */
internal fun Element.relAttr(localName: String): String? {
    val attributes = attributes ?: return null
    for (index in 0 until attributes.length) {
        val attribute = attributes.item(index)
        if (attribute.localNameOrName == localName && attribute.namespaceURI?.contains("relationships") == true) {
            return attribute.nodeValue
        }
    }
    return null
}

/** Office booleans (`w:b`, `a:rPr b="1"`) are true unless explicitly 0/false/off. */
internal fun Element?.isOn(): Boolean {
    if (this == null) return false
    val value = attr("val") ?: return true
    return value != "0" && !value.equals("false", ignoreCase = true) && !value.equals("off", ignoreCase = true)
}

internal fun String.htmlEscape(): String {
    val builder = StringBuilder(length + 16)
    forEach { char ->
        when (char) {
            '&' -> builder.append("&amp;")
            '<' -> builder.append("&lt;")
            '>' -> builder.append("&gt;")
            '"' -> builder.append("&quot;")
            '\'' -> builder.append("&#39;")
            else -> builder.append(char)
        }
    }
    return builder.toString()
}

/** Only web and mail links become clickable in generated previews. */
internal fun safeHref(target: String): String? {
    val trimmed = target.trim()
    val lower = trimmed.lowercase()
    return trimmed.takeIf { lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("mailto:") }
}

internal fun imageMimeType(entryName: String): String? {
    return when (entryName.substringAfterLast('.', "").lowercase()) {
        "png" -> "image/png"
        "jpg", "jpeg", "jpe" -> "image/jpeg"
        "gif" -> "image/gif"
        "bmp", "dib" -> "image/bmp"
        "webp" -> "image/webp"
        "svg" -> "image/svg+xml"
        "tif", "tiff" -> "image/tiff"
        else -> null
    }
}

/** Collects the media entries a document references and hands out stable URLs for them. */
internal class MediaRegistry {
    private val urls = LinkedHashMap<String, String>()

    fun urlFor(entryName: String): String? {
        imageMimeType(entryName) ?: return null
        return urls.getOrPut(entryName) {
            val extension = entryName.substringAfterLast('.', "bin").lowercase()
            "media/${urls.size}.$extension"
        }
    }

    fun toMap(): Map<String, String> = urls.entries.associate { (entry, url) -> url to entry }
}

/** 1 px at 96 dpi, the unit Office uses for drawing extents. */
internal const val EMU_PER_PIXEL = 9525.0
