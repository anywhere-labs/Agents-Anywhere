package com.agentsanywhere.app.ui.screens.sessiondetail

import android.content.ClipData
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.Clipboard
import androidx.compose.ui.platform.LocalClipboard

private const val SESSION_SELECTION_CLIP_LABEL = "plain text"

internal val LocalSessionSelectionCopyTokens = staticCompositionLocalOf<MutableMap<String, String>?> {
    null
}

@Composable
internal fun SessionSelectionContainer(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val copyTokens = remember { mutableStateMapOf<String, String>() }
    val platformClipboard = LocalClipboard.current
    val rewritingClipboard = remember(platformClipboard, copyTokens) {
        SessionSelectionClipboard(platformClipboard, copyTokens)
    }

    CompositionLocalProvider(
        LocalSessionSelectionCopyTokens provides copyTokens,
        LocalClipboard provides rewritingClipboard,
    ) {
        SelectionContainer(modifier = modifier, content = content)
    }
}

@Composable
internal fun RegisterSessionSelectionCopyToken(token: String, replacement: String) {
    val copyTokens = LocalSessionSelectionCopyTokens.current ?: return
    DisposableEffect(copyTokens, token, replacement) {
        copyTokens[token] = replacement
        onDispose {
            if (copyTokens[token] == replacement) {
                copyTokens.remove(token)
            }
        }
    }
}

private class SessionSelectionClipboard(
    private val delegate: Clipboard,
    private val replacements: Map<String, String>,
) : Clipboard {
    override suspend fun getClipEntry(): ClipEntry? {
        return delegate.getClipEntry()
    }

    override suspend fun setClipEntry(clipEntry: ClipEntry?) {
        val rewritten = rewriteClipEntry(clipEntry)
        delegate.setClipEntry(rewritten)
    }

    override val nativeClipboard
        get() = delegate.nativeClipboard

    private fun rewriteClipEntry(clipEntry: ClipEntry?): ClipEntry? {
        if (clipEntry == null || replacements.isEmpty()) return clipEntry
        val clipData = clipEntry.clipData
        if (clipData.itemCount != 1) return clipEntry
        val originalText = clipData.getItemAt(0).text?.toString() ?: return clipEntry
        val rewrittenText = rewriteSelectionText(originalText)
        if (rewrittenText == originalText) return clipEntry
        return ClipEntry(ClipData.newPlainText(SESSION_SELECTION_CLIP_LABEL, rewrittenText))
    }

    private fun rewriteSelectionText(text: String): String {
        var result = text
        replacements.forEach { (token, replacement) ->
            result = result.replace(token, "\n${replacement.trimEnd('\n')}\n")
        }
        return result
            .replace(Regex("\\n{3,}"), "\n\n")
            .trim('\n')
    }
}
