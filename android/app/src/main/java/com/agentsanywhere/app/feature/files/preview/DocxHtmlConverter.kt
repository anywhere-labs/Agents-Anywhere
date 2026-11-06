package com.agentsanywhere.app.feature.files.preview

import org.w3c.dom.Element
import java.io.File

/**
 * Simplified Word (.docx) preview: headings, paragraphs, lists, tables with
 * merged cells, hyperlinks, images and text boxes. Page layout, fonts and
 * headers/footers are not reproduced.
 */
object DocxHtmlConverter {
    fun convert(file: File, labels: PreviewLabels = PreviewLabels(), darkCanvas: Boolean = false): OfficeHtml {
        OfficePackage(file).use { pkg ->
            val documentPart = documentPartName(pkg)
            val document = pkg.xml(documentPart)
                ?: throw PreviewUnavailableException("The file is damaged or not a valid Word document.")
            val body = document.child("body") ?: document
            val media = MediaRegistry()
            val renderer = DocxRenderer(
                relationships = pkg.relationships(documentPart),
                styles = DocxStyles.parse(pkg.xml("word/styles.xml")),
                numbering = DocxNumbering.parse(pkg.xml("word/numbering.xml")),
                media = media,
                labels = labels,
            )
            val content = StringBuilder()
            renderer.renderBlocks(body.childElements(), content)
            val pageBody = if (renderer.hasVisibleContent) {
                content.toString()
            } else {
                "<p>${labels.emptyDocument.htmlEscape()}</p>"
            }
            val html = buildString {
                append(noticeHtml(labels.simplifiedNotice))
                append("<div class=\"page\">")
                append(pageBody)
                append("</div>")
            }
            return OfficeHtml(previewHtmlPage(html, darkCanvas), media.toMap())
        }
    }

    private fun documentPartName(pkg: OfficePackage): String {
        val officeDocument = pkg.relationships("").values.firstOrNull { relationship ->
            relationship.type.endsWith("/officeDocument") && !relationship.external
        }
        return officeDocument?.target?.takeIf(pkg::has) ?: "word/document.xml"
    }
}

private class DocxRenderer(
    private val relationships: Map<String, Relationship>,
    private val styles: DocxStyles,
    private val numbering: DocxNumbering,
    private val media: MediaRegistry,
    private val labels: PreviewLabels,
) {
    var hasVisibleContent = false
        private set
    private var previousParagraphEmpty = false

    fun renderBlocks(blocks: List<Element>, out: StringBuilder) {
        blocks.forEach { renderBlock(it, out) }
    }

    private fun renderBlock(element: Element, out: StringBuilder) {
        when (element.localNameOrName) {
            "p" -> renderParagraph(element, out)
            "tbl" -> renderTable(element, out)
            "sdt" -> element.child("sdtContent")?.let { renderBlocks(it.childElements(), out) }
            "customXml", "ins", "smartTag", "moveTo" -> renderBlocks(element.childElements(), out)
            "AlternateContent" -> alternateContentBranch(element)?.let { renderBlocks(it.childElements(), out) }
        }
    }

    private fun renderParagraph(paragraph: Element, out: StringBuilder) {
        val properties = paragraph.child("pPr")
        val styleId = properties?.child("pStyle")?.attr("val")
        val headingLevel = properties?.child("outlineLvl")?.attr("val")?.toIntOrNull()
            ?.let { level -> (level + 1).takeIf { it in 1..6 } }
            ?: styles.headingLevel(styleId)
        val alignment = when (properties?.child("jc")?.attr("val")) {
            "center" -> "center"
            "right", "end" -> "right"
            "both", "distribute" -> "justify"
            else -> null
        }
        val textBoxes = StringBuilder()
        val inline = StringBuilder()
        renderInline(paragraph.childElements(), inline, textBoxes)
        val content = inline.toString()
        val visible = content.isNotBlank()
        val style = alignment?.let { " style=\"text-align:$it\"" }.orEmpty()
        val list = if (headingLevel == null) listMarker(properties, styleId) else null
        when {
            !visible && textBoxes.isEmpty() -> {
                if (!previousParagraphEmpty && hasVisibleContent) out.append("<p class=\"empty\"></p>")
                previousParagraphEmpty = true
                return
            }
            !visible -> Unit
            headingLevel != null -> out.append("<h$headingLevel$style>").append(content).append("</h$headingLevel>")
            list != null -> {
                val indent = 1.4 * list.level
                out.append("<div class=\"li\" style=\"padding-left:${"%.1f".format(java.util.Locale.ROOT, indent)}em\">")
                    .append("<span class=\"marker\">").append(list.marker.htmlEscape()).append("</span>")
                    .append("<p class=\"content\"$style>").append(content).append("</p></div>")
            }
            else -> out.append("<p$style>").append(content).append("</p>")
        }
        if (visible) {
            hasVisibleContent = true
            previousParagraphEmpty = false
        }
        if (textBoxes.isNotEmpty()) {
            hasVisibleContent = true
            out.append(textBoxes)
        }
    }

    private fun listMarker(properties: Element?, styleId: String?): DocxListMarker? {
        val numberingProperties = properties?.child("numPr")
        val numId = numberingProperties?.child("numId")?.attr("val") ?: styles.numId(styleId)
        if (numId == null || numId == "0") return null
        val level = numberingProperties?.child("ilvl")?.attr("val")?.toIntOrNull()
            ?: styles.numLevel(styleId)
            ?: 0
        return numbering.next(numId, level.coerceIn(0, 8))
    }

    private fun renderInline(nodes: List<Element>, out: StringBuilder, textBoxes: StringBuilder) {
        nodes.forEach { node ->
            when (node.localNameOrName) {
                "r" -> renderRun(node, out, textBoxes)
                "hyperlink" -> {
                    val href = node.relAttr("id")?.let { relationships[it] }?.takeIf { it.external }?.target?.let(::safeHref)
                    if (href != null) out.append("<a href=\"").append(href.htmlEscape()).append("\">")
                    renderInline(node.childElements(), out, textBoxes)
                    if (href != null) out.append("</a>")
                }
                "fldSimple", "ins", "smartTag", "customXml", "bdo", "dir", "moveTo" ->
                    renderInline(node.childElements(), out, textBoxes)
                "sdt" -> node.child("sdtContent")?.let { renderInline(it.childElements(), out, textBoxes) }
                "AlternateContent" -> alternateContentBranch(node)?.let { renderInline(it.childElements(), out, textBoxes) }
                "oMath", "oMathPara" -> out.append(node.descendants("t").joinToString("") { it.textContent }.htmlEscape())
            }
        }
    }

    private fun renderRun(run: Element, out: StringBuilder, textBoxes: StringBuilder) {
        val properties = run.child("rPr")
        val tags = buildList {
            if (properties?.child("b").isOn()) add("b")
            if (properties?.child("i").isOn()) add("i")
            properties?.child("u")?.attr("val")?.let { if (it != "none") add("u") }
            if (properties?.child("strike").isOn() || properties?.child("dstrike").isOn()) add("s")
            when (properties?.child("vertAlign")?.attr("val")) {
                "superscript" -> add("sup")
                "subscript" -> add("sub")
            }
        }
        val color = properties?.child("color")?.attr("val")
            ?.takeIf { Regex("^[0-9A-Fa-f]{6}$").matches(it) && !it.equals("000000", ignoreCase = true) }
        val highlight = properties?.child("highlight")?.attr("val")?.let(::highlightColor)
        val content = StringBuilder()
        run.childElements().forEach { child ->
            when (child.localNameOrName) {
                "t" -> content.append(child.textContent.htmlEscape())
                "tab", "ptab" -> content.append('\t')
                "br" -> content.append(if (child.attr("type") == "page") "<hr class=\"page-break\">" else "<br>")
                "cr" -> content.append("<br>")
                "noBreakHyphen" -> content.append('\u2011')
                "drawing", "pict", "object" -> renderDrawing(child, content, textBoxes)
                "AlternateContent" -> alternateContentBranch(child)?.let { branch ->
                    branch.childElements().forEach { renderDrawing(it, content, textBoxes) }
                }
                "footnoteReference", "endnoteReference" -> child.attr("id")?.let {
                    content.append("<sup>[").append(it.htmlEscape()).append("]</sup>")
                }
            }
        }
        if (content.isEmpty()) return
        val styleParts = listOfNotNull(color?.let { "color:#$it" }, highlight?.let { "background:$it" })
        if (styleParts.isNotEmpty()) out.append("<span style=\"").append(styleParts.joinToString(";")).append("\">")
        tags.forEach { out.append('<').append(it).append('>') }
        out.append(content)
        tags.asReversed().forEach { out.append("</").append(it).append('>') }
        if (styleParts.isNotEmpty()) out.append("</span>")
    }

    private fun renderDrawing(drawing: Element, out: StringBuilder, textBoxes: StringBuilder) {
        // Images inside a text box are rendered with the text box below.
        val outsideTextBoxes = { element: Element -> !element.hasAncestor("txbxContent", stopAt = drawing) }
        val blips = drawing.descendants("blip").filter(outsideTextBoxes).mapNotNull { it.relAttr("embed") ?: it.relAttr("link") } +
            drawing.descendants("imagedata").filter(outsideTextBoxes).mapNotNull { it.relAttr("id") }
        val width = drawing.descendants("extent").firstOrNull()?.attr("cx")?.toLongOrNull()
            ?.let { (it / EMU_PER_PIXEL).toInt() }
            ?.takeIf { it in 8..4000 }
        blips.distinct().forEach { id ->
            val relationship = relationships[id]?.takeIf { !it.external } ?: return@forEach
            val url = media.urlFor(relationship.target) ?: return@forEach
            out.append("<img src=\"").append(url.htmlEscape()).append("\"")
            if (width != null) out.append(" style=\"width:${width}px\"")
            out.append(" alt=\"\">")
            hasVisibleContent = true
        }
        if (drawing.descendants("chart").isNotEmpty() && blips.isEmpty()) {
            out.append("<span class=\"placeholder\">").append(labels.chart.htmlEscape()).append("</span>")
            hasVisibleContent = true
        }
        drawing.descendants("txbxContent").forEach { box ->
            val inner = StringBuilder()
            val nested = DocxRenderer(relationships, styles, numbering, media, labels)
            nested.renderBlocks(box.childElements(), inner)
            if (nested.hasVisibleContent) textBoxes.append("<div class=\"textbox\">").append(inner).append("</div>")
        }
    }

    private fun renderTable(table: Element, out: StringBuilder) {
        val rows = table.childElements().flatMap { child ->
            when (child.localNameOrName) {
                "tr" -> listOf(child)
                "sdt" -> child.child("sdtContent")?.childElements("tr").orEmpty()
                else -> emptyList()
            }
        }
        if (rows.isEmpty()) return
        val grid = rows.map { row ->
            var column = row.child("trPr")?.child("gridBefore")?.attr("val")?.toIntOrNull() ?: 0
            val cells = row.childElements().flatMap { child ->
                when (child.localNameOrName) {
                    "tc" -> listOf(child)
                    "sdt" -> child.child("sdtContent")?.childElements("tc").orEmpty()
                    else -> emptyList()
                }
            }
            cells.map { cell ->
                val properties = cell.child("tcPr")
                val span = properties?.child("gridSpan")?.attr("val")?.toIntOrNull()?.coerceIn(1, 64) ?: 1
                val merge = properties?.child("vMerge")?.let { it.attr("val") ?: "continue" }
                DocxCell(cell, column, span, merge).also { column += span }
            }
        }
        out.append("<div class=\"table-wrap\"><table>")
        grid.forEachIndexed { rowIndex, cells ->
            out.append("<tr>")
            cells.forEach { cell ->
                if (cell.merge == "continue") return@forEach
                var rowSpan = 1
                if (cell.merge == "restart") {
                    for (next in rowIndex + 1 until grid.size) {
                        val below = grid[next].firstOrNull { it.column == cell.column }
                        if (below?.merge == "continue") rowSpan += 1 else break
                    }
                }
                out.append("<td")
                if (cell.span > 1) out.append(" colspan=\"${cell.span}\"")
                if (rowSpan > 1) out.append(" rowspan=\"$rowSpan\"")
                out.append('>')
                val inner = DocxRenderer(relationships, styles, numbering, media, labels)
                inner.renderBlocks(cell.element.childElements(), out)
                if (inner.hasVisibleContent) hasVisibleContent = true
                out.append("</td>")
            }
            out.append("</tr>")
        }
        out.append("</table></div>")
        previousParagraphEmpty = false
    }
}

private data class DocxCell(
    val element: Element,
    val column: Int,
    val span: Int,
    val merge: String?,
)

/** Picks the branch of `mc:AlternateContent` this renderer understands (the first `Choice`). */
internal fun alternateContentBranch(element: Element): Element? {
    return element.child("Choice") ?: element.child("Fallback")
}

private fun highlightColor(value: String): String? {
    return when (value) {
        "yellow" -> "#FFF59D"
        "green" -> "#C8E6C9"
        "cyan" -> "#B2EBF2"
        "magenta" -> "#F8BBD0"
        "blue" -> "#BBDEFB"
        "red" -> "#FFCDD2"
        "lightGray" -> "#E0E0E0"
        "darkGray" -> "#BDBDBD"
        else -> null
    }
}

private class DocxStyles(private val styles: Map<String, DocxStyle>) {
    fun headingLevel(styleId: String?): Int? = resolve(styleId) { it.headingLevel }

    fun numId(styleId: String?): String? = resolve(styleId) { it.numId }

    fun numLevel(styleId: String?): Int? = resolve(styleId) { it.numLevel }

    private fun <T> resolve(styleId: String?, value: (DocxStyle) -> T?): T? {
        var current = styleId?.let(styles::get)
        var depth = 0
        while (current != null && depth < 12) {
            value(current)?.let { return it }
            current = current.basedOn?.let(styles::get)
            depth += 1
        }
        return null
    }

    companion object {
        private val HeadingName = Regex("^heading\\s*(\\d)$", RegexOption.IGNORE_CASE)

        fun parse(root: Element?): DocxStyles {
            if (root == null) return DocxStyles(emptyMap())
            val styles = root.childElements("style").mapNotNull { style ->
                val id = style.attr("styleId") ?: return@mapNotNull null
                val name = style.child("name")?.attr("val").orEmpty().trim()
                val properties = style.child("pPr")
                val outline = properties?.child("outlineLvl")?.attr("val")?.toIntOrNull()?.let { it + 1 }
                val headingLevel = HeadingName.matchEntire(name)?.groupValues?.get(1)?.toIntOrNull()
                    ?: when {
                        name.equals("Title", ignoreCase = true) -> 1
                        name.equals("Subtitle", ignoreCase = true) -> 2
                        else -> outline
                    }
                id to DocxStyle(
                    basedOn = style.child("basedOn")?.attr("val"),
                    headingLevel = headingLevel?.takeIf { it in 1..6 },
                    numId = properties?.child("numPr")?.child("numId")?.attr("val"),
                    numLevel = properties?.child("numPr")?.child("ilvl")?.attr("val")?.toIntOrNull(),
                )
            }.toMap()
            return DocxStyles(styles)
        }
    }
}

private data class DocxStyle(
    val basedOn: String?,
    val headingLevel: Int?,
    val numId: String?,
    val numLevel: Int?,
)

internal data class DocxListMarker(val marker: String, val level: Int)

private class DocxNumbering(
    private val levels: Map<String, Map<Int, DocxLevel>>,
) {
    private val counters = mutableMapOf<String, IntArray>()

    fun next(numId: String, level: Int): DocxListMarker {
        val definition = levels[numId]
        val counts = counters.getOrPut(numId) { IntArray(9) }
        val current = definition?.get(level)
        counts[level] = if (counts[level] == 0) current?.start ?: 1 else counts[level] + 1
        for (deeper in level + 1 until counts.size) counts[deeper] = 0
        val format = current?.format ?: "bullet"
        if (format == "bullet" || current == null) {
            return DocxListMarker(BulletGlyphs[level % BulletGlyphs.size], level)
        }
        if (format == "none") return DocxListMarker("", level)
        val text = current.text.ifBlank { "%${level + 1}." }
        val marker = Regex("%([1-9])").replace(text) { match ->
            val referenced = match.groupValues[1].toInt() - 1
            val referencedFormat = definition[referenced]?.format ?: "decimal"
            val value = counts[referenced].takeIf { it > 0 } ?: definition[referenced]?.start ?: 1
            formatListNumber(value, referencedFormat)
        }
        return DocxListMarker(marker, level)
    }

    companion object {
        private val BulletGlyphs = listOf("•", "◦", "▪")

        fun parse(root: Element?): DocxNumbering {
            if (root == null) return DocxNumbering(emptyMap())
            val abstract = root.childElements("abstractNum").associate { definition ->
                definition.attr("abstractNumId").orEmpty() to definition.childElements("lvl").mapNotNull { level ->
                    val index = level.attr("ilvl")?.toIntOrNull() ?: return@mapNotNull null
                    index to DocxLevel(
                        format = level.child("numFmt")?.attr("val") ?: "decimal",
                        text = level.child("lvlText")?.attr("val").orEmpty(),
                        start = level.child("start")?.attr("val")?.toIntOrNull() ?: 1,
                    )
                }.toMap()
            }
            val numbers = root.childElements("num").mapNotNull { number ->
                val id = number.attr("numId") ?: return@mapNotNull null
                val abstractId = number.child("abstractNumId")?.attr("val") ?: return@mapNotNull null
                id to abstract[abstractId].orEmpty()
            }.toMap()
            return DocxNumbering(numbers)
        }
    }
}

private data class DocxLevel(
    val format: String,
    val text: String,
    val start: Int,
)

private val ChineseDigits = listOf("零", "一", "二", "三", "四", "五", "六", "七", "八", "九")

internal fun formatListNumber(value: Int, format: String): String {
    return when (format) {
        "lowerLetter" -> alphabetic(value).lowercase()
        "upperLetter" -> alphabetic(value)
        "lowerRoman" -> roman(value).lowercase()
        "upperRoman" -> roman(value)
        "decimalZero" -> value.toString().padStart(2, '0')
        "decimalEnclosedCircle", "decimalEnclosedCircleChinese" ->
            if (value in 1..20) (0x2460 + value - 1).toChar().toString() else value.toString()
        "chineseCounting", "chineseCountingThousand", "ideographTraditional", "taiwaneseCounting",
        "chineseLegalSimplified", "ideographDigital", "japaneseCounting" -> chineseNumber(value)
        else -> value.toString()
    }
}

private fun alphabetic(value: Int): String {
    if (value <= 0) return value.toString()
    var remaining = value
    val builder = StringBuilder()
    while (remaining > 0) {
        remaining -= 1
        builder.append('A' + remaining % 26)
        remaining /= 26
    }
    return builder.reverse().toString()
}

private fun roman(value: Int): String {
    if (value !in 1..3999) return value.toString()
    val numerals = listOf(
        1000 to "M", 900 to "CM", 500 to "D", 400 to "CD", 100 to "C", 90 to "XC",
        50 to "L", 40 to "XL", 10 to "X", 9 to "IX", 5 to "V", 4 to "IV", 1 to "I",
    )
    var remaining = value
    return buildString {
        numerals.forEach { (amount, numeral) ->
            while (remaining >= amount) {
                append(numeral)
                remaining -= amount
            }
        }
    }
}

private fun chineseNumber(value: Int): String {
    if (value !in 1..99) return value.toString()
    if (value < 10) return ChineseDigits[value]
    val tens = value / 10
    val ones = value % 10
    return buildString {
        if (tens > 1) append(ChineseDigits[tens])
        append('十')
        if (ones > 0) append(ChineseDigits[ones])
    }
}
