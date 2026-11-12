package com.agentsanywhere.app.feature.files.preview

import org.w3c.dom.Element
import java.io.File

/**
 * PowerPoint (.pptx) preview as a readable outline: one card per slide with
 * its title, text in reading order, tables and pictures. Slide layout,
 * themes and animations are not reproduced.
 */
object PptxHtmlConverter {
    private const val MAX_SLIDES = 300

    fun convert(file: File, labels: PreviewLabels = PreviewLabels(), darkCanvas: Boolean = false): OfficeHtml {
        OfficePackage(file).use { pkg ->
            val presentationPart = pkg.relationships("").values
                .firstOrNull { it.type.endsWith("/officeDocument") && !it.external }
                ?.target?.takeIf(pkg::has)
                ?: "ppt/presentation.xml"
            val presentation = pkg.xml(presentationPart)
                ?: throw PreviewUnavailableException(PreviewFailureReason.Damaged)
            val presentationRels = pkg.relationships(presentationPart)
            val slideParts = presentation.child("sldIdLst")?.childElements("sldId").orEmpty()
                .mapNotNull { slide -> slide.relAttr("id")?.let { presentationRels[it] } }
                .filter { !it.external && pkg.has(it.target) }
                .map { it.target }
                .ifEmpty {
                    // Fall back to file order when the slide list is missing.
                    generateSequence(1) { it + 1 }.map { "ppt/slides/slide$it.xml" }.takeWhile(pkg::has).toList()
                }
            val slideHeight = presentation.child("sldSz")?.attr("cy")?.toLongOrNull() ?: 6_858_000L
            val media = MediaRegistry()
            val body = StringBuilder(noticeHtml(labels.simplifiedNotice))
            if (slideParts.size > MAX_SLIDES) {
                body.append(noticeHtml(labels.slidesTruncated(MAX_SLIDES, slideParts.size)))
            }
            slideParts.take(MAX_SLIDES).forEachIndexed { index, part ->
                val slide = pkg.xml(part) ?: return@forEachIndexed
                val renderer = PptxSlideRenderer(pkg.relationships(part), media, labels, slideHeight)
                body.append("<section class=\"slide\"><div class=\"slide-label\">")
                    .append(labels.slide(index + 1).htmlEscape())
                    .append("</div>")
                body.append(renderer.render(slide))
                body.append("</section>")
            }
            if (slideParts.isEmpty()) {
                body.append("<div class=\"page\"><p>").append(labels.emptyDocument.htmlEscape()).append("</p></div>")
            }
            return OfficeHtml(previewHtmlPage(body.toString(), darkCanvas), media.toMap())
        }
    }
}

private class PptxSlideRenderer(
    private val relationships: Map<String, Relationship>,
    private val media: MediaRegistry,
    private val labels: PreviewLabels,
    private val slideHeight: Long,
) {
    fun render(slide: Element): String {
        val tree = slide.child("cSld")?.child("spTree") ?: return ""
        val shapes = mutableListOf<PptxShape>()
        collectShapes(tree, shapes)
        val ordered = shapes.sortedWith(compareBy<PptxShape> { it.rank }.thenBy { it.y }.thenBy { it.x })
        val images = ordered.filter { it.kind == PptxShapeKind.Image }
        val out = StringBuilder()
        ordered.filter { it.kind != PptxShapeKind.Image }.forEach { out.append(it.html) }
        if (images.isNotEmpty()) {
            out.append("<div class=\"images\">")
            images.forEach { out.append(it.html) }
            out.append("</div>")
        }
        return out.toString()
    }

    private fun collectShapes(container: Element, out: MutableList<PptxShape>) {
        container.childElements().forEach { element ->
            when (element.localNameOrName) {
                "sp" -> textShape(element)?.let(out::add)
                "pic" -> pictureShape(element)?.let(out::add)
                "graphicFrame" -> frameShape(element)?.let(out::add)
                "grpSp" -> collectShapes(element, out)
                "AlternateContent" -> alternateContentBranch(element)?.let { collectShapes(it, out) }
            }
        }
    }

    private fun textShape(shape: Element): PptxShape? {
        val placeholder = shape.child("nvSpPr")?.child("nvPr")?.child("ph")
        val placeholderType = placeholder?.attr("type") ?: if (placeholder != null) "body" else null
        if (placeholderType in setOf("dt", "ftr", "sldNum", "hdr")) return null
        val body = shape.child("txBody") ?: return null
        val isTitle = placeholderType == "title" || placeholderType == "ctrTitle"
        val isSubtitle = placeholderType == "subTitle"
        val bulletsByDefault = placeholderType == "body" || placeholderType == "obj"
        val paragraphs = body.childElements("p").mapNotNull { renderParagraph(it, bulletsByDefault && !isTitle && !isSubtitle) }
        if (paragraphs.isEmpty()) return null
        val html = when {
            isTitle -> "<h2 class=\"slide-title\">${paragraphs.joinToString("<br>") { it.text }}</h2>"
            isSubtitle -> "<p class=\"slide-subtitle\">${paragraphs.joinToString("<br>") { it.text }}</p>"
            else -> buildString {
                append("<div class=\"shape\">")
                paragraphs.forEach { paragraph ->
                    if (paragraph.marker != null) {
                        append("<div class=\"li\" style=\"padding-left:${paragraph.level * 1.3}em\">")
                        append("<span class=\"marker\">").append(paragraph.marker.htmlEscape()).append("</span>")
                        append("<p class=\"content\">").append(paragraph.text).append("</p></div>")
                    } else {
                        append("<p style=\"padding-left:${paragraph.level * 1.3}em\">").append(paragraph.text).append("</p>")
                    }
                }
                append("</div>")
            }
        }
        val position = position(shape.child("spPr"))
        val rank = when {
            isTitle -> 0
            isSubtitle -> 1
            else -> 2
        }
        val defaultY = if (isTitle) 0L else slideHeight / 4
        return PptxShape(PptxShapeKind.Text, rank, position?.first ?: defaultY, position?.second ?: 0L, html)
    }

    private fun renderParagraph(paragraph: Element, bulletsByDefault: Boolean): PptxParagraph? {
        val properties = paragraph.child("pPr")
        val level = properties?.attr("lvl")?.toIntOrNull()?.coerceIn(0, 8) ?: 0
        val text = StringBuilder()
        paragraph.childElements().forEach { child ->
            when (child.localNameOrName) {
                "r", "fld" -> text.append(renderRun(child))
                "br" -> text.append("<br>")
            }
        }
        if (text.isBlank()) return null
        val marker = when {
            properties?.child("buNone") != null -> null
            properties?.child("buChar") != null -> properties.child("buChar")?.attr("char")?.let(::bulletGlyph) ?: "•"
            properties?.child("buAutoNum") != null -> "•"
            bulletsByDefault -> if (level == 0) "•" else "◦"
            else -> null
        }
        return PptxParagraph(text.toString(), level, marker)
    }

    private fun renderRun(run: Element): String {
        val raw = run.child("t")?.textContent.orEmpty()
        if (raw.isEmpty()) return ""
        val properties = run.child("rPr")
        val tags = buildList {
            if (properties?.attr("b").let { it == "1" || it == "true" }) add("b")
            if (properties?.attr("i").let { it == "1" || it == "true" }) add("i")
            properties?.attr("u")?.let { if (it != "none") add("u") }
            properties?.attr("strike")?.let { if (it != "noStrike") add("s") }
        }
        val href = properties?.child("hlinkClick")?.relAttr("id")
            ?.let { relationships[it] }?.takeIf { it.external }?.target?.let(::safeHref)
        return buildString {
            if (href != null) append("<a href=\"").append(href.htmlEscape()).append("\">")
            tags.forEach { append('<').append(it).append('>') }
            append(raw.htmlEscape())
            tags.asReversed().forEach { append("</").append(it).append('>') }
            if (href != null) append("</a>")
        }
    }

    private fun pictureShape(picture: Element): PptxShape? {
        val embed = picture.descendants("blip").firstNotNullOfOrNull { it.relAttr("embed") } ?: return null
        val relationship = relationships[embed]?.takeIf { !it.external } ?: return null
        val url = media.urlFor(relationship.target) ?: return null
        val position = position(picture.child("spPr"))
        return PptxShape(
            kind = PptxShapeKind.Image,
            rank = 3,
            y = position?.first ?: slideHeight,
            x = position?.second ?: 0L,
            html = "<img src=\"${url.htmlEscape()}\" alt=\"\">",
        )
    }

    private fun frameShape(frame: Element): PptxShape? {
        val position = frame.child("xfrm")?.let { transform ->
            val offset = transform.child("off")
            (offset?.attr("y")?.toLongOrNull() ?: 0L) to (offset?.attr("x")?.toLongOrNull() ?: 0L)
        }
        val table = frame.descendants("tbl").firstOrNull()
        val html = when {
            table != null -> renderTable(table)
            frame.descendants("chart").isNotEmpty() ->
                "<div class=\"shape\"><span class=\"placeholder\">${labels.chart.htmlEscape()}</span></div>"
            else -> return null
        }
        return PptxShape(PptxShapeKind.Text, 2, position?.first ?: slideHeight / 2, position?.second ?: 0L, html)
    }

    private fun renderTable(table: Element): String {
        return buildString {
            append("<div class=\"table-wrap\"><table>")
            table.childElements("tr").forEach { row ->
                append("<tr>")
                row.childElements("tc").forEach { cell ->
                    if (cell.attr("hMerge") == "1" || cell.attr("vMerge") == "1") return@forEach
                    append("<td")
                    cell.attr("gridSpan")?.toIntOrNull()?.takeIf { it > 1 }?.let { append(" colspan=\"$it\"") }
                    cell.attr("rowSpan")?.toIntOrNull()?.takeIf { it > 1 }?.let { append(" rowspan=\"$it\"") }
                    append('>')
                    cell.child("txBody")?.childElements("p")?.forEach { paragraph ->
                        renderParagraph(paragraph, bulletsByDefault = false)?.let { append("<p>").append(it.text).append("</p>") }
                    }
                    append("</td>")
                }
                append("</tr>")
            }
            append("</table></div>")
        }
    }

    private fun position(shapeProperties: Element?): Pair<Long, Long>? {
        val offset = shapeProperties?.child("xfrm")?.child("off") ?: return null
        val y = offset.attr("y")?.toLongOrNull() ?: return null
        val x = offset.attr("x")?.toLongOrNull() ?: 0L
        return y to x
    }
}

private enum class PptxShapeKind { Text, Image }

private data class PptxShape(
    val kind: PptxShapeKind,
    val rank: Int,
    val y: Long,
    val x: Long,
    val html: String,
)

private data class PptxParagraph(
    val text: String,
    val level: Int,
    val marker: String?,
)

/** Symbol-font bullets live in the private use area; show a plain bullet instead. */
private fun bulletGlyph(char: String): String {
    val first = char.firstOrNull() ?: return "•"
    return if (first in '\uE000'..'\uF8FF' || first.isLetterOrDigit()) "•" else char
}
