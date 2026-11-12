package com.agentsanywhere.app.feature.files.preview

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files

class LegacyOfficeConverterTest {
    private val directory = Files.createTempDirectory("legacy-preview").toFile()

    @After
    fun tearDown() {
        directory.deleteRecursively()
    }

    @Test
    fun wordTextComesFromThePieceTableWithoutFieldCodes() {
        val text = "第一段\r第二段 \u0013 HYPERLINK \"https://example.com\" \u0014链接\u0015结束\r表格A\u0007表格B\u0007\u0007"
        val file = File(directory, "旧版 报告.doc").apply { writeBytes(compoundFile(wordStreams(text))) }
        val extracted = extractWordText(CompoundFile.parse(file.readBytes()))
        assertEquals("第一段\n第二段 链接结束\n表格A\t表格B", extracted)
        val html = LegacyOfficeConverter.convertDoc(file, PreviewLabels(textOnlyNotice = "仅文字")).html
        assertTrue(html, html.contains("<p>第一段</p>"))
        assertTrue(html.contains("<p>第二段 链接结束</p>"))
        assertTrue(html.contains("<tr><td>表格A</td><td>表格B</td></tr>"))
        assertTrue(html.contains("仅文字"))
        assertFalse(html.contains("HYPERLINK"))
    }

    @Test
    fun powerPointSlidesCombineOutlineAndTextBoxes() {
        val file = File(directory, "旧版 方案.ppt").apply { writeBytes(compoundFile(powerPointStreams())) }
        val slides = extractPowerPointSlides(CompoundFile.parse(file.readBytes()))
        assertEquals(2, slides.size)
        assertEquals("标题一", slides[0].title)
        assertEquals(listOf("要点\n细节", "文本框"), slides[0].blocks)
        assertEquals("Second", slides[1].title)
        val html = LegacyOfficeConverter.convertPpt(file, PreviewLabels(slide = { "第 $it 页" })).html
        assertTrue(html, html.contains("第 1 页"))
        assertTrue(html.contains("<h2 class=\"slide-title\">标题一</h2>"))
        assertTrue(html.contains("<p>细节</p>"))
        assertFalse("notes are skipped", html.contains("备注"))
    }

    @Test
    fun powerPointTitlesAlsoComeFromSlideDrawings() {
        // LibreOffice writes slide text only into the drawing, tagged with its text type.
        fun atom(type: Int, body: ByteArray): ByteArray = header(0, type, body.size) + body
        fun container(type: Int, instance: Int, vararg children: ByteArray): ByteArray {
            val body = children.fold(ByteArray(0)) { acc, child -> acc + child }
            return header((instance shl 4) or 0x000F, type, body.size) + body
        }
        fun int(value: Int) = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array()
        val chars = { value: String -> atom(0x0FA0, value.toByteArray(Charsets.UTF_16LE)) }
        val document = container(0x03E8, 0, container(0x0FF0, 0, atom(0x03F3, ByteArray(20))))
        val slide = container(
            0x03EE, 0,
            container(
                0x040C, 0,
                container(0xF00D, 0, atom(0x0F9F, int(0)), chars("背景")),
                container(0xF00D, 0, atom(0x0F9F, int(4)), chars("要点")),
            ),
        )
        val file = File(directory, "libreoffice.ppt").apply {
            writeBytes(compoundFile(linkedMapOf("PowerPoint Document" to document + slide)))
        }
        val slides = extractPowerPointSlides(CompoundFile.parse(file.readBytes()))
        assertEquals(listOf(LegacySlide("背景", listOf("要点"))), slides)
    }

    @Test
    fun nonCompoundFilesAreRejected() {
        val file = File(directory, "fake.doc").apply { writeText("plain text pretending to be a doc") }
        val error = runCatching { LegacyOfficeConverter.convertDoc(file) }.exceptionOrNull()
        assertTrue(error is PreviewUnavailableException)
    }

    private fun wordStreams(text: String): Map<String, ByteArray> {
        val textOffset = 0x800
        val textBytes = text.toByteArray(Charsets.UTF_16LE)
        val document = ByteBuffer.allocate(textOffset + textBytes.size).order(ByteOrder.LITTLE_ENDIAN)
        document.putShort(0, 0xA5EC.toShort())
        document.putShort(2, 0x00C1)
        document.putShort(0x0A, 0x0200) // fWhichTblStm: the piece table lives in 1Table.
        document.putInt(0x4C, text.length)
        document.putInt(0x01A2, 0)
        document.putInt(0x01A6, 1 + 4 + 16)
        document.position(textOffset)
        document.put(textBytes)
        val table = ByteBuffer.allocate(21).order(ByteOrder.LITTLE_ENDIAN)
        table.put(0x02)
        table.putInt(16)
        table.putInt(0)
        table.putInt(text.length)
        table.putShort(0)
        table.putInt(textOffset) // Uncompressed UTF-16 piece.
        table.putShort(0)
        return linkedMapOf("WordDocument" to document.array(), "1Table" to table.array())
    }

    private fun powerPointStreams(): Map<String, ByteArray> {
        fun atom(type: Int, body: ByteArray, instance: Int = 0): ByteArray =
            header(instance shl 4, type, body.size) + body
        fun container(type: Int, instance: Int = 0, vararg children: ByteArray): ByteArray {
            val body = children.fold(ByteArray(0)) { acc, child -> acc + child }
            return header((instance shl 4) or 0x000F, type, body.size) + body
        }
        fun int(value: Int) = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array()
        val chars = { value: String -> atom(0x0FA0, value.toByteArray(Charsets.UTF_16LE)) }
        val slideList = container(
            0x0FF0, 0,
            atom(0x03F3, ByteArray(20)),
            atom(0x0F9F, int(0)), chars("标题一"),
            atom(0x0F9F, int(1)), chars("要点\r细节"),
            atom(0x03F3, ByteArray(20)),
            atom(0x0F9F, int(0)), atom(0x0FA8, "Second".toByteArray(Charsets.ISO_8859_1)),
        )
        val notesList = container(0x0FF0, 2, atom(0x03F3, ByteArray(20)), chars("备注"))
        val document = container(0x03E8, 0, slideList, notesList)
        val slide = container(0x03EE, 0, container(0x040C, 0, container(0xF00D, 0, atom(0x0F9F, int(4)), chars("文本框"))))
        val notes = container(0x03F0, 0, chars("备注"))
        return linkedMapOf("PowerPoint Document" to document + slide + notes + container(0x03EE, 0))
    }

    private fun header(versionAndInstance: Int, type: Int, length: Int): ByteArray {
        return ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
            .putShort(versionAndInstance.toShort())
            .putShort(type.toShort())
            .putInt(length)
            .array()
    }

    /** Writes a version 3 compound file whose streams all live in regular 512-byte sectors. */
    private fun compoundFile(streams: Map<String, ByteArray>): ByteArray {
        val sectorSize = 512
        val padded = streams.mapValues { (_, bytes) -> bytes.copyOf(maxOf(4096, roundUp(bytes.size, sectorSize))) }
        val fat = IntArray(sectorSize / 4) { -1 }
        fat[0] = -3 // FAT sector
        fat[1] = -2 // Directory, one sector
        var next = 2
        val starts = LinkedHashMap<String, Int>()
        padded.forEach { (name, bytes) ->
            val count = bytes.size / sectorSize
            starts[name] = next
            for (index in 0 until count) {
                fat[next + index] = if (index == count - 1) -2 else next + index + 1
            }
            next += count
        }
        val output = ByteArrayOutputStream()
        val header = ByteBuffer.allocate(sectorSize).order(ByteOrder.LITTLE_ENDIAN)
        header.put(byteArrayOf(0xD0.toByte(), 0xCF.toByte(), 0x11, 0xE0.toByte(), 0xA1.toByte(), 0xB1.toByte(), 0x1A, 0xE1.toByte()))
        header.putShort(0x18, 0x003E)
        header.putShort(0x1A, 0x0003)
        header.putShort(0x1C, 0xFFFE.toShort())
        header.putShort(0x1E, 9)
        header.putShort(0x20, 6)
        header.putInt(0x2C, 1)
        header.putInt(0x30, 1)
        header.putInt(0x38, 4096)
        header.putInt(0x3C, -2)
        header.putInt(0x44, -2)
        header.putInt(0x4C, 0)
        for (index in 1 until 109) header.putInt(0x4C + index * 4, -1)
        output.write(header.array())
        val fatSector = ByteBuffer.allocate(sectorSize).order(ByteOrder.LITTLE_ENDIAN)
        fat.forEach { fatSector.putInt(it) }
        output.write(fatSector.array())
        val directory = ByteBuffer.allocate(sectorSize).order(ByteOrder.LITTLE_ENDIAN)
        fun entry(index: Int, name: String, type: Int, start: Int, size: Int) {
            val base = index * 128
            val nameBytes = (name + "\u0000").toByteArray(Charsets.UTF_16LE)
            directory.position(base)
            directory.put(nameBytes)
            directory.putShort(base + 0x40, nameBytes.size.toShort())
            directory.put(base + 0x42, type.toByte())
            directory.put(base + 0x43, 1)
            directory.putInt(base + 0x44, -1)
            directory.putInt(base + 0x48, if (index + 1 <= padded.size && index > 0) index + 1 else -1)
            directory.putInt(base + 0x4C, if (index == 0) 1 else -1)
            directory.putInt(base + 0x74, start)
            directory.putLong(base + 0x78, size.toLong())
        }
        entry(0, "Root Entry", 5, -2, 0)
        padded.keys.forEachIndexed { index, name -> entry(index + 1, name, 2, starts.getValue(name), padded.getValue(name).size) }
        output.write(directory.array())
        padded.values.forEach { output.write(it) }
        return output.toByteArray()
    }

    private fun roundUp(value: Int, step: Int) = (value + step - 1) / step * step
}
