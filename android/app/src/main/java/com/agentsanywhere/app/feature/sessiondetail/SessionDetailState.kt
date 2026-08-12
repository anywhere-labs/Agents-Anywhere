package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteRuntimeModelCatalog
import com.agentsanywhere.app.api.RemoteRuntimeNoticeAction
import com.agentsanywhere.app.api.RemoteRuntimePermissionCatalog
import com.agentsanywhere.app.api.RemoteSessionCommand
import com.agentsanywhere.app.model.AgentSession

const val SESSION_SEND_MESSAGE_CAPABILITY = "session.send_message"
const val SESSION_STEER_CAPABILITY = "session.steer"
const val SESSION_INTERRUPT_CAPABILITY = "session.interrupt"
const val SESSION_NOTICE_RESPONSE_CAPABILITY = "session.interaction.approval"
const val SESSION_COMMANDS_CAPABILITY = "session.commands"
const val SESSION_COMMAND_EXECUTE_CAPABILITY = "session.command.execute"
const val SESSION_MODEL_CATALOG_CAPABILITY = "catalog.model"
const val SESSION_PERMISSION_CATALOG_CAPABILITY = "catalog.permission"
const val SESSION_ATTACHMENT_CAPABILITY = "runtime.attachment"

data class SessionDetailState(
    val meta: SessionMeta = SessionMeta(),
    val timeline: SessionTimelineState = SessionTimelineState(),
    val runtime: SessionRuntimeState = SessionRuntimeState(),
    val capabilities: EffectiveCapabilities = EffectiveCapabilities(),
    val runtimeCapabilities: RuntimeCapabilities = RuntimeCapabilities(),
    val notices: RuntimeNotices = RuntimeNotices(),
    val catalogs: RuntimeCatalogs = RuntimeCatalogs(),
    val commands: RuntimeCommands = RuntimeCommands(),
    val realtime: SessionRealtimeState = SessionRealtimeState(),
    val initialized: Boolean = false,
    val actionError: String? = null,
    val takeoverInFlight: Boolean = false,
    val sending: Boolean = false,
    val interrupting: Boolean = false,
    val selectionUpdating: Boolean = false,
    val commandExecuting: Boolean = false,
    val respondingNoticeIds: Set<String> = emptySet(),
) {
    val session: AgentSession?
        get() = meta.session

    val messages: List<TimelineMessage>
        get() = timeline.messages

    val nextSeq: Int
        get() = timeline.nextSeq

    val hasMore: Boolean
        get() = timeline.hasMore

    fun withSession(session: AgentSession?): SessionDetailState {
        return copy(meta = meta.copy(session = session))
    }
}

data class SessionRealtimeState(
    val connected: Boolean = false,
    val recovering: Boolean = false,
    val reconnectAttempt: Int = 0,
    val cursor: String = "seq:0",
    val processedEventIds: Set<String> = emptySet(),
    val lastErrorMessage: String? = null,
) {
    fun rememberEvent(eventId: String, cursor: String): SessionRealtimeState {
        val remembered = (processedEventIds + eventId).let { ids ->
            if (ids.size <= MAX_PROCESSED_EVENTS) ids else ids.drop(ids.size - RETAINED_PROCESSED_EVENTS).toSet()
        }
        return copy(
            cursor = laterEventCursor(this.cursor, cursor),
            processedEventIds = remembered,
        )
    }

    private companion object {
        const val MAX_PROCESSED_EVENTS = 1_000
        const val RETAINED_PROCESSED_EVENTS = 500
    }
}

internal fun laterEventCursor(current: String, incoming: String): String {
    val currentSequence = current.removePrefix("seq:").toLongOrNull() ?: 0L
    val incomingSequence = incoming.removePrefix("seq:").toLongOrNull() ?: return current
    return if (incomingSequence >= currentSequence) incoming else current
}

data class SessionMeta(
    val session: AgentSession? = null,
    val serverTime: String? = null,
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
)

data class SessionTimelineState(
    val messages: List<TimelineMessage> = emptyList(),
    val orderingItems: List<TimelineOrderingItem> = emptyList(),
    val nextSeq: Int = 0,
    val hasMore: Boolean = false,
    val eventCursor: String = "seq:0",
    val isLoading: Boolean = false,
    val loadingOlder: Boolean = false,
    val errorMessage: String? = null,
    val historyErrorMessage: String? = null,
)

/**
 * Server-owned ordering data kept separately from visible Android rows.
 * Turn boundary items participate in ordering but are never rendered.
 */
data class TimelineOrderingItem(
    val id: String,
    val type: String,
    val turnId: String?,
    val orderSeq: Int,
    val revision: Int,
    val updatedSeq: Int,
)

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
)

enum class SessionRuntimeStatus {
    Idle,
    Running,
    WaitingApproval,
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
    fun find(capabilityId: String, runtime: String? = null): EffectiveCapability? {
        val matches = capabilities.filter { it.capabilityId == capabilityId }
        return if (runtime == null) {
            matches.firstOrNull()
        } else {
            matches.firstOrNull { it.runtime == runtime }
                ?: matches.firstOrNull { it.runtime == null }
        }
    }

    fun isUsable(capabilityId: String, runtime: String? = null): Boolean {
        return find(capabilityId, runtime)?.usable == true
    }

    fun messageAction(
        runtime: String?,
        runtimeStatus: SessionRuntimeStatus,
    ): RuntimeMessageAction? {
        val canSend = isUsable(SESSION_SEND_MESSAGE_CAPABILITY, runtime)
        val canSteer = isUsable(SESSION_STEER_CAPABILITY, runtime)
        return when {
            canSteer && (!canSend || runtimeStatus == SessionRuntimeStatus.Running) -> RuntimeMessageAction.Steer
            canSend -> RuntimeMessageAction.Send
            canSteer -> RuntimeMessageAction.Steer
            else -> null
        }
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

    private companion object {
        val RESPONDABLE_NOTICE_STATUSES = setOf("open", "failed")
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

    fun applyModel(
        key: SessionRuntimeRequestKey,
        value: RemoteRuntimeModelCatalog,
    ): RuntimeCatalogs = if (requestKey == key) {
        copy(model = value, modelLoading = false, modelStale = false, modelErrorMessage = null)
    } else {
        this
    }

    fun failModel(key: SessionRuntimeRequestKey, message: String): RuntimeCatalogs {
        return if (requestKey == key) {
            copy(
                modelLoading = false,
                modelStale = model != null,
                modelErrorMessage = message,
            )
        } else {
            this
        }
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

    fun applyPermission(
        key: SessionRuntimeRequestKey,
        value: RemoteRuntimePermissionCatalog,
    ): RuntimeCatalogs = if (requestKey == key) {
        copy(
            permission = value,
            permissionLoading = false,
            permissionStale = false,
            permissionErrorMessage = null,
        )
    } else {
        this
    }

    fun failPermission(key: SessionRuntimeRequestKey, message: String): RuntimeCatalogs {
        return if (requestKey == key) {
            copy(
                permissionLoading = false,
                permissionStale = permission != null,
                permissionErrorMessage = message,
            )
        } else {
            this
        }
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

    fun apply(key: SessionRuntimeRequestKey, value: List<RuntimeCommand>): RuntimeCommands {
        return if (requestKey == key) {
            copy(
                commands = value,
                isLoading = false,
                isLoaded = true,
                stale = false,
                errorMessage = null,
            )
        } else {
            this
        }
    }

    fun fail(key: SessionRuntimeRequestKey, message: String): RuntimeCommands {
        return if (requestKey == key) {
            copy(
                isLoading = false,
                isLoaded = false,
                stale = commands.isNotEmpty(),
                errorMessage = message,
            )
        } else {
            this
        }
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
)

data class TimelineMessage(
    val id: String,
    val sourceItemId: String = id,
    val author: MessageAuthor,
    val text: String,
    val attachments: List<TimelineAttachment> = emptyList(),
    val status: String = "done",
    val type: String = "message",
    val kind: TimelineMessageKind = TimelineMessageKind.Text,
    val title: String = "",
    val subtitle: String = "",
    val badge: String = "",
    val detail: String = "",
    val body: String = "",
    val orderSeq: Int = 0,
    val revision: Int = 1,
    val updatedSeq: Int = 0,
    val clientMessageId: String? = null,
    val turnId: String? = null,
    val optimistic: Boolean = false,
    val retryAction: RuntimeMessageAction? = null,
    val errorMessage: String? = null,
)

data class TimelineAttachment(
    val fileId: String,
    val name: String,
    val mediaType: String,
    val size: Long,
    val sha256: String? = null,
) {
    val isImage: Boolean
        get() = mediaType.startsWith("image/")
}

data class AttachmentImageRequest(
    val url: String,
    val authorizationToken: String,
    val cacheKey: String,
)

data class DownloadedAttachment(
    val fileId: String,
    val name: String,
    val mediaType: String,
    val size: Long,
    val sha256: String,
    val bytes: ByteArray,
)

enum class MessageAuthor {
    User,
    Agent,
    Tool,
}

internal fun RemoteRuntimeModelCatalog.selectionOptions(): List<RuntimeSelectionOption> {
    return models.flatMap { model ->
        val reasoning = model.reasoningItems.filter { it.selectionId.isNotBlank() }
        if (reasoning.isNotEmpty()) {
            reasoning.map { item ->
                RuntimeSelectionOption(
                    selectionId = item.selectionId,
                    label = listOf(model.displayName, item.displayName)
                        .filter(String::isNotBlank)
                        .joinToString(" · "),
                    description = item.description ?: model.description,
                    default = item.default || (model.default && reasoning.first() == item),
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
                    ),
                )
            }.orEmpty()
        }
    }.distinctBy { it.selectionId }
}

internal fun RemoteRuntimePermissionCatalog.selectionOptions(): List<RuntimeSelectionOption> {
    return permissions
        .filter { it.selectionId.isNotBlank() }
        .map {
            RuntimeSelectionOption(
                selectionId = it.selectionId,
                label = it.displayName.ifBlank { it.id },
                description = it.description,
                default = it.default,
            )
        }
        .distinctBy { it.selectionId }
}

internal fun List<RuntimeSelectionOption>.validatedSelection(hint: String?): String? {
    return firstOrNull { it.selectionId == hint }?.selectionId
        ?: firstOrNull { it.default }?.selectionId
        ?: firstOrNull()?.selectionId
}

internal fun RemoteRuntimeNoticeAction.toRuntimeNoticeAction(): RuntimeNoticeAction {
    return RuntimeNoticeAction(
        actionId = actionId,
        label = label,
        style = style,
        input = RuntimeNoticeActionInput(
            required = input.required,
            schema = input.schema,
            uiSchema = input.uiSchema,
        ),
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
    val requiredKeys = (schema["required"] as? List<*>).orEmpty()
        .mapNotNull { it as? String }
        .toSet()
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

internal fun RuntimeNoticeAction.coerceInput(
    rawValues: Map<String, String>,
): Result<Map<String, Any?>?> = runCatching {
    val fields = inputFields()
    if (fields.isEmpty()) return@runCatching null
    buildMap {
        fields.forEach { field ->
            val raw = rawValues[field.key].orEmpty().trim()
            if (field.required && raw.isBlank()) {
                throw IllegalArgumentException("${field.label} is required.")
            }
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

enum class TimelineMessageKind {
    Text,
    Reasoning,
    Command,
    FileChange,
    ToolCall,
    Artifact,
    Marker,
    Error,
    Diagnostic,
    System,
}
