package dev.agentsanywhere.v3poc.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3poc.R
import dev.agentsanywhere.v3poc.design.GlassButton
import dev.agentsanywhere.v3poc.model.RuntimeChoice
import dev.agentsanywhere.v3poc.model.SessionController
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun CreateSessionButton(controller: SessionController, runtimes: List<RuntimeChoice>, open: (String) -> Unit) {
    var visible by remember { mutableStateOf(false) }
    GlassButton(stringResource(R.string.connection_create), symbol = "square.and.pencil", prominent = true) {
        visible = true
    }
    if (!visible) return
    var runtime by remember { mutableStateOf(runtimes.firstOrNull()) }
    var cwd by remember { mutableStateOf(controller.selectedSummary?.cwd.orEmpty().ifBlank { controller.projects.firstOrNull()?.cwd.orEmpty() }) }
    var prompt by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    val operationId = remember(runtime, cwd, prompt) { UUID.randomUUID().toString() }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = { if (!busy) visible = false },
        title = { Text(stringResource(R.string.connection_create)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (runtimes.isEmpty()) Text(stringResource(R.string.connection_no_runtimes))
                runtimes.forEach { entry ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(runtime == entry, { runtime = entry }, enabled = !busy)
                        Text(entry.name)
                    }
                }
                OutlinedTextField(cwd, { cwd = it }, Modifier.fillMaxWidth(), singleLine = true, enabled = !busy,
                    label = { Text(stringResource(R.string.connection_workspace)) })
                OutlinedTextField(prompt, { prompt = it }, Modifier.fillMaxWidth(), enabled = !busy,
                    label = { Text(stringResource(R.string.connection_first_message)) })
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (failed) Text(stringResource(R.string.connection_create_failed), color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = {
            Button(
                enabled = !busy && runtime != null && cwd.isNotBlank() && prompt.isNotBlank(),
                onClick = { scope.launch {
                    busy = true
                    failed = false
                    try {
                        val id = controller.create(checkNotNull(runtime), cwd.trim(), prompt.trim(), operationId)
                        visible = false
                        open(id)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        failed = true
                    } finally {
                        busy = false
                    }
                } },
            ) { Text(stringResource(R.string.connection_create)) }
        },
        dismissButton = { TextButton({ visible = false }, enabled = !busy) { Text(stringResource(android.R.string.cancel)) } },
    )
}
