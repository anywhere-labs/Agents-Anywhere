package com.agentsanywhere.app.feature.files

import com.agentsanywhere.app.api.ApiException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

class FilePreviewKindTest {
    @Test
    fun requestedFormatsHaveRenderers() {
        assertEquals(FilePreviewKind.Pdf, filePreviewKind("季度报告.PDF"))
        assertEquals(FilePreviewKind.LegacyWord, filePreviewKind("方案.doc"))
        assertEquals(FilePreviewKind.Docx, filePreviewKind("方案 v2.docx"))
        assertEquals(FilePreviewKind.LegacyPowerPoint, filePreviewKind("deck.ppt"))
        assertEquals(FilePreviewKind.Pptx, filePreviewKind("deck.pptx"))
        assertEquals(FilePreviewKind.Html, filePreviewKind("index.html"))
        assertEquals(FilePreviewKind.Html, filePreviewKind("page.htm"))
        assertEquals(FilePreviewKind.Markdown, filePreviewKind("README.md"))
        assertEquals(FilePreviewKind.Xlsx, filePreviewKind("数据.xlsx"))
        assertEquals(FilePreviewKind.Csv, filePreviewKind("data.csv"))
        assertEquals(FilePreviewKind.Svg, filePreviewKind("chart.svg"))
        assertEquals(FilePreviewKind.Image, filePreviewKind("shot.png"))
        assertEquals(FilePreviewKind.Text, filePreviewKind("notes.txt"))
    }

    @Test
    fun extensionWinsOverAGenericMediaType() {
        // Python's mimetypes reports Markdown as application/octet-stream on some builds.
        assertEquals(FilePreviewKind.Markdown, filePreviewKind("report.md", "application/octet-stream"))
        assertEquals(FilePreviewKind.Pdf, filePreviewKind("download", "application/pdf"))
        assertEquals(FilePreviewKind.Unsupported, filePreviewKind("archive.zip", "application/zip"))
        assertEquals(FilePreviewKind.Unsupported, filePreviewKind("blob.bin"))
    }

    @Test
    fun documentsOpenThePreviewWhileSourceFilesKeepTheCodeBrowser() {
        listOf("a.pdf", "b.docx", "c.doc", "d.pptx", "e.ppt", "f.html", "g.md", "h.xlsx", "i.zip", "j.txt", "k.png")
            .forEach { assertTrue(it, opensInFilePreview("/ws/$it")) }
        listOf("Main.kt", "app.ts", "x.py", "conf.yaml", "data.json", "server.log", "Makefile", "/ws/dir/")
            .forEach { assertFalse(it, opensInFilePreview(it)) }
    }

    @Test
    fun mimeTypesFollowTheExtension() {
        assertEquals("application/pdf", fileMimeType("报告.pdf", "application/octet-stream"))
        assertEquals(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            fileMimeType("a.docx"),
        )
        assertEquals("text/markdown", fileMimeType("a.md", "application/octet-stream"))
        assertEquals("application/x-custom", fileMimeType("a.custom", "application/x-custom"))
        assertEquals("application/octet-stream", fileMimeType("noext", ""))
        assertEquals("audio/flac", fileMimeType("a.flac") { if (it == "flac") "audio/flac" else null })
    }

    @Test
    fun downloadsMimeTypeOnlyTrustsThePlatformTable() {
        val platform = mapOf("pdf" to "application/pdf", "txt" to "text/plain")
        assertEquals("application/pdf", downloadsMimeType("报告.pdf", platform::get))
        // Unknown to the platform: octet-stream keeps `server.log` from becoming `server.log.txt`.
        assertEquals("application/octet-stream", downloadsMimeType("server.log", platform::get))
        assertEquals("application/octet-stream", downloadsMimeType("README", platform::get))
    }

    @Test
    fun localFileNamesKeepChineseSpacesAndExtension() {
        assertEquals("季度 报告（终稿）.pdf", localFileName("季度 报告（终稿）.pdf"))
        assertEquals("报告.pdf", localFileName("/Users/me/报告.pdf"))
        assertEquals("a_b.md", localFileName("a\u0000b.md"))
        assertEquals("download", localFileName(".."))
        assertEquals("download", localFileName("   "))
        val long = "很".repeat(120) + ".pptx"
        val shortened = localFileName(long)
        assertTrue(shortened.endsWith(".pptx"))
        assertTrue(shortened.toByteArray(Charsets.UTF_8).size <= 200)
        val emoji = "📊".repeat(80) + ".xlsx"
        val shortenedEmoji = localFileName(emoji)
        assertTrue(shortenedEmoji.endsWith(".xlsx"))
        assertFalse(shortenedEmoji.dropLast(5).last().isHighSurrogate())
    }

    @Test
    fun cacheDirectoryChangesWithContent() {
        val cache = File("/tmp/cache")
        val first = filePreviewCacheDirectory(cache, "dev", "/ws/报告.pdf", "aa")
        assertEquals(first, filePreviewCacheDirectory(cache, "dev", "/ws/报告.pdf", "AA"))
        assertFalse(first == filePreviewCacheDirectory(cache, "dev", "/ws/报告.pdf", "bb"))
        assertFalse(first == filePreviewCacheDirectory(cache, "other", "/ws/报告.pdf", "aa"))
        assertEquals(File(cache, FILE_PREVIEW_CACHE_DIRECTORY), first.parentFile)
    }

    @Test
    fun pruneDropsStaleEntriesButKeepsTheCurrentOne() {
        val cache = Files.createTempDirectory("preview-cache").toFile()
        try {
            val root = File(cache, FILE_PREVIEW_CACHE_DIRECTORY).apply { mkdirs() }
            val now = System.currentTimeMillis()
            val stale = File(root, "stale").apply { mkdirs() }
            File(stale, "old.pdf").writeText("x")
            stale.setLastModified(now - 10L * 24 * 60 * 60 * 1000)
            val keep = File(root, "keep").apply { mkdirs() }
            File(keep, "new.pdf").writeText("y")
            keep.setLastModified(now - 10L * 24 * 60 * 60 * 1000)
            pruneFilePreviewCache(cache, keep = keep, now = now)
            assertFalse(stale.exists())
            assertTrue(keep.exists())
        } finally {
            cache.deleteRecursively()
        }
    }

    @Test
    fun failuresMapToTheCasesThePreviewExplains() {
        assertEquals(RemoteFileFailure.TooLarge, remoteFileFailure(ApiException("The file is too large to preview.", 413)))
        assertEquals(RemoteFileFailure.NotFound, remoteFileFailure(ApiException("file not found: /ws/报告.pdf", 502)))
        assertEquals(RemoteFileFailure.DeviceOffline, remoteFileFailure(ApiException("connector is offline", 409)))
        assertEquals(RemoteFileFailure.Other("transfer not found"), remoteFileFailure(ApiException("transfer not found", 404)))
        assertEquals(RemoteFileFailure.Other(null), remoteFileFailure(IllegalStateException()))
    }

    @Test
    fun uniqueDownloadNamesLikeTheDownloadsApp() {
        val directory = Files.createTempDirectory("downloads").toFile()
        try {
            assertEquals("报告.pdf", uniqueDownloadFile(directory, "报告.pdf").name)
            File(directory, "报告.pdf").writeText("1")
            assertEquals("报告 (1).pdf", uniqueDownloadFile(directory, "报告.pdf").name)
            File(directory, "报告 (1).pdf").writeText("2")
            assertEquals("报告 (2).pdf", uniqueDownloadFile(directory, "报告.pdf").name)
        } finally {
            directory.deleteRecursively()
        }
    }
}
