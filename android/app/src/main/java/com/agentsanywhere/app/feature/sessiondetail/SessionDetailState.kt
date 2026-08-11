package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteRuntimeModelCatalog
import com.agentsanywhere.app.api.RemoteRuntimePermissionCatalog
import com.agentsanywhere.app.model.AgentSession

data class SessionDetailState(
    val meta: SessionMeta = SessionMeta(),
    val timeline: SessionTimelineState = SessionTimelineState(),
    val runtime: SessionRuntimeState = SessionRuntimeState(),
    val capabilities: EffectiveCapabilities = EffectiveCapabilities(),
    val runtimeCapabilities: RuntimeCapabilities = RuntimeCapabilities(),
    val notices: RuntimeNotices = RuntimeNotices(),
    val catalogs: RuntimeCatalogs = RuntimeCatalogs(),
    val approvals: List<TimelineApproval> = emptyList(),
    val initialized: Boolean = false,
    val actionError: String? = null,
    val takeoverInFlight: Boolean = false,
    val sending: Boolean = false,
    val interrupting: Boolean = false,
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

data class SessionMeta(
    val session: AgentSession? = null,
    val serverTime: String? = null,
    val isLoading: Boolean = false,
    val errorMessage: String? = null,
)

data class SessionTimelineState(
    val messages: List<TimelineMessage> = emptyList(),
    val nextSeq: Int = 0,
    val hasMore: Boolean = false,
    val eventCursor: String = "seq:0",
    val isLoading: Boolean = false,
    val loadingOlder: Boolean = false,
    val errorMessage: String? = null,
    val historyErrorMessage: String? = null,
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
    fun isUsable(capabilityId: String, runtime: String? = null): Boolean {
        val matches = capabilities.filter { it.capabilityId == capabilityId }
        val capability = if (runtime == null) {
            matches.firstOrNull()
        } else {
            matches.firstOrNull { it.runtime == runtime } ?: matches.firstOrNull { it.runtime == null }
        }
        return capability?.usable == true
    }
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
)

data class RuntimeNotice(
    val noticeId: String,
    val type: String,
    val sessionId: String,
    val title: String,
    val message: String?,
    val severity: String,
    val status: String,
    val responseRequired: Boolean,
    val revision: Int,
    val updatedSeq: Int,
    val source: Map<String, Any?>,
    val actions: List<Map<String, Any?>>,
    val context: Map<String, Any?>,
    val metadata: Map<String, Any?>,
)

data class RuntimeCatalogs(
    val model: RemoteRuntimeModelCatalog? = null,
    val permission: RemoteRuntimePermissionCatalog? = null,
    val unknown: Map<String, Any?> = emptyMap(),
    val isLoaded: Boolean = false,
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
