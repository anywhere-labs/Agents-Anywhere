package com.agentsanywhere.app.ui.screens.sessiondetail

import android.content.Context
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.util.Log
import android.view.MotionEvent
import android.widget.FrameLayout
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.unit.dp
import io.github.rosemoe.sora.lang.EmptyLanguage
import io.github.rosemoe.sora.lang.Language
import io.github.rosemoe.sora.lang.analysis.AnalyzeManager
import io.github.rosemoe.sora.lang.analysis.AsyncIncrementalAnalyzeManager
import io.github.rosemoe.sora.lang.analysis.IncrementalAnalyzeManager
import io.github.rosemoe.sora.lang.analysis.IncrementalAnalyzeManager.LineTokenizeResult
import io.github.rosemoe.sora.lang.analysis.StyleReceiver
import io.github.rosemoe.sora.lang.analysis.StyleUpdateRange
import io.github.rosemoe.sora.lang.brackets.BracketsProvider
import io.github.rosemoe.sora.lang.diagnostic.DiagnosticsContainer
import io.github.rosemoe.sora.lang.format.Formatter
import io.github.rosemoe.sora.lang.smartEnter.NewlineHandler
import io.github.rosemoe.sora.lang.styling.CodeBlock
import io.github.rosemoe.sora.lang.styling.Span
import io.github.rosemoe.sora.lang.styling.Styles
import io.github.rosemoe.sora.lang.styling.color.ConstColor
import io.github.rosemoe.sora.lang.styling.line.LineBackground
import io.github.rosemoe.sora.lang.styling.line.LineGutterBackground
import io.github.rosemoe.sora.lang.util.PlainTextSpans
import io.github.rosemoe.sora.text.Content
import io.github.rosemoe.sora.event.EventReceiver
import io.github.rosemoe.sora.event.PublishSearchResultEvent
import io.github.rosemoe.sora.event.SubscriptionReceipt
import io.github.rosemoe.sora.langs.textmate.TextMateColorScheme
import io.github.rosemoe.sora.langs.textmate.TextMateLanguage
import io.github.rosemoe.sora.langs.textmate.registry.FileProviderRegistry
import io.github.rosemoe.sora.langs.textmate.registry.GrammarRegistry
import io.github.rosemoe.sora.langs.textmate.registry.ThemeRegistry
import io.github.rosemoe.sora.langs.textmate.registry.model.DefaultGrammarDefinition
import io.github.rosemoe.sora.langs.textmate.registry.model.ThemeModel
import io.github.rosemoe.sora.langs.textmate.registry.provider.AssetsFileResolver
import io.github.rosemoe.sora.text.CharPosition
import io.github.rosemoe.sora.text.ContentReference
import io.github.rosemoe.sora.widget.CodeEditor
import io.github.rosemoe.sora.widget.EditorSearcher
import io.github.rosemoe.sora.widget.SymbolPairMatch
import io.github.rosemoe.sora.widget.schemes.EditorColorScheme
import org.eclipse.tm4e.core.registry.IGrammarSource
import org.eclipse.tm4e.core.registry.IThemeSource
import kotlin.math.abs

private const val LIGHT_THEME = "quietlight"
private const val DARK_THEME = "darcula"
private const val TEXTMATE_LOG_TAG = "SoraTextMate"

@Composable
internal fun SoraCodeBlock(
    text: String,
    languageHint: String?,
    darkMode: Boolean,
    diffHighlights: Map<Int, DiffLineTone> = emptyMap(),
    modifier: Modifier = Modifier,
    editorBackground: Color? = null,
    fixedHeight: Dp? = null,
    framed: Boolean = true,
    verticalScrollEnabled: Boolean = true,
    horizontalTouchOnly: Boolean = false,
    scalable: Boolean = true,
) {
    val context = LocalContext.current
    val shape = RoundedCornerShape(12.dp)
    val border = if (darkMode) Color(0xFF27272A) else Color(0xFFE4E1DB)
    val viewModifier = (fixedHeight?.let { modifier.fillMaxWidth().height(it) }
        ?: modifier.fillMaxWidth().heightIn(min = 64.dp, max = 360.dp))
        .then(if (framed) Modifier.clip(shape).border(1.dp, border, shape) else Modifier)
    AndroidView(
        modifier = viewModifier,
        factory = { ctx ->
            CodeEditor(ctx).apply {
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                )
                configureReadOnlyCodeEditor(
                    darkMode = darkMode,
                    editorBackground = editorBackground,
                    verticalScrollEnabled = verticalScrollEnabled,
                    horizontalTouchOnly = horizontalTouchOnly,
                    scalable = scalable,
                )
            }
        },
        update = { editor ->
            val previous = editor.tag as? SoraEditorState
            val languageKey = SoraTextMate.languageKeyFor(languageHint)
            val highlights = diffHighlights.toMap()
            val textChanged = editor.text.toString() != text
            SoraTextMate.ensureReady(context)
            if (previous?.darkMode != darkMode) {
                editor.colorScheme = SoraTextMate.colorScheme(darkMode)
            }
            editor.configureReadOnlyCodeEditor(
                darkMode = darkMode,
                editorBackground = editorBackground,
                verticalScrollEnabled = verticalScrollEnabled,
                horizontalTouchOnly = horizontalTouchOnly,
                scalable = scalable,
            )
            if (textChanged) {
                editor.setText(text)
            }
            if (previous?.languageKey != languageKey || previous.highlights != highlights) {
                val language = TracingLanguage(
                    base = SoraTextMate.languageFor(languageHint),
                    label = languageHint.orEmpty().substringAfterLast('/').ifBlank { "unknown" },
                )
                editor.setEditorLanguage(
                    if (diffHighlights.isEmpty()) {
                        language
                    } else {
                        DiffDecoratingLanguage(
                            base = language,
                            highlights = diffHighlights,
                            addedLineColor = if (darkMode) 0xFF163820.toInt() else 0xFFDDF8E7.toInt(),
                            deletedLineColor = if (darkMode) 0xFF411C1C.toInt() else 0xFFFFE1E1.toInt(),
                        )
                    },
                )
            }
            editor.tag = SoraEditorState(darkMode = darkMode, languageKey = languageKey, highlights = highlights)
        },
    )
}

@Composable
internal fun SoraFilePreview(
    text: String,
    languageHint: String?,
    darkMode: Boolean,
    searchQuery: String,
    searchController: SoraFileSearchController,
    onSearchResult: (SoraFileSearchResult) -> Unit,
    modifier: Modifier = Modifier,
    editorBackground: Color? = null,
) {
    val context = LocalContext.current
    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            CodeEditor(ctx).apply {
                layoutParams = FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT,
                )
                configureReadOnlyCodeEditor(
                    darkMode = darkMode,
                    editorBackground = editorBackground,
                    verticalScrollEnabled = true,
                    horizontalTouchOnly = false,
                    scalable = true,
                )
                searchController.attach(this, onSearchResult)
            }
        },
        update = { editor ->
            val previous = editor.tag as? SoraFileEditorState
            val languageKey = SoraTextMate.languageKeyFor(languageHint)
            val textChanged = editor.text.toString() != text
            val backgroundArgb = editorBackground?.toArgb()
                ?: if (darkMode) 0xFF09090B.toInt() else 0xFFFFFFFF.toInt()
            SoraTextMate.ensureReady(context)
            if (previous?.darkMode != darkMode) {
                editor.colorScheme = SoraTextMate.colorScheme(darkMode)
            }
            if (previous == null || previous.darkMode != darkMode || previous.backgroundArgb != backgroundArgb) {
                editor.configureReadOnlyCodeEditor(
                    darkMode = darkMode,
                    editorBackground = editorBackground,
                    verticalScrollEnabled = true,
                    horizontalTouchOnly = false,
                    scalable = true,
                )
            }
            if (textChanged) {
                editor.setText(text)
            }
            if (previous?.languageKey != languageKey) {
                editor.setEditorLanguage(
                    TracingLanguage(
                        base = SoraTextMate.languageFor(languageHint),
                        label = languageHint.orEmpty().substringAfterLast('/').ifBlank { "unknown" },
                    ),
                )
            }
            searchController.attach(editor, onSearchResult)
            if (previous?.searchQuery != searchQuery || textChanged) {
                searchController.search(searchQuery)
            }
            editor.tag = SoraFileEditorState(
                darkMode = darkMode,
                languageKey = languageKey,
                searchQuery = searchQuery,
                backgroundArgb = backgroundArgb,
            )
        },
    )
}

internal data class SoraFileSearchResult(
    val current: Int = 0,
    val total: Int = 0,
)

internal class SoraFileSearchController {
    private var editor: CodeEditor? = null
    private var receipt: SubscriptionReceipt<PublishSearchResultEvent>? = null
    private var receiver: EventReceiver<PublishSearchResultEvent>? = null
    private var query: String = ""
    private var onResult: ((SoraFileSearchResult) -> Unit)? = null

    fun attach(editor: CodeEditor, onResult: (SoraFileSearchResult) -> Unit) {
        this.onResult = onResult
        if (this.editor === editor) return
        receipt?.unsubscribe()
        this.editor = editor
        editor.searcher.setCyclicJumping(true)
        val newReceiver = EventReceiver<PublishSearchResultEvent> { event, _ ->
            report()
        }
        receiver = newReceiver
        receipt = editor.subscribeEvent(PublishSearchResultEvent::class.java, newReceiver)
    }

    fun search(newQuery: String) {
        query = newQuery
        val searcher = editor?.searcher ?: return
        if (newQuery.isBlank()) {
            runCatching { searcher.stopSearch() }
            onResult?.invoke(SoraFileSearchResult())
            return
        }
        runCatching {
            searcher.search(newQuery, EditorSearcher.SearchOptions(true, false))
        }.onFailure {
            onResult?.invoke(SoraFileSearchResult())
        }
    }

    fun next() {
        jump { gotoNext() }
    }

    fun previous() {
        jump { gotoPrevious() }
    }

    private fun jump(action: EditorSearcher.() -> Boolean) {
        if (query.isBlank()) return
        val searcher = editor?.searcher ?: return
        runCatching {
            action(searcher)
            editor?.ensureSelectionVisible()
        }
        report()
    }

    private fun report() {
        val searcher = editor?.searcher
        if (searcher == null || query.isBlank()) {
            onResult?.invoke(SoraFileSearchResult())
            return
        }
        val total = runCatching { searcher.matchedPositionCount }.getOrDefault(0)
        val index = runCatching { searcher.currentMatchedPositionIndex }.getOrDefault(-1)
        onResult?.invoke(
            SoraFileSearchResult(
                current = when {
                    total == 0 -> 0
                    index < 0 -> 1
                    else -> (index + 1).coerceIn(1, total)
                },
                total = total,
            ),
        )
    }
}

private data class SoraFileEditorState(
    val darkMode: Boolean,
    val languageKey: String,
    val searchQuery: String,
    val backgroundArgb: Int,
)

private data class SoraEditorState(
    val darkMode: Boolean,
    val languageKey: String,
    val highlights: Map<Int, DiffLineTone>,
)

internal enum class DiffLineTone {
    Added,
    Deleted,
}

private fun CodeEditor.configureReadOnlyCodeEditor(
    darkMode: Boolean,
    editorBackground: Color? = null,
    verticalScrollEnabled: Boolean = true,
    horizontalTouchOnly: Boolean = false,
    scalable: Boolean = true,
) {
    setEditable(false)
    isFocusable = false
    isFocusableInTouchMode = false
    inputType = InputType.TYPE_NULL
    setLineNumberEnabled(true)
    setWordwrap(false)
    setScrollBarEnabled(true)
    setHorizontalScrollBarEnabled(true)
    setVerticalScrollBarEnabled(verticalScrollEnabled)
    setScalable(scalable)
    setHighlightCurrentLine(false)
    setHighlightCurrentBlock(false)
    setHighlightBracketPair(false)
    setBlockLineEnabled(false)
    setCursorAnimationEnabled(false)
    setCursorBlinkPeriod(0)
    setTextSize(12f)
    setLineSpacing(0f, 1.08f)
    typefaceText = Typeface.MONOSPACE
    typefaceLineNumber = Typeface.MONOSPACE
    setDividerWidth(0f)
    setDividerMargin(0f)
    setLineNumberMarginLeft(8f)
    setPadding(0, 8, 0, 8)
    var downX = 0f
    var downY = 0f
    setOnTouchListener { view, event ->
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x
                downY = event.y
                view.parent?.requestDisallowInterceptTouchEvent(!horizontalTouchOnly)
            }
            MotionEvent.ACTION_MOVE -> {
                val horizontal = abs(event.x - downX) > abs(event.y - downY)
                view.parent?.requestDisallowInterceptTouchEvent(!horizontalTouchOnly || horizontal)
            }
            MotionEvent.ACTION_UP,
            MotionEvent.ACTION_CANCEL -> view.parent?.requestDisallowInterceptTouchEvent(false)
        }
        false
    }
    props.drawCustomLineBgOnCurrentLine = true
    props.scrollFling = true
    val bg = editorBackground?.toArgb()
        ?: if (darkMode) 0xFF09090B.toInt() else 0xFFFFFFFF.toInt()
    colorScheme.apply {
        setColor(EditorColorScheme.WHOLE_BACKGROUND, bg)
        setColor(EditorColorScheme.LINE_NUMBER_BACKGROUND, bg)
        setColor(EditorColorScheme.LINE_NUMBER, if (darkMode) 0xFFA1A1AA.toInt() else 0xFF8D8B84.toInt())
        setColor(EditorColorScheme.LINE_DIVIDER, if (darkMode) 0xFF27272A.toInt() else 0xFFE4E1DB.toInt())
        setColor(EditorColorScheme.CURRENT_LINE, android.graphics.Color.TRANSPARENT)
        setColor(EditorColorScheme.BLOCK_LINE, android.graphics.Color.TRANSPARENT)
        setColor(EditorColorScheme.BLOCK_LINE_CURRENT, android.graphics.Color.TRANSPARENT)
        setColor(EditorColorScheme.SIDE_BLOCK_LINE, android.graphics.Color.TRANSPARENT)
    }
}

internal object SoraTextMate {
    private var ready = false
    private var selectedTheme: String? = null

    fun ensureReady(context: Context) {
        if (ready) return
        FileProviderRegistry.getInstance().addFileProvider(AssetsFileResolver(context.applicationContext.assets))
        val themeRegistry = ThemeRegistry.getInstance()
        listOf(LIGHT_THEME to false, DARK_THEME to true).forEach { (name, dark) ->
            val path = "textmate/$name.json"
            val input = FileProviderRegistry.getInstance().tryGetInputStream(path)
            if (input == null) {
                Log.w(TEXTMATE_LOG_TAG, "Missing TextMate theme asset: $path")
                return@forEach
            }
            runCatching {
                themeRegistry.loadTheme(
                    ThemeModel(IThemeSource.fromInputStream(input, path, null), name).apply {
                        isDark = dark
                    },
                )
            }.onFailure { error ->
                Log.e(TEXTMATE_LOG_TAG, "Failed to load TextMate theme: $path", error)
            }
        }
        ready = true
    }

    fun setTheme(darkMode: Boolean) {
        val name = if (darkMode) DARK_THEME else LIGHT_THEME
        if (selectedTheme == name) return
        if (ThemeRegistry.getInstance().setTheme(name)) {
            selectedTheme = name
        } else {
            Log.w(TEXTMATE_LOG_TAG, "TextMate theme not registered: $name")
        }
    }

    fun colorScheme(darkMode: Boolean): EditorColorScheme {
        setTheme(darkMode)
        val themeRegistry = ThemeRegistry.getInstance()
        val theme = themeRegistry.currentThemeModel
        return TextMateColorScheme(null, theme).apply { setTheme(theme) }
    }

    fun languageFor(languageHint: String?): Language {
        val spec = specFor(languageHint)
        if (spec == null) {
            Log.w(TEXTMATE_LOG_TAG, "TextMate hint=$languageHint -> plain; no grammar spec")
            return EmptyLanguage()
        }
        Log.d(TEXTMATE_LOG_TAG, "TextMate hint=$languageHint -> ${spec.name} (${spec.scopeName})")
        if (!load(spec)) {
            Log.w(TEXTMATE_LOG_TAG, "Falling back to plain text; grammar load failed for ${spec.name} (${spec.scopeName})")
            return EmptyLanguage()
        }
        return runCatching { TextMateLanguage.create(spec.scopeName, false) }.getOrElse { error ->
            Log.e(TEXTMATE_LOG_TAG, "Failed to create TextMate language ${spec.name} (${spec.scopeName})", error)
            EmptyLanguage()
        }
    }

    fun languageKeyFor(languageHint: String?): String = specFor(languageHint)?.name ?: "plain"

    fun hasLanguageSpec(fileName: String): Boolean = specFor(fileName) != null

    private fun load(spec: LanguageSpec): Boolean {
        val grammarRegistry = GrammarRegistry.getInstance()
        if (grammarRegistry.findGrammar(spec.scopeName) != null) {
            Log.d(TEXTMATE_LOG_TAG, "TextMate grammar already loaded: ${spec.name} (${spec.scopeName})")
            return true
        }
        return runCatching {
            spec.dependencies.forEach { dependencyName ->
                val dependency = specsByName[dependencyName]
                if (dependency == null) {
                    Log.w(TEXTMATE_LOG_TAG, "Missing dependency spec '$dependencyName' for ${spec.name}")
                } else if (!load(dependency)) {
                    Log.w(TEXTMATE_LOG_TAG, "Dependency '$dependencyName' failed while loading ${spec.name}")
                }
            }
            val input = FileProviderRegistry.getInstance().tryGetInputStream(spec.grammarPath)
            if (input == null) {
                Log.w(TEXTMATE_LOG_TAG, "Missing TextMate grammar asset: ${spec.grammarPath}")
                return false
            }
            val source = IGrammarSource.fromInputStream(input, spec.grammarPath, null)
            Log.d(TEXTMATE_LOG_TAG, "Loading TextMate grammar ${spec.name} (${spec.scopeName}) from ${spec.grammarPath}")
            grammarRegistry.loadGrammar(
                DefaultGrammarDefinition.withLanguageConfiguration(source, null, spec.name, spec.scopeName),
            )
            ThemeRegistry.getInstance().currentThemeModel?.let { grammarRegistry.setTheme(it) }
            Log.d(TEXTMATE_LOG_TAG, "Loaded TextMate grammar ${spec.name} (${spec.scopeName})")
            true
        }.getOrElse { error ->
            Log.e(TEXTMATE_LOG_TAG, "Failed to load TextMate grammar ${spec.name} (${spec.scopeName}) from ${spec.grammarPath}", error)
            false
        }
    }

    private fun specFor(languageHint: String?): LanguageSpec? {
        val fileName = languageHint.orEmpty()
            .substringAfterLast('/')
            .substringAfterLast('\\')
        val lower = fileName.lowercase()

        return when {
            lower == "dockerfile" || lower.startsWith("dockerfile.") -> specsByName["docker"]
            lower.endsWith(".gradle.kts") -> specsByName["kotlin"]
            lower.endsWith(".gradle") -> specsByName["groovy"]
            lower == ".env" || lower.startsWith(".env.") || lower.endsWith(".env") -> specsByName["dotenv"]
            lower.endsWith(".wxml") -> specsByName["html"]
            lower.endsWith(".wxss") -> specsByName["css"]
            lower.endsWith(".wxs") -> specsByName["javascript"]
            else -> specsByName[languageAliases[lower] ?: lower]
                ?: specsByExtension[lower.substringAfterLast('.', "")]
        }
    }

    private data class LanguageSpec(
        val name: String,
        val scopeName: String,
        val dependencies: List<String> = emptyList(),
    ) {
        val grammarPath = "textmate/grammars/$name.json"
    }

    private val specsByName = listOf(
        LanguageSpec("kotlin", "source.kotlin"),
        LanguageSpec("java", "source.java"),
        LanguageSpec("javascript", "source.js"),
        LanguageSpec("typescript", "source.ts"),
        LanguageSpec("jsx", "source.js.jsx"),
        LanguageSpec("tsx", "source.tsx", dependencies = listOf("jsx")),
        LanguageSpec("json", "source.json"),
        LanguageSpec("yaml", "source.yaml"),
        LanguageSpec("shellscript", "source.shell"),
        LanguageSpec("css", "source.css"),
        LanguageSpec("scss", "source.css.scss", dependencies = listOf("css")),
        LanguageSpec("sass", "source.sass", dependencies = listOf("css")),
        LanguageSpec("sql", "source.sql"),
        LanguageSpec("toml", "source.toml"),
        LanguageSpec("docker", "source.dockerfile"),
        LanguageSpec("groovy", "source.groovy"),
        LanguageSpec("ini", "source.ini"),
        LanguageSpec("dotenv", "source.dotenv"),
        LanguageSpec("go", "source.go"),
        LanguageSpec("rust", "source.rust"),
        LanguageSpec("c", "source.c"),
        LanguageSpec("cpp", "source.cpp", dependencies = listOf("c")),
        LanguageSpec("csharp", "source.cs"),
        LanguageSpec("swift", "source.swift"),
        LanguageSpec("dart", "source.dart"),
        LanguageSpec("ruby", "source.ruby"),
        LanguageSpec("php", "source.php", dependencies = listOf("html", "xml", "sql", "javascript", "json", "css")),
        LanguageSpec("r", "source.r"),
        LanguageSpec("html", "text.html.basic", dependencies = listOf("css", "javascript")),
        LanguageSpec("xml", "text.xml"),
        LanguageSpec("markdown", "text.html.markdown"),
        LanguageSpec("lua", "source.lua"),
        LanguageSpec("python", "source.python"),
    ).associateBy { it.name }

    private val specsByExtension = mapOf(
        "kt" to "kotlin",
        "kts" to "kotlin",
        "java" to "java",
        "js" to "javascript",
        "mjs" to "javascript",
        "cjs" to "javascript",
        "ts" to "typescript",
        "mts" to "typescript",
        "cts" to "typescript",
        "jsx" to "jsx",
        "tsx" to "tsx",
        "json" to "json",
        "yaml" to "yaml",
        "yml" to "yaml",
        "sh" to "shellscript",
        "bash" to "shellscript",
        "zsh" to "shellscript",
        "css" to "css",
        "scss" to "scss",
        "sass" to "sass",
        "sql" to "sql",
        "toml" to "toml",
        "properties" to "ini",
        "env" to "dotenv",
        "go" to "go",
        "rs" to "rust",
        "c" to "c",
        "h" to "c",
        "cpp" to "cpp",
        "cc" to "cpp",
        "cxx" to "cpp",
        "hpp" to "cpp",
        "hh" to "cpp",
        "cs" to "csharp",
        "swift" to "swift",
        "dart" to "dart",
        "rb" to "ruby",
        "php" to "php",
        "r" to "r",
        "html" to "html",
        "htm" to "html",
        "xml" to "xml",
        "md" to "markdown",
        "markdown" to "markdown",
        "lua" to "lua",
        "py" to "python",
    ).mapValues { (_, name) -> specsByName[name] }

    private val languageAliases = mapOf(
        "bash" to "shellscript",
        "c++" to "cpp",
        "js" to "javascript",
        "md" to "markdown",
        "py" to "python",
        "sh" to "shellscript",
        "shell" to "shellscript",
        "ts" to "typescript",
        "zsh" to "shellscript",
    )
}

private class TracingLanguage(
    private val base: Language,
    label: String,
) : Language by base {
    private val manager = TracingAnalyzeManager(base.analyzeManager.withTokenizerFailureLogging(label), label)

    override fun getAnalyzeManager(): AnalyzeManager = manager

    override fun getFormatter(): Formatter = base.formatter

    override fun getSymbolPairs(): SymbolPairMatch = base.symbolPairs

    override fun getNewlineHandlers(): Array<NewlineHandler> = base.newlineHandlers ?: emptyArray()
}

@Suppress("UNCHECKED_CAST")
private fun AnalyzeManager.withTokenizerFailureLogging(label: String): AnalyzeManager {
    val incremental = this as? IncrementalAnalyzeManager<Any?, Span> ?: return this
    return SafeIncrementalAnalyzeManager(incremental, label)
}

private class SafeIncrementalAnalyzeManager(
    private val base: IncrementalAnalyzeManager<Any?, Span>,
    private val label: String,
) : AsyncIncrementalAnalyzeManager<Any?, Span>() {
    private var disabled = false
    private var reportedFailure = false

    override fun getInitialState(): Any? = runCatching {
        base.initialState
    }.getOrElse { error ->
        reportFailure("getInitialState", error)
        disabled = true
        null
    }

    override fun stateEquals(state: Any?, another: Any?): Boolean {
        if (disabled) return true
        return runCatching { base.stateEquals(state, another) }.getOrElse { error ->
            reportFailure("stateEquals", error)
            state == another
        }
    }

    override fun tokenizeLine(line: CharSequence, state: Any?, lineIndex: Int): LineTokenizeResult<Any?, Span> {
        if (disabled) return plainLineResult(state)
        return runCatching {
            base.tokenizeLine(line, state, lineIndex)
        }.getOrElse { error ->
            disabled = true
            reportFailure("tokenizeLine line=$lineIndex text=${line.take(120)}", error)
            plainLineResult(state)
        }
    }

    override fun generateSpansForLine(tokens: LineTokenizeResult<Any?, Span>): MutableList<Span> {
        return runCatching {
            base.generateSpansForLine(tokens).toMutableList()
        }.getOrElse { error ->
            reportFailure("generateSpansForLine", error)
            plainSpans()
        }
    }

    override fun onAddState(state: Any?) {
        if (!disabled) {
            runCatching { base.onAddState(state) }
                .onFailure { reportFailure("onAddState", it) }
        }
    }

    override fun onAbandonState(state: Any?) {
        if (!disabled) {
            runCatching { base.onAbandonState(state) }
                .onFailure { reportFailure("onAbandonState", it) }
        }
    }

    override fun computeBlocks(text: Content, delegate: CodeBlockAnalyzeDelegate): MutableList<CodeBlock> = mutableListOf()

    override fun destroy() {
        super.destroy()
        base.destroy()
    }

    private fun plainLineResult(state: Any?): LineTokenizeResult<Any?, Span> {
        return LineTokenizeResult(PlainState, null, plainSpans())
    }

    private fun plainSpans(): MutableList<Span> = mutableListOf(Span.obtain(0, EditorColorScheme.TEXT_NORMAL.toLong()))

    private fun reportFailure(where: String, error: Throwable) {
        if (reportedFailure) {
            Log.w(TEXTMATE_LOG_TAG, "[$label] TextMate analyzer already disabled; latest failure at $where: ${error.javaClass.simpleName}: ${error.message}")
            return
        }
        reportedFailure = true
        Log.e(TEXTMATE_LOG_TAG, "[$label] TextMate analyzer disabled after $where", error)
    }

    private data object PlainState
}

private class TracingAnalyzeManager(
    private val base: AnalyzeManager,
    private val label: String,
) : AnalyzeManager by base {
    override fun setReceiver(receiver: StyleReceiver?) {
        Log.d(TEXTMATE_LOG_TAG, "[$label] setReceiver=${receiver != null} manager=${base.javaClass.simpleName}")
        base.setReceiver(receiver?.let { TracingStyleReceiver(it, this, label) })
    }

    override fun reset(content: ContentReference, extraArguments: Bundle) {
        Log.d(TEXTMATE_LOG_TAG, "[$label] reset lines=${content.lineCount}")
        base.reset(content, extraArguments)
    }

    override fun insert(start: CharPosition, end: CharPosition, insertedContent: CharSequence) {
        Log.d(TEXTMATE_LOG_TAG, "[$label] insert ${start.line}:${start.column}-${end.line}:${end.column}")
        base.insert(start, end, insertedContent)
    }

    override fun delete(start: CharPosition, end: CharPosition, deletedContent: CharSequence) {
        Log.d(TEXTMATE_LOG_TAG, "[$label] delete ${start.line}:${start.column}-${end.line}:${end.column}")
        base.delete(start, end, deletedContent)
    }

    override fun rerun() {
        Log.d(TEXTMATE_LOG_TAG, "[$label] rerun")
        base.rerun()
    }
}

private class TracingStyleReceiver(
    private val delegate: StyleReceiver,
    private val source: AnalyzeManager,
    private val label: String,
) : StyleReceiver by delegate {
    override fun setStyles(sourceManager: AnalyzeManager, styles: Styles?) {
        Log.d(TEXTMATE_LOG_TAG, "[$label] setStyles ${styles.debugSummary()}")
        delegate.setStyles(source, styles)
    }

    override fun setStyles(sourceManager: AnalyzeManager, styles: Styles?, action: Runnable?) {
        Log.d(TEXTMATE_LOG_TAG, "[$label] setStyles(action) ${styles.debugSummary()}")
        delegate.setStyles(source, styles, action)
    }

    override fun updateStyles(sourceManager: AnalyzeManager, styles: Styles, range: StyleUpdateRange) {
        Log.d(TEXTMATE_LOG_TAG, "[$label] updateStyles ${styles.debugSummary()}")
        delegate.updateStyles(source, styles, range)
    }

    override fun setDiagnostics(sourceManager: AnalyzeManager, diagnostics: DiagnosticsContainer?) {
        delegate.setDiagnostics(source, diagnostics)
    }

    override fun updateBracketProvider(sourceManager: AnalyzeManager, provider: BracketsProvider?) {
        delegate.updateBracketProvider(source, provider)
    }
}

private fun Styles?.debugSummary(): String {
    if (this == null) return "styles=null"
    val spans = spans ?: return "spans=null lineStyles=${lineStyles?.size ?: 0} blocks=${blocks?.size ?: 0}"
    return runCatching {
        val reader = spans.read()
        val lineCount = spans.lineCount
        if (lineCount <= 0) return@runCatching "spans lines=0"
        reader.moveToLine(0)
        val spanCount = reader.spanCount
        val colorIds = (0 until spanCount.coerceAtMost(6))
            .joinToString(",") { index -> reader.getSpanAt(index).foregroundColorId.toString() }
        reader.moveToLine(-1)
        "spans lines=$lineCount firstLineSpans=$spanCount firstLineColors=$colorIds lineStyles=${lineStyles?.size ?: 0} blocks=${blocks?.size ?: 0}"
    }.getOrElse { error ->
        "spans unreadable: ${error.javaClass.simpleName}: ${error.message}"
    }
}

private class DiffDecoratingLanguage(
    private val base: Language,
    highlights: Map<Int, DiffLineTone>,
    addedLineColor: Int,
    deletedLineColor: Int,
) : Language by base {
    private val manager = DiffDecoratingAnalyzeManager(base.analyzeManager, highlights, addedLineColor, deletedLineColor)

    override fun getAnalyzeManager(): AnalyzeManager = manager

    override fun getFormatter(): Formatter = base.formatter

    override fun getSymbolPairs(): SymbolPairMatch = base.symbolPairs

    override fun getNewlineHandlers(): Array<NewlineHandler> = base.newlineHandlers ?: emptyArray()
}

private class DiffDecoratingAnalyzeManager(
    private val base: AnalyzeManager,
    private val highlights: Map<Int, DiffLineTone>,
    private val addedLineColor: Int,
    private val deletedLineColor: Int,
) : AnalyzeManager by base {
    private var receiver: StyleReceiver? = null

    override fun setReceiver(receiver: StyleReceiver?) {
        this.receiver = receiver
        base.setReceiver(receiver?.let { DiffDecoratingStyleReceiver(it, this, highlights, addedLineColor, deletedLineColor) })
    }

    override fun reset(content: ContentReference, extraArguments: Bundle) {
        sendDiffOnlyStyles(content.lineCount)
        base.reset(content, extraArguments)
    }

    override fun insert(start: CharPosition, end: CharPosition, insertedContent: CharSequence) {
        base.insert(start, end, insertedContent)
        sendDiffOnlyStyles(null)
    }

    override fun delete(start: CharPosition, end: CharPosition, deletedContent: CharSequence) {
        base.delete(start, end, deletedContent)
        sendDiffOnlyStyles(null)
    }

    override fun rerun() {
        sendDiffOnlyStyles(null)
        base.rerun()
    }

    private fun sendDiffOnlyStyles(lineCount: Int?) {
        if (highlights.isEmpty()) return
        receiver?.setStyles(
            this,
            Styles(lineCount?.let(::PlainTextSpans)).withDiffStyles(highlights, addedLineColor, deletedLineColor),
        )
    }
}

private class DiffDecoratingStyleReceiver(
    private val delegate: StyleReceiver,
    private val source: AnalyzeManager,
    private val highlights: Map<Int, DiffLineTone>,
    private val addedLineColor: Int,
    private val deletedLineColor: Int,
) : StyleReceiver by delegate {
    override fun setStyles(sourceManager: AnalyzeManager, styles: Styles?) {
        val decorated = styles.withDiffStyles(highlights, addedLineColor, deletedLineColor)
        delegate.setStyles(source, decorated)
    }

    override fun setStyles(sourceManager: AnalyzeManager, styles: Styles?, action: Runnable?) {
        val decorated = styles.withDiffStyles(highlights, addedLineColor, deletedLineColor)
        delegate.setStyles(source, decorated, action)
    }

    override fun updateStyles(sourceManager: AnalyzeManager, styles: Styles, range: StyleUpdateRange) {
        val decorated = styles.withDiffStyles(highlights, addedLineColor, deletedLineColor) ?: styles
        delegate.updateStyles(source, decorated, range)
    }

    override fun setDiagnostics(sourceManager: AnalyzeManager, diagnostics: DiagnosticsContainer?) {
        delegate.setDiagnostics(source, diagnostics)
    }

    override fun updateBracketProvider(sourceManager: AnalyzeManager, provider: BracketsProvider?) {
        delegate.updateBracketProvider(source, provider)
    }

}

private fun Styles?.withDiffStyles(
    highlights: Map<Int, DiffLineTone>,
    addedLineColor: Int,
    deletedLineColor: Int,
): Styles? {
    if (this == null || highlights.isEmpty()) return this
    val decorated = Styles(spans, false).also {
        it.blocks = blocks?.let(::ArrayList)
        it.suppressSwitch = suppressSwitch
        it.indentCountMode = indentCountMode
    }
    highlights.forEach { (line, tone) ->
        val color = ConstColor(if (tone == DiffLineTone.Added) addedLineColor else deletedLineColor)
        decorated.addLineStyle(LineBackground(line, color))
        decorated.addLineStyle(LineGutterBackground(line, color))
    }
    decorated.finishBuilding()
    return decorated
}
