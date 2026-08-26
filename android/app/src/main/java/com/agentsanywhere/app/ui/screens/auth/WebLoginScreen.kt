package com.agentsanywhere.app.ui.screens.auth

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.agentsanywhere.app.R
import com.agentsanywhere.app.feature.auth.WEB_LOGIN_CALLBACK_URI
import com.agentsanywhere.app.feature.auth.WebLoginSession
import com.agentsanywhere.app.feature.auth.WebLoginState
import com.agentsanywhere.app.feature.auth.WebLoginViewModel
import com.agentsanywhere.app.feature.auth.webLoginApiOriginBridgeScript
import com.agentsanywhere.app.navigation.AppDestination
import com.agentsanywhere.app.ui.designsystem.AAWordmark
import com.agentsanywhere.app.ui.designsystem.AuthErrorNotice
import com.agentsanywhere.app.ui.designsystem.BackPill
import com.agentsanywhere.app.ui.designsystem.LocalAAColors
import com.agentsanywhere.app.ui.designsystem.ScreenScaffold
import com.agentsanywhere.app.ui.designsystem.noRippleClickable
import com.composables.icons.lucide.Cloud
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.ArrowLeft
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Info
import com.composables.icons.lucide.Server

@Composable
fun WebLoginHostScreen(
    viewModel: WebLoginViewModel,
    navigate: (AppDestination) -> Unit,
) {
    val state = viewModel.state
    val embeddedSession = when (state) {
        is WebLoginState.WebLogin -> state.session
        is WebLoginState.Exchanging -> state.session
        else -> null
    }
    if (embeddedSession != null) {
        EmbeddedWebLogin(
            session = embeddedSession,
            exchanging = state is WebLoginState.Exchanging,
            onCallback = viewModel::handleCallback,
            onWebError = viewModel::reportWebError,
            onBack = viewModel::returnFromWebLogin,
            takeSavedState = { viewModel.takeWebViewState(embeddedSession) },
            onSaveState = { viewModel.saveWebViewState(embeddedSession, it) },
        )
        return
    }

    when (state) {
        is WebLoginState.HostChoice -> HostChoiceScreen(
            officialServiceAvailable = state.officialServiceAvailable,
            onSelfHost = viewModel::selectSelfHost,
            onOfficial = viewModel::startOfficialLogin,
            onBack = { navigate(AppDestination.LoginMethods) },
        )
        is WebLoginState.ServerEntry -> ServerEntryScreen(
            serverUrl = state.serverUrl,
            errorMessage = state.errorMessage,
            checking = false,
            onServerUrlChanged = viewModel::updateServerUrl,
            onContinue = viewModel::start,
            onBack = viewModel::returnToHostChoice,
        )
        is WebLoginState.Checking -> ServerEntryScreen(
            serverUrl = state.serverUrl,
            errorMessage = null,
            checking = true,
            onServerUrlChanged = {},
            onContinue = {},
            onBack = {
                viewModel.returnToHostChoice()
            },
        )
        is WebLoginState.WebLogin, is WebLoginState.Exchanging -> Unit
        is WebLoginState.Error -> ServerEntryScreen(
            serverUrl = state.serverUrl,
            errorMessage = state.message,
            checking = false,
            onServerUrlChanged = viewModel::updateServerUrl,
            onContinue = viewModel::start,
            onBack = {
                viewModel.returnToHostChoice()
            },
        )
        WebLoginState.Success -> LaunchedEffect(Unit) { navigate(AppDestination.Sessions) }
    }
}

@Composable
private fun HostChoiceScreen(
    officialServiceAvailable: Boolean,
    onSelfHost: () -> Unit,
    onOfficial: () -> Unit,
    onBack: () -> Unit,
) {
    val colors = LocalAAColors.current
    BackHandler(onBack = onBack)
    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 32.dp)
                .padding(top = 54.dp, bottom = 30.dp),
        ) {
            IconButton(
                onClick = onBack,
                modifier = Modifier.size(44.dp),
            ) {
                Icon(
                    imageVector = Lucide.ArrowLeft,
                    contentDescription = stringResource(R.string.common_back),
                    tint = colors.ink,
                    modifier = Modifier.size(24.dp),
                )
            }
            Spacer(Modifier.height(36.dp))
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = stringResource(R.string.auth_host_choice_title),
                    color = colors.ink,
                    fontSize = 28.sp,
                    fontWeight = FontWeight.SemiBold,
                    lineHeight = 34.sp,
                )
                Text(
                    text = stringResource(R.string.auth_host_choice_description),
                    color = colors.muted,
                    fontSize = 15.sp,
                    lineHeight = 21.sp,
                )
            }
            Spacer(Modifier.height(30.dp))
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                HostChoiceButton(
                    title = stringResource(R.string.auth_official_service),
                    description = stringResource(R.string.auth_official_service_description),
                    icon = Lucide.Cloud,
                    badge = if (officialServiceAvailable) {
                        stringResource(R.string.auth_recommended)
                    } else {
                        stringResource(R.string.auth_coming_soon)
                    },
                    enabled = officialServiceAvailable,
                    onClick = onOfficial,
                )
                HostChoiceButton(
                    title = stringResource(R.string.auth_self_host_service),
                    description = stringResource(R.string.auth_self_host_service_description),
                    icon = Lucide.Server,
                    onClick = onSelfHost,
                )
            }
            Spacer(Modifier.height(22.dp))
            Row(verticalAlignment = Alignment.Top) {
                Icon(
                    imageVector = Lucide.Info,
                    contentDescription = null,
                    tint = colors.faint,
                    modifier = Modifier.size(17.dp),
                )
                Text(
                    modifier = Modifier.padding(start = 9.dp),
                    text = stringResource(R.string.auth_host_choice_hint),
                    color = colors.muted,
                    fontSize = 13.sp,
                    lineHeight = 19.sp,
                )
            }
        }
    }
}

@Composable
private fun HostChoiceButton(
    title: String,
    description: String,
    icon: ImageVector,
    badge: String? = null,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val colors = LocalAAColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(88.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(colors.raisedSurface)
            .border(1.2.dp, colors.border, RoundedCornerShape(14.dp))
            .then(if (enabled) Modifier.noRippleClickable(onClick = onClick) else Modifier)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(42.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(colors.subtle),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = colors.ink, modifier = Modifier.size(21.dp))
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(start = 14.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                text = title,
                color = if (enabled) colors.ink else colors.muted,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 20.sp,
            )
            Text(
                text = description,
                color = colors.muted,
                fontSize = 12.5.sp,
                lineHeight = 17.sp,
            )
        }
        if (badge != null) {
            Text(
                text = badge,
                color = if (enabled) colors.inkSoft else colors.faint,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold,
                lineHeight = 15.sp,
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .background(colors.subtle)
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        } else {
            Spacer(Modifier.width(10.dp))
            Icon(
                imageVector = Lucide.ChevronRight,
                contentDescription = null,
                tint = colors.faint,
                modifier = Modifier.size(19.dp),
            )
        }
    }
}

@Composable
private fun ServerEntryScreen(
    serverUrl: String,
    errorMessage: String?,
    checking: Boolean,
    onServerUrlChanged: (String) -> Unit,
    onContinue: (String) -> Unit,
    onBack: () -> Unit,
) {
    val colors = LocalAAColors.current
    BackHandler(onBack = onBack)
    ScreenScaffold {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 32.dp)
                .padding(top = 74.dp, bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(30.dp),
        ) {
            BackPill(label = stringResource(R.string.common_back), onClick = onBack)
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = stringResource(R.string.auth_self_host_login_title),
                    color = colors.ink,
                    fontSize = 24.sp,
                    fontWeight = FontWeight.Medium,
                    lineHeight = 26.sp,
                )
                AAWordmark(color = colors.ink, fontSize = 42.sp, lineHeight = 44.sp)
                Text(
                    text = stringResource(R.string.auth_web_login_subtitle),
                    color = colors.muted,
                    fontSize = 14.sp,
                    lineHeight = 19.sp,
                )
            }
            errorMessage?.let { AuthErrorNotice(message = it) }
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                AuthInputRow(
                    value = serverUrl,
                    onValueChange = onServerUrlChanged,
                    placeholder = stringResource(R.string.common_server_url),
                    icon = Lucide.Server,
                    enabled = !checking,
                )
                AuthContinueButton(
                    isLoading = checking,
                    label = stringResource(R.string.auth_continue_in_web),
                    loadingLabel = stringResource(R.string.common_checking),
                ) { onContinue(serverUrl) }
                Text(
                    text = stringResource(R.string.auth_web_login_help),
                    color = colors.muted,
                    fontSize = 13.sp,
                    lineHeight = 18.sp,
                )
            }
        }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun EmbeddedWebLogin(
    session: WebLoginSession,
    exchanging: Boolean,
    onCallback: (String) -> Unit,
    onWebError: (String) -> Unit,
    onBack: () -> Unit,
    takeSavedState: () -> Bundle?,
    onSaveState: (Bundle) -> Unit,
) {
    var webView by remember(session) { mutableStateOf<WebView?>(null) }
    var loading by remember(session) { mutableStateOf(true) }

    BackHandler(onBack = onBack)

    Column(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.statusBars),
    ) {
        Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
            BackPill(label = stringResource(R.string.common_back), onClick = onBack)
        }
        Box(modifier = Modifier.fillMaxSize()) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { context ->
                    WebView(context).apply {
                        webView = this
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.allowFileAccess = false
                        settings.allowContentAccess = false
                        settings.javaScriptCanOpenWindowsAutomatically = false
                        settings.setSupportMultipleWindows(false)
                        CookieManager.getInstance().setAcceptCookie(true)
                        CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
                        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                            WebViewCompat.addDocumentStartJavaScript(
                                this,
                                webLoginApiOriginBridgeScript(session.serverUrl),
                                setOf(session.serverUrl),
                            )
                        } else {
                            onWebError("Update Android System WebView to continue signing in.")
                            return@apply
                        }
                        webViewClient = SecureLoginWebViewClient(
                            onLoadingChanged = { loading = it },
                            onCallback = onCallback,
                            onError = onWebError,
                        )
                        val restored = takeSavedState()
                        if (restored == null || restoreState(restored) == null) {
                            loadUrl(session.authorizeUrl)
                        }
                    }
                },
            )
            if (loading || exchanging) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
        }
    }

    DisposableEffect(session) {
        onDispose {
            webView?.apply {
                val state = Bundle()
                if (saveState(state) != null) onSaveState(state)
                stopLoading()
                clearHistory()
                loadUrl("about:blank")
                removeAllViews()
                destroy()
            }
            webView = null
        }
    }
}

private class SecureLoginWebViewClient(
    private val onLoadingChanged: (Boolean) -> Unit,
    private val onCallback: (String) -> Unit,
    private val onError: (String) -> Unit,
) : WebViewClient() {
    override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
        onLoadingChanged(true)
    }

    override fun onPageFinished(view: WebView?, url: String?) {
        onLoadingChanged(false)
    }

    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest): Boolean {
        return handleUrl(request.url.toString())
    }

    @Deprecated("Deprecated in Java")
    override fun shouldOverrideUrlLoading(view: WebView?, url: String): Boolean = handleUrl(url)

    override fun onReceivedSslError(view: WebView?, handler: SslErrorHandler, error: SslError?) {
        handler.cancel()
        onError("The server certificate could not be verified.")
    }

    override fun onReceivedError(view: WebView?, request: WebResourceRequest, error: WebResourceError?) {
        if (request.isForMainFrame) {
            onError(error?.description?.toString().orEmpty().ifBlank { "Could not load the web login page." })
        }
    }

    private fun handleUrl(url: String): Boolean {
        if (url.startsWith(WEB_LOGIN_CALLBACK_URI, ignoreCase = true)) {
            onCallback(url)
            return true
        }
        val scheme = runCatching { java.net.URI(url).scheme?.lowercase() }.getOrNull()
        if (scheme == "http" || scheme == "https") return false
        onError("This link cannot be opened inside the sign-in page.")
        return true
    }
}
