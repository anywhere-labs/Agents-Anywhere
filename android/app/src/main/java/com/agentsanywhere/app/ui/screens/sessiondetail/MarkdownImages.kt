package com.agentsanywhere.app.ui.screens.sessiondetail

import android.text.Html
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil3.compose.SubcomposeAsyncImage
import coil3.compose.SubcomposeAsyncImageContent
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.X
import me.saket.telephoto.zoomable.coil3.ZoomableAsyncImage
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.node.Emphasis
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.Link
import org.commonmark.node.Node
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text

internal sealed interface MarkdownImagePart {
    data class Words(val nodes: List<Node>) : MarkdownImagePart
    data class Picture(val source: String, val description: String) : MarkdownImagePart
}

// Only recognize image tags. Never execute arbitrary HTML or scripts from a message.
private val imageTag = Regex("""<img\b(?:[^<>"']|"[^"]*"|'[^']*')*>""", RegexOption.IGNORE_CASE)
private val htmlAttribute = Regex("""([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>]+))""")

internal fun splitMarkdownImages(
    nodes: List<Node>,
    restoreLiteral: (String) -> String = { it },
): List<MarkdownImagePart> {
    val result = mutableListOf<MarkdownImagePart>()
    val words = mutableListOf<Node>()
    fun flush() {
        // A line break bordering a block image doesn't need its own empty text row.
        while (words.firstOrNull() is org.commonmark.node.SoftLineBreak || words.firstOrNull() is org.commonmark.node.HardLineBreak) words.removeAt(0)
        while (words.lastOrNull() is org.commonmark.node.SoftLineBreak || words.lastOrNull() is org.commonmark.node.HardLineBreak) words.removeAt(words.lastIndex)
        if (words.isNotEmpty()) result += MarkdownImagePart.Words(words.toList())
        words.clear()
    }
    fun add(part: MarkdownImagePart) {
        when (part) {
            is MarkdownImagePart.Words -> words.addAll(part.nodes)
            is MarkdownImagePart.Picture -> { flush(); result += part }
        }
    }
    nodes.forEach { node ->
        when (node) {
            is Image -> {
                fun altText(n: Node): String = when (n) {
                    is Text -> n.literal
                    is org.commonmark.node.Code -> n.literal
                    else -> n.childrenForImages().joinToString("") { altText(it) }
                }
                add(MarkdownImagePart.Picture(restoreLiteral(node.destination), restoreLiteral(altText(node))))
            }
            is HtmlInline -> {
                val literal = restoreLiteral(node.literal)
                var end = 0
                imageTag.findAll(literal).forEach { match ->
                    if (match.range.first > end) words += Text(literal.substring(end, match.range.first))
                    val attributes = htmlAttribute.findAll(match.value).associate { attr ->
                        attr.groupValues[1].lowercase() to Html.fromHtml(
                            attr.groups[2]?.value ?: attr.groups[3]?.value ?: attr.groupValues[4],
                            Html.FROM_HTML_MODE_LEGACY,
                        ).toString()
                    }
                    add(MarkdownImagePart.Picture(attributes["src"].orEmpty(), attributes["alt"].orEmpty()))
                    end = match.range.last + 1
                }
                if (end == 0) words += node
                else if (end < literal.length) words += Text(literal.substring(end))
            }
            is Link, is Emphasis, is StrongEmphasis, is Strikethrough -> {
                val parts = splitMarkdownImages(node.childrenForImages(), restoreLiteral)
                if (parts.none { it is MarkdownImagePart.Picture }) words += node
                else parts.forEach { part ->
                    if (part is MarkdownImagePart.Words) {
                        val wrapper = when (node) {
                            is Link -> Link(node.destination, node.title)
                            is Emphasis -> Emphasis(node.openingDelimiter)
                            is StrongEmphasis -> StrongEmphasis(node.openingDelimiter)
                            else -> Strikethrough("~~")
                        }
                        // Preserve the style without moving children out of the live AST.
                        add(MarkdownImagePart.Words(listOf(ImageTextWrapper(wrapper, part.nodes))))
                    } else add(part)
                }
            }
            else -> words += node
        }
    }
    flush()
    return result
}

// Exposes split runs without reparenting the CommonMark AST during recomposition.
internal class ImageTextWrapper(val styleNode: Node, val content: List<Node>) : org.commonmark.node.CustomNode()
private fun Node.childrenForImages(): List<Node> = buildList {
    var child = firstChild
    while (child != null) { add(child); child = child.next }
}

@Composable
internal fun MarkdownImage(source: String, description: String) {
    val colors = LocalAAColors.current
    val name = description.ifBlank { stringResource(R.string.session_markdown_image) }
    // Local file paths belong to the Connector machine, not this phone. Don't read phone files.
    val supported = source.startsWith("https://", true) || source.startsWith("http://", true) ||
        source.startsWith("data:image/", true)
    var preview by remember(source) { mutableStateOf(false) }
    var retry by remember(source) { mutableIntStateOf(0) }
    key(source, retry) {
        SubcomposeAsyncImage(
            model = source.takeIf { supported },
            contentDescription = name,
            modifier = Modifier.fillMaxWidth().aspectRatio(1.6f),
            contentScale = ContentScale.Fit,
            loading = { Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() } },
            error = {
                Column(
                    Modifier.fillMaxSize().background(colors.subtle),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(name, color = colors.ink)
                    Text(stringResource(R.string.session_markdown_image_failed), color = colors.inkSoft)
                    if (supported) TextButton(onClick = { retry++ }) { Text(text = stringResource(R.string.common_retry)) }
                }
            },
            success = { SubcomposeAsyncImageContent(Modifier.fillMaxSize().clickable { preview = true }) },
        )
    }
    if (preview) Dialog(
        onDismissRequest = { preview = false },
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(Modifier.fillMaxSize().background(Color.Black).safeDrawingPadding()) {
            ZoomableAsyncImage(
                model = source, contentDescription = name,
                modifier = Modifier.fillMaxSize().padding(vertical = 56.dp), contentScale = ContentScale.Fit,
            )
            IconButton(onClick = { preview = false }, modifier = Modifier.align(Alignment.TopEnd)) {
                Icon(Lucide.X, stringResource(R.string.common_close), tint = Color.White)
            }
        }
    }
}
