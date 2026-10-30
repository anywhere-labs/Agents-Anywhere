package com.agentsanywhere.app.ui.screens.sessiondetail

import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.agentsanywhere.app.R
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
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
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.regex.Matcher
import java.util.regex.Pattern
import kotlin.math.roundToInt
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
import org.scilab.forge.jlatexmath.Atom
import org.scilab.forge.jlatexmath.Box as JlmBox
import org.scilab.forge.jlatexmath.ColorAtom
import org.scilab.forge.jlatexmath.MacroInfo
import org.scilab.forge.jlatexmath.NewCommandMacro
import org.scilab.forge.jlatexmath.NewEnvironmentMacro
import org.scilab.forge.jlatexmath.StrutBox
import org.scilab.forge.jlatexmath.TeXEnvironment
import org.scilab.forge.jlatexmath.TeXFormula
import org.scilab.forge.jlatexmath.TeXParser
import ru.noties.jlatexmath.JLatexMathAndroid
import ru.noties.jlatexmath.JLatexMathDrawable
import ru.noties.jlatexmath.awt.BasicStroke
import ru.noties.jlatexmath.awt.Graphics2D
import ru.noties.jlatexmath.awt.geom.Line2D

private const val AnnotationFile = "aa-file"
private const val AnnotationUrl = "aa-url"
private const val SelectionCodeTokenPrefix = "[[AA_SELECT_CODE:"
private val TableDelimiterCellRegex = Regex(""":?-{1,}:?""")
private val MathExtractionRegex = Regex(
    pattern = """(?m:^[ ]{0,3}(`{3,}|~{3,})[^\n]*\n(?s:.*?)(?:^[ ]{0,3}\1[ \t]*(?:\n|$)|\z))|(`+)(?s:.*?)\2(?!`)|\]\([^\n]*\)|\\\\|\\\$|(\$\$(?s:.+?)\$\$)|(\\\[(?s:.+?)\\\])|(\\\([^\n]+?\\\))|(\$(?!\$|\s)(?:\\.|[^$\n])*?[^\s\\]\$(?!\d)|\$[^\s$\\]\$(?!\d))""",
)

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
internal fun AgentMarkdownText(
    text: String,
    darkMode: Boolean,
    onOpenFile: (String) -> Unit = {},
    compact: Boolean = false,
) {
    val context = LocalContext.current
    remember(context) {
        ensureLatexExtensionsRegistered(context)
    }
    val uriHandler = LocalUriHandler.current
    val (mathSource, document) = remember(text) {
        val raw = text.ifBlank { "_(no content)_" }
        val extracted = MarkdownMathSource.parse(raw)
        val parsed = markdownParser.parse(normalizeMarkdownTables(extracted.markdown)) as Document
        extracted to parsed
    }
    val styles = markdownStyles(darkMode, compact)
    val openUrl: (String) -> Unit = { url ->
        runCatching { uriHandler.openUri(url) }
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 4.dp),
        verticalArrangement = Arrangement.spacedBy(if (compact) 6.dp else 8.dp),
    ) {
        MarkdownBlocks(
            nodes = document.children(),
            mathSource = mathSource,
            darkMode = darkMode,
            styles = styles,
            onOpenFile = onOpenFile,
            onOpenUrl = openUrl,
        )
    }
}

@Composable
private fun MarkdownBlocks(
    nodes: List<Node>,
    mathSource: MarkdownMathSource,
    darkMode: Boolean,
    styles: MarkdownStyles,
    onOpenFile: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    val parentPart = LocalReadingPart.current
    nodes.forEachIndexed { nodeIndex, node ->
        CompositionLocalProvider(LocalReadingPart provides "$parentPart/node:$nodeIndex") {
            when (node) {
                is Paragraph -> {
                    val standaloneCode = node.children().singleOrNull() as? Code
                    if (standaloneCode != null) {
                        val codeLiteral = mathSource.restoreLiteral(standaloneCode.literal)
                        if (codeLiteral.needsWrappingCode()) {
                            MarkdownWrappingCodeChip(
                                code = codeLiteral,
                                path = parseFileRef(codeLiteral),
                                styles = styles,
                                onOpenFile = onOpenFile,
                            )
                            return@CompositionLocalProvider
                        }
                    }
                    val segments = splitParagraphSegments(node.children(), mathSource)
                    segments.forEachIndexed { segmentIndex, segment ->
                        CompositionLocalProvider(LocalReadingPart provides "$parentPart/node:$nodeIndex/segment:$segmentIndex") {
                            when (segment) {
                                is ParagraphSegment.InlineRun -> {
                                    MarkdownInlineText(
                                        nodes = segment.nodes,
                                        mathSource = mathSource,
                                        textStyle = styles.body,
                                        styles = styles,
                                        onOpenFile = onOpenFile,
                                        onOpenUrl = onOpenUrl,
                                    )
                                }
                                is ParagraphSegment.BlockMath -> {
                                    MarkdownMathBlock(
                                        latex = segment.expression.tex,
                                        copyText = segment.expression.source,
                                        styles = styles,
                                    )
                                }
                            }
                        }
                    }
                }
                is Heading -> MarkdownInlineText(
                    nodes = node.children(),
                    mathSource = mathSource,
                    textStyle = styles.heading(node.level),
                    styles = styles,
                    onOpenFile = onOpenFile,
                    onOpenUrl = onOpenUrl,
                )
                is FencedCodeBlock -> {
                    val rawLabel = node.info.trim().substringBefore(' ')
                    val rawCode = mathSource.restoreLiteral(node.literal.removeSuffix("\n"))
                    if (rawLabel.equals("math", ignoreCase = true)) {
                        MarkdownMathBlock(
                            latex = rawCode.trim(),
                            copyText = rawCode,
                            styles = styles,
                        )
                    } else {
                        MarkdownCodePanel(
                            label = rawLabel.ifBlank { "code" },
                            code = rawCode,
                            darkMode = darkMode,
                            styles = styles,
                        )
                    }
                }
                is IndentedCodeBlock -> MarkdownCodePanel(
                    label = "code",
                    code = mathSource.restoreLiteral(node.literal.removeSuffix("\n")),
                    darkMode = darkMode,
                    styles = styles,
                )
                is BulletList -> MarkdownList(node.children(), null, mathSource, darkMode, styles, onOpenFile, onOpenUrl)
                is OrderedList -> MarkdownList(node.children(), node.startNumber, mathSource, darkMode, styles, onOpenFile, onOpenUrl)
                is BlockQuote -> MarkdownQuote(node.children(), mathSource, darkMode, styles, onOpenFile, onOpenUrl)
                is TableBlock -> MarkdownTable(node, mathSource, styles, onOpenFile, onOpenUrl)
                is ThematicBreak -> Box(
                    Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(styles.border),
                )
                is HtmlBlock -> MarkdownInlineText(
                    nodes = listOf(Text(mathSource.restoreLiteral(node.literal))),
                    mathSource = mathSource,
                    textStyle = styles.body,
                    styles = styles,
                    onOpenFile = onOpenFile,
                    onOpenUrl = onOpenUrl,
                )
                else -> {
                    val children = node.children()
                    if (children.isNotEmpty()) MarkdownBlocks(children, mathSource, darkMode, styles, onOpenFile, onOpenUrl)
                }
            }
        }
    }
}

@Composable
private fun MarkdownList(
    items: List<Node>,
    startNumber: Int?,
    mathSource: MarkdownMathSource,
    darkMode: Boolean,
    styles: MarkdownStyles,
    onOpenFile: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    val parentPart = LocalReadingPart.current
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        items.filterIsInstance<ListItem>().forEachIndexed { index, item ->
            val marker = item.children().filterIsInstance<TaskListItemMarker>().firstOrNull()
            val markerText = when {
                marker?.isChecked == true -> "[x]"
                marker != null -> "[ ]"
                startNumber != null -> "${startNumber + index}."
                else -> "-"
            }
            CompositionLocalProvider(LocalReadingPart provides "$parentPart/list:$index") {
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
                            mathSource = mathSource,
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
}

@Composable
private fun MarkdownQuote(
    nodes: List<Node>,
    mathSource: MarkdownMathSource,
    darkMode: Boolean,
    styles: MarkdownStyles,
    onOpenFile: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            // Code and math blocks use SubcomposeLayout, which cannot answer intrinsic queries.
            // Draw the quote rule using the measured content height instead.
            .drawBehind {
                val ruleWidth = 2.dp.toPx()
                val ruleStart = if (layoutDirection == LayoutDirection.Ltr) 0f else size.width - ruleWidth
                drawRect(
                    color = styles.border,
                    topLeft = Offset(ruleStart, 0f),
                    size = Size(ruleWidth, size.height),
                )
            }
            .padding(start = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        MarkdownBlocks(nodes, mathSource, darkMode, styles.copy(bodyColor = styles.muted), onOpenFile, onOpenUrl)
    }
}

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
private fun MarkdownTable(
    table: TableBlock,
    mathSource: MarkdownMathSource,
    styles: MarkdownStyles,
    onOpenFile: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    val parentPart = LocalReadingPart.current
    val context = LocalContext.current
    val clipboard = LocalClipboardManager.current
    val rows = table.tableRows()
    val columnCount = rows.maxOfOrNull { row -> row.children().count { it is TableCell } } ?: 0
    val scrollHorizontally = columnCount > 2
    val shape = RoundedCornerShape(12.dp)
    var fullscreen by remember { mutableStateOf(false) }
    var phoneSheet by remember { mutableStateOf<String?>(null) }
    val title = stringResource(R.string.markdown_table_title)
    val copyLabel = stringResource(R.string.markdown_table_copy)
    val downloadLabel = stringResource(R.string.markdown_table_download)
    val fullscreenLabel = stringResource(R.string.markdown_table_fullscreen)
    val closeLabel = stringResource(R.string.markdown_table_close)

    // 列宽自适应：同时看「最长的格子」和「平均长度」，避免个别长格把整列撑宽、留下大片空白。
    val columnMaxChars = IntArray(columnCount) { index ->
        rows.maxOfOrNull { row ->
            row.children().filterIsInstance<TableCell>().getOrNull(index)?.let { cell ->
                cell.children().joinToString("") { it.plainTableText() }.displayColumnWidth()
            } ?: 0
        } ?: 0
    }
    // 两列：短列按内容收窄，长列占满剩余宽度（右列可以超过一半）。
    // 单列：占满。
    val columnWeights = FloatArray(columnCount) { index ->
        if (columnCount <= 1) {
            1f
        } else {
            (columnMaxChars.getOrNull(index) ?: 0).toFloat().coerceAtLeast(4f) + 4f
        }
    }
    // 3 列及以上的列宽在 Grid 里按「表格宽度的一半」封顶，内容短时自动收窄。

    @Composable
    fun Cells(fillWidth: Boolean, tableWidth: androidx.compose.ui.unit.Dp) {
        val tableWidthValue = tableWidth.value
        val halfWidth = tableWidthValue * 0.5f
        // 先按「半表宽」把每个单元格排一次版，取最长一行的实际宽度，作为该列需要的宽度。
        val measureText = rememberTextMeasurer()
        val measureDensity = LocalDensity.current
        val measureStyle = styles.tableCell(header = false, alignment = null)
        val measuredWidths = remember(rows, tableWidthValue, measureStyle, measureText, measureDensity) {
            val halfPx = with(measureDensity) { halfWidth.dp.roundToPx() }.coerceAtLeast(1)
            FloatArray(columnCount) { index ->
                var widestPx = 0
                rows.forEach { row ->
                    val cell = row.children().filterIsInstance<TableCell>().getOrNull(index) ?: return@forEach
                    val content = cell.children().joinToString("") { it.plainTableText() }
                    if (content.isNotEmpty()) {
                        val layout = measureText.measure(
                            text = AnnotatedString(content),
                            style = if (cell.isHeader) measureStyle.copy(fontWeight = FontWeight.Bold) else measureStyle,
                            constraints = androidx.compose.ui.unit.Constraints(maxWidth = halfPx),
                        )
                        var lineWidest = 0
                        for (line in 0 until layout.lineCount) {
                            val lineWidth = (layout.getLineRight(line) - layout.getLineLeft(line)).toInt()
                            if (lineWidth > lineWidest) lineWidest = lineWidth
                        }
                        if (lineWidest > widestPx) widestPx = lineWidest
                    }
                }
                with(measureDensity) { widestPx.toDp().value } + 22f
            }
        }
        val widths: FloatArray = if (fillWidth) {
            if (columnCount <= 1) {
                floatArrayOf(tableWidthValue)
            } else {
                // 两列：每列先按内容拿宽度（最多一半），剩余空间全部补给最后一列，
                // 这样前面的列正好贴合内容，不会出现「文字后面一大片空白」。
                val needs = measuredWidths.copyOf()
                val result = FloatArray(columnCount) { minOf(needs[it], halfWidth) }
                val used = result.sum()
                if (used < tableWidthValue) {
                    result[columnCount - 1] += tableWidthValue - used
                } else if (used > tableWidthValue) {
                    val scale = tableWidthValue / used
                    for (index in 0 until columnCount) result[index] *= scale
                }
                result
            }
        } else {
            // 三列及以上：按内容自适应，单列最宽不超过表格宽度的一半，最窄 96dp。
            FloatArray(columnCount) { index ->
                measuredWidths[index].coerceIn(96f, halfWidth)
            }
        }

        Column {
            rows.forEachIndexed { rowIndex, row ->
                Row(modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min), verticalAlignment = Alignment.Top) {
                    row.children().filterIsInstance<TableCell>().forEachIndexed { columnIndex, cell ->
                        CompositionLocalProvider(
                            LocalReadingPart provides "$parentPart/table:$rowIndex:$columnIndex",
                        ) {
                            val cellStyle = styles.tableCell(
                                header = cell.isHeader,
                                alignment = cell.alignment,
                            )
                            val cellModifier = if (columnCount <= 1) {
                                Modifier.fillMaxWidth()
                            } else {
                                val columnWidth = widths.getOrNull(columnIndex) ?: (tableWidthValue / columnCount)
                                Modifier.width(columnWidth.dp)
                            }
                            Box(
                                modifier = cellModifier
                                    .fillMaxHeight()
                                    .clipToBounds()
                                    .background(if (cell.isHeader || rowIndex == 0) styles.codeBackground else Color.Transparent)
                                    .border(0.5.dp, styles.border)
                                    .padding(horizontal = 10.dp, vertical = 8.dp),
                            ) {
                                val cellText = cell.children().joinToString("") { it.plainTableText() }
                                MarkdownInlineText(
                                    nodes = cell.children(),
                                    mathSource = mathSource,
                                    textStyle = cellStyle,
                                    styles = styles.copy(bodyColor = cellStyle.color),
                                    onOpenFile = onOpenFile,
                                    onOpenUrl = onOpenUrl,
                                    softBreakTokens = true,
                                    phoneChips = true,
                                    onPlainTap = {
                                        val phone = cellText.firstPhoneNumber()
                                        if (phone != null) {
                                            phoneSheet = phone
                                        } else if (cellText.isNotEmpty()) {
                                            clipboard.setText(AnnotatedString(cellText))
                                            android.widget.Toast.makeText(
                                                context,
                                                R.string.markdown_table_cell_copied,
                                                android.widget.Toast.LENGTH_SHORT,
                                            ).show()
                                        }
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    @Composable
    fun Grid() {
        BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
            val tableWidth = maxWidth
            if (scrollHorizontally) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                ) {
                    Cells(fillWidth = false, tableWidth = tableWidth)
                }
            } else {
                Cells(fillWidth = true, tableWidth = tableWidth)
            }
        }
    }

    @Composable
    fun Card() {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(shape)
                .border(1.dp, styles.border, shape),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(styles.codeBackground)
                    .padding(start = 14.dp, end = 6.dp, top = 2.dp, bottom = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = title,
                    color = styles.muted,
                    style = styles.body.copy(fontSize = 13.sp),
                    modifier = Modifier.weight(1f),
                )
                MarkdownTableButton(
                    iconRes = R.drawable.aa_ic_table_copy,
                    description = copyLabel,
                    tint = styles.muted,
                    iconSize = 19.dp,
                    onClick = { clipboard.setText(AnnotatedString(rows.toTsv())) },
                )
                MarkdownTableButton(
                    iconRes = R.drawable.aa_ic_table_download,
                    description = downloadLabel,
                    tint = styles.muted,
                    iconSize = 20.dp,
                    onClick = { saveTableCsv(context, "table-${'$'}{System.currentTimeMillis()}.csv", rows.toCsv()) },
                )
                MarkdownTableButton(
                    iconRes = R.drawable.aa_ic_table_expand,
                    description = fullscreenLabel,
                    tint = styles.muted,
                    iconSize = 17.dp,
                    onClick = { fullscreen = true },
                )
            }
            Grid()
        }
    }

    Card()

    val phone = phoneSheet
    if (phone != null) {
        androidx.compose.material3.ModalBottomSheet(onDismissRequest = { phoneSheet = null }) {
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = stringResource(R.string.markdown_table_phone_hint, phone),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 20.dp, vertical = 16.dp),
                    color = styles.muted,
                    style = styles.body.copy(fontSize = 13.sp),
                    textAlign = TextAlign.Center,
                )
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(0.5.dp)
                        .background(styles.border),
                )
                TableSheetAction(stringResource(R.string.markdown_table_call), textColor = MaterialTheme.colorScheme.primary) {
                    phoneSheet = null
                    dialPhoneNumber(context, phone)
                }
                TableSheetAction(stringResource(R.string.markdown_table_copy_number), textColor = styles.bodyColor) {
                    phoneSheet = null
                    clipboard.setText(AnnotatedString(phone))
                    android.widget.Toast.makeText(context, R.string.markdown_table_cell_copied, android.widget.Toast.LENGTH_SHORT).show()
                }
                TableSheetAction(stringResource(R.string.markdown_table_add_contact), textColor = styles.bodyColor) {
                    phoneSheet = null
                    addPhoneContact(context, phone)
                }
                TableSheetAction(stringResource(R.string.markdown_table_cancel), textColor = styles.muted) {
                    phoneSheet = null
                }
                Spacer(modifier = Modifier.height(8.dp))
            }
        }
    }

    if (fullscreen) {
        Dialog(
            onDismissRequest = { fullscreen = false },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .background(MaterialTheme.colorScheme.surface),
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(start = 18.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = title,
                        color = styles.bodyColor,
                        style = styles.body.copy(fontSize = 17.sp, fontWeight = FontWeight.Bold),
                        modifier = Modifier.weight(1f),
                    )
                    MarkdownTableButton(
                        iconRes = R.drawable.aa_ic_table_close,
                        description = closeLabel,
                        tint = styles.muted,
                        onClick = { fullscreen = false },
                    )
                }
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp, vertical = 4.dp),
                ) {
                    BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
                        val dialogTableWidth = maxWidth
                        if (scrollHorizontally) {
                            Box(modifier = Modifier.horizontalScroll(rememberScrollState())) {
                                Cells(fillWidth = false, tableWidth = dialogTableWidth)
                            }
                        } else {
                            Cells(fillWidth = true, tableWidth = dialogTableWidth)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MarkdownTableButton(
    iconRes: Int,
    description: String,
    tint: Color,
    iconSize: androidx.compose.ui.unit.Dp = 17.dp,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(32.dp)
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            painter = painterResource(id = iconRes),
            contentDescription = description,
            tint = tint,
            modifier = Modifier.size(iconSize),
        )
    }
}

private fun Node.plainTableText(): String = when (this) {
    is org.commonmark.node.Text -> literal
    is org.commonmark.node.Code -> literal
    is org.commonmark.node.SoftLineBreak -> " "
    is org.commonmark.node.HardLineBreak -> " "
    else -> {
        val builder = StringBuilder()
        var child = firstChild
        while (child != null) {
            builder.append(child.plainTableText())
            child = child.next
        }
        builder.toString()
    }
}

private fun AnnotatedString.withSoftBreaks(): AnnotatedString {
    if (text.isEmpty()) return this
    // 电话号码内部不插入断点，保证号码整体换行、不会从中间断开。
    val protectedRanges = ArrayList<IntRange>()
    for (pattern in PHONE_NUMBER_PATTERNS) {
        for (match in pattern.findAll(text)) {
            if (protectedRanges.none { it.first <= match.range.last && match.range.first <= it.last }) {
                protectedRanges += match.range
            }
        }
    }
    fun isProtected(index: Int): Boolean = protectedRanges.any { index >= it.first && index <= it.last }
    val builder = AnnotatedString.Builder()
    val indexMap = IntArray(text.length + 1)
    var sinceBreak = 0
    for (index in text.indices) {
        indexMap[index] = builder.length
        val char = text[index]
        builder.append(char)
        val wide = char.code >= 0x2E80
        val separator = char == ' ' || char == '\t' || char == '\n'
        if (isProtected(index) || wide || separator) {
            // 中文、空格、和电话号码内部都不插入断点，并重置连续英文计数。
            sinceBreak = 0
            continue
        }
        val breakLetter = char == '/' || char == '-' || char == '_' || char == '.' ||
            char == '\\' || char == '&' || char == '=' || char == '?' || char == '#' || char == ':'
        if (breakLetter) {
            builder.append('\u200B')
            sinceBreak = 0
            continue
        }
        sinceBreak += 1
        if (sinceBreak >= 8) {
            builder.append('\u200B')
            sinceBreak = 0
        }
    }
    indexMap[text.length] = builder.length
    fun remap(source: Int): Int = indexMap[source.coerceIn(0, text.length)]
    for (span in spanStyles) {
        val start = remap(span.start)
        val end = remap(span.end)
        if (end > start) builder.addStyle(span.item, start, end)
    }
    for (span in paragraphStyles) {
        val start = remap(span.start)
        val end = remap(span.end)
        if (end > start) builder.addStyle(span.item, start, end)
    }
    for (annotation in getStringAnnotations(0, text.length)) {
        val start = remap(annotation.start)
        val end = remap(annotation.end)
        if (end > start) builder.addStringAnnotation(annotation.tag, annotation.item, start, end)
    }
    return builder.toAnnotatedString()
}

// 手机号 / 400-800 服务号 / 带区号座机（可带分机）
private val PHONE_NUMBER_PATTERNS = listOf(
    Regex("(?<!\\d)(?:\\+?86[\\s-]?)?1[3-9]\\d{9}(?!\\d)"),
    Regex("(?<!\\d)(?:400|800)[\\s-]?\\d{3}[\\s-]?\\d{4}(?!\\d)"),
    Regex("(?<!\\d)0\\d{2,3}[\\s-]?\\d{7,8}(?:\\s*(?:转|分机|ext\\.?|x)\\s*\\d{1,6})?(?!\\d)", RegexOption.IGNORE_CASE),
)

/** 给文本里的电话号码上色，不加任何背景框或阴影。 */
private fun AnnotatedString.withPhoneColor(color: Color): AnnotatedString {
    if (text.isEmpty()) return this
    val ranges = ArrayList<IntRange>()
    for (pattern in PHONE_NUMBER_PATTERNS) {
        for (match in pattern.findAll(text)) {
            if (ranges.none { it.first <= match.range.last && match.range.first <= it.last }) {
                ranges += match.range
            }
        }
    }
    if (ranges.isEmpty()) return this
    val builder = AnnotatedString.Builder(this)
    for (range in ranges) {
        builder.addStyle(
            androidx.compose.ui.text.SpanStyle(color = color, fontWeight = FontWeight.Medium),
            range.first,
            range.last + 1,
        )
    }
    return builder.toAnnotatedString()
}

private fun String.firstPhoneNumber(): String? {
    for (pattern in PHONE_NUMBER_PATTERNS) {
        val match = pattern.find(this) ?: continue
        return match.value
    }
    return null
}

/** 去掉空格、横线、括号，把「转/分机」换成 tel: 的暂停符，得到可直接拨号的号码。 */
private fun String.toDialNumber(): String {
    val extensionMatch = Regex("(?:转|分机|ext\\.?|x)\\s*(\\d{1,6})", RegexOption.IGNORE_CASE).find(this)
    val extension = extensionMatch?.groupValues?.getOrNull(1)
    val base = if (extensionMatch != null) substring(0, extensionMatch.range.first) else this
    val digits = StringBuilder()
    for (char in base) {
        if (char.isDigit()) digits.append(char)
    }
    var number = digits.toString()
    if (number.startsWith("0086")) number = number.removePrefix("0086") else if (number.startsWith("86") && number.length > 11) number = number.removePrefix("86")
    return number + if (extension != null) ",$extension" else ""
}

private fun dialPhoneNumber(context: Context, phone: String) {
    try {
        context.startActivity(android.content.Intent(android.content.Intent.ACTION_DIAL, android.net.Uri.parse("tel:" + phone.toDialNumber())))
    } catch (error: Throwable) {
        android.widget.Toast.makeText(context, R.string.markdown_table_open_failed, android.widget.Toast.LENGTH_SHORT).show()
    }
}

private fun addPhoneContact(context: Context, phone: String) {
    try {
        val intent = android.content.Intent(android.content.Intent.ACTION_INSERT).apply {
            type = android.provider.ContactsContract.Contacts.CONTENT_TYPE
            putExtra(android.provider.ContactsContract.Intents.Insert.PHONE, phone.toDialNumber())
        }
        context.startActivity(intent)
    } catch (error: Throwable) {
        android.widget.Toast.makeText(context, R.string.markdown_table_open_failed, android.widget.Toast.LENGTH_SHORT).show()
    }
}

@Composable
private fun TableSheetAction(label: String, textColor: Color, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 17.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text = label, color = textColor, style = TextStyle(fontSize = 16.sp))
    }
}

private fun String.displayColumnWidth(): Int {
    var width = 0
    for (char in this) {
        width += when {
            char.code in 0x1100..0x115F ||
                char.code in 0x2E80..0xA4CF ||
                char.code in 0xAC00..0xD7A3 ||
                char.code in 0xF900..0xFAFF ||
                char.code in 0xFE30..0xFE4F ||
                char.code in 0xFF00..0xFF60 ||
                char.code in 0xFFE0..0xFFE6 -> 2
            else -> 1
        }
    }
    return width
}

private fun List<TableRow>.toTsv(): String = joinToString("\n") { row ->
    row.children().filterIsInstance<TableCell>().joinToString("\t") { cell -> cell.children().joinToString("") { it.plainTableText() } }
}

private fun List<TableRow>.toCsv(): String = joinToString("\r\n") { row ->
    row.children().filterIsInstance<TableCell>().joinToString(",") { cell ->
        val value = cell.children().joinToString("") { it.plainTableText() }
        if (value.contains(',') || value.contains('"') || value.contains('\n')) "\"" + value.replace("\"", "\"\"") + "\"" else value
    }
}

private fun saveTableCsv(context: Context, fileName: String, content: String) {
    try {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, fileName)
                put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "text/csv")
                put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH, "Download/AgentsAnywhere")
            }
            val uri = context.contentResolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            if (uri != null) {
                context.contentResolver.openOutputStream(uri)?.use { stream -> stream.write(content.toByteArray(Charsets.UTF_8)) }
            }
        } else {
            val dir = context.getExternalFilesDir("tables") ?: context.filesDir
            java.io.File(dir, fileName).writeText(content, Charsets.UTF_8)
        }
        android.widget.Toast.makeText(context, R.string.markdown_table_saved, android.widget.Toast.LENGTH_SHORT).show()
    } catch (error: Throwable) {
        android.widget.Toast.makeText(context, R.string.markdown_table_save_failed, android.widget.Toast.LENGTH_SHORT).show()
    }
}

@Composable
private fun MarkdownInlineText(
    nodes: List<Node>,
    mathSource: MarkdownMathSource,
    textStyle: TextStyle,
    styles: MarkdownStyles,
    onOpenFile: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
    softBreakTokens: Boolean = false,
    phoneChips: Boolean = false,
    onPlainTap: (() -> Unit)? = null,
) {
    val density = LocalDensity.current
    val textMeasurer = rememberTextMeasurer()
    val maxInlineMathWidthPx = with(density) { 280.dp.roundToPx() }
    val inline = remember(nodes, mathSource, textStyle, styles, density, textMeasurer, maxInlineMathWidthPx, onOpenFile) {
        buildMarkdownInline(
            nodes = nodes,
            mathSource = mathSource,
            textStyle = textStyle,
            styles = styles,
            textMeasurer = textMeasurer,
            density = density,
            maxInlineMathWidthPx = maxInlineMathWidthPx,
            onOpenFile = onOpenFile,
        )
    }
    val baseText = if (phoneChips) {
        // 只给电话号码上色（深色模式是黄色、浅色模式是蓝色），不加底框/阴影。
        remember(inline.text, styles.linkColor) { inline.text.withPhoneColor(styles.linkColor) }
    } else {
        inline.text
    }
    val baseInlineContent = inline.inlineContent
    val displayText = if (softBreakTokens) {
        remember(baseText) { baseText.withSoftBreaks() }
    } else {
        baseText
    }
    var layoutResult by remember(displayText) { mutableStateOf<TextLayoutResult?>(null) }
    val readingAnchor = ReadingTextAnchor(displayText.text)

    BasicText(
        text = displayText,
        modifier = Modifier
            .fillMaxWidth()
            .onGloballyPositioned(readingAnchor::positioned)
            .pointerInput(displayText) {
                detectTapGestures { position ->
                    val offset = layoutResult?.getOffsetForPosition(position) ?: return@detectTapGestures
                    displayText.getStringAnnotations(AnnotationFile, offset, offset).firstOrNull()?.let {
                        onOpenFile(it.item)
                        return@detectTapGestures
                    }
                    displayText.getStringAnnotations(AnnotationUrl, offset, offset).firstOrNull()?.let {
                        onOpenUrl(it.item)
                        return@detectTapGestures
                    }
                    onPlainTap?.invoke()
                }
            },
        style = textStyle,
        onTextLayout = { layoutResult = it; readingAnchor.laidOut(it) },
        inlineContent = baseInlineContent,
    )
}

private data class MarkdownInlineRender(
    val text: AnnotatedString,
    val inlineContent: Map<String, InlineTextContent>,
)

private fun buildMarkdownInline(
    nodes: List<Node>,
    mathSource: MarkdownMathSource,
    textStyle: TextStyle,
    styles: MarkdownStyles,
    textMeasurer: androidx.compose.ui.text.TextMeasurer,
    density: Density,
    maxInlineMathWidthPx: Int,
    onOpenFile: (String) -> Unit,
): MarkdownInlineRender {
    val inlineContent = mutableMapOf<String, InlineTextContent>()
    var nextInlineId = 0
    val resolvedFontSizeSp = if (textStyle.fontSize != TextUnit.Unspecified) textStyle.fontSize else styles.body.fontSize
    val mathTextSizePx = with(density) { resolvedFontSizeSp.toPx() }
    val mathColorArgb = (if (textStyle.color != Color.Unspecified) textStyle.color else styles.bodyColor).toArgb()
    val text = buildAnnotatedString {
        fun appendNodes(nodes: List<Node>) {
            nodes.forEach { node ->
                when (node) {
                    is Text -> {
                        if (!mathSource.hasMath) {
                            append(node.literal)
                        } else {
                            mathSource.splitInlineSegments(node.literal).forEach { segment ->
                                when (segment) {
                                    is MarkdownMathSource.InlineSegment.Literal -> append(segment.text)
                                    is MarkdownMathSource.InlineSegment.Math -> {
                                        val expr = segment.expression
                                        val drawable = createLatexDrawable(
                                            latex = expr.tex,
                                            textSizePx = mathTextSizePx,
                                            colorArgb = mathColorArgb,
                                        )
                                        if (drawable == null) {
                                            append(expr.source)
                                        } else {
                                            val id = "math-${nextInlineId++}"
                                            appendInlineContent(id, expr.source)
                                            inlineContent[id] = mathInlineContent(
                                                drawable = drawable,
                                                density = density,
                                                maxWidthPx = maxInlineMathWidthPx,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                    is SoftLineBreak -> append(" ")
                    is HardLineBreak -> append("\n")
                    is Code -> {
                        val codeLiteral = mathSource.restoreLiteral(node.literal)
                        val path = parseFileRef(codeLiteral)
                        if (codeLiteral.needsWrappingCode()) {
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
                                append(codeLiteral)
                            }
                            if (path != null) pop()
                        } else {
                            val id = "code-${nextInlineId++}"
                            appendInlineContent(id, codeLiteral)
                            inlineContent[id] = codeInlineContent(
                                code = codeLiteral,
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
                        val destination = mathSource.restoreLiteral(node.destination)
                        val filePath = if (isFilePath(destination)) stripLine(destination) else null
                        pushStringAnnotation(if (filePath != null) AnnotationFile else AnnotationUrl, filePath ?: destination)
                        withSpan(SpanStyle(color = styles.linkColor, textDecoration = TextDecoration.Underline)) {
                            appendNodes(node.children())
                        }
                        pop()
                    }
                    is Image -> appendNodes(node.children())
                    is HtmlInline -> append(mathSource.restoreLiteral(node.literal))
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
        // Anchor placeholder geometry to a physical 1.dp font unit so device
        // font scaling cannot enlarge the embedded code panel.
        val layoutUnitFontSize = with(density) { 1.dp.toSp() }
        val placeholderWidth = maxWidth.value.em
        val placeholderHeight = height.value.em
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
                fontSize = layoutUnitFontSize,
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
    val panelBackground = if (darkMode) LocalAAColors.current.raisedSurface else Color(0xFFECECEA)
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
    val cardBackground = if (darkMode) LocalAAColors.current.raisedSurface else Color(0xFFECECEA)
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
private fun markdownStyles(darkMode: Boolean, compact: Boolean): MarkdownStyles {
    val body = if (darkMode) Color(0xFFEDEDEF) else Color(0xFF242522)
    val muted = if (darkMode) Color(0xFFA1A1AA) else Color(0xFF7C7B76)
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE4E1DB)
    return MarkdownStyles(
        bodyColor = body,
        muted = muted,
        border = border,
        codeBackground = if (darkMode) LocalAAColors.current.subtle else Color(0xFFF1F0ED),
        codeBorder = if (darkMode) Color(0xFF27272A) else Color(0xFFE4E1DB),
        linkColor = Color(0xFFEBB353),
        body = TextStyle(
            color = body,
            fontSize = if (compact) 14.sp else 17.sp,
            lineHeight = if (compact) 21.sp else 27.sp,
            fontWeight = if (compact) FontWeight.Light else FontWeight.Normal,
        ),
        compact = compact,
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
    val compact: Boolean,
) {
    fun heading(level: Int): TextStyle = body.copy(
        fontSize = when (level) {
            1 -> if (compact) 17.sp else 22.sp
            2 -> if (compact) 16.sp else 20.sp
            else -> if (compact) 15.sp else 18.sp
        },
        lineHeight = when (level) {
            1 -> if (compact) 24.sp else 30.sp
            2 -> if (compact) 23.sp else 28.sp
            else -> if (compact) 22.sp else 26.sp
        },
        fontWeight = if (compact) FontWeight.SemiBold else FontWeight.Bold,
    )

    fun tableCell(header: Boolean, alignment: TableCell.Alignment?): TextStyle = body.copy(
        fontSize = if (compact) 13.sp else 14.5.sp,
        lineHeight = if (compact) 19.sp else 22.sp,
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

private val latexExtensionsRegistered = AtomicBoolean(false)
private val StarredEnvironmentRegex = Regex(
    """\\(begin|end)\{(equation|align|flalign|gather|multline|eqnarray|alignat|alignedat|split)\*\}""",
)
private val CeExplicitChargePattern = Pattern.compile("^(.*?)\\^(\\d*[+-]+)$")
private val CeImplicitChargePattern = Pattern.compile("^([A-Za-z0-9()\\[\\]]+?)([+-]+)$")
private val PuFractionPattern = Pattern.compile("([A-Za-z0-9^_+-]+)\\s*//\\s*([A-Za-z0-9^_+-]+)")
private val PuUnitWordPattern = Pattern.compile("(?<!\\\\)\\b([A-Za-z]+)\\b")

private fun ensureLatexExtensionsRegistered(context: Context) {
    runCatching {
        JLatexMathAndroid.init(context.applicationContext)
        registerLatexExtensionsOnce()
    }
}

private fun registerLatexExtensionsOnce() {
    if (!latexExtensionsRegistered.compareAndSet(false, true)) return
    runCatching {
        NewEnvironmentMacro.addNewEnvironment("equation", "", "", 0)

        NewCommandMacro.addNewCommand("pounds", "\\mathsterling", 0)
        NewCommandMacro.addNewCommand("sterling", "\\mathsterling", 0)
        NewCommandMacro.addNewCommand("textsterling", "\\mathsterling", 0)
        NewCommandMacro.addNewCommand("sout", "\\st{#1}", 1)

        MacroInfo.Commands["tag"] = object : MacroInfo(1) {
            override fun invoke(tp: TeXParser, args: Array<String?>): Any? {
                val starred = args.getOrNull(1) == "*"
                val label = (if (starred) tp.getOptsArgs(1, 0).getOrNull(1) else args.getOrNull(1)).orEmpty()
                val tagLatex = if (starred) {
                    "\\qquad\\text{$label}"
                } else {
                    "\\qquad(\\text{$label})"
                }
                return TeXFormula(tagLatex, false).root
            }
        }

        MacroInfo.Commands["color"] = object : MacroInfo(1) {
            override fun invoke(tp: TeXParser, args: Array<String?>): Any {
                val remaining = tp.stringFromCurrentPos
                val body = if (remaining != null && remaining.trimStart().startsWith("{")) {
                    val arg = tp.getOptsArgs(1, 0).getOrNull(1).orEmpty()
                    TeXFormula(arg, null, false, tp.isIgnoreWhiteSpace).root
                } else {
                    val rest = tp.overArgument.orEmpty()
                    TeXFormula(rest, null, false, tp.isIgnoreWhiteSpace).root
                }
                return ColorAtom(body, null, ColorAtom.getColor(args.getOrNull(1).orEmpty()))
            }
        }

        MacroInfo.Commands["cancel"] = cancelMacro(CancelMode.Slash)
        MacroInfo.Commands["bcancel"] = cancelMacro(CancelMode.Backslash)
        MacroInfo.Commands["xcancel"] = cancelMacro(CancelMode.Cross)

        MacroInfo.Commands["ce"] = object : MacroInfo(1) {
            override fun invoke(tp: TeXParser, args: Array<String?>): Any? {
                val converted = convertMhchemCe(args.getOrNull(1).orEmpty())
                return TeXFormula(converted, false).root
            }
        }

        MacroInfo.Commands["pu"] = object : MacroInfo(1) {
            override fun invoke(tp: TeXParser, args: Array<String?>): Any? {
                val converted = convertMhchemPu(args.getOrNull(1).orEmpty())
                return TeXFormula(converted, false).root
            }
        }
    }
}

private enum class CancelMode {
    Slash,
    Backslash,
    Cross,
}

private class CancelBox(
    private val inner: JlmBox,
    private val thickness: Float,
    private val pad: Float,
    private val mode: CancelMode,
) : JlmBox() {
    init {
        width = inner.width + pad * 2f
        height = inner.height + pad
        depth = inner.depth + pad
        shift = inner.shift
    }

    override fun draw(g2: Graphics2D, x: Float, y: Float) {
        inner.draw(g2, x + pad, y)
        val oldStroke = g2.stroke
        g2.stroke = BasicStroke(thickness, BasicStroke.CAP_BUTT, BasicStroke.JOIN_MITER)
        val top = y - height
        val bottom = y + depth
        val left = x
        val right = x + width
        if (mode == CancelMode.Slash || mode == CancelMode.Cross) {
            g2.draw(Line2D.Float(left, bottom, right, top))
        }
        if (mode == CancelMode.Backslash || mode == CancelMode.Cross) {
            g2.draw(Line2D.Float(left, top, right, bottom))
        }
        g2.stroke = oldStroke
    }

    override fun getLastFontId(): Int = inner.lastFontId
}

private class CancelAtom(
    private val base: Atom?,
    private val mode: CancelMode,
) : Atom() {
    override fun createBox(env: TeXEnvironment): JlmBox {
        val tf = env.teXFont
        val thickness = tf.getDefaultRuleThickness(env.style)
        val inner = base?.createBox(env) ?: StrutBox(0f, 0f, 0f, 0f)
        val pad = thickness * 2f
        return CancelBox(inner, thickness, pad, mode)
    }
}

private fun cancelMacro(mode: CancelMode): MacroInfo = object : MacroInfo(1) {
    override fun invoke(tp: TeXParser, args: Array<String?>): Any {
        val base = TeXFormula(args.getOrNull(1).orEmpty(), false).root
        return CancelAtom(base, mode)
    }
}

private fun convertMhchemCe(input: String): String {
    val trimmed = input.trim()
    if (trimmed.isEmpty()) return ""
    val tokens = trimmed.split(Regex("\\s+"))
    return buildString {
        tokens.forEachIndexed { index, token ->
            if (index > 0) append(' ')
            when (token) {
                "<=>", "<-->" -> append("\\rightleftharpoons")
                "<->" -> append("\\leftrightarrow")
                "->", "\u27F6" -> append("\\rightarrow")
                "<-", "\u27F5" -> append("\\leftarrow")
                "+", "-", "=" -> append(token)
                "^", "(^)" -> append("\\uparrow")
                "v", "(v)" -> append("\\downarrow")
                else -> append(convertCeSpecies(token))
            }
        }
    }
}

private fun convertCeSpecies(token: String): String {
    if (token.contains('\\')) return token
    var body = token
    var charge: String? = null

    val explicitMatcher = CeExplicitChargePattern.matcher(body)
    if (explicitMatcher.matches()) {
        body = explicitMatcher.group(1).orEmpty()
        charge = explicitMatcher.group(2)
    } else {
        val implicitMatcher = CeImplicitChargePattern.matcher(body)
        if (implicitMatcher.matches()) {
            body = implicitMatcher.group(1).orEmpty()
            charge = implicitMatcher.group(2)
        }
    }

    return buildString {
        var idx = 0
        val n = body.length
        while (idx < n && body[idx].isDigit()) {
            append(body[idx])
            idx++
        }
        while (idx < n) {
            val ch = body[idx]
            when {
                ch.isLetter() -> {
                    val start = idx
                    while (idx < n && body[idx].isLetter()) {
                        idx++
                    }
                    append("\\mathrm{").append(body, start, idx).append('}')
                }
                ch.isDigit() -> {
                    val start = idx
                    while (idx < n && body[idx].isDigit()) {
                        idx++
                    }
                    append("_{").append(body, start, idx).append('}')
                }
                else -> {
                    append(ch)
                    idx++
                }
            }
        }
        if (!charge.isNullOrEmpty()) {
            append("^{").append(charge).append('}')
        }
    }
}

private fun convertMhchemPu(input: String): String {
    var s = input.trim()
    if (s.isEmpty()) return ""
    s = s.replace(Regex("(\\d+(?:\\.\\d+)?)[eE]([+-]?\\d+)"), "$1 \\\\times 10^{$2}")
    val fracMatcher = PuFractionPattern.matcher(s)
    val sb = StringBuffer()
    while (fracMatcher.find()) {
        val num = wrapPuUnits(fracMatcher.group(1).orEmpty())
        val den = wrapPuUnits(fracMatcher.group(2).orEmpty())
        fracMatcher.appendReplacement(sb, Matcher.quoteReplacement("\\frac{$num}{$den}"))
    }
    fracMatcher.appendTail(sb)
    s = wrapPuUnits(sb.toString())
    return s.replace(Regex("\\s+"), "\\\\,")
}

private fun wrapPuUnits(input: String): String {
    val matcher = PuUnitWordPattern.matcher(input)
    val sb = StringBuffer()
    while (matcher.find()) {
        matcher.appendReplacement(sb, Matcher.quoteReplacement("\\mathrm{${matcher.group(1).orEmpty()}}"))
    }
    matcher.appendTail(sb)
    return sb.toString()
}

private fun normalizeLatexSource(latex: String): String {
    if (!latex.contains('*')) return latex
    return StarredEnvironmentRegex.replace(latex, "\\\\$1{$2}")
}

private fun createLatexDrawable(
    latex: String,
    textSizePx: Float,
    colorArgb: Int,
): JLatexMathDrawable? {
    val trimmed = normalizeLatexSource(latex.trim())
    if (trimmed.isEmpty()) return null
    registerLatexExtensionsOnce()
    return runCatching {
        JLatexMathDrawable.builder(trimmed)
            .textSize(textSizePx)
            .color(colorArgb)
            .align(JLatexMathDrawable.ALIGN_CENTER)
            .build()
    }.getOrNull()
}

private fun mathInlineContent(
    drawable: JLatexMathDrawable,
    density: Density,
    maxWidthPx: Int,
): InlineTextContent {
    val rawWidthPx = drawable.intrinsicWidth.coerceAtLeast(1)
    val rawHeightPx = drawable.intrinsicHeight.coerceAtLeast(1)
    val widthPx = rawWidthPx.coerceAtMost(maxWidthPx.coerceAtLeast(1))
    val heightPx = if (rawWidthPx > widthPx) {
        (rawHeightPx.toFloat() * (widthPx.toFloat() / rawWidthPx.toFloat())).roundToInt().coerceAtLeast(1)
    } else {
        rawHeightPx
    }
    val widthDp = with(density) { widthPx.toDp() }
    val heightDp = with(density) { heightPx.toDp() }
    val placeholderWidth = with(density) { (widthDp + 2.dp).toSp() }
    val placeholderHeight = with(density) { (heightDp + 2.dp).toSp() }

    return InlineTextContent(
        placeholder = Placeholder(
            width = placeholderWidth,
            height = placeholderHeight,
            placeholderVerticalAlign = PlaceholderVerticalAlign.Center,
        ),
    ) {
        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            LatexDrawableCanvas(
                drawable = drawable,
                widthDp = widthDp,
                heightDp = heightDp,
            )
        }
    }
}

@Composable
private fun MarkdownMathBlock(
    latex: String,
    copyText: String,
    styles: MarkdownStyles,
) {
    val density = LocalDensity.current
    val baseFontSize = if (styles.body.fontSize != TextUnit.Unspecified) styles.body.fontSize else 17.sp
    val textSizePx = with(density) { (baseFontSize * 1.15f).toPx() }
    val colorArgb = styles.bodyColor.toArgb()
    val drawable = remember(latex, textSizePx, colorArgb) {
        createLatexDrawable(
            latex = latex,
            textSizePx = textSizePx,
            colorArgb = colorArgb,
        )
    }
    if (drawable == null) {
        Text(
            text = copyText,
            color = styles.bodyColor,
            style = styles.body,
        )
        return
    }

    val widthDp = with(density) { drawable.intrinsicWidth.coerceAtLeast(1).toDp() }
    val heightDp = with(density) { drawable.intrinsicHeight.coerceAtLeast(1).toDp() }
    val blockHeight = (heightDp + 16.dp).coerceAtLeast(36.dp)

    SelectableMarkdownCodeBlock(
        label = "math",
        code = copyText,
        height = blockHeight,
    ) {
        BoxWithConstraints(
            modifier = Modifier
                .fillMaxWidth()
                .height(blockHeight),
        ) {
            val minBlockWidth = maxWidth
            Box(
                modifier = Modifier
                    .fillMaxHeight()
                    .horizontalScroll(rememberScrollState())
                    .widthIn(min = minBlockWidth)
                    .padding(horizontal = 4.dp, vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                LatexDrawableCanvas(
                    drawable = drawable,
                    widthDp = widthDp,
                    heightDp = heightDp,
                )
            }
        }
    }
}

@Composable
private fun LatexDrawableCanvas(
    drawable: JLatexMathDrawable,
    widthDp: Dp,
    heightDp: Dp,
) {
    Canvas(modifier = Modifier.size(width = widthDp, height = heightDp)) {
        val w = size.width.roundToInt().coerceAtLeast(1)
        val h = size.height.roundToInt().coerceAtLeast(1)
        drawable.setBounds(0, 0, w, h)
        drawable.draw(drawContext.canvas.nativeCanvas)
    }
}

private sealed interface ParagraphSegment {
    data class InlineRun(val nodes: List<Node>) : ParagraphSegment
    data class BlockMath(val expression: MathExpression) : ParagraphSegment
}

private fun splitParagraphSegments(
    nodes: List<Node>,
    mathSource: MarkdownMathSource,
): List<ParagraphSegment> {
    if (!mathSource.hasMath || nodes.isEmpty()) {
        return listOf(ParagraphSegment.InlineRun(nodes))
    }

    fun standaloneBlockMathAt(index: Int): MathExpression? {
        val node = nodes[index] as? Text ?: return null
        val expr = mathSource.expressionForToken(node.literal.trim()) ?: return null
        if (expr.displayStyle != MathDisplayStyle.Block) return null
        val prev = nodes.getOrNull(index - 1)
        val next = nodes.getOrNull(index + 1)
        val prevIsLineBoundary = prev == null || prev is SoftLineBreak || prev is HardLineBreak
        val nextIsLineBoundary = next == null || next is SoftLineBreak || next is HardLineBreak
        return if (prevIsLineBoundary && nextIsLineBoundary) expr else null
    }

    val hasAnyBlockMath = nodes.indices.any { standaloneBlockMathAt(it) != null }
    if (!hasAnyBlockMath) {
        return listOf(ParagraphSegment.InlineRun(nodes))
    }

    val segments = mutableListOf<ParagraphSegment>()
    val currentInline = mutableListOf<Node>()

    fun flushInline() {
        while (currentInline.firstOrNull().let { it is SoftLineBreak || it is HardLineBreak }) {
            currentInline.removeAt(0)
        }
        while (currentInline.lastOrNull().let { it is SoftLineBreak || it is HardLineBreak }) {
            currentInline.removeAt(currentInline.lastIndex)
        }
        if (currentInline.isNotEmpty()) {
            segments += ParagraphSegment.InlineRun(currentInline.toList())
            currentInline.clear()
        }
    }

    nodes.forEachIndexed { index, node ->
        val blockMath = standaloneBlockMathAt(index)
        if (blockMath != null) {
            flushInline()
            segments += ParagraphSegment.BlockMath(blockMath)
        } else {
            currentInline += node
        }
    }
    flushInline()

    return segments
}

private enum class MathDisplayStyle {
    Inline,
    Block,
}

private data class MathExpression(
    val token: String,
    val tex: String,
    val source: String,
    val displayStyle: MathDisplayStyle,
)

private class MarkdownMathSource private constructor(
    val markdown: String,
    private val expressionsByToken: Map<String, MathExpression>,
    private val tokenRegex: Regex?,
) {
    val hasMath: Boolean get() = expressionsByToken.isNotEmpty()

    fun expressionForToken(text: String): MathExpression? = expressionsByToken[text]

    fun restoreLiteral(text: String): String {
        val regex = tokenRegex ?: return text
        if (!text.contains("AAMATH")) return text
        return regex.replace(text) { match ->
            expressionsByToken[match.value]?.source ?: match.value
        }
    }

    sealed interface InlineSegment {
        data class Literal(val text: String) : InlineSegment
        data class Math(val expression: MathExpression) : InlineSegment
    }

    fun splitInlineSegments(text: String): List<InlineSegment> {
        val regex = tokenRegex ?: return listOf(InlineSegment.Literal(text))
        if (!text.contains("AAMATH")) return listOf(InlineSegment.Literal(text))
        val segments = mutableListOf<InlineSegment>()
        var cursor = 0
        for (match in regex.findAll(text)) {
            if (match.range.first > cursor) {
                segments += InlineSegment.Literal(text.substring(cursor, match.range.first))
            }
            val expr = expressionsByToken[match.value]
            if (expr != null) {
                segments += InlineSegment.Math(expr)
            } else {
                segments += InlineSegment.Literal(match.value)
            }
            cursor = match.range.last + 1
        }
        if (cursor < text.length) {
            segments += InlineSegment.Literal(text.substring(cursor))
        }
        return segments
    }

    companion object {
        fun parse(markdown: String): MarkdownMathSource {
            if (!mayContainMath(markdown)) {
                return MarkdownMathSource(markdown, emptyMap(), null)
            }
            val nonce = UUID.randomUUID().toString().replace("-", "").uppercase()
            val expressions = LinkedHashMap<String, MathExpression>()
            var index = 0

            val rewritten = MathExtractionRegex.replace(markdown) { match ->
                val block = match.groups[3]?.value
                val bracket = match.groups[4]?.value
                val paren = match.groups[5]?.value
                val inline = match.groups[6]?.value

                val extracted: Triple<String, String, MathDisplayStyle>? = when {
                    block != null -> {
                        val body = block.removePrefix("$$").removeSuffix("$$").trim()
                        if (body.isNotEmpty()) Triple(body, block, MathDisplayStyle.Block) else null
                    }
                    bracket != null -> {
                        val body = bracket.removePrefix("\\[").removeSuffix("\\]").trim()
                        if (body.isNotEmpty()) Triple(body, bracket, MathDisplayStyle.Block) else null
                    }
                    paren != null -> {
                        val body = paren.removePrefix("\\(").removeSuffix("\\)").trim()
                        if (body.isNotEmpty()) Triple(body, paren, MathDisplayStyle.Inline) else null
                    }
                    inline != null -> {
                        val body = inline.removePrefix("$").removeSuffix("$").trim()
                        if (body.isNotEmpty()) Triple(body, inline, MathDisplayStyle.Inline) else null
                    }
                    else -> null
                }

                if (extracted == null) {
                    match.value
                } else {
                    val token = "AAMATH${nonce}X${index++}Z"
                    expressions[token] = MathExpression(
                        token = token,
                        tex = extracted.first,
                        source = extracted.second,
                        displayStyle = extracted.third,
                    )
                    token
                }
            }

            if (expressions.isEmpty()) {
                return MarkdownMathSource(markdown, emptyMap(), null)
            }
            val tokenRegex = Regex("AAMATH${Regex.escape(nonce)}X\\d+Z")
            return MarkdownMathSource(rewritten, expressions, tokenRegex)
        }

        private fun mayContainMath(markdown: String): Boolean {
            return markdown.contains('$') || markdown.contains("\\(") || markdown.contains("\\[")
        }
    }
}
