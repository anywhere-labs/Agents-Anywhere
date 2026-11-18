package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteTimelineItem

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
    // Local generation: history requests cannot cross a snapshot/reset boundary.
    val historyGeneration: Long = 0,
    /**
     * The protocol items behind [messages], newest revision per id. The disk
     * cache stores these instead of the projection, and replays them through
     * the snapshot projection on restore, so projection changes never strand
     * stored content. Strings are shared with the projected rows.
     */
    val remoteItems: Map<String, RemoteTimelineItem> = emptyMap(),
    /**
     * Protocol 1.2: the device is offline, so the Server could not read this
     * history. Loaded content and the recovery cursor stay as they are.
     */
    val historyUnavailable: Boolean = false,
    /**
     * Only an offline snapshot was ever applied: the empty page is not an
     * authoritative base, so it is not cached and the next read is a snapshot.
     */
    val historyBaseMissing: Boolean = false,
)

/** Newest revision per id, using the same rule as the timeline projection. */
internal fun Map<String, RemoteTimelineItem>.mergeRemoteItems(
    incoming: Collection<RemoteTimelineItem>,
    replace: Boolean = false,
): Map<String, RemoteTimelineItem> {
    if (!replace && incoming.isEmpty()) return this
    val byId = if (replace) LinkedHashMap<String, RemoteTimelineItem>(incoming.size) else LinkedHashMap(this)
    incoming.forEach { observed ->
        val existing = byId[observed.id]
        if (existing == null || observed.revision > existing.revision || observed.updatedSeq >= existing.updatedSeq) {
            byId[observed.id] = observed
        }
    }
    return byId
}

/**
 * Server-owned ordering data kept separately from visible Android rows.
 * Every source item is ordered by the same v2 Timeline contract as Web.
 */
data class TimelineOrderingItem(
    val id: String,
    val orderSeq: Int,
    val revision: Int,
    val updatedSeq: Int,
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
    val contentKind: String = "",
    val reasoningSegments: List<String> = emptyList(),
    val command: String = "",
    val output: String = "",
    val input: String = "",
    val toolError: String = "",
    val fileChanges: List<TimelineFileChange> = emptyList(),
    val agentCall: TimelineAgentCall? = null,
    val rawContent: String = "",
    val workspaceImages: List<String> = emptyList(),
    /** Large fields of the source item kept on the device; set on the first row of the item only. */
    val blobRefs: List<TimelineBlobRef> = emptyList(),
    val orderSeq: Int = 0,
    val revision: Int = 1,
    val updatedSeq: Int = 0,
    val clientMessageId: String? = null,
    val contentHash: String = "",
    val sourceRuntime: String? = null,
    val sourceItemType: String? = null,
    val sourceReplacedBy: String? = null,
    val optimistic: Boolean = false,
    val errorMessage: String? = null,
    val createdAt: String = "",
    val sourceRole: String? = null,
)

data class TimelineFileChange(
    val action: String,
    val path: String,
    val diff: String,
)

data class TimelineAgentCall(
    val action: TimelineAgentCallAction,
    val description: String = "",
    val parentItemId: String? = null,
)

enum class TimelineAgentCallAction {
    Invoke,
    Spawn,
    SendInput,
    Resume,
    Wait,
    Close,
    Unknown,
}

data class TimelineAttachment(
    val fileId: String,
    val name: String,
    val mediaType: String,
    val size: Long,
    val sha256: String? = null,
    val localPreviewUri: String? = null,
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

enum class TimelineMessageKind {
    Text,
    Reasoning,
    Command,
    FileChange,
    AgentCall,
    ToolCall,
    Artifact,
    Marker,
    Error,
    Diagnostic,
    System,
}
