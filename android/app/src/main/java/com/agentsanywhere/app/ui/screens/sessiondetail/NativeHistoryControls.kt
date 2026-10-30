package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

@Composable
internal fun NativeHistoryControls(
    sessionId: String,
    generation: String,
    revision: String,
    canContinue: Boolean,
    canRelease: Boolean,
    reason: String?,
    onAction: suspend (JSONObject, Boolean) -> Result<Unit>,
    onSettled: suspend () -> Unit,
) {
    var confirming by remember(sessionId) { mutableStateOf(false) }
    var cliExited by remember(sessionId) { mutableStateOf(false) }
    var busy by remember(sessionId) { mutableStateOf(false) }
    var releasing by remember(sessionId) { mutableStateOf(false) }
    var error by remember(sessionId) { mutableStateOf<String?>(null) }
    var pending by remember(sessionId) { mutableStateOf<JSONObject?>(null) }
    val scope = rememberCoroutineScope()
    fun execute(close: Boolean) {
        if (busy) return
        val body = if (close) JSONObject().put("ownerGeneration", generation).put("closeOperationId", UUID.randomUUID().toString())
            else pending ?: JSONObject().put("operationId", UUID.randomUUID().toString()).put("expectedGeneration", generation)
                .put("sourceRevision", revision).put("cliExited", true).also { pending = it }
        busy = true
        releasing = close
        error = null
        confirming = false
        scope.launch {
            try {
                onAction(body, close).fold(
                    onSuccess = { pending = null },
                    onFailure = {
                        if (it is com.agentsanywhere.app.feature.sessiondetail.NativeHistoryRejected || (it is com.agentsanywhere.app.api.ApiException && it.statusCode in 400..499)) pending = null
                        error = it.message
                    },
                )
                onSettled()
            } finally { busy = false }
        }
    }
    Surface(tonalElevation = 2.dp) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(if (busy && releasing) R.string.native_history_releasing else if (busy) R.string.native_history_preparing else R.string.native_history_title))
            Text(error ?: reason ?: stringResource(if (canRelease) R.string.native_history_release_hint else R.string.native_history_browse_hint))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (busy) CircularProgressIndicator()
                TextButton(enabled = !busy && (canContinue || canRelease || pending != null), onClick = {
                    if (canRelease) execute(true) else if (pending != null) execute(false) else { cliExited = false; confirming = true }
                }) {
                    Text(stringResource(if (canRelease) R.string.native_history_release else if (pending != null) R.string.native_history_check else R.string.native_history_continue))
                }
            }
        }
    }
    if (confirming) AlertDialog(
        onDismissRequest = { confirming = false },
        title = { Text(stringResource(R.string.native_history_continue)) },
        text = {
            Column {
                Text(stringResource(R.string.native_history_confirm_hint))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = cliExited, onCheckedChange = { cliExited = it })
                    Text(stringResource(R.string.native_history_cli_exited))
                }
            }
        },
        confirmButton = { TextButton(enabled = cliExited, onClick = { execute(false) }) { Text(stringResource(R.string.native_history_continue)) } },
        dismissButton = { TextButton(onClick = { confirming = false }) { Text(stringResource(android.R.string.cancel)) } },
    )
}
