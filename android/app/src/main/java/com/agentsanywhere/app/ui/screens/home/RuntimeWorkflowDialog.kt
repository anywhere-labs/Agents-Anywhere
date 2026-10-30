package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Checkbox
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentsanywhere.app.feature.sessions.RuntimeWorkflowCoordinator
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
fun RuntimeWorkflowDialog(coordinator: RuntimeWorkflowCoordinator, onOpenAccepted: suspend () -> Unit) {
    val operation by coordinator.operation.collectAsState()
    val error by coordinator.error.collectAsState()
    val binding by coordinator.binding.collectAsState()
    val scope = rememberCoroutineScope()
    var pending by remember(operation?.optString("id")) { mutableStateOf(false) }
    val value = operation ?: return
    LaunchedEffect(value.optString("id")) { while (true) { kotlinx.coroutines.delay(1500); coordinator.refresh() } }
    val state = value.getJSONObject("state")
    val requests = state.optJSONArray("interactions")
    val openRequests = (0 until (requests?.length() ?: 0)).map { requests!!.getJSONObject(it) }
        .filter { it.optString("status") == "open" }
    val hasQuestions = openRequests.isNotEmpty()
    val accepted = state.optBoolean("messageAccepted")
    LaunchedEffect(value.optString("id"), accepted) {
        if (accepted && !binding) onOpenAccepted()
    }
    val failure = state.optJSONObject("failure")?.optString("message")?.takeIf { it.isNotBlank() }
    val stopped = state.optString("phase") in setOf("failed", "rejected", "cancelled", "expired", "outcome_unknown")
    if (!hasQuestions && error == null && failure == null && !stopped) return
    AlertDialog(onDismissRequest = {}, title = { Text(openRequests.firstOrNull()?.getString("title") ?: androidx.compose.ui.res.stringResource(com.agentsanywhere.app.R.string.new_session_create_failed)) },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (error != null || failure != null) Text(error ?: failure.orEmpty())
            for (i in 0 until (requests?.length() ?: 0)) {
                val request = requests!!.getJSONObject(i)
                if (request.optString("status") == "open") key(request.getString("interactionId"), request.getString("ownerGeneration")) {
                    RuntimeWorkflowInput(request, pending) { action, input -> scope.launch { pending = true; try { coordinator.respond(request, action, input) } finally { pending = false } } }
                }
            }
        } }, confirmButton = {
            if (state.optBoolean("messageAccepted")) TextButton(enabled = !pending && !binding, onClick = {
                scope.launch { pending = true; try { onOpenAccepted() } finally { pending = false } }
            }) { Text(if (binding) "正在读取会话…" else "打开已创建的会话") }
        }, dismissButton = {
            if (state.optBoolean("canCancel") || state.optBoolean("canCancelInitialization")) TextButton(enabled = !pending, onClick = { scope.launch { coordinator.cancel() } }) { Text("取消") }
            if (state.optString("phase") in setOf("failed", "rejected", "cancelled", "expired", "outcome_unknown")) TextButton(onClick = { coordinator.dismiss() }) { Text(androidx.compose.ui.res.stringResource(com.agentsanywhere.app.R.string.common_close)) }
            else if (state.optBoolean("messageAccepted")) TextButton(enabled = !binding && !pending, onClick = { coordinator.dismiss() }) { Text("稍后打开") }
        })
}

@Composable
internal fun RuntimeWorkflowInput(request: JSONObject, pending: Boolean, respond: (String, JSONObject?) -> Unit) {
    val kind = request.getString("kind")
    val metadata = request.optJSONObject("metadata") ?: JSONObject()
    var text by remember { mutableStateOf(metadata.optString("initialValue")) }
    var selected by remember { mutableStateOf("") }
    var confirmed by remember { mutableStateOf(false) }
    val formSchema = metadata.optJSONObject("formSchema") ?: JSONObject()
    val formValues = remember(request.optString("interactionId")) { mutableStateMapOf<String, Any>().apply { putAll(com.agentsanywhere.app.feature.sessions.AgentForm.defaults(formSchema)) } }
    Text(request.getString("title"))
    if (request.has("message")) Text(request.optString("message"))
    when (kind) {
        "form" -> StructuredAgentFields(formSchema, formValues, !pending) { key, value -> if (value == null) formValues.remove(key) else formValues[key] = value }
        "input", "editor" -> OutlinedTextField(value = text, onValueChange = { text = it }, enabled = !pending, singleLine = kind == "input", modifier = Modifier.fillMaxWidth())
        "confirm" -> Checkbox(checked = confirmed, onCheckedChange = { confirmed = it }, enabled = !pending)
        "select" -> {
            val options = metadata.optJSONArray("options")
            for (i in 0 until (options?.length() ?: 0)) {
                val option = options!!.getJSONObject(i)
                TextButton(enabled = !pending, onClick = { selected = option.getString("id") }) { Text((if (selected == option.getString("id")) "✓ " else "") + option.getString("label")) }
            }
        }
    }
    val actions = request.getJSONArray("actions")
    for (i in 0 until actions.length()) {
        val action = actions.getJSONObject(i)
        TextButton(enabled = !pending && !(kind == "form" && action.getString("actionId") == "accept" && !com.agentsanywhere.app.feature.sessions.AgentForm.valid(formSchema, formValues)) && !(kind == "select" && action.getString("actionId") == "submit" && selected.isEmpty()), onClick = {
            val input = if (kind == "form" && action.getString("actionId") == "accept") JSONObject().put("kind", "form").put("values", JSONObject(formValues.toMap())) else if (action.getString("actionId") == "submit") JSONObject().put("kind", kind).put("status", "submitted").apply {
                when (kind) { "input", "editor" -> put("text", text); "select" -> put("optionId", selected); "confirm" -> put("value", confirmed) }
            } else null
            respond(action.getString("actionId"), input)
        }) { Text(action.getString("label")) }
    }
}
