package dev.agentsanywhere.v3poc.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.agentsanywhere.v3poc.R
import dev.agentsanywhere.v3poc.model.MeshSessionsClient
import dev.agentsanywhere.v3poc.model.long
import dev.agentsanywhere.v3poc.model.str
import java.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

@Composable
internal fun WorkspaceToolDialog(client: MeshSessionsClient, root: String, terminal: Boolean, close: () -> Unit) {
    var input by remember { mutableStateOf("") }
    var output by remember { mutableStateOf("") }
    var id by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(terminal) }
    var ended by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(client, root, terminal) {
        if (!terminal) return@LaunchedEffect
        var opened: String? = null
        try {
            opened = client.startTerminal(root)
            id = opened
            busy = false
            var seq = 0L
            var bytes = ByteArray(0)
            while (isActive && !ended) {
                try {
                    client.terminalEvents(opened, seq).collect { event ->
                        val kind = event["type"].str
                        if (kind == "exit") { ended = true; error = false }
                        val data = event["data"].str?.let { Base64.getDecoder().decode(it) } ?: return@collect
                        val next = event["seq"].long ?: seq
                        if (kind == "replay" || next > seq) {
                            bytes = if (kind == "replay") data else bytes + data
                            if (bytes.size > 65_536) bytes = bytes.copyOfRange(bytes.size - 65_536, bytes.size)
                            output = bytes.decodeToString()
                            seq = next
                            error = false
                        }
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    error = true
                }
                if (!ended) delay(1_000)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            error = true
            busy = false
        } finally {
            opened?.let { terminalId ->
                withContext(NonCancellable) { withTimeoutOrNull(3_000) { runCatching { client.closeTerminal(terminalId) } } }
            }
        }
    }

    AlertDialog(
        onDismissRequest = close,
        title = { Text(stringResource(if (terminal) R.string.connection_terminal else R.string.connection_device_file)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(input, { input = it }, Modifier.fillMaxWidth(), singleLine = true,
                    label = { Text(stringResource(if (terminal) R.string.connection_terminal_input else R.string.connection_file_path)) })
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (ended) Text(stringResource(R.string.connection_terminal_ended))
                if (error) Text(stringResource(R.string.connection_tool_failed), color = MaterialTheme.colorScheme.error)
                SelectionContainer {
                    Text(output, Modifier.fillMaxWidth().heightIn(max = 300.dp).verticalScroll(rememberScrollState()),
                        fontFamily = FontFamily.Monospace)
                }
            }
        },
        confirmButton = {
            Button(enabled = input.isNotBlank() && !busy && !ended && (!terminal || id != null), onClick = {
                scope.launch {
                    busy = true
                    error = false
                    try {
                        val value = input
                        val terminalId = id
                        if (terminalId != null) {
                            client.writeTerminal(terminalId, value)
                            if (input == value) input = ""
                        } else {
                            output = client.readFile(root, value.trim())
                        }
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        error = true
                    } finally {
                        busy = false
                    }
                }
            }) { Text(stringResource(if (terminal) R.string.connection_terminal_send else R.string.connection_read_file)) }
        },
        dismissButton = { TextButton(onClick = close) { Text(stringResource(R.string.connection_cancel)) } },
    )
}
