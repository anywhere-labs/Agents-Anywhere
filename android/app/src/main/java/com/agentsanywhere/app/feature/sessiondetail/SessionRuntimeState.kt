package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteRuntimeModelCatalog
import com.agentsanywhere.app.api.RemoteRuntimeNoticeAction
import com.agentsanywhere.app.api.RemoteRuntimePermissionCatalog
import com.agentsanywhere.app.api.RemoteSessionCommand

const val SESSION_SEND_MESSAGE_CAPABILITY = "session.send_message"
const val SESSION_STEER_CAPABILITY = "session.steer"
const val SESSION_INTERRUPT_CAPABILITY = "session.interrupt"
const val SESSION_NOTICE_RESPONSE_CAPABILITY = "session.interaction.approval"
const val SESSION_COMMANDS_CAPABILITY = "session.commands"
const val SESSION_COMMAND_EXECUTE_CAPABILITY = "session.command.execute"
const val SESSION_MODEL_CATALOG_CAPABILITY = "catalog.model"
const val SESSION_PERMISSION_CATALOG_CAPABILITY = "catalog.permission"
const val SESSION_ATTACHMENT_CAPABILITY = "runtime.attachment"

data class SessionRuntimeState(
    val sessionId: String? = null,
    val runtime: String? = null,
    val externalSessionId: String? = null,
    val status: SessionRuntimeStatus = SessionRuntimeStatus.Unknown,
    val selections: Map<String, String?> = emptyMap(),
    val statusReason: String? = null,
    val error: Map<String, Any?>? = null,
    val metadata: Map<String, Any?> = emptyMap(),
    val updatedSeq: Int = 0,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val serverTime: String? = null,
    val isLoaded: Boolean = false,
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val runtimeId: String? = runtime,
    val runtimeType: String? = runtime,
    val runtimeName: String? = runtimeType,
)

enum class SessionRuntimeStatus {
    Idle,
    Waiting,
    Pending,
    Running,
    Stopping,
    WaitingApproval,
    Blocked,
    Disconnected,
    Error,
    Unknown,
}

data class EffectiveCapabilities(
    val revision: Long = 0,
    val capabilities: List<EffectiveCapability> = emptyList(),
    val connectorId: String? = null,
    val serverTime: String? = null,
    val isLoaded: Boolean = false,
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
) {
    fun find(
        capabilityId: String,
        runtimeId: String? = null,
        runtimeType: String? = null,
    ): EffectiveCapability? {
        val matches = capabilities.filter { it.capabilityId == capabilityId }
        return if (runtimeId == null && runtimeType == null) {
            matches.firstOrNull()
        } else {
            matches.firstOrNull { runtimeId != null && it.runtimeId == runtimeId }
                ?: matches.firstOrNull {
                    runtimeId != null && it.runtimeId == null && it.runtime == runtimeId
                }
                ?: runtimeType?.let { expectedType ->
                    matches.firstOrNull {
                        it.runtimeId == null && (it.runtimeType ?: it.runtime) == expectedType
                    }
                }
                ?: matches.firstOrNull {
                    it.runtimeId == null && it.runtimeType == null && it.runtime == null
                }
        }
    }

    fun isUsable(
        capabilityId: String,
        runtimeId: String? = null,
        runtimeType: String? = null,
    ): Boolean {
        return find(capabilityId, runtimeId, runtimeType)?.usable == true
    }

    fun messageAction(
        runtime: String?,
        runtimeStatus: SessionRuntimeStatus,
        runtimeType: String? = runtime,
    ): RuntimeMessageAction? {
        val canSend = isUsable(SESSION_SEND_MESSAGE_CAPABILITY, runtime, runtimeType)
        val canSteer = isUsable(SESSION_STEER_CAPABILITY, runtime, runtimeType)
        return when {
            canSteer && (!canSend || runtimeStatus in ACTIVE_RUNTIME_STATUSES) -> RuntimeMessageAction.Steer
            canSend -> RuntimeMessageAction.Send
            canSteer -> RuntimeMessageAction.Steer
            else -> null
        }
    }

    private companion object {
        val ACTIVE_RUNTIME_STATUSES = setOf(
            SessionRuntimeStatus.Waiting,
            SessionRuntimeStatus.Pending,
            SessionRuntimeStatus.Running,
            SessionRuntimeStatus.Stopping,
            SessionRuntimeStatus.WaitingApproval,
            SessionRuntimeStatus.Blocked,
        )
    }
}

enum class RuntimeMessageAction {
    Send,
    Steer,
}

data class EffectiveCapability(
    val capabilityId: String,
    val version: String,
    val scope: String,
    val runtime: String?,
    val sessionId: String?,
    val supported: Boolean,
    val available: Boolean,
    val allowed: Boolean,
    val unavailableReason: String?,
    val parameters: Map<String, Any?>,
    val runtimeId: String? = null,
    val runtimeType: String? = runtime,
) {
    val usable: Boolean
        get() = supported && available && allowed
}

data class RuntimeCapabilities(
    val revision: Long = 0,
    val capabilities: List<EffectiveCapability> = emptyList(),
    val isLoaded: Boolean = false,
)

data class RuntimeNotices(
    val notices: List<RuntimeNotice> = emptyList(),
    val serverTime: String? = null,
    val isLoaded: Boolean = false,
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val eventSequence: Long = 0L,
)

data class RuntimeNotice(
    val noticeId: String,
    val type: String,
    val sessionId: String,
    val title: String,
    val message: String?,
    val severity: String,
    val status: String,
    val interactionType: String?,
    val blocking: RuntimeNoticeBlocking?,
    val responseRequired: Boolean,
    val revision: Int,
    val updatedSeq: Int,
    val source: Map<String, Any?>,
    val actions: List<RuntimeNoticeAction>,
    val context: Map<String, Any?>,
    val metadata: Map<String, Any?>,
    val expiresAt: String?,
    val createdAt: String?,
    val updatedAt: String?,
    val resolvedAt: String?,
) {
    val respondable: Boolean
        get() = type == "interaction" && responseRequired && status in RESPONDABLE_NOTICE_STATUSES &&
            actions.any { it.actionId.isNotBlank() }

    val openInteraction: Boolean
        get() = type == "interaction" && status in OPEN_INTERACTION_STATUSES

    val openNotification: Boolean
        get() = type == "notification" && status == "open"

    fun timelineTargetId(): String? {
        return (source["timelineItemId"] as? String)?.takeIf(String::isNotBlank)
            ?: (context["timelineItemId"] as? String)?.takeIf(String::isNotBlank)
    }

    fun blocksSession(sessionId: String): Boolean =
        blocking?.scope == "session" && blocking.targetId == sessionId

    private companion object {
        val RESPONDABLE_NOTICE_STATUSES = setOf("open", "failed")
        val OPEN_INTERACTION_STATUSES = setOf(
            "open",
            "responding",
            "response_accepted",
            "resolving",
            "failed",
        )
    }
}

data class RuntimeNoticeBlocking(
    val scope: String,
    val targetId: String,
)

data class RuntimeNoticeAction(
    val actionId: String,
    val label: String,
    val style: String,
    val input: RuntimeNoticeActionInput,
    val unknown: Map<String, Any?>,
)

data class RuntimeNoticeActionInput(
    val required: Boolean,
    val schema: Map<String, Any?>?,
    val uiSchema: Map<String, Any?>?,
)

data class RuntimeNoticeInputField(
    val key: String,
    val label: String,
    val type: String,
    val required: Boolean,
)

data class RuntimeInputRequestOption(
    val id: String,
    val label: String,
    val description: String?,
)

data class RuntimeInputRequestQuestion(
    val id: String,
    val prompt: String,
    val header: String?,
    val multiple: Boolean,
    val allowCustom: Boolean,
    val options: List<RuntimeInputRequestOption>,
)

data class RuntimeInputRequestForm(
    val action: RuntimeNoticeAction,
    val questions: List<RuntimeInputRequestQuestion>,
)

data class RuntimeInputRequestDraft(
    val optionIds: List<String> = emptyList(),
    val customText: String = "",
    val useCustom: Boolean = false,
)

data class RuntimeCatalogs(
    val model: RemoteRuntimeModelCatalog? = null,
    val permission: RemoteRuntimePermissionCatalog? = null,
    val unknown: Map<String, Any?> = emptyMap(),
    val modelLoading: Boolean = false,
    val permissionLoading: Boolean = false,
    val modelStale: Boolean = false,
    val permissionStale: Boolean = false,
    val modelErrorMessage: String? = null,
    val permissionErrorMessage: String? = null,
    val generation: Long = 0,
    val requestKey: SessionRuntimeRequestKey? = null,
) {
    fun beginModel(sessionId: String): RuntimeCatalogs {
        val nextGeneration = generation + 1
        return copy(
            modelLoading = true,
            modelStale = false,
            modelErrorMessage = null,
            generation = nextGeneration,
            requestKey = SessionRuntimeRequestKey(sessionId, nextGeneration),
        )
    }

    fun applyModel(key: SessionRuntimeRequestKey, value: RemoteRuntimeModelCatalog): RuntimeCatalogs =
        if (requestKey == key) {
            copy(model = value, modelLoading = false, modelStale = false, modelErrorMessage = null)
        } else {
            this
        }

    fun failModel(key: SessionRuntimeRequestKey, message: String): RuntimeCatalogs =
        if (requestKey == key) {
            copy(modelLoading = false, modelStale = model != null, modelErrorMessage = message)
        } else {
            this
        }

    fun beginPermission(sessionId: String): RuntimeCatalogs {
        val nextGeneration = generation + 1
        return copy(
            permissionLoading = true,
            permissionStale = false,
            permissionErrorMessage = null,
            generation = nextGeneration,
            requestKey = SessionRuntimeRequestKey(sessionId, nextGeneration),
        )
    }

    fun applyPermission(key: SessionRuntimeRequestKey, value: RemoteRuntimePermissionCatalog): RuntimeCatalogs =
        if (requestKey == key) {
            copy(
                permission = value,
                permissionLoading = false,
                permissionStale = false,
                permissionErrorMessage = null,
            )
        } else {
            this
        }

    fun failPermission(key: SessionRuntimeRequestKey, message: String): RuntimeCatalogs =
        if (requestKey == key) {
            copy(permissionLoading = false, permissionStale = permission != null, permissionErrorMessage = message)
        } else {
            this
        }
}

data class SessionRuntimeRequestKey(
    val sessionId: String,
    val generation: Long,
)

data class RuntimeCommands(
    val commands: List<RuntimeCommand> = emptyList(),
    val isLoading: Boolean = false,
    val isLoaded: Boolean = false,
    val stale: Boolean = false,
    val errorMessage: String? = null,
    val generation: Long = 0,
    val requestKey: SessionRuntimeRequestKey? = null,
) {
    fun begin(sessionId: String): RuntimeCommands {
        val nextGeneration = generation + 1
        return copy(
            isLoading = true,
            stale = false,
            errorMessage = null,
            generation = nextGeneration,
            requestKey = SessionRuntimeRequestKey(sessionId, nextGeneration),
        )
    }

    fun apply(key: SessionRuntimeRequestKey, value: List<RuntimeCommand>): RuntimeCommands =
        if (requestKey == key) {
            copy(commands = value, isLoading = false, isLoaded = true, stale = false, errorMessage = null)
        } else {
            this
        }

    fun fail(key: SessionRuntimeRequestKey, message: String): RuntimeCommands =
        if (requestKey == key) {
            copy(isLoading = false, isLoaded = false, stale = commands.isNotEmpty(), errorMessage = message)
        } else {
            this
        }
}

data class RuntimeCommand(
    val id: String,
    val title: String,
    val description: String?,
    val aliases: List<String>,
    val category: String?,
    val scope: String,
    val enabled: Boolean,
    val disabledReason: String?,
    val acceptsArgs: Boolean,
    val argsSchema: Map<String, Any?>?,
    val metadata: Map<String, Any?>,
) {
    fun matches(query: String): Boolean {
        val tokens = query.trim().lowercase().split(Regex("\\s+")).filter(String::isNotBlank)
        if (tokens.isEmpty()) return true
        val haystack = buildString {
            append(id.lowercase())
            append(' ')
            append(title.lowercase())
            append(' ')
            append(aliases.joinToString(" ").lowercase())
            description?.let { append(' ').append(it.lowercase()) }
        }
        return tokens.all { it in haystack }
    }
}

data class RuntimeSelectionOption(
    val selectionId: String,
    val label: String,
    val description: String?,
    val default: Boolean,
    val enabled: Boolean = true,
    val disabledReason: String? = null,
    val modelId: String? = null,
)

internal enum class RuntimePermissionTranslation {
    RequestApproval,
    AutoReview,
    FullAccess,
    ClaudeDefault,
    ClaudeAcceptEdits,
    ClaudePlan,
    ClaudeAuto,
    ClaudeDontAsk,
    ClaudeBypassPermissions,
}

internal fun runtimePermissionTranslation(
    runtime: String?,
    permissionId: String,
    metadata: Map<String, Any?> = emptyMap(),
): RuntimePermissionTranslation? {
    val i18n = metadata["i18n"] as? Map<*, *>
    val labelKey = i18n?.get("labelKey") as? String
    permissionTranslationByLabelKey(labelKey)?.let { return it }

    val normalizedId = permissionId.trim().lowercase()
    return when (normalizedId) {
        "request_approval" -> RuntimePermissionTranslation.RequestApproval
        "auto_review" -> RuntimePermissionTranslation.AutoReview
        "full_access" -> RuntimePermissionTranslation.FullAccess
        else -> if (runtime.orEmpty().trim().lowercase().contains("claude")) {
            when (normalizedId) {
                "default" -> RuntimePermissionTranslation.ClaudeDefault
                "acceptedits" -> RuntimePermissionTranslation.ClaudeAcceptEdits
                "plan" -> RuntimePermissionTranslation.ClaudePlan
                "auto" -> RuntimePermissionTranslation.ClaudeAuto
                "dontask" -> RuntimePermissionTranslation.ClaudeDontAsk
                "bypasspermissions" -> RuntimePermissionTranslation.ClaudeBypassPermissions
                else -> null
            }
        } else {
            null
        }
    }
}

private fun permissionTranslationByLabelKey(labelKey: String?): RuntimePermissionTranslation? =
    when (labelKey) {
        "dashboard.new.permissionModes.requestApproval.label" -> RuntimePermissionTranslation.RequestApproval
        "dashboard.new.permissionModes.autoReview.label" -> RuntimePermissionTranslation.AutoReview
        "dashboard.new.permissionModes.fullAccess.label" -> RuntimePermissionTranslation.FullAccess
        "dashboard.new.permissionModes.claude.default.label" -> RuntimePermissionTranslation.ClaudeDefault
        "dashboard.new.permissionModes.claude.acceptEdits.label" -> RuntimePermissionTranslation.ClaudeAcceptEdits
        "dashboard.new.permissionModes.claude.plan.label" -> RuntimePermissionTranslation.ClaudePlan
        "dashboard.new.permissionModes.claude.auto.label" -> RuntimePermissionTranslation.ClaudeAuto
        "dashboard.new.permissionModes.claude.dontAsk.label" -> RuntimePermissionTranslation.ClaudeDontAsk
        "dashboard.new.permissionModes.claude.bypassPermissions.label" ->
            RuntimePermissionTranslation.ClaudeBypassPermissions
        else -> null
    }

internal fun RemoteRuntimeModelCatalog.selectionOptions(): List<RuntimeSelectionOption> {
    return models.flatMap { model ->
        val reasoning = model.reasoningItems.filter { it.selectionId.isNotBlank() }
        if (reasoning.isNotEmpty()) {
            reasoning.map { item ->
                RuntimeSelectionOption(
                    selectionId = item.selectionId,
                    label = listOf(model.displayName, item.displayName).filter(String::isNotBlank).joinToString(" · "),
                    description = item.description ?: model.description,
                    default = item.default || (model.default && reasoning.first() == item),
                    enabled = model.enabled && item.enabled,
                    disabledReason = item.disabledReason ?: model.disabledReason,
                    modelId = model.id,
                )
            }
        } else {
            model.selectionId?.takeIf(String::isNotBlank)?.let { selectionId ->
                listOf(
                    RuntimeSelectionOption(
                        selectionId = selectionId,
                        label = model.displayName.ifBlank { model.id },
                        description = model.description,
                        default = model.default,
                        enabled = model.enabled,
                        disabledReason = model.disabledReason,
                        modelId = model.id,
                    ),
                )
            }.orEmpty()
        }
    }.distinctBy { it.selectionId }
}

internal fun RemoteRuntimePermissionCatalog.selectionOptions(): List<RuntimeSelectionOption> =
    permissions
        .filter { it.selectionId.isNotBlank() }
        .map {
            RuntimeSelectionOption(
                selectionId = it.selectionId,
                label = it.displayName.ifBlank { it.id },
                description = it.description,
                default = it.default,
                enabled = it.enabled,
                disabledReason = it.disabledReason,
            )
        }
        .distinctBy { it.selectionId }

internal fun List<RuntimeSelectionOption>.validatedSelection(hint: String?): String? {
    val explicitSelection = hint?.takeIf(String::isNotBlank)
    return if (explicitSelection != null) {
        firstOrNull { it.enabled && it.selectionId == explicitSelection }?.selectionId
    } else {
        firstOrNull { it.enabled && it.default }?.selectionId
            ?: firstOrNull { it.enabled }?.selectionId
    }
}

internal fun sessionComposerEnabled(
    takeoverEnabled: Boolean,
    capabilityFactsFresh: Boolean,
    canSendMessage: Boolean,
    canSteer: Boolean,
    canUseCommands: Boolean,
): Boolean = takeoverEnabled && capabilityFactsFresh && (canSendMessage || canSteer || canUseCommands)

internal fun runtimeSelectionEnabled(takeoverEnabled: Boolean, capabilityUsable: Boolean): Boolean =
    takeoverEnabled && capabilityUsable

internal fun isInternalRuntimeError(message: String?): Boolean {
    val normalized = message?.trim()?.lowercase().orEmpty()
    if (normalized.isEmpty()) return false
    return normalized.contains("json-rpc") ||
        normalized.contains("invalidrequesterror") ||
        normalized.contains("traceback") ||
        normalized.contains("already has an active writer") ||
        Regex("[a-z0-9_.]+(?:error|exception):").containsMatchIn(normalized)
}

internal fun RemoteRuntimeNoticeAction.toRuntimeNoticeAction(): RuntimeNoticeAction {
    return RuntimeNoticeAction(
        actionId = actionId,
        label = label,
        style = style,
        input = RuntimeNoticeActionInput(required = input.required, schema = input.schema, uiSchema = input.uiSchema),
        unknown = unknown,
    )
}

internal fun RemoteSessionCommand.toRuntimeCommand(): RuntimeCommand {
    return RuntimeCommand(
        id = id,
        title = title,
        description = description,
        aliases = aliases,
        category = category,
        scope = scope,
        enabled = enabled,
        disabledReason = disabledReason,
        acceptsArgs = acceptsArgs,
        argsSchema = argsSchema,
        metadata = metadata,
    )
}

internal fun RuntimeNoticeAction.inputFields(): List<RuntimeNoticeInputField> {
    val schema = input.schema.orEmpty()
    val requiredKeys = (schema["required"] as? List<*>).orEmpty().mapNotNull { it as? String }.toSet()
    val properties = schema["properties"] as? Map<*, *>
    val fields = properties.orEmpty().mapNotNull { (rawKey, rawValue) ->
        val key = rawKey as? String ?: return@mapNotNull null
        val property = rawValue as? Map<*, *> ?: emptyMap<Any?, Any?>()
        RuntimeNoticeInputField(
            key = key,
            label = (property["title"] as? String)?.takeIf(String::isNotBlank) ?: key,
            type = (property["type"] as? String)?.ifBlank { "string" } ?: "string",
            required = key in requiredKeys,
        )
    }
    if (fields.isNotEmpty()) return fields
    return if (input.required) {
        listOf(RuntimeNoticeInputField("value", "Value", "string", required = true))
    } else {
        emptyList()
    }
}

internal fun RuntimeNotice.inputRequestForm(): RuntimeInputRequestForm? {
    if (interactionType != "input_request") return null
    actions.forEach { action ->
        val uiSchema = action.input.uiSchema ?: return@forEach
        if (uiSchema["component"] != "inputRequest" || (uiSchema["version"] as? Number)?.toInt() != 1) {
            return@forEach
        }
        val rawQuestions = uiSchema["questions"] as? List<*> ?: return null
        if (rawQuestions.isEmpty()) return null
        val questionIds = mutableSetOf<String>()
        val questions = rawQuestions.map { rawQuestion ->
            val question = rawQuestion as? Map<*, *> ?: return null
            val id = question["id"].nonEmptyText() ?: return null
            val prompt = question["prompt"].nonEmptyText() ?: return null
            if (!questionIds.add(id)) return null
            val rawOptions = question["options"] as? List<*> ?: return null
            val optionIds = mutableSetOf<String>()
            val options = rawOptions.map { rawOption ->
                val option = rawOption as? Map<*, *> ?: return null
                val optionId = option["id"].nonEmptyText() ?: return null
                val label = option["label"].nonEmptyText() ?: return null
                if (!optionIds.add(optionId)) return null
                RuntimeInputRequestOption(
                    id = optionId,
                    label = label,
                    description = option["description"].nonEmptyText(),
                )
            }
            RuntimeInputRequestQuestion(
                id = id,
                prompt = prompt,
                header = question["header"].nonEmptyText(),
                multiple = question["multiple"] == true,
                allowCustom = question["allowCustom"] != false,
                options = options,
            )
        }
        return RuntimeInputRequestForm(action = action, questions = questions)
    }
    return null
}

internal fun RuntimeInputRequestForm.initialDrafts(): Map<String, RuntimeInputRequestDraft> =
    questions.associate { it.id to RuntimeInputRequestDraft() }

internal fun RuntimeInputRequestForm.isComplete(
    drafts: Map<String, RuntimeInputRequestDraft>,
): Boolean = questions.all { question ->
    val draft = drafts[question.id] ?: return@all false
    val optionCount = draft.optionIds.size
    (question.multiple || optionCount <= 1) &&
        (optionCount > 0 || (draft.useCustom && draft.customText.isNotBlank()))
}

internal fun RuntimeInputRequestForm.buildPayload(
    drafts: Map<String, RuntimeInputRequestDraft>,
): Map<String, Any?> = mapOf(
    "answers" to questions.associate { question ->
        val draft = drafts[question.id] ?: RuntimeInputRequestDraft()
        val customText = draft.customText.trim().takeIf { draft.useCustom && it.isNotEmpty() }
        question.id to buildMap<String, Any?> {
            put("optionIds", draft.optionIds)
            if (customText != null) put("customText", customText)
        }
    },
)

private fun Any?.nonEmptyText(): String? = (this as? String)?.trim()?.takeIf(String::isNotEmpty)

internal fun RuntimeNoticeAction.coerceInput(rawValues: Map<String, String>): Result<Map<String, Any?>?> = runCatching {
    val fields = inputFields()
    if (fields.isEmpty()) return@runCatching null
    buildMap {
        fields.forEach { field ->
            val raw = rawValues[field.key].orEmpty().trim()
            if (field.required && raw.isBlank()) throw IllegalArgumentException("${field.label} is required.")
            if (raw.isBlank()) return@forEach
            val value: Any = when (field.type) {
                "integer" -> raw.toLongOrNull()
                    ?: throw IllegalArgumentException("${field.label} must be an integer.")
                "number" -> raw.toDoubleOrNull()
                    ?: throw IllegalArgumentException("${field.label} must be a number.")
                "boolean" -> when (raw.lowercase()) {
                    "true", "yes", "1" -> true
                    "false", "no", "0" -> false
                    else -> throw IllegalArgumentException("${field.label} must be true or false.")
                }
                else -> raw
            }
            put(field.key, value)
        }
    }
}
