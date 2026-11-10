package com.agentsanywhere.app.feature.files.preview

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.Charset

private const val MAX_LEGACY_FILE_BYTES = 96L * 1024 * 1024

/**
 * Text-only previews for Word 97-2003 (.doc) and PowerPoint 97-2003 (.ppt)
 * files. Both are OLE compound files; the text is read from the document
 * streams without layout, images or formatting.
 */
object LegacyOfficeConverter {
    fun convertDoc(file: File, labels: PreviewLabels = PreviewLabels(), darkCanvas: Boolean = false): OfficeHtml {
        val text = extractWordText(readCompoundFile(file))
        val paragraphs = text.split('\n').map(String::trimEnd)
        val body = buildString {
            append(noticeHtml(labels.textOnlyNotice))
            append("<div class=\"page\">")
            var previousEmpty = true
            var tableRows = mutableListOf<List<String>>()
            fun flushTable() {
                if (tableRows.isEmpty()) return
                append("<div class=\"table-wrap\"><table>")
                tableRows.forEach { cells ->
                    append("<tr>")
                    cells.forEach { append("<td>").append(it.trim().htmlEscape()).append("</td>") }
                    append("</tr>")
                }
                append("</table></div>")
                tableRows = mutableListOf()
                previousEmpty = false
            }
            paragraphs.forEach { paragraph ->
                when {
                    // Table rows come out of the text stream as tab-separated cells.
                    paragraph.contains('\t') -> tableRows.add(paragraph.split('\t'))
                    paragraph.isBlank() -> {
                        flushTable()
                        if (!previousEmpty) append("<p class=\"empty\"></p>")
                        previousEmpty = true
                    }
                    else -> {
                        flushTable()
                        append("<p>").append(paragraph.htmlEscape()).append("</p>")
                        previousEmpty = false
                    }
                }
            }
            flushTable()
            if (text.isBlank()) append("<p>").append(labels.emptyDocument.htmlEscape()).append("</p>")
            append("</div>")
        }
        return OfficeHtml(previewHtmlPage(body, darkCanvas))
    }

    fun convertPpt(file: File, labels: PreviewLabels = PreviewLabels(), darkCanvas: Boolean = false): OfficeHtml {
        val slides = extractPowerPointSlides(readCompoundFile(file))
        val body = buildString {
            append(noticeHtml(labels.textOnlyNotice))
            slides.forEachIndexed { index, slide ->
                append("<section class=\"slide\"><div class=\"slide-label\">")
                append(labels.slide(index + 1).htmlEscape())
                append("</div>")
                slide.title?.let { append("<h2 class=\"slide-title\">").append(it.htmlEscape()).append("</h2>") }
                slide.blocks.forEach { block ->
                    append("<div class=\"shape\">")
                    block.split('\n').filter(String::isNotBlank).forEach { line ->
                        append("<p>").append(line.trim().htmlEscape()).append("</p>")
                    }
                    append("</div>")
                }
                append("</section>")
            }
            if (slides.isEmpty()) append("<div class=\"page\"><p>").append(labels.emptyDocument.htmlEscape()).append("</p></div>")
        }
        return OfficeHtml(previewHtmlPage(body, darkCanvas))
    }

    private fun readCompoundFile(file: File): CompoundFile {
        if (file.length() > MAX_LEGACY_FILE_BYTES) throw PreviewUnavailableException(PreviewFailureReason.TooLarge)
        return CompoundFile.parse(file.readBytes())
    }
}

/** Minimal reader for the OLE compound file format ([MS-CFB]). */
internal class CompoundFile private constructor(
    private val data: ByteArray,
    private val sectorSize: Int,
    private val miniSectorSize: Int,
    private val miniStreamCutoff: Long,
    private val fat: IntArray,
    private val miniFat: IntArray,
    private val entries: List<Entry>,
    private val miniStream: ByteArray,
) {
    data class Entry(val name: String, val type: Int, val startSector: Int, val size: Long)

    fun stream(name: String): ByteArray? {
        val entry = entries.firstOrNull { it.type == STREAM && it.name.equals(name, ignoreCase = true) } ?: return null
        return if (entry.size < miniStreamCutoff) {
            readChain(miniStream, miniFat, entry.startSector, miniSectorSize, entry.size, offsetSectors = 0)
        } else {
            readChain(data, fat, entry.startSector, sectorSize, entry.size, offsetSectors = 1)
        }
    }

    fun hasStream(name: String): Boolean = entries.any { it.type == STREAM && it.name.equals(name, ignoreCase = true) }

    companion object {
        private const val STREAM = 2
        private const val ROOT = 5
        private const val END_OF_CHAIN = -2
        private const val FREE = -1
        private val Signature = byteArrayOf(
            0xD0.toByte(), 0xCF.toByte(), 0x11, 0xE0.toByte(), 0xA1.toByte(), 0xB1.toByte(), 0x1A, 0xE1.toByte(),
        )

        fun parse(data: ByteArray): CompoundFile {
            if (data.size < 512 || !data.copyOfRange(0, 8).contentEquals(Signature)) {
                throw PreviewUnavailableException(PreviewFailureReason.Damaged)
            }
            val header = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
            val sectorShift = header.getShort(0x1E).toInt()
            val miniShift = header.getShort(0x20).toInt()
            if (sectorShift !in 7..16 || miniShift !in 2..sectorShift) {
                throw PreviewUnavailableException(PreviewFailureReason.Damaged)
            }
            val sectorSize = 1 shl sectorShift
            val miniSectorSize = 1 shl miniShift
            val fatSectorCount = header.getInt(0x2C)
            val firstDirectorySector = header.getInt(0x30)
            val miniCutoff = header.getInt(0x38).toLong() and 0xFFFFFFFFL
            val firstMiniFatSector = header.getInt(0x3C)
            var difatSector = header.getInt(0x44)

            val fatSectors = ArrayList<Int>()
            for (index in 0 until 109) {
                val sector = header.getInt(0x4C + index * 4)
                if (sector >= 0) fatSectors.add(sector)
            }
            val sectorCount = (data.size - sectorSize) / sectorSize
            var guard = 0
            while (difatSector >= 0 && difatSector < sectorCount && guard++ < sectorCount) {
                val offset = (difatSector + 1) * sectorSize
                val perSector = sectorSize / 4 - 1
                for (index in 0 until perSector) {
                    val sector = header.getInt(offset + index * 4)
                    if (sector >= 0) fatSectors.add(sector)
                }
                difatSector = header.getInt(offset + perSector * 4)
            }
            if (fatSectors.isEmpty() || fatSectorCount <= 0) {
                throw PreviewUnavailableException(PreviewFailureReason.Damaged)
            }
            val fat = IntArray(fatSectors.size * sectorSize / 4)
            fatSectors.forEachIndexed { fatIndex, sector ->
                if (sector >= sectorCount) return@forEachIndexed
                val offset = (sector + 1) * sectorSize
                for (index in 0 until sectorSize / 4) {
                    fat[fatIndex * (sectorSize / 4) + index] = header.getInt(offset + index * 4)
                }
            }
            val directory = readChain(data, fat, firstDirectorySector, sectorSize, null, offsetSectors = 1)
            val directoryBuffer = ByteBuffer.wrap(directory).order(ByteOrder.LITTLE_ENDIAN)
            val entries = (0 until directory.size / 128).map { index ->
                val base = index * 128
                val nameLength = (directoryBuffer.getShort(base + 0x40).toInt() and 0xFFFF).coerceIn(0, 64)
                val name = String(directory, base, maxOf(0, nameLength - 2), Charsets.UTF_16LE)
                Entry(
                    name = name,
                    type = directory[base + 0x42].toInt(),
                    startSector = directoryBuffer.getInt(base + 0x74),
                    size = directoryBuffer.getLong(base + 0x78).let { if (sectorSize == 512) it and 0xFFFFFFFFL else it },
                )
            }
            val root = entries.firstOrNull { it.type == ROOT }
                ?: throw PreviewUnavailableException(PreviewFailureReason.Damaged)
            val miniStream = if (root.size > 0) readChain(data, fat, root.startSector, sectorSize, root.size, 1) else ByteArray(0)
            val miniFatBytes = if (firstMiniFatSector >= 0) {
                readChain(data, fat, firstMiniFatSector, sectorSize, null, offsetSectors = 1)
            } else {
                ByteArray(0)
            }
            val miniFatBuffer = ByteBuffer.wrap(miniFatBytes).order(ByteOrder.LITTLE_ENDIAN)
            val miniFat = IntArray(miniFatBytes.size / 4) { miniFatBuffer.getInt(it * 4) }
            return CompoundFile(data, sectorSize, miniSectorSize, miniCutoff, fat, miniFat, entries, miniStream)
        }

        private fun readChain(
            source: ByteArray,
            table: IntArray,
            start: Int,
            sectorSize: Int,
            size: Long?,
            offsetSectors: Int,
        ): ByteArray {
            val output = java.io.ByteArrayOutputStream()
            var sector = start
            var steps = 0
            while (sector != END_OF_CHAIN && sector != FREE && sector >= 0 && steps <= table.size) {
                val offset = (sector.toLong() + offsetSectors) * sectorSize
                if (offset + sectorSize > source.size) {
                    val remaining = (source.size - offset).toInt()
                    if (remaining > 0) output.write(source, offset.toInt(), remaining)
                    break
                }
                output.write(source, offset.toInt(), sectorSize)
                if (size != null && output.size() >= size) break
                sector = table.getOrElse(sector) { END_OF_CHAIN }
                steps += 1
            }
            val bytes = output.toByteArray()
            return if (size != null && bytes.size > size) bytes.copyOf(size.toInt()) else bytes
        }
    }
}

/** Main document text of a Word 97-2003 file, read through its piece table ([MS-DOC]). */
internal fun extractWordText(compound: CompoundFile): String {
    val document = compound.stream("WordDocument")
        ?: throw PreviewUnavailableException(PreviewFailureReason.Damaged)
    if (document.size < 0x1AA) throw PreviewUnavailableException(PreviewFailureReason.Damaged)
    val fib = ByteBuffer.wrap(document).order(ByteOrder.LITTLE_ENDIAN)
    if ((fib.getShort(0).toInt() and 0xFFFF) != 0xA5EC) {
        throw PreviewUnavailableException(PreviewFailureReason.Damaged)
    }
    val flags = fib.getShort(0x0A).toInt()
    if (flags and 0x0100 != 0) throw PreviewUnavailableException(PreviewFailureReason.PasswordProtected)
    val tableName = if (flags and 0x0200 != 0) "1Table" else "0Table"
    val table = compound.stream(tableName)
        ?: throw PreviewUnavailableException(PreviewFailureReason.Damaged)
    val textLength = fib.getInt(0x4C).coerceAtLeast(0)
    val clxOffset = fib.getInt(0x01A2)
    val clxLength = fib.getInt(0x01A6)
    val raw = if (clxOffset >= 0 && clxLength > 0 && clxOffset + clxLength <= table.size) {
        readPieces(document, table, clxOffset, clxLength, textLength)
    } else {
        null
    } ?: throw PreviewUnavailableException(PreviewFailureReason.Damaged)
    return cleanWordText(raw)
}

private fun readPieces(document: ByteArray, table: ByteArray, offset: Int, length: Int, textLength: Int): String? {
    val buffer = ByteBuffer.wrap(table).order(ByteOrder.LITTLE_ENDIAN)
    var position = offset
    val end = offset + length
    while (position < end) {
        when (table[position].toInt()) {
            0x01 -> position += 3 + (buffer.getShort(position + 1).toInt() and 0xFFFF)
            0x02 -> {
                val pieceTableLength = buffer.getInt(position + 1)
                val start = position + 5
                if (pieceTableLength < 4 || start + pieceTableLength > table.size) return null
                val count = (pieceTableLength - 4) / 12
                val text = StringBuilder()
                val cp1252 = runCatching { Charset.forName("windows-1252") }.getOrDefault(Charsets.ISO_8859_1)
                for (index in 0 until count) {
                    val cpStart = buffer.getInt(start + index * 4)
                    val cpEnd = buffer.getInt(start + (index + 1) * 4)
                    if (cpStart >= textLength && textLength > 0) break
                    val characters = (minOf(cpEnd, if (textLength > 0) textLength else cpEnd) - cpStart).coerceAtLeast(0)
                    val descriptor = start + (count + 1) * 4 + index * 8
                    val fcValue = buffer.getInt(descriptor + 2)
                    val compressed = fcValue and 0x40000000 != 0
                    val fc = fcValue and 0x3FFFFFFF
                    if (compressed) {
                        val from = fc / 2
                        val to = minOf(from + characters, document.size)
                        if (from in 0 until to) text.append(String(document, from, to - from, cp1252))
                    } else {
                        val to = minOf(fc + characters * 2, document.size)
                        if (fc in 0 until to) text.append(String(document, fc, to - fc, Charsets.UTF_16LE))
                    }
                }
                return text.toString()
            }
            else -> return null
        }
    }
    return null
}

/** Removes field codes and maps Word control characters to plain text. */
internal fun cleanWordText(raw: String): String {
    val output = StringBuilder(raw.length)
    // Each open field records whether its code part (before the separator) is still running.
    val fields = ArrayDeque<Boolean>()
    var index = 0
    while (index < raw.length) {
        val char = raw[index]
        when (char.code) {
            0x13 -> fields.addLast(true)
            0x14 -> if (fields.isNotEmpty()) {
                fields.removeLast()
                fields.addLast(false)
            }
            0x15 -> fields.removeLastOrNull()
            else -> if (fields.none { it }) {
                when (char.code) {
                    0x0D, 0x0B, 0x0E -> output.append('\n')
                    0x0C -> output.append("\n\n")
                    // A cell ends with 0x07; a second 0x07 right after it ends the table row.
                    0x07 -> if (index + 1 < raw.length && raw[index + 1].code == 0x07) {
                        output.append('\n')
                        index += 1
                    } else {
                        output.append('\t')
                    }
                    0x1E -> output.append('-')
                    0xA0 -> output.append(' ')
                    0x01, 0x02, 0x05, 0x08, 0x1F -> Unit
                    else -> if (char.code >= 0x20 || char == '\t') output.append(char)
                }
            }
        }
        index += 1
    }
    return output.toString()
        .replace(Regex("\t+\n"), "\n")
        .replace(Regex("\n{3,}"), "\n\n")
        .trim()
}

internal data class LegacySlide(val title: String?, val blocks: List<String>)

/** Slide texts of a PowerPoint 97-2003 file ([MS-PPT]). */
internal fun extractPowerPointSlides(compound: CompoundFile): List<LegacySlide> {
    if (compound.hasStream("EncryptedSummary")) throw PreviewUnavailableException(PreviewFailureReason.PasswordProtected)
    val stream = compound.stream("PowerPoint Document")
        ?: throw PreviewUnavailableException(PreviewFailureReason.Damaged)
    val collector = PptTextCollector(stream)
    collector.walk(0, stream.size, inSlideList = false, inSlide = false)
    return collector.slides()
}

private class PptTextCollector(private val data: ByteArray) {
    private val buffer = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
    private val outlineSlides = ArrayList<MutableList<Pair<Int, String>>>()
    private val drawingSlides = ArrayList<MutableList<Pair<Int, String>>>()
    private var pendingTextType = -1

    fun walk(start: Int, end: Int, inSlideList: Boolean, inSlide: Boolean, depth: Int = 0) {
        var position = start
        while (position + 8 <= end && depth < 32) {
            val versionAndInstance = buffer.getShort(position).toInt() and 0xFFFF
            val type = buffer.getShort(position + 2).toInt() and 0xFFFF
            val length = buffer.getInt(position + 4)
            val bodyStart = position + 8
            if (length < 0 || bodyStart + length > end) return
            val bodyEnd = bodyStart + length
            val isContainer = versionAndInstance and 0x000F == 0x000F
            val instance = versionAndInstance shr 4
            when {
                type == SLIDE_LIST_WITH_TEXT -> if (instance == 0) walk(bodyStart, bodyEnd, inSlideList = true, inSlide = false, depth + 1)
                type == SLIDE -> {
                    drawingSlides.add(mutableListOf())
                    walk(bodyStart, bodyEnd, inSlideList = false, inSlide = true, depth + 1)
                }
                type == NOTES || type == MAIN_MASTER || type == HANDOUT -> Unit
                type == SLIDE_PERSIST_ATOM && inSlideList -> outlineSlides.add(mutableListOf())
                type == TEXT_HEADER_ATOM && length >= 4 -> pendingTextType = buffer.getInt(bodyStart)
                type == TEXT_CHARS_ATOM -> addText(String(data, bodyStart, length - length % 2, Charsets.UTF_16LE), inSlideList, inSlide)
                type == TEXT_BYTES_ATOM -> addText(String(data, bodyStart, length, Charsets.ISO_8859_1), inSlideList, inSlide)
                isContainer -> walk(bodyStart, bodyEnd, inSlideList, inSlide, depth + 1)
            }
            position = bodyEnd
        }
    }

    private fun addText(raw: String, inSlideList: Boolean, inSlide: Boolean) {
        val text = raw.replace('\r', '\n').replace('\u000B', '\n').filter { it == '\n' || it.code >= 0x20 }.trim()
        if (text.isBlank() || text == "*") return
        when {
            inSlideList -> outlineSlides.lastOrNull()?.add(pendingTextType to text)
            inSlide -> drawingSlides.lastOrNull()?.add(pendingTextType to text)
        }
        pendingTextType = -1
    }

    fun slides(): List<LegacySlide> {
        val count = maxOf(outlineSlides.size, drawingSlides.size)
        return (0 until count).map { index ->
            val outline = outlineSlides.getOrNull(index).orEmpty()
            val drawing = drawingSlides.getOrNull(index).orEmpty()
            val isTitle = { entry: Pair<Int, String> -> entry.first == TITLE || entry.first == CENTER_TITLE }
            // PowerPoint keeps placeholder text in the outline; other writers
            // (LibreOffice) only fill the slide drawing, which is tagged too.
            val title = (outline.firstOrNull(isTitle) ?: drawing.firstOrNull(isTitle))?.second
            val blocks = outline.filter { it.second != title }.map { it.second }.toMutableList()
            drawing.forEach { (_, text) ->
                if (text != title && text !in blocks) blocks.add(text)
            }
            LegacySlide(title, blocks)
        }.filter { it.title != null || it.blocks.isNotEmpty() }
    }

    companion object {
        const val SLIDE = 0x03EE
        const val NOTES = 0x03F0
        const val SLIDE_PERSIST_ATOM = 0x03F3
        const val MAIN_MASTER = 0x03F8
        const val HANDOUT = 0x0FC9
        const val SLIDE_LIST_WITH_TEXT = 0x0FF0
        const val TEXT_HEADER_ATOM = 0x0F9F
        const val TEXT_CHARS_ATOM = 0x0FA0
        const val TEXT_BYTES_ATOM = 0x0FA8
        const val TITLE = 0
        const val CENTER_TITLE = 6
    }
}
