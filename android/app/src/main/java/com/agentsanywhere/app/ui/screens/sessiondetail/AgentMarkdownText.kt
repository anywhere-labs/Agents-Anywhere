package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.commonmark.Extension
import org.commonmark.ext.autolink.AutolinkExtension
import org.commonmark.ext.gfm.strikethrough.Strikethrough
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension
import org.commonmark.ext.gfm.tables.TableBlock
import org.commonmark.ext.gfm.tables.TableCell
import org.commonmark.ext.gfm.tables.TableRow
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.ext.task.list.items.TaskListItemMarker
import org.commonmark.ext.task.list.items.TaskListItemsExtension
import org.commonmark.node.BlockQuote
import org.commonmark.node.BulletList
import org.commonmark.node.Code
import org.commonmark.node.Document
import org.commonmark.node.Emphasis
import org.commonmark.node.FencedCodeBlock
import org.commonmark.node.HardLineBreak
import org.commonmark.node.Heading
import org.commonmark.node.HtmlBlock
import org.commonmark.node.HtmlInline
import org.commonmark.node.Image
import org.commonmark.node.IndentedCodeBlock
import org.commonmark.node.Link
import org.commonmark.node.ListItem
import org.commonmark.node.Node
import org.commonmark.node.OrderedList
import org.commonmark.node.Paragraph
import org.commonmark.node.SoftLineBreak
import org.commonmark.node.StrongEmphasis
import org.commonmark.node.Text
import org.commonmark.node.ThematicBreak
import org.commonmark.parser.Parser

private const val AnnotationFile = "aa-file"
private const val AnnotationUrl = "aa-url"
private const val SelectionCodeTokenPrefix = "[[AA_SELECT_CODE:"
private val TableDelimiterCellRegex = Regex(""":?-{1,}:?""")

private val markdownParser = Parser.builder()
    .extensions(
        listOf<Extension>(
            AutolinkExtension.create(),
            StrikethroughExtension.create(),
            TablesExtension.create(),
            TaskListItemsExtension.create(),
        ),
    )
    .build()

@Composable
internal fun AgentMarkdownText(text: String, darkMode: Boolean) {
    val uriHandler = LocalUriHandler.current
    val document = remember(text) {
        markdownParser.parse(normalizeMarkdownTables(text.ifBlank { "_(no content)_" })) as Document
    }
    val styles = markdownStyles(darkMode)
    val openUrl: (String) -> Unit = { url ->
        runCatching { uriHandler.openUri(url) }
    }
    // ponytail: Android has no file panel yet; wire this to the runtime file panel when it lands.
    val openFile: (String) -> Unit = { _ -> }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        MarkdownBlocks(
            nodes = document.children(),
            darkMode = darkMode,
            styles = styles,
            onOpenFile = openFile,
            onOpenUrl = openUrl,
        )
    }
}

@Composable
private fun MarkdownBlocks(
    nodes: List<Node>,
    darkMode: Boolean,
    styles: MarkdownStyles,
    onOpenFile: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    nodes.forEach { node ->
        when (node) {
            is Paragraph -> {
                val standaloneCode = node.children().singleOrNull() as? Code
                if (standaloneCode != null && standaloneCode.literal.needsWrappingCode()) {
                    MarkdownWrappingCodeChip(
                        code = standaloneCode.literal,
                        path = parseFileRef(standaloneCode.literal),
                        styles = styles,
                        onOpenFile = onOpenFile,
                    )
                } else {
                    MarkdownInlineText(node.children(), styles.body, styles, onOpenFile, onOpenUrl)
                }
            }
            is Heading -> MarkdownInlineText(node.children(), styles.heading(node.level), styles, onOpenFile, onOpenUrl)
            is FencedCodeBlock -> MarkdownCodePanel(
                label = node.info.trim().substringBefore(' ').ifBlank { "code" },
                code = node.literal.removeSuffix("\n"),
                darkMode = darkMode,
                styles = styles,
            )
            is IndentedCodeBlock -> MarkdownCodePanel(
                label = "code",
                code = node.literal.removeSuffix("\n"),
                darkMode = darkMode,
                styles = styles,
            )
            is BulletList -> MarkdownList(node.children(), null, darkMode, styles, onOpenFile, onOpenUrl)
            is OrderedList -> MarkdownList(node.children(), node.startNumber, darkMode, styles, onOpenFile, onOpenUrl)
            is BlockQuote -> MarkdownQuote(node.children(), darkMode, styles, onOpenFile, onOpenUrl)
            is TableBlock -> MarkdownTable(node, darkMode, styles, onOpenFile, onOpenUrl)
            is ThematicBreak -> Box(
                Modifier
                    .fillMaxWidth()
                    .height(1.dp)
                    .background(styles.border),
            )
            is HtmlBlock -> MarkdownInlineText(listOf(Text(node.literal)), styles.body, styles, onOpenFile, onOpenUrl)
            else -> {
                val children = node.children()
                if (children.isNotEmpty()) MarkdownBlocks(children, darkMode, styles, onOpenFile, onOpenUrl)
            }
        }
    }
}

@Composable
private fun MarkdownList(
    items: List<Node>,
    startNumber: Int?,
    darkMode: Boolean,
    styles: MarkdownStyles,
    onOpenFile: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        items.filterIsInstance<ListItem>().forEachIndexed { index, item ->
            val marker = item.children().filterIsInstance<TaskListItemMarker>().firstOrNull()
            val markerText = when {
                marker?.isChecked == true -> "[x]"
                marker != null -> "[ ]"
                startNumber != null -> "${startNumber + index}."
                else -> "-"
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    text = markerText,
                    color = styles.muted,
                    fontSize = 16.sp,
                    lineHeight = 24.sp,
                    fontFamily = if (marker != null) FontFamily.Monospace else FontFamily.SansSerif,
                )
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    MarkdownBlocks(
                        nodes = item.children().filterNot { it is TaskListItemMarker },
                        darkMode = darkMode,
                        styles = styles,
                        onOpenFile = onOpenFile,
                        onOpenUrl = onOpenUrl,
                    )
                }
            }
        }
    }
}

@Composable
private fun MarkdownQuote(
    nodes: List<Node>,
    darkMode: Boolean,
    styles: MarkdownStyles,
    onOpenFile: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    Row(
        modifier = Modifier.height(IntrinsicSize.Min),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier
                .fillMaxHeight()
                .width(2.dp)
                .background(styles.border),
        )
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            MarkdownBlocks(nodes, darkMode, styles.copy(bodyColor = styles.muted), onOpenFile, onOpenUrl)
        }
    }
}

@Composable
private fun MarkdownTable(
    table: TableBlock,
    darkMode: Boolean,
    styles: MarkdownStyles,
    onOpenFile: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .horizontalScroll(rememberScrollState())
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, styles.border, RoundedCornerShape(8.dp)),
    ) {
        table.tableRows().forEachIndexed { rowIndex, row ->
            Row {
                row.children().filterIsInstance<TableCell>().forEach { cell ->
                    val cellStyle = styles.tableCell(
                        header = cell.isHeader,
                        alignment = cell.alignment,
                    )
                    Box(
                        modifier = Modifier
                            .widthIn(min = 112.dp, max = 240.dp)
                            .background(if (cell.isHeader || rowIndex == 0) styles.codeBackground else Color.Transparent)
                            .border(0.5.dp, styles.border)
                            .padding(horizontal = 10.dp, vertical = 8.dp),
                    ) {
                        MarkdownInlineText(
                            nodes = cell.children(),
                            textStyle = cellStyle,
                            styles = styles.copy(bodyColor = cellStyle.color),
                            onOpenFile = onOpenFile,
                            onOpenUrl = onOpenUrl,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MarkdownInlineText(
    nodes: List<Node>,
    textStyle: TextStyle,
    styles: MarkdownStyles,
    onOpenFile: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    val density = LocalDensity.current
    val textMeasurer = rememberTextMeasurer()
    val inline = remember(nodes, styles, density, textMeasurer, onOpenFile) {
        buildMarkdownInline(nodes, styles, textMeasurer, density, onOpenFile)
    }
    var layoutResult by remember(inline.text) { mutableStateOf<TextLayoutResult?>(null) }

    BasicText(
        text = inline.text,
        modifier = Modifier
            .fillMaxWidth()
            .pointerInput(inline.text) {
                detectTapGestures { position ->
                    val offset = layoutResult?.getOffsetForPosition(position) ?: return@detectTapGestures
                    inline.text.getStringAnnotations(AnnotationFile, offset, offset).firstOrNull()?.let {
                        onOpenFile(it.item)
                        return@detectTapGestures
                    }
                    inline.text.getStringAnnotations(AnnotationUrl, offset, offset).firstOrNull()?.let {
                        onOpenUrl(it.item)
                    }
                }
            },
        style = textStyle,
        onTextLayout = { layoutResult = it },
        inlineContent = inline.inlineContent,
    )
}

private data class MarkdownInlineRender(
    val text: AnnotatedString,
    val inlineContent: Map<String, InlineTextContent>,
)

private fun buildMarkdownInline(
    nodes: List<Node>,
    styles: MarkdownStyles,
    textMeasurer: androidx.compose.ui.text.TextMeasurer,
    density: Density,
    onOpenFile: (String) -> Unit,
): MarkdownInlineRender {
    val inlineContent = mutableMapOf<String, InlineTextContent>()
    var nextInlineId = 0
    val text = buildAnnotatedString {
        fun appendNodes(nodes: List<Node>) {
            nodes.forEach { node ->
                when (node) {
                    is Text -> append(node.literal)
                    is SoftLineBreak -> append(" ")
                    is HardLineBreak -> append("\n")
                    is Code -> {
                        val path = parseFileRef(node.literal)
                        if (node.literal.needsWrappingCode()) {
                            if (path != null) pushStringAnnotation(AnnotationFile, path)
                            withSpan(
                                SpanStyle(
                                    color = if (path != null) styles.linkColor else styles.bodyColor,
                                    background = styles.codeBackground,
                                    fontSize = 14.sp,
                                    fontFamily = FontFamily.Monospace,
                                    fontWeight = FontWeight.Normal,
                                    textDecoration = if (path != null) TextDecoration.Underline else null,
                                ),
                            ) {
                                append(node.literal)
                            }
                            if (path != null) pop()
                        } else {
                            val id = "code-${nextInlineId++}"
                            appendInlineContent(id, node.literal)
                            inlineContent[id] = codeInlineContent(
                                code = node.literal,
                                path = path,
                                styles = styles,
                                textMeasurer = textMeasurer,
                                density = density,
                                onOpenFile = onOpenFile,
                            )
                        }
                    }
                    is Emphasis -> withSpan(SpanStyle(fontStyle = FontStyle.Italic)) {
                        appendNodes(node.children())
                    }
                    is StrongEmphasis -> withSpan(SpanStyle(fontWeight = FontWeight.Bold)) {
                        appendNodes(node.children())
                    }
                    is Strikethrough -> withSpan(SpanStyle(textDecoration = TextDecoration.LineThrough)) {
                        appendNodes(node.children())
                    }
                    is Link -> {
                        val destination = node.destination
                        val filePath = if (isFilePath(destination)) stripLine(destination) else null
                        pushStringAnnotation(if (filePath != null) AnnotationFile else AnnotationUrl, filePath ?: destination)
                        withSpan(SpanStyle(color = styles.linkColor, textDecoration = TextDecoration.Underline)) {
                            appendNodes(node.children())
                        }
                        pop()
                    }
                    is Image -> appendNodes(node.children())
                    is HtmlInline -> append(node.literal)
                    else -> appendNodes(node.children())
                }
            }
        }
        appendNodes(nodes)
    }
    return MarkdownInlineRender(text, inlineContent)
}

private inline fun AnnotatedString.Builder.withSpan(style: SpanStyle, block: AnnotatedString.Builder.() -> Unit) {
    pushStyle(style)
    block()
    pop()
}

private fun codeInlineContent(
    code: String,
    path: String?,
    styles: MarkdownStyles,
    textMeasurer: androidx.compose.ui.text.TextMeasurer,
    density: Density,
    onOpenFile: (String) -> Unit,
): InlineTextContent {
    val codeStyle = TextStyle(
        color = if (path != null) styles.linkColor else styles.bodyColor,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        fontFamily = FontFamily.Monospace,
        textDecoration = if (path != null) TextDecoration.Underline else null,
    )
    val measured = textMeasurer.measure(code, style = codeStyle, maxLines = 1)
    val width = with(density) { (measured.size.width.toDp() + 24.dp).toSp() }
    val height = with(density) { 29.dp.toSp() }
    return InlineTextContent(
        placeholder = Placeholder(width, height, PlaceholderVerticalAlign.TextCenter),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(start = 1.dp, top = 3.dp, end = 1.dp, bottom = 1.dp)
                .clip(RoundedCornerShape(5.dp))
                .background(styles.codeBackground)
                .border(1.dp, styles.codeBorder, RoundedCornerShape(5.dp))
                .then(if (path != null) Modifier.noRippleClickable { onOpenFile(path) } else Modifier)
                .padding(horizontal = 7.dp, vertical = 2.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(text = code, style = codeStyle, maxLines = 1)
        }
    }
}

@Composable
private fun MarkdownWrappingCodeChip(
    code: String,
    path: String?,
    styles: MarkdownStyles,
    onOpenFile: (String) -> Unit,
) {
    val codeStyle = TextStyle(
        color = if (path != null) styles.linkColor else styles.bodyColor,
        fontSize = 14.sp,
        lineHeight = 20.sp,
        fontFamily = FontFamily.Monospace,
        textDecoration = if (path != null) TextDecoration.Underline else null,
    )
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(5.dp))
            .background(styles.codeBackground)
            .border(1.dp, styles.codeBorder, RoundedCornerShape(5.dp))
            .then(if (path != null) Modifier.noRippleClickable { onOpenFile(path) } else Modifier)
            .padding(horizontal = 7.dp, vertical = 4.dp),
    ) {
        Text(text = code, style = codeStyle)
    }
}

private fun String.needsWrappingCode(): Boolean = length > 30 || any { it.isWhitespace() }

private fun isBashLabel(label: String): Boolean {
    val lower = label.lowercase()
    return lower == "bash" || lower == "sh" || lower == "shell" || lower == "zsh"
}

@Composable
private fun MarkdownCodePanel(label: String, code: String, darkMode: Boolean, styles: MarkdownStyles) {
    val normalizedLabel = label.ifBlank { "code" }
    if (isBashLabel(label)) {
        val commands = code.lineSequence()
            .map { it.trimEnd() }
            .filter { it.isNotBlank() }
            .toList()
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            commands.ifEmpty { listOf(code) }.forEach { command ->
                SelectableMarkdownCodeBlock(
                    label = "Bash",
                    code = command,
                    height = 112.dp,
                ) {
                    BashCommandCard(label = "Bash", code = command, darkMode = darkMode, styles = styles)
                }
            }
        }
        return
    }

    SelectableMarkdownCodeBlock(
        label = normalizedLabel,
        code = code,
        height = markdownCodePanelHeight(code),
    ) {
        MarkdownCodePanelContent(label = normalizedLabel, code = code, darkMode = darkMode, styles = styles)
    }
}

@Composable
private fun SelectableMarkdownCodeBlock(
    label: String,
    code: String,
    height: Dp,
    content: @Composable () -> Unit,
) {
    val density = LocalDensity.current
    val token = remember(label, code) { selectionCodeToken(label, code) }
    RegisterSessionSelectionCopyToken(token = token, replacement = code)

    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val placeholderWidth = with(density) { maxWidth.toSp() }
        val placeholderHeight = with(density) { height.toSp() }
        val text = remember(token) {
            buildAnnotatedString {
                appendInlineContent(token, token)
            }
        }
        val inlineContent = mapOf(
            token to InlineTextContent(
                placeholder = Placeholder(
                    width = placeholderWidth,
                    height = placeholderHeight,
                    placeholderVerticalAlign = PlaceholderVerticalAlign.TextTop,
                ),
            ) {
                content()
            },
        )

        BasicText(
            text = text,
            modifier = Modifier.fillMaxWidth(),
            style = TextStyle(
                color = Color.Transparent,
                fontSize = 1.sp,
                lineHeight = placeholderHeight,
            ),
            inlineContent = inlineContent,
        )
    }
}

private fun selectionCodeToken(label: String, code: String): String {
    return "$SelectionCodeTokenPrefix${label.hashCode()}:${code.hashCode()}]]"
}

private fun markdownCodePanelHeight(code: String): Dp {
    val lineCount = code.lineSequence().count().coerceAtLeast(1)
    return (lineCount * 15 + 73).dp.coerceAtLeast(112.dp)
}

@Composable
private fun MarkdownCodePanelContent(label: String, code: String, darkMode: Boolean, styles: MarkdownStyles) {
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var copied by remember(code) { mutableStateOf(false) }
    val panelShape = RoundedCornerShape(20.dp)
    val panelBackground = if (darkMode) Color(0xFF18181B) else Color(0xFFECECEA)
    val labelColor = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF191A18)
    val copyIcon = if (darkMode) R.drawable.ic_copy_bash_command_light else R.drawable.ic_copy_bash_command_dark
    val shadow = if (darkMode) Color(0x66000000) else Color(0x0A000000)
    val codeHeight = (code.lineSequence().count().coerceAtLeast(1) * 15 + 12).dp

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 112.dp)
            .shadow(20.dp, panelShape, ambientColor = shadow, spotColor = shadow)
            .clip(panelShape)
            .background(panelBackground)
            .then(if (darkMode) Modifier.border(1.dp, Color(0xFF27272A), panelShape) else Modifier)
            .padding(start = 18.dp, top = 17.dp, end = 18.dp, bottom = 12.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Top,
        ) {
            Text(
                text = label,
                color = labelColor,
                fontSize = 14.sp,
                lineHeight = 18.sp,
                fontWeight = FontWeight.Bold,
            )
            Box(
                modifier = Modifier
                    .size(23.dp)
                    .noRippleClickable {
                        if (code.isBlank()) return@noRippleClickable
                        clipboard.setText(AnnotatedString(code))
                        copied = true
                        scope.launch {
                            delay(1100)
                            copied = false
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                if (copied) CheckMiniGlyph(labelColor) else Image(
                    painter = painterResource(copyIcon),
                    contentDescription = "Copy code",
                    modifier = Modifier.size(23.dp),
                )
            }
        }
        Spacer(Modifier.height(14.dp))
        SoraCodeBlock(
            text = code,
            languageHint = label,
            darkMode = darkMode,
            editorBackground = panelBackground,
            fixedHeight = codeHeight,
            framed = false,
            verticalScrollEnabled = false,
            horizontalTouchOnly = true,
            scalable = false,
        )
    }
}

@Composable
private fun BashCommandCard(label: String, code: String, darkMode: Boolean, styles: MarkdownStyles) {
    val clipboard = LocalClipboardManager.current
    val scope = rememberCoroutineScope()
    var copied by remember(code) { mutableStateOf(false) }
    val shape = RoundedCornerShape(20.dp)
    val cardBackground = if (darkMode) Color(0xFF18181B) else Color(0xFFECECEA)
    val labelColor = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF191A18)
    val copyIcon = if (darkMode) R.drawable.ic_copy_bash_command_light else R.drawable.ic_copy_bash_command_dark
    val shadow = if (darkMode) Color(0x66000000) else Color(0x0A000000)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 112.dp)
            .shadow(20.dp, shape, ambientColor = shadow, spotColor = shadow)
            .clip(shape)
            .background(cardBackground)
            .then(if (darkMode) Modifier.border(1.dp, Color(0xFF27272A), shape) else Modifier)
            .padding(start = 18.dp, top = 17.dp, end = 18.dp, bottom = 18.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Top,
        ) {
            Text(
                text = label,
                color = labelColor,
                fontSize = 14.sp,
                lineHeight = 18.sp,
                fontWeight = FontWeight.Bold,
            )
            Box(
                modifier = Modifier
                    .size(23.dp)
                    .noRippleClickable {
                        if (code.isBlank()) return@noRippleClickable
                        clipboard.setText(AnnotatedString(code))
                        copied = true
                        scope.launch {
                            delay(1100)
                            copied = false
                        }
                    },
                contentAlignment = Alignment.Center,
            ) {
                if (copied) CheckMiniGlyph(labelColor) else Image(
                    painter = painterResource(copyIcon),
                    contentDescription = "Copy command",
                    modifier = Modifier.size(23.dp),
                )
            }
        }
        Spacer(Modifier.height(31.dp))
        Column(
            modifier = Modifier.horizontalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            code.lineSequence().filter { it.isNotBlank() }.forEach { line ->
                BashCommandLine(line = line, darkMode = darkMode)
            }
        }
    }
}

@Composable
private fun BashCommandLine(line: String, darkMode: Boolean) {
    val command = line.trim()
    val first = command.substringBefore(' ')
    val rest = command.removePrefix(first).trimStart()
    val promptColor = if (darkMode) Color(0xFFE8798F) else Color(0xFFC45D74)
    val textColor = if (darkMode) Color(0xFFFAFAFA) else Color(0xFF181916)
    Row(
        horizontalArrangement = Arrangement.spacedBy(7.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = first,
            color = promptColor,
            fontSize = 16.sp,
            lineHeight = 22.sp,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Medium,
            maxLines = 1,
        )
        if (rest.isNotBlank()) {
            Text(
                text = rest,
                color = textColor,
                fontSize = 16.sp,
                lineHeight = 22.sp,
                fontFamily = FontFamily.Monospace,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun CopyMiniGlyph(color: Color) {
    Canvas(Modifier.size(14.dp)) {
        val stroke = Stroke(width = 1.5.dp.toPx())
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.30f, size.height * 0.18f),
            size = androidx.compose.ui.geometry.Size(size.width * 0.52f, size.height * 0.58f),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(2.dp.toPx()),
            style = stroke,
        )
        drawRoundRect(
            color = color,
            topLeft = Offset(size.width * 0.18f, size.height * 0.30f),
            size = androidx.compose.ui.geometry.Size(size.width * 0.52f, size.height * 0.58f),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(2.dp.toPx()),
            style = stroke,
        )
    }
}

@Composable
private fun CheckMiniGlyph(color: Color) {
    Canvas(Modifier.size(14.dp)) {
        val path = Path().apply {
            moveTo(size.width * 0.18f, size.height * 0.52f)
            lineTo(size.width * 0.42f, size.height * 0.74f)
            lineTo(size.width * 0.82f, size.height * 0.28f)
        }
        drawPath(path, color, style = Stroke(width = 1.8.dp.toPx(), cap = StrokeCap.Round))
    }
}

@Composable
private fun markdownStyles(darkMode: Boolean): MarkdownStyles {
    val body = if (darkMode) Color(0xFFEDEDEF) else Color(0xFF242522)
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF7C7B76)
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE4E1DB)
    return MarkdownStyles(
        bodyColor = body,
        muted = muted,
        border = border,
        codeBackground = if (darkMode) Color(0xFF18181B) else Color(0xFFF1F0ED),
        codeBorder = if (darkMode) Color(0xFF27272A) else Color(0xFFE4E1DB),
        linkColor = Color(0xFFEBB353),
        body = TextStyle(
            color = body,
            fontSize = 17.sp,
            lineHeight = 27.sp,
            fontWeight = FontWeight.Normal,
        ),
    )
}

private data class MarkdownStyles(
    val bodyColor: Color,
    val muted: Color,
    val border: Color,
    val codeBackground: Color,
    val codeBorder: Color,
    val linkColor: Color,
    val body: TextStyle,
) {
    fun heading(level: Int): TextStyle = body.copy(
        fontSize = when (level) {
            1 -> 22.sp
            2 -> 20.sp
            else -> 18.sp
        },
        lineHeight = when (level) {
            1 -> 30.sp
            2 -> 28.sp
            else -> 26.sp
        },
        fontWeight = FontWeight.Bold,
    )

    fun tableCell(header: Boolean, alignment: TableCell.Alignment?): TextStyle = body.copy(
        fontSize = 14.5.sp,
        lineHeight = 22.sp,
        fontWeight = if (header) FontWeight.Bold else FontWeight.Normal,
        textAlign = when (alignment) {
            TableCell.Alignment.CENTER -> TextAlign.Center
            TableCell.Alignment.RIGHT -> TextAlign.End
            else -> TextAlign.Start
        },
    )
}

private fun Node.children(): List<Node> {
    val out = mutableListOf<Node>()
    var child = firstChild
    while (child != null) {
        out += child
        child = child.next
    }
    return out
}

private fun Node.tableRows(): List<TableRow> {
    val out = mutableListOf<TableRow>()
    fun visit(node: Node) {
        if (node is TableRow) out += node
        node.children().forEach(::visit)
    }
    children().forEach(::visit)
    return out
}

private fun normalizeMarkdownTables(markdown: String): String {
    if (!markdown.contains('|')) return markdown

    val lines = markdown.lines()
    if (lines.size < 2) return markdown

    val normalized = mutableListOf<String>()
    var inFence = false

    lines.forEachIndexed { index, line ->
        if (
            !inFence &&
            index + 1 < lines.size &&
            isPotentialTableHeaderRow(line) &&
            isTableDelimiterRow(lines[index + 1]) &&
            normalized.lastOrNull()?.isNotBlank() == true
        ) {
            normalized += ""
        }

        normalized += line

        if (line.isMarkdownFenceBoundary()) {
            inFence = !inFence
        }
    }

    return normalized.joinToString("\n")
}

private fun isPotentialTableHeaderRow(line: String): Boolean {
    if (isTableDelimiterRow(line)) return false
    val cells = splitTableRowCells(line)
    return cells.size >= 2 && cells.any { it.trim().isNotEmpty() }
}

private fun isTableDelimiterRow(line: String): Boolean {
    val cells = splitTableRowCells(line)
    return cells.size >= 2 && cells.all { it.trim().matches(TableDelimiterCellRegex) }
}

private fun splitTableRowCells(line: String): List<String> {
    val trimmed = line.trim().trim('|')
    if (trimmed.isBlank()) return emptyList()
    return trimmed.split('|')
}

private fun String.isMarkdownFenceBoundary(): Boolean {
    val trimmed = trimStart()
    return trimmed.startsWith("```") || trimmed.startsWith("~~~")
}

private fun stripLine(path: String): String = path.replace(Regex(""":\d+(:\d+)?$"""), "")

private fun parseFileRef(text: String): String? {
    if (text.isBlank() || text.contains(" ") || text.contains("://")) return null
    if (!text.contains("/")) return null
    if (!Regex("""\.[a-zA-Z0-9]+(?::\d+(?::\d+)?)?$""").containsMatchIn(text)) return null
    return stripLine(text)
}

private fun isFilePath(href: String): Boolean {
    if (href.isBlank()) return false
    return !href.startsWith("http://") &&
        !href.startsWith("https://") &&
        !href.startsWith("mailto:") &&
        !href.startsWith("#") &&
        !href.startsWith("//")
}
