package com.agentsanywhere.app.ui.screens.sessiondetail

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.ApiException
import com.agentsanywhere.app.feature.sessiondetail.NativeHistoryRejected
import com.agentsanywhere.app.ui.designsystem.runtimeOperationErrorMessage
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

/** Resumes a session whose Agent connection was lost. Native history keeps its own controls. */
@Composable
internal fun AgentRecoveryControls(
    sessionId: String,
    generation: String,
    enabled: Boolean,
    onRecover: suspend (JSONObject) -> Result<Unit>,
    onSettled: suspend () -> Unit,
) {
    var busy by remember(sessionId) { mutableStateOf(false) }
    var error by remember(sessionId) { mutableStateOf<String?>(null) }
    var pending by remember(sessionId) { mutableStateOf<JSONObject?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

    Surface(tonalElevation = 2.dp) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(if (busy) R.string.agent_recovery_preparing else R.string.agent_recovery_title))
            Text(error ?: stringResource(R.string.agent_recovery_hint))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (busy) CircularProgressIndicator()
                TextButton(enabled = enabled && !busy, onClick = {
                    val body = pending ?: JSONObject().put("operationId", UUID.randomUUID().toString())
                        .put("expectedGeneration", generation).also { pending = it }
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            onRecover(body).fold(
                                onSuccess = { pending = null },
                                onFailure = {
                                    if (it is NativeHistoryRejected || (it is ApiException && it.statusCode in 400..499)) pending = null
                                    error = runtimeOperationErrorMessage(context, it)
                                },
                            )
                            onSettled()
                        } finally { busy = false }
                    }
                }) {
                    Text(stringResource(if (pending != null) R.string.agent_recovery_check else R.string.agent_recovery_action))
                }
            }
        }
    }
}
