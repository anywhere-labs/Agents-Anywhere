package dev.agentsanywhere.v3.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3.BuildConfig
import dev.agentsanywhere.v3.design.AAFonts
import dev.agentsanywhere.v3.design.AAText
import dev.agentsanywhere.v3.design.AAWordmark
import dev.agentsanywhere.v3.model.userMessage
import kotlinx.coroutines.launch

/** Sign in: control plane URL + email / password (local accounts; OIDC is a later step). */
@Composable
fun SignInScreen() {
    val app = LocalApp.current
    val scope = rememberCoroutineScope()
    var url by rememberSaveable { mutableStateOf(app.model.controlUrl ?: if (BuildConfig.DEBUG) "http://127.0.0.1:8790" else "") }
    var email by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var busy by mutableStateOfSaveable(false)
    var error by rememberSaveable { mutableStateOf<String?>(null) }
    val canSubmit = url.isNotBlank() && email.isNotBlank() && password.isNotEmpty() && !busy

    fun submit() {
        if (!canSubmit) return
        busy = true
        error = null
        scope.launch {
            try {
                app.model.signIn(url, email, password)
            } catch (e: Throwable) {
                error = e.userMessage()
            } finally {
                busy = false
            }
        }
    }

    Column(
        Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.statusBars.union(WindowInsets.navigationBars).union(WindowInsets.ime))
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(64.dp))
        AAWordmark(40f)
        Spacer(Modifier.height(8.dp))
        AAText("登录到你的控制面，查看和控制所有设备上的 Agent。", Modifier.padding(horizontal = 40.dp), font = AAFonts.subheadline,
            color = Ios.colors.secondaryText, align = TextAlign.Center)
        Column(Modifier.widthIn(max = 520.dp).fillMaxWidth()) {
            GroupedSection(header = "控制面") {
                TextFieldRow(url, { url = it.trim() }, "https://control.example.com", keyboardType = KeyboardType.Uri, separator = false)
            }
            GroupedSection(header = "账号", footer = error) {
                TextFieldRow(email, { email = it }, "邮箱", keyboardType = KeyboardType.Email)
                TextFieldRow(password, { password = it }, "密码", secure = true, imeAction = ImeAction.Go, onDone = ::submit, separator = false)
            }
            Column(Modifier.padding(horizontal = 32.dp, vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                ProminentButton("登录", enabled = canSubmit, loading = busy, onClick = ::submit)
            }
        }
    }
}

@Composable
private fun mutableStateOfSaveable(initial: Boolean) = rememberSaveable { mutableStateOf(initial) }
