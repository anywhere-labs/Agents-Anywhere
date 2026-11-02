package com.agentsanywhere.app.ui.screens.home

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import org.json.JSONObject

@Composable
internal fun StructuredAgentFields(schema: JSONObject, values: Map<String, Any>, enabled: Boolean, change: (String, Any?) -> Unit) {
    val properties = schema.optJSONObject("properties") ?: return
    for (key in properties.keys().asSequence().toList()) {
        val field = properties.getJSONObject(key)
        val value = values[key]
        Column {
            Text(field.optString("title", key))
            field.optString("description").takeIf { it.isNotEmpty() }?.let { Text(it) }
            when {
                field.optString("type") == "boolean" -> Checkbox(checked = value == true, onCheckedChange = { change(key, it) }, enabled = enabled)
                field.has("enum") -> {
                    val options = field.getJSONArray("enum")
                    val names = field.optJSONArray("enumNames")
                    for (i in 0 until options.length()) {
                        val item = options.getString(i)
                        TextButton(enabled = enabled, onClick = { change(key, item) }) { Text((if (value == item) "✓ " else "") + (names?.optString(i) ?: item)) }
                    }
                }
                field.optString("type") == "array" -> {
                    val options = field.optJSONObject("items")?.optJSONArray("enum")
                    for (i in 0 until (options?.length() ?: 0)) {
                        val item = options!!.getString(i)
                        val list = (value as? org.json.JSONArray)?.let { array -> (0 until array.length()).map { array.getString(it) } }.orEmpty()
                        Text(item)
                        Checkbox(checked = item in list, enabled = enabled, onCheckedChange = { checked -> change(key, org.json.JSONArray(if (checked) list + item else list - item)) })
                    }
                }
                else -> OutlinedTextField(value = value?.toString().orEmpty(), onValueChange = { text ->
                    change(key, if (field.optString("type") in setOf("number", "integer")) text.toDoubleOrNull() ?: text.takeIf { it.isNotEmpty() } else text)
                }, enabled = enabled, modifier = Modifier.fillMaxWidth())
            }
        }
    }
}
