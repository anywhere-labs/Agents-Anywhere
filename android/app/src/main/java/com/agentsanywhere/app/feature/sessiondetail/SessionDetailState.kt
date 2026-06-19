package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.model.AgentSession

data class SessionDetailState(
    val session: AgentSession? = null,
    val messages: List<TimelineMessage> = emptyList(),
    val approvals: List<TimelineApproval> = emptyList(),
    val nextSeq: Int = 0,
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
    val actionError: String? = null,
    val sseConnected: Boolean = false,
    val takeoverInFlight: Boolean = false,
    val sending: Boolean = false,
    val interrupting: Boolean = false,
    val runtimeSettings: RuntimeSettingsState = RuntimeSettingsState(),
)

data class RuntimeSettingsState(
    val schema: RuntimeConfigSchema? = null,
    val settings: Map<String, Any?> = emptyMap(),
    val overrideSettings: Map<String, Any?> = emptyMap(),
    val isLoading: Boolean = false,
    val savingKey: String? = null,
    val errorMessage: String? = null,
)

data class RuntimeConfigSchema(
    val runtime: String,
    val schemaVersion: Int,
    val fields: List<RuntimeConfigField>,
)

data class RuntimeConfigField(
    val key: String,
    val label: String,
    val type: String,
    val description: String?,
    val options: List<RuntimeConfigOption>,
    val visibleWhen: Map<String, Any?>,
    val allowSessionOverride: Boolean,
    val hidden: Boolean,
)

data class RuntimeConfigOption(
    val value: String,
    val label: String,
    val description: String?,
)

data class SessionFilesDirectory(
    val path: String,
    val entries: List<SessionFileEntry> = emptyList(),
)

data class SessionFileEntry(
    val name: String,
    val path: String,
    val isDirectory: Boolean,
    val size: Long?,
)

data class SessionTextFile(
    val path: String,
    val name: String,
    val size: Long,
    val sha256: String,
    val encoding: String,
    val content: String,
    val truncated: Boolean,
    val binary: Boolean,
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
    val updatedSeq: Int = 0,
    val clientMessageId: String? = null,
    val turnId: String? = null,
    val optimistic: Boolean = false,
)

data class TimelineAttachment(
    val fileId: String,
    val name: String,
    val mediaType: String,
    val size: Long,
) {
    val isImage: Boolean
        get() = mediaType.startsWith("image/")
}

data class AttachmentImageRequest(
    val url: String,
    val authorizationToken: String,
    val cacheKey: String,
)

data class TimelineApproval(
    val id: String,
    val title: String,
    val description: String?,
    val kind: String,
    val status: String,
    val choices: List<String>,
    val updatedSeq: Int,
)

sealed interface SessionStreamEvent {
    data object Connected : SessionStreamEvent
    data object Disconnected : SessionStreamEvent
    data class Delta(val value: SessionDetailDelta) : SessionStreamEvent
    data class Failed(val message: String) : SessionStreamEvent
}

data class SessionDetailDelta(
    val session: AgentSession? = null,
    val messages: List<TimelineMessage> = emptyList(),
    val replaceSourceItemIds: Set<String> = emptySet(),
    val approvals: List<TimelineApproval>? = null,
    val nextSeq: Int = 0,
    val refetch: Boolean = false,
)

enum class MessageAuthor {
    User,
    Agent,
    Tool,
}

enum class TimelineMessageKind {
    Text,
    Reasoning,
    Command,
    FileChange,
    ToolCall,
    System,
}
