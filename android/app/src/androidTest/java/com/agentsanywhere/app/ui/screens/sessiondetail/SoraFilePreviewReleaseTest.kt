package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/**
 * The file preview editor must stop its TextMate analyzer thread when the preview leaves the
 * screen. Detaching the view does not do that; while the thread runs it keeps the file's text and
 * styles reachable, so every opened preview stays allocated for the lifetime of the process.
 */
@RunWith(AndroidJUnit4::class)
class SoraFilePreviewReleaseTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private var visible by mutableStateOf(true)
    private val searchController = SoraFileSearchController()

    @Test
    fun leavingTheScreenStopsTheAnalyzerThread() {
        val baseline = analyzerThreadCount()
        val code = buildString {
            repeat(200) { index ->
                append("val item$index = map[\"key$index\"] ?: fallback($index)\n")
            }
        }

        rule.setContent {
            Column {
                if (visible) {
                    SoraFilePreview(
                        text = code,
                        languageHint = "kotlin",
                        darkMode = false,
                        searchQuery = "",
                        searchController = searchController,
                        onSearchResult = {},
                    )
                }
            }
        }
        rule.waitForIdle()
        assertTrue(
            "the preview should start its analyzer thread, baseline=$baseline",
            waitForAnalyzerThreadCount(baseline + 1),
        )

        rule.runOnUiThread { visible = false }
        rule.waitForIdle()
        assertTrue(
            "the analyzer thread should stop once the preview leaves the screen, baseline=$baseline",
            waitForAnalyzerThreadCount(baseline),
        )
        assertEquals(baseline, analyzerThreadCount())
    }

    private fun analyzerThreadCount(): Int =
        Thread.getAllStackTraces().keys.count { it.name.startsWith(ANALYZER_THREAD_PREFIX) }

    private fun waitForAnalyzerThreadCount(expected: Int): Boolean {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            if (analyzerThreadCount() == expected) return true
            Thread.sleep(100)
        }
        return analyzerThreadCount() == expected
    }

    private companion object {
        const val ANALYZER_THREAD_PREFIX = "AsyncAnalyzer"
    }
}
