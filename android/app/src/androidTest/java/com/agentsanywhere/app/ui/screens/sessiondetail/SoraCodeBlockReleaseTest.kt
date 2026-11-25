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
 * A code block that leaves the timeline must stop Sora's TextMate analyzer thread. Sora only
 * creates that thread when the editor gets a language, and detaching the view does not stop it;
 * while it runs it keeps the block's text and styles reachable, so the memory of every visited
 * block stays allocated for the lifetime of the process.
 */
@RunWith(AndroidJUnit4::class)
class SoraCodeBlockReleaseTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private var visible by mutableStateOf(true)

    @Test
    fun leavingTheCompositionStopsTheAnalyzerThread() {
        val baseline = analyzerThreadCount()
        val code = buildString {
            repeat(200) { index ->
                append("val item$index = map[\"key$index\"] ?: fallback($index)\n")
            }
        }

        rule.setContent {
            Column {
                if (visible) {
                    SoraCodeBlock(text = code, languageHint = "kotlin", darkMode = false)
                }
            }
        }
        rule.waitForIdle()
        assertTrue(
            "the editor should start its analyzer thread, baseline=$baseline",
            waitForAnalyzerThreadCount(baseline + 1),
        )

        rule.runOnUiThread { visible = false }
        rule.waitForIdle()
        assertTrue(
            "the analyzer thread should stop once the block leaves the composition, baseline=$baseline",
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
