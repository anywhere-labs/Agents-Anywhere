package com.agentsanywhere.app.feature.files.preview

import org.w3c.dom.Element
import java.io.File
import java.math.BigDecimal
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

internal const val MAX_SHEET_ROWS = 500
internal const val MAX_SHEET_COLUMNS = 40
private const val MAX_SHEETS = 30

/** Simplified Excel (.xlsx) and CSV/TSV previews rendered as HTML tables. */
object SpreadsheetHtmlConverter {
    fun convertXlsx(file: File, labels: PreviewLabels = PreviewLabels(), darkCanvas: Boolean = false): OfficeHtml {
        OfficePackage(file).use { pkg ->
            val workbookPart = pkg.relationships("").values
                .firstOrNull { it.type.endsWith("/officeDocument") && !it.external }
                ?.target?.takeIf(pkg::has)
                ?: "xl/workbook.xml"
            val workbook = pkg.xml(workbookPart)
                ?: throw PreviewUnavailableException(PreviewFailureReason.Damaged)
            val relationships = pkg.relationships(workbookPart)
            val date1904 = workbook.child("workbookPr")?.attr("date1904").let { it == "1" || it == "true" }
            val sharedStrings = relationships.values.firstOrNull { it.type.endsWith("/sharedStrings") }
                ?.target?.let(pkg::xml)?.let(::parseSharedStrings).orEmpty()
            val dateStyles = relationships.values.firstOrNull { it.type.endsWith("/styles") }
                ?.target?.let(pkg::xml)?.let(::parseDateStyles).orEmpty()
            val sheets = workbook.child("sheets")?.childElements("sheet").orEmpty()
                .filter { it.attr("state") != "veryHidden" }
                .mapNotNull { sheet ->
                    val target = sheet.relAttr("id")?.let { relationships[it] }?.takeIf { !it.external }?.target
                    target?.let { (sheet.attr("name") ?: "Sheet") to it }
                }
                .take(MAX_SHEETS)
            val body = StringBuilder(noticeHtml(labels.simplifiedNotice))
            if (sheets.size > 1) {
                body.append("<div class=\"sheet-tabs\">")
                sheets.forEachIndexed { index, (name, _) ->
                    body.append("<a href=\"#sheet-$index\">").append(name.htmlEscape()).append("</a>")
                }
                body.append("</div>")
            }
            sheets.forEachIndexed { index, (name, part) ->
                val sheet = pkg.xml(part) ?: return@forEachIndexed
                val grid = readWorksheet(sheet, sharedStrings, dateStyles, date1904)
                body.append("<section class=\"sheet\" id=\"sheet-$index\"><h2>").append(name.htmlEscape()).append("</h2>")
                body.append(renderGrid(grid, labels, excelHeaders = true))
                body.append("</section>")
            }
            if (sheets.isEmpty()) {
                body.append("<div class=\"page\"><p>").append(labels.emptyDocument.htmlEscape()).append("</p></div>")
            }
            return OfficeHtml(previewHtmlPage(body.toString(), darkCanvas))
        }
    }

    fun convertDelimited(
        text: String,
        delimiter: Char,
        textTruncated: Boolean,
        labels: PreviewLabels = PreviewLabels(),
        darkCanvas: Boolean = false,
    ): OfficeHtml {
        val rows = parseDelimited(text, delimiter, MAX_SHEET_ROWS + 1)
        val grid = SheetGrid(
            cells = rows.take(MAX_SHEET_ROWS).mapIndexed { rowIndex, row ->
                row.take(MAX_SHEET_COLUMNS).mapIndexed { column, value -> CellPosition(rowIndex, column) to SheetCell(value, isNumber(value)) }
            }.flatten().toMap(),
            rowCount = minOf(rows.size, MAX_SHEET_ROWS),
            columnCount = minOf(rows.maxOfOrNull { it.size } ?: 0, MAX_SHEET_COLUMNS),
            rowsTruncated = rows.size > MAX_SHEET_ROWS || textTruncated,
            columnsTruncated = rows.any { it.size > MAX_SHEET_COLUMNS },
        )
        val body = buildString {
            append("<section class=\"sheet\">")
            append(renderGrid(grid, labels, excelHeaders = false))
            append("</section>")
        }
        return OfficeHtml(previewHtmlPage(body, darkCanvas))
    }

    /** Picks `;` for European CSV exports when it splits the header better than `,`. */
    fun delimiterFor(name: String, sample: String): Char {
        if (name.lowercase().endsWith(".tsv")) return '\t'
        val firstLine = sample.lineSequence().firstOrNull().orEmpty()
        val commas = firstLine.count { it == ',' }
        val semicolons = firstLine.count { it == ';' }
        val tabs = firstLine.count { it == '\t' }
        return when {
            tabs > commas && tabs > semicolons -> '\t'
            semicolons > commas -> ';'
            else -> ','
        }
    }
}

internal data class CellPosition(val row: Int, val column: Int)

internal data class SheetCell(val text: String, val numeric: Boolean)

internal data class SheetMerge(val rowSpan: Int, val columnSpan: Int)

internal data class SheetGrid(
    val cells: Map<CellPosition, SheetCell>,
    val rowCount: Int,
    val columnCount: Int,
    val rowsTruncated: Boolean,
    val columnsTruncated: Boolean,
    val merges: Map<CellPosition, SheetMerge> = emptyMap(),
    val covered: Set<CellPosition> = emptySet(),
    val rowNumbers: List<Int> = emptyList(),
)

private fun renderGrid(grid: SheetGrid, labels: PreviewLabels, excelHeaders: Boolean): String {
    if (grid.rowCount == 0 || grid.columnCount == 0) return "<p>${labels.emptyDocument.htmlEscape()}</p>"
    return buildString {
        append("<div class=\"table-wrap\"><table>")
        if (excelHeaders) {
            append("<tr><th class=\"row\"></th>")
            for (column in 0 until grid.columnCount) append("<th>").append(columnName(column)).append("</th>")
            append("</tr>")
        }
        for (row in 0 until grid.rowCount) {
            append("<tr>")
            if (excelHeaders) {
                append("<th class=\"row\">").append(grid.rowNumbers.getOrNull(row) ?: (row + 1)).append("</th>")
            }
            for (column in 0 until grid.columnCount) {
                val position = CellPosition(row, column)
                if (position in grid.covered) continue
                val cell = grid.cells[position]
                val merge = grid.merges[position]
                append("<td")
                if (cell?.numeric == true) append(" class=\"num\"")
                merge?.columnSpan?.takeIf { it > 1 }?.let { append(" colspan=\"$it\"") }
                merge?.rowSpan?.takeIf { it > 1 }?.let { append(" rowspan=\"$it\"") }
                append('>')
                cell?.text?.let { append(it.htmlEscape()) }
                append("</td>")
            }
            append("</tr>")
        }
        append("</table></div>")
        if (grid.rowsTruncated) {
            append("<div class=\"sheet-note\">").append(labels.rowsTruncated(grid.rowCount).htmlEscape()).append("</div>")
        }
        if (grid.columnsTruncated) {
            append("<div class=\"sheet-note\">").append(labels.columnsTruncated(grid.columnCount).htmlEscape()).append("</div>")
        }
    }
}

private fun parseSharedStrings(root: Element): List<String> {
    return root.childElements("si").map { item ->
        val direct = item.child("t")
        if (direct != null) {
            direct.textContent
        } else {
            item.childElements("r").joinToString("") { run -> run.child("t")?.textContent.orEmpty() }
        }
    }
}

private val BuiltInDateFormats = (14..22).toSet() + setOf(27, 30, 36, 45, 46, 47, 50, 57)

/** Style indexes (`c@s`) whose number format shows a date or time. */
private fun parseDateStyles(root: Element): Map<Int, Boolean> {
    val custom = root.child("numFmts")?.childElements("numFmt").orEmpty().associate { format ->
        (format.attr("numFmtId")?.toIntOrNull() ?: -1) to format.attr("formatCode").orEmpty()
    }
    val formats = root.child("cellXfs")?.childElements("xf").orEmpty()
    return formats.mapIndexed { index, xf ->
        val id = xf.attr("numFmtId")?.toIntOrNull() ?: 0
        val isDate = id in BuiltInDateFormats || custom[id]?.let(::isDateFormatCode) == true
        index to isDate
    }.toMap()
}

internal fun isDateFormatCode(code: String): Boolean {
    // Drop quoted literals, escapes and colors like [Red] before looking for date tokens.
    val stripped = code.replace(Regex("\"[^\"]*\""), "")
        .replace(Regex("\\\\."), "")
        .replace(Regex("\\[[^\\]]*\\]"), "")
        .lowercase()
    if (stripped.contains("general")) return false
    if (stripped.any { it == 'y' || it == 'd' || it == 'h' || it == 's' }) return true
    // A lone `m`/`mmm` is a month format unless the code also has digit placeholders.
    return stripped.contains('m') && !stripped.contains('0') && !stripped.contains('#')
}

private fun readWorksheet(
    sheet: Element,
    sharedStrings: List<String>,
    dateStyles: Map<Int, Boolean>,
    date1904: Boolean,
): SheetGrid {
    val rows = sheet.child("sheetData")?.childElements("row").orEmpty()
    val cells = HashMap<CellPosition, SheetCell>()
    val rowNumbers = ArrayList<Int>()
    var columnCount = 0
    var columnsTruncated = false
    var rowsTruncated = false
    var nextRowNumber = 1
    for (row in rows) {
        val rowNumber = row.attr("r")?.toIntOrNull() ?: nextRowNumber
        nextRowNumber = rowNumber + 1
        if (rowNumbers.size >= MAX_SHEET_ROWS) {
            rowsTruncated = true
            break
        }
        val rowIndex = rowNumbers.size
        rowNumbers.add(rowNumber)
        var nextColumn = 0
        row.childElements("c").forEach { cell ->
            val column = cell.attr("r")?.let(::columnIndex) ?: nextColumn
            nextColumn = column + 1
            if (column >= MAX_SHEET_COLUMNS) {
                columnsTruncated = true
                return@forEach
            }
            val value = cellText(cell, sharedStrings, dateStyles, date1904) ?: return@forEach
            if (value.text.isEmpty()) return@forEach
            cells[CellPosition(rowIndex, column)] = value
            columnCount = maxOf(columnCount, column + 1)
        }
    }
    val rowIndexByNumber = rowNumbers.withIndex().associate { (index, number) -> number to index }
    val merges = HashMap<CellPosition, SheetMerge>()
    val covered = HashSet<CellPosition>()
    sheet.child("mergeCells")?.childElements("mergeCell").orEmpty().forEach { merge ->
        val range = merge.attr("ref")?.split(':')?.takeIf { it.size == 2 } ?: return@forEach
        val (startColumn, startRow) = cellReference(range[0]) ?: return@forEach
        val (endColumn, endRow) = cellReference(range[1]) ?: return@forEach
        val top = rowIndexByNumber[startRow] ?: return@forEach
        val bottomRow = (startRow..endRow).lastOrNull { it in rowIndexByNumber } ?: startRow
        val bottom = rowIndexByNumber[bottomRow] ?: top
        if (startColumn >= MAX_SHEET_COLUMNS) return@forEach
        val lastColumn = minOf(endColumn, MAX_SHEET_COLUMNS - 1)
        merges[CellPosition(top, startColumn)] = SheetMerge(bottom - top + 1, lastColumn - startColumn + 1)
        for (rowIndex in top..bottom) {
            for (column in startColumn..lastColumn) {
                if (rowIndex != top || column != startColumn) covered.add(CellPosition(rowIndex, column))
            }
        }
        columnCount = maxOf(columnCount, lastColumn + 1)
    }
    return SheetGrid(
        cells = cells,
        rowCount = rowNumbers.size,
        columnCount = columnCount,
        rowsTruncated = rowsTruncated,
        columnsTruncated = columnsTruncated,
        merges = merges,
        covered = covered,
        rowNumbers = rowNumbers,
    )
}

private fun cellText(
    cell: Element,
    sharedStrings: List<String>,
    dateStyles: Map<Int, Boolean>,
    date1904: Boolean,
): SheetCell? {
    val type = cell.attr("t") ?: "n"
    val raw = cell.child("v")?.textContent
    return when (type) {
        "s" -> raw?.trim()?.toIntOrNull()?.let { sharedStrings.getOrNull(it) }?.let { SheetCell(it, false) }
        "inlineStr" -> cell.child("is")?.let { inline ->
            inline.child("t")?.textContent ?: inline.childElements("r").joinToString("") { it.child("t")?.textContent.orEmpty() }
        }?.let { SheetCell(it, false) }
        "b" -> raw?.let { SheetCell(if (it.trim() == "1") "TRUE" else "FALSE", false) }
        "str", "e", "d" -> raw?.let { SheetCell(it, false) }
        else -> {
            val number = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val style = cell.attr("s")?.toIntOrNull()
            if (style != null && dateStyles[style] == true) {
                number.toDoubleOrNull()?.let { serial -> excelDate(serial, date1904) }?.let { return SheetCell(it, true) }
            }
            SheetCell(formatNumber(number), true)
        }
    }
}

private fun formatNumber(raw: String): String {
    val value = raw.toBigDecimalOrNull() ?: return raw
    // Preserve the stored value, including small nonzero numbers and all significant digits.
    return value.stripTrailingZeros().let { if (it.scale() < 0) it.setScale(0) else it }.toPlainString()
}

internal fun excelDate(serial: Double, date1904: Boolean): String? {
    if (serial < 0 || serial > 2_958_465) return null
    val base = if (date1904) LocalDate.of(1904, 1, 1) else LocalDate.of(1899, 12, 30)
    val days = kotlin.math.floor(serial).toLong()
    val seconds = Math.round((serial - days) * 86_400)
    val dateTime = LocalDateTime.of(base.plusDays(days), java.time.LocalTime.MIDNIGHT).plusSeconds(seconds)
    return when {
        seconds == 0L -> dateTime.toLocalDate().format(DateTimeFormatter.ISO_LOCAL_DATE)
        days == 0L -> dateTime.toLocalTime().format(DateTimeFormatter.ofPattern("HH:mm:ss"))
        else -> dateTime.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"))
    }
}

private fun isNumber(value: String): Boolean {
    val trimmed = value.trim()
    return trimmed.isNotEmpty() && trimmed.length < 32 && trimmed.replace(",", "").toBigDecimalOrNull() != null
}

private fun String.toBigDecimalOrNull(): BigDecimal? = runCatching { BigDecimal(this) }.getOrNull()

internal fun columnIndex(reference: String): Int? = cellReference(reference)?.first

/** Parses `AB12` into a zero-based column and a one-based row. */
internal fun cellReference(reference: String): Pair<Int, Int>? {
    val match = Regex("^\\$?([A-Za-z]{1,3})\\$?(\\d+)$").matchEntire(reference.trim()) ?: return null
    var column = 0
    match.groupValues[1].uppercase().forEach { column = column * 26 + (it - 'A' + 1) }
    return (column - 1) to match.groupValues[2].toInt()
}

internal fun columnName(index: Int): String {
    var value = index + 1
    val builder = StringBuilder()
    while (value > 0) {
        value -= 1
        builder.append('A' + value % 26)
        value /= 26
    }
    return builder.reverse().toString()
}

/** RFC 4180 parsing: quoted fields may contain delimiters, quotes (`""`) and newlines. */
internal fun parseDelimited(text: String, delimiter: Char, maxRows: Int): List<List<String>> {
    val rows = ArrayList<List<String>>()
    var row = ArrayList<String>()
    val field = StringBuilder()
    var inQuotes = false
    var index = if (text.startsWith('\uFEFF')) 1 else 0
    var fieldStarted = false
    while (index < text.length && rows.size < maxRows) {
        val char = text[index]
        if (inQuotes) {
            if (char == '"') {
                if (index + 1 < text.length && text[index + 1] == '"') {
                    field.append('"')
                    index += 1
                } else {
                    inQuotes = false
                }
            } else {
                field.append(char)
            }
        } else {
            when (char) {
                '"' -> if (field.isEmpty()) inQuotes = true else field.append(char)
                delimiter -> {
                    row.add(field.toString())
                    field.clear()
                }
                '\r' -> Unit
                '\n' -> {
                    row.add(field.toString())
                    field.clear()
                    rows.add(row)
                    row = ArrayList()
                }
                else -> field.append(char)
            }
        }
        fieldStarted = true
        index += 1
    }
    if (rows.size < maxRows && fieldStarted && (field.isNotEmpty() || row.isNotEmpty())) {
        row.add(field.toString())
        rows.add(row)
    }
    return rows
}
