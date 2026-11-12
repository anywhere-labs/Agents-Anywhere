package com.agentsanywhere.app.feature.files

import org.junit.Assert.assertEquals
import org.junit.Test

class GeneratedFilesTest {
    @Test
    fun linkedDocumentsBecomeFileCardsInOrder() {
        val markdown = """
            已生成以下文件：

            - [季度报告](</Users/me/out/季度 报告.pdf>)
            - 演示文稿：`out/方案 v2.pptx`
            - 数据：[data](out/%E6%95%B0%E6%8D%AE.xlsx)
            - 源码改动见 [main.kt](src/main.kt:12) 和 `README.md`
            - 页面：[index](file:///Users/me/out/index.html)
        """.trimIndent()
        assertEquals(
            listOf("/Users/me/out/季度 报告.pdf", "out/方案 v2.pptx", "out/数据.xlsx", "/Users/me/out/index.html"),
            deliverableFileReferences(markdown),
        )
    }

    @Test
    fun webLinksCodeBlocksAndDuplicatesAreSkipped() {
        val markdown = """
            See [spec](https://example.com/spec.pdf) and [the report](out/report.pdf).
            Again: `out/report.pdf`

            ```bash
            open out/other.pdf
            ```
        """.trimIndent()
        assertEquals(listOf("out/report.pdf"), deliverableFileReferences(markdown))
    }

    @Test
    fun cardCountIsLimited() {
        val markdown = (1..8).joinToString("\n") { "- [f$it](out/f$it.docx)" }
        assertEquals(4, deliverableFileReferences(markdown).size)
        assertEquals(emptyList<String>(), deliverableFileReferences(""))
    }
}
