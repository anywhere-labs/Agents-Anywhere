package com.agentsanywhere.app.ui.screens.files

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.LruCache
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.files.FilePreviewKind
import com.agentsanywhere.app.feature.files.TEXT_PREVIEW_MAX_BYTES
import com.agentsanywhere.app.feature.files.fileMimeType
import com.agentsanywhere.app.feature.files.preview.DocxHtmlConverter
import com.agentsanywhere.app.feature.files.preview.LegacyOfficeConverter
import com.agentsanywhere.app.feature.files.preview.MarkdownHtmlConverter
import com.agentsanywhere.app.feature.files.preview.OfficeHtml
import com.agentsanywhere.app.feature.files.preview.PREVIEW_BASE_URL
import com.agentsanywhere.app.feature.files.preview.PREVIEW_FILE_PATH
import com.agentsanywhere.app.feature.files.preview.PREVIEW_HOST
import com.agentsanywhere.app.feature.files.preview.PREVIEW_OPEN_PATH
import com.agentsanywhere.app.feature.files.preview.PptxHtmlConverter
import com.agentsanywhere.app.feature.files.preview.PreviewFailureReason
import com.agentsanywhere.app.feature.files.preview.PreviewLabels
import com.agentsanywhere.app.feature.files.preview.PreviewTextContent
import com.agentsanywhere.app.feature.files.preview.PreviewUnavailableException
import com.agentsanywhere.app.feature.files.preview.SVG_PREVIEW_SOURCE
import com.agentsanywhere.app.feature.files.preview.SpreadsheetHtmlConverter
import com.agentsanywhere.app.feature.files.preview.readPreviewText
import com.agentsanywhere.app.feature.files.preview.svgPreviewHtml
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.agentsanywhere.app.ui.screens.sessiondetail.FullscreenSystemBars
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.X
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import me.saket.telephoto.zoomable.coil3.ZoomableAsyncImage
import java.io.ByteArrayInputStream
import java.io.Closeable
import java.io.File
import java.util.zip.ZipFile
import kotlin.math.roundToInt

/** What the preview body needs from the screen around it. */
internal class FilePreviewHost(
    /** Absolute work-device path of the file being shown, for resolving relative links. */
    val remotePath: String,
    val labels: PreviewLabels,
    /** Blocking download of an image referenced by a document; called off the main thread. */
    val loadDocumentImage: (remotePath: String) -> File?,
    val onOpenRemotePath: (String) -> Unit,
    val onOpenExternalUrl: (String) -> Unit,
)

@Composable
internal fun FilePreviewBody(
    file: File,
    name: String,
    kind: FilePreviewKind,
    showSource: Boolean,
    darkMode: Boolean,
    host: FilePreviewHost,
    modifier: Modifier = Modifier,
) {
    when (kind) {
        FilePreviewKind.Pdf -> PdfFilePreview(file = file, name = name, modifier = modifier)
        FilePreviewKind.Image -> ZoomableAsyncImage(
            model = Uri.fromFile(file),
            contentDescription = name,
            contentScale = ContentScale.Fit,
            modifier = modifier.fillMaxSize().padding(8.dp),
        )
        FilePreviewKind.Text -> TextFilePreview(file = file, darkMode = darkMode, modifier = modifier)
        FilePreviewKind.Markdown, FilePreviewKind.Html, FilePreviewKind.Svg, FilePreviewKind.Csv ->
            if (showSource) {
                TextFilePreview(file = file, darkMode = darkMode, modifier = modifier)
            } else {
                ConvertedWebPreview(file, name, kind, darkMode, host, modifier)
            }
        FilePreviewKind.Docx, FilePreviewKind.Pptx, FilePreviewKind.Xlsx,
        FilePreviewKind.LegacyWord, FilePreviewKind.LegacyPowerPoint ->
            ConvertedWebPreview(file, name, kind, darkMode, host, modifier)
        FilePreviewKind.Unsupported -> Unit
    }
}

/** Which kinds offer a "source" toggle next to the rendered preview. */
internal fun FilePreviewKind.hasSourceView(): Boolean =
    this == FilePreviewKind.Markdown || this == FilePreviewKind.Html ||
        this == FilePreviewKind.Svg || this == FilePreviewKind.Csv

private sealed interface WebContent {
    data class Office(val document: OfficeHtml) : WebContent
    data class Page(val html: String, val javaScript: Boolean) : WebContent
}

@Composable
private fun ConvertedWebPreview(
    file: File,
    name: String,
    kind: FilePreviewKind,
    darkMode: Boolean,
    host: FilePreviewHost,
    modifier: Modifier,
) {
    var content by remember(file, kind, darkMode) { mutableStateOf<Result<WebContent>?>(null) }
    LaunchedEffect(file, kind, darkMode) {
        content = withContext(Dispatchers.Default) {
            runCatching {
                when (kind) {
                    FilePreviewKind.Docx -> WebContent.Office(DocxHtmlConverter.convert(file, host.labels, darkMode))
                    FilePreviewKind.Pptx -> WebContent.Office(PptxHtmlConverter.convert(file, host.labels, darkMode))
                    FilePreviewKind.Xlsx -> WebContent.Office(SpreadsheetHtmlConverter.convertXlsx(file, host.labels, darkMode))
                    FilePreviewKind.LegacyWord -> WebContent.Office(LegacyOfficeConverter.convertDoc(file, host.labels, darkMode))
                    FilePreviewKind.LegacyPowerPoint -> WebContent.Office(LegacyOfficeConverter.convertPpt(file, host.labels, darkMode))
                    FilePreviewKind.Csv -> {
                        val text = readPreviewText(file, TEXT_PREVIEW_MAX_BYTES)
                        val delimiter = SpreadsheetHtmlConverter.delimiterFor(name, text.text.take(4096))
                        WebContent.Office(
                            SpreadsheetHtmlConverter.convertDelimited(text.text, delimiter, text.truncated, host.labels, darkMode),
                        )
                    }
                    FilePreviewKind.Markdown -> {
                        val text = readPreviewText(file, TEXT_PREVIEW_MAX_BYTES)
                        WebContent.Page(MarkdownHtmlConverter.convert(text.text, host.remotePath, darkMode), javaScript = false)
                    }
                    FilePreviewKind.Svg -> WebContent.Page(svgPreviewHtml(darkMode), javaScript = false)
                    else -> WebContent.Page(readPreviewText(file, TEXT_PREVIEW_MAX_BYTES).text, javaScript = true)
                }
            }
        }
    }
    val result = content
    when {
        result == null -> PreviewProgress(stringResource(R.string.file_preview_rendering), modifier)
        result.isFailure -> PreviewFailure(
            message = stringResource(
                when ((result.exceptionOrNull() as? PreviewUnavailableException)?.reason) {
                    PreviewFailureReason.Damaged -> R.string.file_preview_document_damaged
                    PreviewFailureReason.TooLarge -> R.string.file_preview_document_too_large
                    PreviewFailureReason.PasswordProtected -> R.string.file_preview_document_protected
                    null -> R.string.file_preview_render_failed
                },
            ),
            modifier = modifier,
        )
        else -> when (val web = result.getOrThrow()) {
            is WebContent.Office -> PreviewWebView(
                html = web.document.html,
                javaScript = false,
                allowNetwork = false,
                darkMode = darkMode,
                serveResource = { uri -> serveOfficeMedia(file, web.document.media, uri) },
                host = host,
                modifier = modifier,
            )
            is WebContent.Page -> PreviewWebView(
                html = web.html,
                javaScript = web.javaScript,
                // Markdown and SVG stay offline; an HTML report may load its CDN scripts and styles.
                allowNetwork = web.javaScript,
                darkMode = darkMode,
                serveResource = { uri ->
                    when {
                        web.javaScript -> null
                        kind == FilePreviewKind.Svg && uri.path?.endsWith("/$SVG_PREVIEW_SOURCE") == true ->
                            WebResourceResponse("image/svg+xml", "utf-8", file.inputStream())
                        else -> serveDocumentImage(uri, host)
                    }
                },
                host = host,
                modifier = modifier,
            )
        }
    }
}

private fun serveOfficeMedia(file: File, media: Map<String, String>, uri: Uri): WebResourceResponse? {
    val relative = uri.path.orEmpty().removePrefix(Uri.parse(PREVIEW_BASE_URL).path.orEmpty())
    val entryName = media[relative] ?: return null
    return runCatching {
        ZipFile(file).use { zip ->
            val entry = zip.getEntry(entryName) ?: return null
            if (entry.size > 24L * 1024 * 1024) return null
            val bytes = zip.getInputStream(entry).use { it.readBytes() }
            WebResourceResponse(fileMimeType(entryName), null, ByteArrayInputStream(bytes))
        }
    }.getOrNull()
}

private fun serveDocumentImage(uri: Uri, host: FilePreviewHost): WebResourceResponse? {
    if (uri.path != PREVIEW_FILE_PATH) return null
    val path = uri.getQueryParameter("path")?.takeIf { it.isNotBlank() } ?: return null
    val image = host.loadDocumentImage(path) ?: return null
    return runCatching {
        WebResourceResponse(fileMimeType(image.name), null, image.inputStream())
    }.getOrNull()
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun PreviewWebView(
    html: String,
    javaScript: Boolean,
    allowNetwork: Boolean,
    darkMode: Boolean,
    serveResource: (Uri) -> WebResourceResponse?,
    host: FilePreviewHost,
    modifier: Modifier,
) {
    val canvas = if (darkMode) Color(0xFF09090B) else Color(0xFFF1F0ED)
    val currentServe by rememberUpdatedState(serveResource)
    val currentHost by rememberUpdatedState(host)
    AndroidView(
        modifier = modifier.fillMaxSize(),
        factory = { context ->
            WebView(context).apply {
                setBackgroundColor(canvas.toArgb())
                settings.apply {
                    javaScriptEnabled = javaScript
                    domStorageEnabled = javaScript
                    allowFileAccess = false
                    allowContentAccess = false
                    builtInZoomControls = true
                    displayZoomControls = false
                    loadWithOverviewMode = true
                    useWideViewPort = true
                    javaScriptCanOpenWindowsAutomatically = false
                    mediaPlaybackRequiresUserGesture = true
                    blockNetworkLoads = !allowNetwork
                    setSupportMultipleWindows(false)
                }
                if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
                    WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false)
                }
                webViewClient = object : WebViewClient() {
                    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                        val url = request.url
                        if (url.host == PREVIEW_HOST) {
                            return currentServe(url) ?: WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                        }
                        // The document itself arrives as a data: URL; only web requests are blocked offline.
                        val web = url.scheme.equals("http", ignoreCase = true) || url.scheme.equals("https", ignoreCase = true)
                        if (web && !allowNetwork) {
                            return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                        }
                        return null
                    }

                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        val url = request.url
                        if (url.host == PREVIEW_HOST) {
                            if (url.path == PREVIEW_OPEN_PATH) {
                                url.getQueryParameter("path")?.takeIf { it.isNotBlank() }?.let(currentHost.onOpenRemotePath)
                                return true
                            }
                            // In-page anchors such as the sheet tabs.
                            return url.fragment == null
                        }
                        if (!request.isForMainFrame && allowNetwork) return false
                        when (url.scheme?.lowercase()) {
                            "http", "https", "mailto" -> currentHost.onOpenExternalUrl(url.toString())
                        }
                        return true
                    }
                }
                loadDataWithBaseURL(PREVIEW_BASE_URL, html, "text/html", "utf-8", null)
                tag = html.hashCode()
            }
        },
        update = { view ->
            if (view.tag != html.hashCode()) {
                view.loadDataWithBaseURL(PREVIEW_BASE_URL, html, "text/html", "utf-8", null)
                view.tag = html.hashCode()
            }
        },
        onRelease = { view ->
            view.stopLoading()
            view.destroy()
        },
    )
}

@Composable
private fun TextFilePreview(file: File, darkMode: Boolean, modifier: Modifier) {
    val colors = LocalAAColors.current
    var content by remember(file) { mutableStateOf<PreviewTextContent?>(null) }
    LaunchedEffect(file) {
        content = withContext(Dispatchers.IO) {
            runCatching { readPreviewText(file, TEXT_PREVIEW_MAX_BYTES) }.getOrElse { PreviewTextContent("", false) }
        }
    }
    val text = content
    if (text == null) {
        PreviewProgress(stringResource(R.string.file_preview_rendering), modifier)
        return
    }
    val lines = remember(text) { text.text.split('\n') }
    SelectionContainer(modifier = modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .background(if (darkMode) Color(0xFF111113) else Color.White),
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp),
        ) {
            items(lines.size) { index ->
                Text(
                    text = lines[index].trimEnd('\r'),
                    color = colors.ink,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.5.sp,
                    lineHeight = 19.sp,
                )
            }
            if (text.truncated) {
                item {
                    Text(
                        text = stringResource(R.string.file_preview_text_truncated),
                        color = colors.muted,
                        fontSize = 12.sp,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                }
            }
        }
    }
}

/** Renders PDF pages with the platform renderer; tap a page to zoom. */
@Composable
private fun PdfFilePreview(file: File, name: String, modifier: Modifier) {
    val colors = LocalAAColors.current
    val document = remember(file) { runCatching { PdfDocument(file) } }
    DisposableEffect(document) {
        onDispose { document.getOrNull()?.close() }
    }
    val pdf = document.getOrNull()
    if (pdf == null) {
        val message = if (document.exceptionOrNull() is SecurityException) {
            stringResource(R.string.file_preview_pdf_protected)
        } else {
            stringResource(R.string.file_preview_render_failed)
        }
        PreviewFailure(message, modifier)
        return
    }
    var zoomPage by remember(file) { mutableStateOf<Int?>(null) }
    val aspects = remember(file) { mutableStateMapOf<Int, Float>() }
    val cache = remember(file) {
        object : LruCache<Int, Bitmap>(48 * 1024 * 1024) {
            override fun sizeOf(key: Int, value: Bitmap): Int = value.byteCount
        }
    }
    val listState = rememberLazyListState()
    val currentPage by remember { derivedStateOf { listState.firstVisibleItemIndex + 1 } }
    BoxWithConstraints(modifier = modifier.fillMaxSize().background(if (colors.isDark) Color(0xFF09090B) else Color(0xFFF1F0ED))) {
        val pageWidthPx = with(LocalDensity.current) { (maxWidth - 24.dp).roundToPx() }.coerceIn(200, 2000)
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(pdf.pageCount) { index ->
                var bitmap by remember(index, pageWidthPx) { mutableStateOf(cache.get(index)?.takeIf { it.width == pageWidthPx }) }
                LaunchedEffect(index, pageWidthPx) {
                    if (bitmap == null) {
                        bitmap = pdf.render(index, pageWidthPx)?.also { rendered ->
                            cache.put(index, rendered)
                            aspects[index] = rendered.width.toFloat() / rendered.height
                        }
                    }
                }
                val aspect = aspects[index] ?: bitmap?.let { it.width.toFloat() / it.height } ?: (1f / 1.414f)
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .aspectRatio(aspect)
                        .shadow(1.dp, RoundedCornerShape(2.dp))
                        .background(Color.White)
                        .noRippleClickable { zoomPage = index },
                ) {
                    bitmap?.let {
                        Image(
                            bitmap = it.asImageBitmap(),
                            contentDescription = "$name ${index + 1}",
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                }
            }
        }
        Text(
            text = stringResource(R.string.file_preview_page_indicator, currentPage.coerceAtMost(pdf.pageCount), pdf.pageCount),
            color = Color.White,
            fontSize = 12.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(16.dp)
                .clip(CircleShape)
                .background(Color(0x99000000))
                .padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
    zoomPage?.let { index ->
        PdfPageZoomDialog(pdf = pdf, index = index, name = name, onDismiss = { zoomPage = null })
    }
}

@Composable
private fun PdfPageZoomDialog(pdf: PdfDocument, index: Int, name: String, onDismiss: () -> Unit) {
    var bitmap by remember(pdf, index) { mutableStateOf<Bitmap?>(null) }
    LaunchedEffect(pdf, index) {
        bitmap = pdf.render(index, 2400)
    }
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        FullscreenSystemBars(backgroundColor = Color.Black, useDarkIcons = false)
        val statusTop = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
        Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
            val image = bitmap
            if (image == null) {
                CircularProgressIndicator(color = Color.White, modifier = Modifier.align(Alignment.Center).size(28.dp))
            } else {
                ZoomableAsyncImage(
                    model = image,
                    contentDescription = "$name ${index + 1}",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = statusTop + 12.dp, end = 16.dp)
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(Color(0xD93F3F46))
                    .noRippleClickable(onClick = onDismiss),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Lucide.X, contentDescription = stringResource(R.string.common_close), tint = Color.White, modifier = Modifier.size(20.dp))
            }
        }
    }
}

/** Serializes access to [PdfRenderer], which renders one page at a time. */
private class PdfDocument(file: File) : Closeable {
    private val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    private val renderer = try {
        PdfRenderer(descriptor)
    } catch (error: Throwable) {
        descriptor.close()
        throw error
    }
    private val lock = Any()
    private var closed = false
    val pageCount: Int = renderer.pageCount

    suspend fun render(index: Int, widthPx: Int): Bitmap? = withContext(Dispatchers.IO) {
        synchronized(lock) {
            if (closed || index !in 0 until pageCount) return@withContext null
            runCatching {
                renderer.openPage(index).use { page ->
                    val pageWidth = page.width.coerceAtLeast(1)
                    val pageHeight = page.height.coerceAtLeast(1)
                    // Keep very tall pages within a sane bitmap size.
                    val maxPixels = 12_000_000.0
                    var width = widthPx
                    var height = (pageHeight * (width.toDouble() / pageWidth)).roundToInt()
                    if (width.toDouble() * height > maxPixels) {
                        val shrink = kotlin.math.sqrt(maxPixels / (width.toDouble() * height))
                        width = (width * shrink).roundToInt()
                        height = (height * shrink).roundToInt()
                    }
                    val bitmap = Bitmap.createBitmap(width.coerceAtLeast(1), height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
                    bitmap.eraseColor(android.graphics.Color.WHITE)
                    page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    bitmap
                }
            }.getOrNull()
        }
    }

    override fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            runCatching { renderer.close() }
            runCatching { descriptor.close() }
        }
    }
}

@Composable
internal fun PreviewProgress(message: String, modifier: Modifier = Modifier) {
    val colors = LocalAAColors.current
    Column(
        modifier = modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator(color = colors.muted, strokeWidth = 2.dp, modifier = Modifier.size(26.dp))
        Text(
            text = message,
            color = colors.muted,
            fontSize = 13.sp,
            modifier = Modifier.padding(top = 12.dp),
        )
    }
}

@Composable
internal fun PreviewFailure(message: String, modifier: Modifier = Modifier) {
    val colors = LocalAAColors.current
    Box(modifier = modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
        Text(text = message, color = colors.muted, fontSize = 13.sp, lineHeight = 19.sp)
    }
}
