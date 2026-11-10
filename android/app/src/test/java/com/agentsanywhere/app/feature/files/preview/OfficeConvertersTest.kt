package com.agentsanywhere.app.feature.files.preview

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class OfficeConvertersTest {
    private val directory = Files.createTempDirectory("office-preview").toFile()

    @After
    fun tearDown() {
        directory.deleteRecursively()
    }

    @Test
    fun docxRendersHeadingsListsTablesLinksAndImages() {
        val file = zip(
            "季度报告.docx",
            "[Content_Types].xml" to "<Types/>",
            "_rels/.rels" to rels("rId1" to ("officeDocument" to "word/document.xml")),
            "word/_rels/document.xml.rels" to rels(
                "rId5" to ("image" to "media/image1.png"),
                "rId9" to ("hyperlink" to "https://example.com/详情"),
                external = setOf("rId9"),
            ),
            "word/styles.xml" to """
                <w:styles xmlns:w="$W">
                  <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style>
                  <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/>
                    <w:pPr><w:numPr><w:numId w:val="7"/></w:numPr></w:pPr></w:style>
                </w:styles>
            """.trimIndent(),
            "word/numbering.xml" to """
                <w:numbering xmlns:w="$W">
                  <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/></w:lvl></w:abstractNum>
                  <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum>
                  <w:num w:numId="7"><w:abstractNumId w:val="0"/></w:num>
                  <w:num w:numId="8"><w:abstractNumId w:val="1"/></w:num>
                </w:numbering>
            """.trimIndent(),
            "word/document.xml" to """
                <w:document xmlns:w="$W" xmlns:r="$R" xmlns:wp="$WP" xmlns:a="$A" xmlns:pic="$PIC">
                  <w:body>
                    <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>第一章 概述</w:t></w:r></w:p>
                    <w:p><w:pPr><w:jc w:val="center"/></w:pPr>
                      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">重点 </w:t></w:r>
                      <w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r>
                      <w:hyperlink r:id="rId9"><w:r><w:t>链接</w:t></w:r></w:hyperlink>
                    </w:p>
                    <w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>要点一</w:t></w:r></w:p>
                    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="8"/></w:numPr></w:pPr><w:r><w:t>步骤</w:t></w:r></w:p>
                    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="8"/></w:numPr></w:pPr><w:r><w:t>步骤</w:t></w:r></w:p>
                    <w:tbl>
                      <w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并标题</w:t></w:r></w:p></w:tc></w:tr>
                      <w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>纵向</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr>
                      <w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
                    </w:tbl>
                    <w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/>
                      <a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic>
                    </wp:inline></w:drawing></w:r></w:p>
                  </w:body>
                </w:document>
            """.trimIndent(),
            "word/media/image1.png" to "PNG",
        )
        val result = DocxHtmlConverter.convert(file, PreviewLabels(simplifiedNotice = "简化预览"))
        val html = result.html
        assertTrue(html, html.contains("<h1>第一章 概述</h1>"))
        assertTrue(html.contains("style=\"text-align:center\""))
        assertTrue(html.contains("<b>重点 </b>"))
        assertTrue("text must be escaped", html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"))
        assertFalse(html.contains("<script>alert"))
        assertTrue(html.contains("<a href=\"https://example.com/详情\">链接</a>"))
        assertTrue(html.contains(">•</span>"))
        assertTrue(html.contains(">1.</span>"))
        assertTrue(html.contains(">2.</span>"))
        assertTrue(html.contains("<td colspan=\"2\">"))
        assertTrue(html.contains("<td rowspan=\"2\">"))
        assertTrue(html.contains("<img src=\"media/0.png\" style=\"width:100px\""))
        assertTrue(html.contains("简化预览"))
        assertEquals(mapOf("media/0.png" to "word/media/image1.png"), result.media)
    }

    @Test
    fun pptxRendersSlidesInPresentationOrder() {
        val slide = { title: String, body: String ->
            """
            <p:sld xmlns:p="$P" xmlns:a="$A" xmlns:r="$R"><p:cSld><p:spTree>
              <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>
                <p:spPr/><p:txBody><a:p><a:r><a:t>$body</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:rPr b="1"/><a:t>细节</a:t></a:r></a:p></p:txBody></p:sp>
              <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
                <p:spPr/><p:txBody><a:p><a:r><a:t>$title</a:t></a:r></a:p></p:txBody></p:sp>
              <p:sp><p:nvSpPr><p:cNvPr id="4" name="Footer"/><p:cNvSpPr/><p:nvPr><p:ph type="ftr"/></p:nvPr></p:nvSpPr>
                <p:spPr/><p:txBody><a:p><a:r><a:t>页脚</a:t></a:r></a:p></p:txBody></p:sp>
            </p:spTree></p:cSld></p:sld>
            """.trimIndent()
        }
        val file = zip(
            "方案.pptx",
            "_rels/.rels" to rels("rId1" to ("officeDocument" to "ppt/presentation.xml")),
            "ppt/_rels/presentation.xml.rels" to rels(
                "rId2" to ("slide" to "slides/slide1.xml"),
                "rId3" to ("slide" to "slides/slide2.xml"),
            ),
            "ppt/presentation.xml" to """
                <p:presentation xmlns:p="$P" xmlns:r="$R"><p:sldIdLst>
                  <p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/>
                </p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>
            """.trimIndent(),
            "ppt/slides/slide1.xml" to slide("第二张", "内容 B"),
            "ppt/slides/slide2.xml" to slide("第一张", "内容 A"),
        )
        val html = PptxHtmlConverter.convert(file, PreviewLabels(slide = { "第 $it 页" })).html
        val first = html.indexOf("第一张")
        val second = html.indexOf("第二张")
        assertTrue(html, first in 0 until second)
        assertTrue(html.contains("第 1 页") && html.contains("第 2 页"))
        assertTrue(html.contains("<h2 class=\"slide-title\">第一张</h2>"))
        assertTrue("title comes before body", html.indexOf("第一张") < html.indexOf("内容 A"))
        assertTrue(html.contains("<b>细节</b>"))
        assertFalse("footers are skipped", html.contains("页脚"))
    }

    @Test
    fun xlsxRendersSharedStringsNumbersDatesAndMerges() {
        val file = zip(
            "数据.xlsx",
            "_rels/.rels" to rels("rId1" to ("officeDocument" to "xl/workbook.xml")),
            "xl/_rels/workbook.xml.rels" to rels(
                "rId1" to ("worksheet" to "worksheets/sheet1.xml"),
                "rId2" to ("sharedStrings" to "sharedStrings.xml"),
                "rId3" to ("styles" to "styles.xml"),
            ),
            "xl/workbook.xml" to """
                <workbook xmlns="$S" xmlns:r="$R"><sheets><sheet name="销售" sheetId="1" r:id="rId1"/></sheets></workbook>
            """.trimIndent(),
            "xl/sharedStrings.xml" to """
                <sst xmlns="$S"><si><t>地区</t></si><si><r><t>华</t></r><r><t>东</t></r></si></sst>
            """.trimIndent(),
            "xl/styles.xml" to """
                <styleSheet xmlns="$S"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>
            """.trimIndent(),
            "xl/worksheets/sheet1.xml" to """
                <worksheet xmlns="$S"><sheetData>
                  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>日期</t></is></c></row>
                  <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="1"><v>45658</v></c><c r="C2"><v>0.30000000000000004</v></c></row>
                  <row r="4"><c r="A4" t="b"><v>1</v></c><c r="B4"><v>1e-11</v></c><c r="C4"><v>-1e-12</v></c><c r="D4"><v>0.123456789012345</v></c></row>
                </sheetData><mergeCells><mergeCell ref="B1:C1"/></mergeCells></worksheet>
            """.trimIndent(),
        )
        val html = SpreadsheetHtmlConverter.convertXlsx(file).html
        assertTrue(html, html.contains("<h2>销售</h2>"))
        assertTrue(html.contains(">地区</td>"))
        assertTrue(html.contains(">华东</td>"))
        assertTrue(html.contains("<td colspan=\"2\">日期</td>"))
        assertTrue(html.contains(">2025-01-01</td>"))
        assertTrue(html.contains(">0.30000000000000004</td>"))
        assertTrue(html.contains(">0.00000000001</td>"))
        assertTrue(html.contains(">-0.000000000001</td>"))
        assertTrue(html.contains(">0.123456789012345</td>"))
        assertTrue(html.contains(">TRUE</td>"))
        assertTrue("row numbers follow the sheet", html.contains("<th class=\"row\">4</th>"))
    }

    @Test
    fun csvParsingHandlesQuotesNewlinesAndDelimiters() {
        val rows = parseDelimited("名称,备注\n\"A, B\",\"第一行\n第二行\"\n\"引号\"\"\",x\n", ',', 10)
        assertEquals(listOf(listOf("名称", "备注"), listOf("A, B", "第一行\n第二行"), listOf("引号\"", "x")), rows)
        assertEquals(';', SpreadsheetHtmlConverter.delimiterFor("a.csv", "a;b;c\n1;2;3"))
        assertEquals('\t', SpreadsheetHtmlConverter.delimiterFor("a.tsv", "a,b"))
        val html = SpreadsheetHtmlConverter.convertDelimited("a,b\n1,<b>\n", ',', textTruncated = false).html
        assertTrue(html.contains("<td class=\"num\">1</td><td>&lt;b&gt;</td>"))
    }

    @Test
    fun gbkTextIsDecoded() {
        val bytes = "名称,数量\n苹果,3\n".toByteArray(charset("GB18030"))
        assertEquals("名称,数量\n苹果,3\n", decodePreviewText(bytes))
        assertEquals("报告", decodePreviewText(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + "报告".toByteArray()))
        // A UTF-8 file cut in the middle of a character still decodes as UTF-8.
        val cut = "预览文本".toByteArray().copyOf(10)
        assertEquals("预览文", decodePreviewText(cut, truncated = true))
    }

    @Test
    fun markdownRewritesWorkDeviceImagesAndLinks() {
        val html = MarkdownHtmlConverter.convert(
            """
            # 报告

            ![图](images/图%201.png) ![remote](https://example.com/a.png)

            [附录](appendix.md) [site](https://example.com) [top](#报告)

            | a | b |
            |---|---|
            | 1 | 2 |
            """.trimIndent(),
            documentPath = "/ws/docs/report.md",
        )
        assertTrue(html, html.contains("<h1>报告</h1>"))
        assertTrue(html.contains("src=\"https://appassets.androidplatform.net/fs?path=%2Fws%2Fdocs%2Fimages%2F%E5%9B%BE%201.png\""))
        assertTrue(html.contains("src=\"https://example.com/a.png\""))
        assertTrue(html.contains("href=\"https://appassets.androidplatform.net/open?path=%2Fws%2Fdocs%2Fappendix.md\""))
        assertTrue(html.contains("href=\"https://example.com\""))
        assertTrue(html.contains("<table>"))
    }

    @Test
    fun yamlFrontMatterBecomesATable() {
        val html = MarkdownHtmlConverter.convert("---\ntitle: 产品方案 v2\nauthor: \"Agent\"\n---\n\n# 背景\n", "/ws/a.md")
        assertTrue(html, html.contains("<table class=\"front-matter\"><tr><th>title</th><td>产品方案 v2</td></tr>"))
        assertTrue(html.contains("<td>Agent</td>"))
        assertTrue(html.contains("<h1>背景</h1>"))
        // A thematic break followed by prose is not front matter.
        val (entries, rest) = splitFrontMatter("---\nJust a sentence here.\n---\ntext")
        assertTrue(entries.isEmpty())
        assertEquals("---\nJust a sentence here.\n---\ntext", rest)
    }

    @Test
    fun brokenPackagesReportAPreviewError() {
        val notZip = File(directory, "broken.docx").apply { writeText("not a zip") }
        val error = runCatching { DocxHtmlConverter.convert(notZip) }.exceptionOrNull()
        assertTrue(error is PreviewUnavailableException)
    }

    private fun zip(name: String, vararg entries: Pair<String, String>): File {
        val file = File(directory, name)
        ZipOutputStream(file.outputStream()).use { output ->
            entries.forEach { (entry, content) ->
                output.putNextEntry(ZipEntry(entry))
                output.write(content.toByteArray(Charsets.UTF_8))
                output.closeEntry()
            }
        }
        return file
    }

    private fun rels(vararg items: Pair<String, Pair<String, String>>, external: Set<String> = emptySet()): String {
        return buildString {
            append("<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">")
            items.forEach { (id, value) ->
                val (type, target) = value
                append("<Relationship Id=\"$id\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/$type\" Target=\"$target\"")
                if (id in external) append(" TargetMode=\"External\"")
                append("/>")
            }
            append("</Relationships>")
        }
    }

    private companion object {
        const val W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
        const val R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        const val WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
        const val A = "http://schemas.openxmlformats.org/drawingml/2006/main"
        const val PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture"
        const val P = "http://schemas.openxmlformats.org/presentationml/2006/main"
        const val S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    }
}
