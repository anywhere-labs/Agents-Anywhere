package com.agentsanywhere.app.feature.devices

import com.agentsanywhere.app.api.formatJsonValue
import com.agentsanywhere.app.api.parseJsonValue
import java.util.concurrent.atomic.AtomicLong

/** Display text a schema node offers: translation keys with the schema's own text as fallback. */
data class RuntimeConfigCopy(
    val title: String?,
    val description: String?,
    val labelKey: String?,
    val descriptionKey: String?,
)

data class RuntimeConfigOption(
    val value: Any?,
    val label: String,
    val disabled: Boolean = false,
    val description: String? = null,
    val disabledReason: String? = null,
)

sealed interface RuntimeConfigFieldKind {
    data class Text(val path: Boolean, val secure: Boolean) : RuntimeConfigFieldKind
    data object Toggle : RuntimeConfigFieldKind
    data class Number(val integer: Boolean) : RuntimeConfigFieldKind
    data class Choice(val options: List<RuntimeConfigOption>) : RuntimeConfigFieldKind
    /** Environment overrides; a null value removes an inherited variable. */
    data object KeyValue : RuntimeConfigFieldKind
    data class ModelGateway(val baseUrl: RuntimeConfigCopy, val apiKey: RuntimeConfigCopy) : RuntimeConfigFieldKind
    data object CustomModels : RuntimeConfigFieldKind
    /** Values without a dedicated editor are edited as JSON text. */
    data object Json : RuntimeConfigFieldKind
}

data class RuntimeConfigField(
    val id: String,
    val copy: RuntimeConfigCopy,
    val required: Boolean,
    val defaultValue: Any?,
    val kind: RuntimeConfigFieldKind,
    val schema: Map<String, Any?>,
) {
    val title: String
        get() = copy.title ?: id
}

/** Why a value cannot be saved; the screen turns it into text. */
enum class RuntimeConfigIssue {
    Required,
    InvalidNumber,
    InvalidJson,
    DuplicateVariable,
    DuplicateModel,
    DuplicateEffort,
    UnsupportedValue,
    ChooseOption,
    TooLong,
    InvalidFormat,
    OutOfRange,
    InvalidItemCount,
    DuplicateItems,
    IncompleteGroup,
    UnsupportedField,
}

/** A runtime's configuration schema as ordered, typed fields. */
class RuntimeConfigForm private constructor(
    val fields: List<RuntimeConfigField>,
    private val defaults: Map<String, Any?>,
    private val requiredFields: Set<String>,
) {
    /** Starting values: saved config over form defaults, then each field's own default. */
    fun initialValues(config: Map<String, Any?>?): Map<String, Any?> {
        val values = (defaults + config.orEmpty()).toMutableMap()
        fields.forEach { field ->
            if (field.id !in values && field.defaultValue != null) values[field.id] = field.defaultValue
        }
        return values
    }

    fun draft(config: Map<String, Any?>?): RuntimeConfigDraft {
        val values = initialValues(config)
        return RuntimeConfigDraft(this, values, inputs(values), values)
    }

    /** Defaults again; a required named-instance value the user entered before is kept. */
    internal fun resetValues(original: Map<String, Any?>): Map<String, Any?> {
        val values = initialValues(null).toMutableMap()
        requiredFields.forEach { id -> original[id]?.let { values[id] = it } }
        return values
    }

    internal fun inputs(values: Map<String, Any?>): Map<String, RuntimeConfigInput> = fields.associate { field ->
        val value = values[field.id]
        field.id to when (field.kind) {
            is RuntimeConfigFieldKind.Text -> RuntimeConfigInput.Text(value as? String ?: value?.toString().orEmpty())
            is RuntimeConfigFieldKind.Number -> RuntimeConfigInput.Text((value as? kotlin.Number)?.displayText().orEmpty())
            RuntimeConfigFieldKind.Toggle -> RuntimeConfigInput.Toggle(value == true)
            is RuntimeConfigFieldKind.Choice -> RuntimeConfigInput.Choice(value)
            is RuntimeConfigFieldKind.ModelGateway -> {
                val gateway = value as? Map<*, *>
                RuntimeConfigInput.Gateway(
                    RuntimeGatewayDraft(
                        baseUrl = gateway?.get("baseUrl") as? String ?: "",
                        apiKey = gateway?.get("apiKey") as? String ?: "",
                    ),
                )
            }
            RuntimeConfigFieldKind.KeyValue -> RuntimeConfigInput.Environment(
                (value as? Map<*, *>).orEmpty().entries
                    .mapNotNull { (key, item) ->
                        val name = key as? String ?: return@mapNotNull null
                        RuntimeEnvironmentRow(key = name, value = item as? String ?: "", removesInherited = item == null)
                    }
                    .sortedBy { it.key },
            )
            RuntimeConfigFieldKind.CustomModels -> RuntimeConfigInput.Models(
                (value as? List<*>).orEmpty().mapNotNull { item ->
                    val model = item as? Map<*, *> ?: return@mapNotNull null
                    RuntimeCustomModelRow(
                        modelId = model["modelId"] as? String ?: "",
                        displayName = model["displayName"] as? String ?: "",
                        efforts = (model["efforts"] as? List<*>).orEmpty().mapNotNull { effortItem ->
                            val effort = effortItem as? Map<*, *> ?: return@mapNotNull null
                            RuntimeEffortRow(
                                effortId = effort["effortId"] as? String ?: "",
                                displayName = effort["displayName"] as? String ?: "",
                            )
                        },
                    )
                },
            )
            RuntimeConfigFieldKind.Json -> RuntimeConfigInput.Text(if (value == null) "" else formatJsonValue(value))
        }
    }

    companion object {
        /** Null when the runtime offers no schema to edit. */
        fun from(
            schema: Map<String, Any?>?,
            uiSchema: Map<String, Any?>,
            defaults: Map<String, Any?>,
            requiredFields: List<String> = emptyList(),
        ): RuntimeConfigForm? {
            val root = schema ?: return null
            val properties = root.objectValue("properties")
            val required = root.stringList("required").toSet() + requiredFields.filter { it in properties }
            val order = uiSchema.stringList("order").filter { it in properties }
            val names = order + properties.keys.filter { it !in order }
            val fields = names.mapNotNull { name ->
                val fieldSchema = properties[name].asObject() ?: return@mapNotNull null
                RuntimeConfigField(
                    id = name,
                    copy = fieldSchema.copy(),
                    required = name in required,
                    defaultValue = fieldSchema["default"],
                    kind = fieldKind(fieldSchema, uiField(uiSchema, name)),
                    schema = fieldSchema,
                )
            }
            return RuntimeConfigForm(fields, defaults, requiredFields.filter { it in required }.toSet())
        }
    }
}

sealed interface RuntimeConfigInput {
    data class Text(val value: String) : RuntimeConfigInput
    data class Toggle(val value: Boolean) : RuntimeConfigInput
    data class Choice(val value: Any?) : RuntimeConfigInput
    data class Gateway(val value: RuntimeGatewayDraft) : RuntimeConfigInput
    data class Environment(val rows: List<RuntimeEnvironmentRow>) : RuntimeConfigInput
    data class Models(val rows: List<RuntimeCustomModelRow>) : RuntimeConfigInput
}

data class RuntimeGatewayDraft(val baseUrl: String = "", val apiKey: String = "")

/** [id] is list identity only; it never reaches the saved configuration. */
data class RuntimeEnvironmentRow(
    val key: String = "",
    val value: String = "",
    val removesInherited: Boolean = false,
    val id: Long = nextRowId(),
)

data class RuntimeCustomModelRow(
    val modelId: String = "",
    val displayName: String = "",
    val efforts: List<RuntimeEffortRow> = emptyList(),
    val id: Long = nextRowId(),
)

data class RuntimeEffortRow(
    val effortId: String = "",
    val displayName: String = "",
    val id: Long = nextRowId(),
)

sealed interface RuntimeConfigResult {
    data class Valid(val config: Map<String, Any?>) : RuntimeConfigResult
    data class Invalid(val issues: Map<String, RuntimeConfigIssue>) : RuntimeConfigResult
}

/**
 * The editable draft keeps incomplete text and row identities apart from the JSON
 * sent to the runtime. Keys the form does not show are saved unchanged.
 */
@ConsistentCopyVisibility
data class RuntimeConfigDraft internal constructor(
    val form: RuntimeConfigForm,
    private val base: Map<String, Any?>,
    val inputs: Map<String, RuntimeConfigInput>,
    private val original: Map<String, Any?>,
    val issues: Map<String, RuntimeConfigIssue> = emptyMap(),
    private val initial: List<Any?> = comparable(base, inputs),
) {
    val hasChanges: Boolean
        get() = comparable(base, inputs) != initial

    fun update(fieldId: String, input: RuntimeConfigInput): RuntimeConfigDraft =
        copy(inputs = inputs + (fieldId to input), issues = issues - fieldId)

    fun resetToDefaults(): RuntimeConfigDraft {
        val values = form.resetValues(original)
        return copy(base = values, inputs = form.inputs(values), issues = emptyMap())
    }

    fun withIssues(issues: Map<String, RuntimeConfigIssue>): RuntimeConfigDraft = copy(issues = issues)

    fun result(): RuntimeConfigResult {
        val config = base.toMutableMap()
        val found = mutableMapOf<String, RuntimeConfigIssue>()
        form.fields.forEach { field ->
            val issue = field.write(inputs[field.id], config)
            val value = config[field.id]
            val problem = issue
                ?: if (field.id in config && (value != null || field.kind == RuntimeConfigFieldKind.Json)) {
                    runtimeConfigIssue(value, field.schema)
                } else if (field.required && config[field.id] == null) {
                    RuntimeConfigIssue.Required
                } else {
                    null
                }
            if (problem != null) found[field.id] = problem
        }
        return if (found.isEmpty()) RuntimeConfigResult.Valid(config) else RuntimeConfigResult.Invalid(found)
    }
}

/** Writes the field's input into [config]; returns an issue the input itself has. */
private fun RuntimeConfigField.write(input: RuntimeConfigInput?, config: MutableMap<String, Any?>): RuntimeConfigIssue? {
    when (kind) {
        is RuntimeConfigFieldKind.Text -> {
            val value = (input as? RuntimeConfigInput.Text)?.value.orEmpty()
            if (value.isEmpty() && !required) config.remove(id) else config[id] = value
        }
        is RuntimeConfigFieldKind.Number -> {
            val text = (input as? RuntimeConfigInput.Text)?.value.orEmpty().trim()
            if (text.isEmpty()) {
                config.remove(id)
            } else {
                val number = text.toDoubleOrNull()?.takeIf(Double::isFinite) ?: return RuntimeConfigIssue.InvalidNumber
                config[id] = if (number % 1.0 == 0.0 && kotlin.math.abs(number) < Long.MAX_VALUE) number.toLong() else number
            }
        }
        RuntimeConfigFieldKind.Toggle -> config[id] = (input as? RuntimeConfigInput.Toggle)?.value == true
        is RuntimeConfigFieldKind.Choice -> {
            val value = (input as? RuntimeConfigInput.Choice)?.value
            if (value == null) config.remove(id) else config[id] = value
        }
        is RuntimeConfigFieldKind.ModelGateway -> {
            val gateway = (input as? RuntimeConfigInput.Gateway)?.value ?: RuntimeGatewayDraft()
            if (gateway.baseUrl.isEmpty() && gateway.apiKey.isEmpty()) {
                config.remove(id)
            } else {
                config[id] = linkedMapOf("baseUrl" to gateway.baseUrl, "apiKey" to gateway.apiKey)
            }
        }
        RuntimeConfigFieldKind.KeyValue -> {
            val values = linkedMapOf<String, Any?>()
            var duplicate = false
            (input as? RuntimeConfigInput.Environment)?.rows.orEmpty().forEach { row ->
                val key = row.key.trim()
                if (key.isEmpty()) return@forEach
                if (key in values) duplicate = true
                values[key] = if (row.removesInherited) null else row.value
            }
            config[id] = values
            if (duplicate) return RuntimeConfigIssue.DuplicateVariable
        }
        RuntimeConfigFieldKind.CustomModels -> {
            val modelIds = mutableSetOf<String>()
            var issue: RuntimeConfigIssue? = null
            config[id] = (input as? RuntimeConfigInput.Models)?.rows.orEmpty().mapNotNull { row ->
                val modelId = row.modelId.trim()
                val name = row.displayName.trim()
                val effortIds = mutableSetOf<String>()
                val efforts = row.efforts.mapNotNull { effort ->
                    val effortId = effort.effortId.trim()
                    val effortName = effort.displayName.trim()
                    if (effortId.isEmpty() && effortName.isEmpty()) return@mapNotNull null
                    if (!effortIds.add(effortId)) issue = RuntimeConfigIssue.DuplicateEffort
                    linkedMapOf("effortId" to effortId, "displayName" to effortName)
                }
                if (modelId.isEmpty() && name.isEmpty() && efforts.isEmpty()) return@mapNotNull null
                if (!modelIds.add(modelId)) issue = RuntimeConfigIssue.DuplicateModel
                linkedMapOf<String, Any?>("modelId" to modelId, "displayName" to name).apply {
                    if (efforts.isNotEmpty()) put("efforts", efforts)
                }
            }
            return issue
        }
        RuntimeConfigFieldKind.Json -> {
            val text = (input as? RuntimeConfigInput.Text)?.value.orEmpty().trim()
            if (text.isEmpty()) {
                config.remove(id)
            } else {
                config[id] = runCatching { parseJsonValue(text) }.getOrElse { return RuntimeConfigIssue.InvalidJson }
            }
        }
    }
    return null
}

/** The first rule [value] breaks in [schema], checking the subset of JSON Schema runtimes use. */
internal fun runtimeConfigIssue(value: Any?, schema: Map<String, Any?>): RuntimeConfigIssue? {
    for (combinator in listOf("anyOf", "oneOf")) {
        val alternatives = schema[combinator] as? List<*> ?: continue
        val matches = alternatives.count { alternative ->
            alternative.asObject()?.let { runtimeConfigIssue(value, it) == null } == true
        }
        if (matches == 0 || (combinator == "oneOf" && matches != 1)) return RuntimeConfigIssue.UnsupportedValue
    }
    val types = when (val type = schema["type"]) {
        is String -> listOf(type)
        is List<*> -> type.filterIsInstance<String>()
        else -> emptyList()
    }
    if (types.isNotEmpty() && types.none { value.matchesJsonType(it) }) return RuntimeConfigIssue.UnsupportedValue
    (schema["enum"] as? List<*>)?.let { options ->
        if (options.none { jsonEquals(it, value) }) return RuntimeConfigIssue.ChooseOption
    }
    when (value) {
        is String -> {
            val length = value.codePointCount(0, value.length).toDouble()
            schema.number("minLength")?.let { if (length < it) return RuntimeConfigIssue.Required }
            schema.number("maxLength")?.let { if (length > it) return RuntimeConfigIssue.TooLong }
            (schema["pattern"] as? String)?.let { pattern ->
                val regex = runCatching { Regex(pattern) }.getOrNull()
                if (regex != null && !regex.containsMatchIn(value)) return RuntimeConfigIssue.InvalidFormat
            }
        }
        is kotlin.Number -> {
            val number = value.toDouble()
            if (!number.isFinite() ||
                schema.number("minimum")?.let { number < it } == true ||
                schema.number("maximum")?.let { number > it } == true
            ) {
                return RuntimeConfigIssue.OutOfRange
            }
        }
        is List<*> -> {
            val count = value.size.toDouble()
            if (schema.number("minItems")?.let { count < it } == true || schema.number("maxItems")?.let { count > it } == true) {
                return RuntimeConfigIssue.InvalidItemCount
            }
            if (schema["uniqueItems"] == true && value.distinct().size != value.size) return RuntimeConfigIssue.DuplicateItems
            schema["items"].asObject()?.let { itemSchema ->
                value.forEach { item -> runtimeConfigIssue(item, itemSchema)?.let { return it } }
            }
        }
        is Map<*, *> -> {
            val properties = schema.objectValue("properties")
            if (schema.stringList("required").any { it !in value }) return RuntimeConfigIssue.IncompleteGroup
            value.forEach { (key, child) ->
                val name = key as? String ?: return RuntimeConfigIssue.UnsupportedField
                schema["propertyNames"].asObject()?.let { names ->
                    runtimeConfigIssue(name, names)?.let { return it }
                }
                val property = properties[name].asObject()
                val additional = schema["additionalProperties"]
                when {
                    property != null -> runtimeConfigIssue(child, property)?.let { return it }
                    additional == false -> return RuntimeConfigIssue.UnsupportedField
                    additional is Map<*, *> -> runtimeConfigIssue(child, additional.asObject().orEmpty())?.let { return it }
                }
            }
        }
    }
    return null
}

private fun fieldKind(schema: Map<String, Any?>, ui: Map<String, Any?>): RuntimeConfigFieldKind {
    val component = ui["component"] as? String
    val type = schema["type"] as? String
    return when {
        component == "customModels" -> RuntimeConfigFieldKind.CustomModels
        component == "modelGateway" -> {
            val properties = schema.objectValue("properties")
            RuntimeConfigFieldKind.ModelGateway(
                baseUrl = properties.objectValue("baseUrl").copy(),
                apiKey = properties.objectValue("apiKey").copy(),
            )
        }
        component == "keyValue" || (type == "object" && schema["additionalProperties"] is Map<*, *>) -> RuntimeConfigFieldKind.KeyValue
        type == "boolean" -> RuntimeConfigFieldKind.Toggle
        (schema["enum"] as? List<*>)?.isNotEmpty() == true || component == "select" ->
            RuntimeConfigFieldKind.Choice(choiceOptions(schema, ui))
        type == "number" || type == "integer" -> RuntimeConfigFieldKind.Number(integer = type == "integer")
        type == "string" || component == "path" ->
            RuntimeConfigFieldKind.Text(path = component == "path", secure = component == "password" || component == "secure")
        else -> RuntimeConfigFieldKind.Json
    }
}

/** Schema owns the allowed values; UI metadata and enumNames only supply their labels. */
private fun choiceOptions(schema: Map<String, Any?>, ui: Map<String, Any?>): List<RuntimeConfigOption> {
    val rows = (ui["options"] as? List<*>).orEmpty().mapNotNull { it.asObject()?.takeIf { row -> "value" in row } }
    val names = schema["enumNames"] as? List<*>
    val values = (schema["enum"] as? List<*>) ?: rows.map { it["value"] }
    return values.mapIndexed { index, value ->
        val row = rows.firstOrNull { jsonEquals(it["value"], value) }
        RuntimeConfigOption(
            value = value,
            label = (row?.get("label") as? String)?.takeIf(String::isNotBlank)
                ?: (names?.getOrNull(index) as? String)?.takeIf(String::isNotBlank)
                ?: value.displayText(),
            disabled = row?.get("disabled") == true,
            description = (row?.get("description") as? String)?.takeIf(String::isNotBlank),
            disabledReason = (row?.get("disabledReason") as? String)?.takeIf(String::isNotBlank),
        )
    }
}

/** UI hints live at the top level, or under `fields` for some runtimes. */
private fun uiField(uiSchema: Map<String, Any?>, name: String): Map<String, Any?> =
    uiSchema[name].asObject() ?: uiSchema["fields"].asObject()?.get(name).asObject() ?: emptyMap()

private fun Map<String, Any?>.copy(): RuntimeConfigCopy {
    val i18n = objectValue("metadata").objectValue("i18n")
    return RuntimeConfigCopy(
        title = (this["title"] as? String)?.takeIf(String::isNotBlank),
        description = (this["description"] as? String)?.takeIf(String::isNotBlank),
        labelKey = (i18n["labelKey"] as? String)?.takeIf(String::isNotBlank),
        descriptionKey = (i18n["descriptionKey"] as? String)?.takeIf(String::isNotBlank),
    )
}

private fun comparable(base: Map<String, Any?>, inputs: Map<String, RuntimeConfigInput>): List<Any?> =
    listOf(base, inputs.mapValues { (_, input) ->
        when (input) {
            is RuntimeConfigInput.Environment -> input.rows.map { listOf(it.key, it.value, it.removesInherited) }
            is RuntimeConfigInput.Models -> input.rows.map { row ->
                listOf(row.modelId, row.displayName, row.efforts.map { listOf(it.effortId, it.displayName) })
            }
            else -> input
        }
    })

private fun Any?.matchesJsonType(type: String): Boolean = when (type) {
    "string" -> this is String
    "boolean" -> this is Boolean
    "object" -> this is Map<*, *>
    "array" -> this is List<*>
    "null" -> this == null
    "integer" -> this is kotlin.Number && toDouble().isFinite() && toDouble() % 1.0 == 0.0
    "number" -> this is kotlin.Number
    else -> true
}

private fun jsonEquals(left: Any?, right: Any?): Boolean =
    if (left is kotlin.Number && right is kotlin.Number) left.toDouble() == right.toDouble() else left == right

private fun Any?.displayText(): String = when (this) {
    null -> "null"
    is kotlin.Number -> displayText()
    else -> toString()
}

private fun kotlin.Number.displayText(): String {
    val number = toDouble()
    return if (number.isFinite() && number % 1.0 == 0.0 && kotlin.math.abs(number) < Long.MAX_VALUE) {
        number.toLong().toString()
    } else {
        toString()
    }
}

@Suppress("UNCHECKED_CAST")
private fun Any?.asObject(): Map<String, Any?>? =
    (this as? Map<*, *>)?.takeIf { map -> map.keys.all { it is String } } as Map<String, Any?>?

private fun Map<String, Any?>.objectValue(key: String): Map<String, Any?> = this[key].asObject() ?: emptyMap()

private fun Map<String, Any?>.stringList(key: String): List<String> = (this[key] as? List<*>).orEmpty().filterIsInstance<String>()

private fun Map<String, Any?>.number(key: String): Double? = (this[key] as? kotlin.Number)?.toDouble()

private val rowIds = AtomicLong()

private fun nextRowId(): Long = rowIds.incrementAndGet()
