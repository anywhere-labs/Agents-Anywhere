package com.agentsanywhere.app.feature.files

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionFileLinksTest {
    @Test
    fun plainLinkDestinationsKeepChineseNamesAndSpaces() {
        assertEquals("/Users/me/报告/季度 总结.pdf", sessionFileLinkPath("/Users/me/报告/季度 总结.pdf"))
        assertEquals("out/report.docx", sessionFileLinkPath("out/report.docx"))
        assertEquals("~/Desktop/方案.pptx", sessionFileLinkPath("~/Desktop/方案.pptx"))
    }

    @Test
    fun angleBracketAndPercentEncodedDestinationsDecode() {
        assertEquals("/Users/me/My Docs/报告.pdf", sessionFileLinkPath("</Users/me/My Docs/报告.pdf>"))
        assertEquals("/Users/me/My Docs/报告.pdf", sessionFileLinkPath("/Users/me/My%20Docs/%E6%8A%A5%E5%91%8A.pdf"))
        assertEquals("docs/a b.md", sessionFileLinkPath("docs/a%20b.md"))
    }

    @Test
    fun invalidPercentEscapesKeepTheRawName() {
        assertEquals("notes/100%.md", sessionFileLinkPath("notes/100%.md"))
        assertEquals("notes/%ZZ.md", sessionFileLinkPath("notes/%ZZ.md"))
        // %E6%8A alone is not valid UTF-8.
        assertEquals("a%E6%8A.md", sessionFileLinkPath("a%E6%8A.md"))
    }

    @Test
    fun fileUrisBecomePaths() {
        assertEquals("/Users/me/My Docs/报告.pdf", sessionFileLinkPath("file:///Users/me/My%20Docs/%E6%8A%A5%E5%91%8A.pdf"))
        assertEquals("/tmp/a.html", sessionFileLinkPath("file://localhost/tmp/a.html"))
        assertEquals("C:/Users/me/报告.docx", sessionFileLinkPath("file:///C:/Users/me/%E6%8A%A5%E5%91%8A.docx"))
        assertEquals("//server/share/deck.pptx", sessionFileLinkPath("file://server/share/deck.pptx"))
        assertEquals("/tmp/a.md", sessionFileLinkPath("FILE:///tmp/a.md#L3"))
    }

    @Test
    fun lineSuffixesAreRemoved() {
        assertEquals("src/app.ts", sessionFileLinkPath("src/app.ts:42"))
        assertEquals("src/app.ts", sessionFileLinkPath("src/app.ts:42:7"))
        assertEquals("src/app.ts", sessionFileLinkPath("src/app.ts#L10"))
        assertEquals("src/app.ts", sessionFileLinkPath("src/app.ts#L10C2"))
        assertEquals("src/app.ts", sessionFileLinkPath("src/app.ts#L10-L20"))
        assertEquals("notes/C#入门.md", sessionFileLinkPath("notes/C#入门.md"))
    }

    @Test
    fun windowsPathsStayIntact() {
        assertEquals("C:\\Users\\me\\报告 终稿.docx", sessionFileLinkPath("C:\\Users\\me\\报告 终稿.docx"))
        assertEquals("C:/repo/main.rs", sessionFileLinkPath("/C:/repo/main.rs:12:5"))
    }

    @Test
    fun webUrlsAnchorsAndOtherSchemesAreNotFiles() {
        assertNull(sessionFileLinkPath("https://example.com/report.pdf"))
        assertNull(sessionFileLinkPath("http://example.com"))
        assertNull(sessionFileLinkPath("mailto:a@example.com"))
        assertNull(sessionFileLinkPath("#section"))
        assertNull(sessionFileLinkPath("//cdn.example.com/a.js"))
        assertNull(sessionFileLinkPath("vscode://file/x.ts"))
        assertNull(sessionFileLinkPath("data:image/png;base64,AAAA"))
        assertNull(sessionFileLinkPath("   "))
    }

    @Test
    fun inlineCodeKeepsExistingPathDetection() {
        assertEquals("src/app.ts", inlineCodeFilePath("src/app.ts:42"))
        assertEquals("/abs/out/report.pdf", inlineCodeFilePath("/abs/out/report.pdf"))
        assertNull(inlineCodeFilePath("console.log"))
        assertNull(inlineCodeFilePath("index.ts"))
        assertNull(inlineCodeFilePath("https://example.com/a.pdf"))
        assertNull(inlineCodeFilePath("v1.2.3"))
        assertNull(inlineCodeFilePath("*.pdf"))
    }

    @Test
    fun inlineCodeAcceptsDocumentNamesWithChineseAndSpaces() {
        assertEquals("季度报告.pdf", inlineCodeFilePath("季度报告.pdf"))
        assertEquals("季度 报告.docx", inlineCodeFilePath("季度 报告.docx"))
        assertEquals("README.md", inlineCodeFilePath("README.md"))
        assertEquals("/Users/me/My Docs/方案 v2.pptx", inlineCodeFilePath("/Users/me/My Docs/方案 v2.pptx"))
        assertEquals("C:\\工作\\数据 汇总.xlsx", inlineCodeFilePath("C:\\工作\\数据 汇总.xlsx"))
        assertEquals("out/报告.pdf", inlineCodeFilePath("out/报告.pdf"))
        assertEquals("/tmp/a b.html", inlineCodeFilePath("file:///tmp/a%20b.html"))
    }

    @Test
    fun inlineCodeRejectsCommandsThatMentionFiles() {
        assertNull(inlineCodeFilePath("open report.pdf"))
        assertNull(inlineCodeFilePath("cat README.md"))
        assertNull(inlineCodeFilePath("ls -la out/report.pdf"))
        assertNull(inlineCodeFilePath("python gen.py --out report.pdf"))
        assertNull(inlineCodeFilePath("pandoc a.md -o b.pdf"))
        assertNull(inlineCodeFilePath("open out/a.pdf"))
        assertNull(inlineCodeFilePath("echo hi > out.txt"))
        assertNull(inlineCodeFilePath("src/main.kt foo"))
    }

    @Test
    fun linkDestinationsWithSpacesAreWrappedForCommonMark() {
        assertEquals(
            "见 [报告](<out/季度 报告.pdf>) 和 [说明](<out/季度 报告.md:12>)",
            normalizeSpacedLinkDestinations("见 [报告](out/季度 报告.pdf) 和 [说明](out/季度 报告.md:12)"),
        )
        assertEquals("![图](<images/图 1.png>)", normalizeSpacedLinkDestinations("![图](images/图 1.png)"))
        val unchanged = listOf(
            "[a](out/report.pdf)",
            "[a](<out/a b.pdf>)",
            "[a](out/a.md \"Title\")",
            "[a](https://example.com/a b.pdf)",
            "`[a](out/a b.pdf)`",
            "[a](foo) bar (not a link.pdf)",
        )
        unchanged.forEach { assertEquals(it, normalizeSpacedLinkDestinations(it)) }
        val fenced = "```md\n[a](out/a b.pdf)\n```\n[b](out/c d.docx)"
        assertEquals("```md\n[a](out/a b.pdf)\n```\n[b](<out/c d.docx>)", normalizeSpacedLinkDestinations(fenced))
        assertEquals("[a](<file:///tmp/a b.pdf>)", normalizeSpacedLinkDestinations("[a](file:///tmp/a b.pdf)"))
    }

    @Test
    fun documentRelativeLinksResolveAgainstTheDocument() {
        assertEquals("/ws/docs/images/图 1.png", resolveDocumentLinkPath("/ws/docs/report.md", "images/%E5%9B%BE%201.png"))
        assertEquals("/ws/assets/a.png", resolveDocumentLinkPath("/ws/docs/report.md", "../assets/a.png"))
        assertEquals("/abs/x.png", resolveDocumentLinkPath("/ws/docs/report.md", "/abs/x.png"))
        assertEquals("C:\\ws\\img\\a.png", resolveDocumentLinkPath("C:\\ws\\report.md", "img/a.png"))
        assertNull(resolveDocumentLinkPath("/ws/report.md", "https://example.com/a.png"))
    }
}
