package com.agentsanywhere.app.feature.sessiondetail

import com.agentsanywhere.app.api.RemoteTimelineItem
import org.json.JSONArray
import org.json.JSONObject

private fun JSONObject.toTimelineAttachmentOrNull(): TimelineAttachment? {
    val fileId = text("fileId")?.takeIf { it.isNotBlank() } ?: return null
    return TimelineAttachment(
        fileId = fileId,
        name = text("name") ?: fileId,
        mediaType = text("mediaType").orEmpty(),
        size = optLong("size", 0L),
        sha256 = text("sha256"),
    )
}

private fun RemoteTimelineItem.toTimelineMessages(): List<TimelineMessage> {
    return when (type) {
        "message" -> listOf(toMessage())
        "tool" -> toToolMessages()
        "artifact" -> toArtifactMessages()
        "marker" -> listOf(toMarkerMessage())
        "system" -> listOf(toSystemMessage())
        else -> listOf(toDiagnosticMessage())
    }
}

internal fun mergeRemoteTimelineItems(
    currentOrdering: List<TimelineOrderingItem>,
    currentMessages: List<TimelineMessage>,
    incoming: List<RemoteTimelineItem>,
    replace: Boolean,
): TimelineProjection {
    val latestIncoming = latestTimelineItemsById(incoming)
    val normalizedIncoming = normalizeTimelineOrderingItems(currentOrdering, latestIncoming)
    val orderingItems = if (replace) {
        normalizedIncoming
    } else {
        mergeTimelineOrderingItems(currentOrdering, normalizedIncoming)
    }
    val normalizedOrderById = orderingItems.associateBy { it.id }
    val incomingMessages = latestIncoming.flatMap { item ->
        val orderSeq = normalizedOrderById[item.id]?.orderSeq ?: item.orderSeq
        item.toTimelineMessages().map { it.copy(orderSeq = orderSeq) }
    }
    val messages = if (replace) {
        sortTimelineMessages(incomingMessages, orderingItems)
    } else {
        mergeTimelineMessages(currentMessages, incomingMessages, orderingItems)
    }
    return TimelineProjection(orderingItems, messages)
}

private fun latestTimelineItemsById(incoming: List<RemoteTimelineItem>): List<RemoteTimelineItem> {
    val byId = linkedMapOf<String, RemoteTimelineItem>()
    incoming.forEach { observed ->
        val existing = byId[observed.id]
        if (existing == null || observed.revision > existing.revision ||
            observed.updatedSeq >= existing.updatedSeq
        ) {
            byId[observed.id] = observed
        }
    }
    return byId.values.toList()
}

private fun RemoteTimelineItem.toToolMessages(): List<TimelineMessage> {
    return when (content.text("kind")) {
        "command" -> listOf(toCommandMessage())
        "file_change" -> toFileChangeMessages()
        "web_search" -> listOf(toToolCallMessage(title = "Searched web", subtitle = content.text("query").orEmpty()))
        "mcp" -> listOf(
            toToolCallMessage(
                title = content.text("tool") ?: "tool",
                subtitle = content.text("server") ?: "mcp",
            )
        )
        "tool_call", "tool_result", "permission", "input_request" -> listOf(
            toToolCallMessage(title = shortToolTitle(), subtitle = content.text("kind").orEmpty()),
        )
        else -> listOf(toDiagnosticMessage())
    }
}

private fun RemoteTimelineItem.toMessage(): TimelineMessage {
    val contentKind = content.text("kind")
    val nestedContent = content.optJSONObject("content")
    val attachments = (
        content.records("attachments") + nestedContent?.records("attachments").orEmpty()
    ).mapNotNull { it.toTimelineAttachmentOrNull() }
        .distinctBy { it.fileId }
    val messageText = text
        .ifBlank { content.platformMessageText().orEmpty() }
        .stripInjectedAttachmentMentions()
    if (contentKind !in setOf(null, "text", "markdown", "multimodal") ||
        (messageText.isBlank() && attachments.isEmpty())
    ) {
        return toDiagnosticMessage()
    }
    val author = when (role) {
        "user" -> MessageAuthor.User
        "assistant" -> MessageAuthor.Agent
        else -> MessageAuthor.Tool
    }
    return TimelineMessage(
        id = id,
        sourceItemId = id,
        author = author,
        text = messageText,
        attachments = attachments,
        status = status,
        type = type,
        badge = status.statusLabel(),
        orderSeq = orderSeq,
        revision = revision,
        updatedSeq = updatedSeq,
        clientMessageId = source.text("clientMessageId"),
    )
}

private fun JSONObject.platformMessageText(): String? {
    firstText("text", "message", "description", "rawText")?.let { return it }
    return when (val nested = opt("content")) {
        is String -> nested.takeIf(String::isNotBlank)
        is JSONObject -> nested.firstText("text", "message", "description", "rawText")
        is JSONArray -> buildList {
            repeat(nested.length()) { index ->
                when (val part = nested.opt(index)) {
                    is String -> part.takeIf(String::isNotBlank)?.let(::add)
                    is JSONObject -> part.firstText("text", "message", "description", "rawText")?.let(::add)
                }
            }
        }.takeIf(List<String>::isNotEmpty)?.joinToString("\n")
        else -> null
    }
}

private fun RemoteTimelineItem.toSystemMessage(): TimelineMessage {
    val kind = content.text("kind") ?: "system"
    if (kind == "reasoning") {
        val summaries = content.records("summaries").mapNotNull { it.text("text") }
        val rawText = content.text("rawText") ?: content.text("text")
        val body = (if (summaries.isNotEmpty()) summaries else listOfNotNull(rawText))
            .joinToString("\n\n")
        return TimelineMessage(
            id = id,
            sourceItemId = id,
            author = MessageAuthor.Agent,
            text = body,
            status = status,
            type = type,
            kind = TimelineMessageKind.Reasoning,
            title = "Reasoning",
            badge = status.statusLabel(),
            orderSeq = orderSeq,
            revision = revision,
            updatedSeq = updatedSeq,
            clientMessageId = source.text("clientMessageId"),
        )
    }
    if (kind == "compact") return toCompactMessage()
    if (kind !in setOf("runtime", "system", "error", "notice")) {
        return toDiagnosticMessage()
    }
    val message = content.text("message") ?: content.text("text") ?: kind
    return TimelineMessage(
        id = id,
        sourceItemId = id,
        author = MessageAuthor.Tool,
        text = message,
        status = status,
        type = type,
        kind = if (kind == "error" || status == "failed") TimelineMessageKind.Error else TimelineMessageKind.System,
        title = kind,
        badge = status.statusLabel(),
        orderSeq = orderSeq,
        revision = revision,
        updatedSeq = updatedSeq,
        clientMessageId = source.text("clientMessageId"),
    )
}

private fun RemoteTimelineItem.toArtifactMessages(): List<TimelineMessage> {
    val kind = content.text("kind") ?: return listOf(toDiagnosticMessage())
    if (kind == "file_change") return toFileChangeMessages()
    if (kind !in setOf("file", "diff", "image", "document", "code")) {
        return listOf(toDiagnosticMessage())
    }
    val path = content.firstText("path", "filePath", "file", "uri")
    val title = path?.substringAfterLast('/')?.ifBlank { null } ?: kind
    return listOf(
        TimelineMessage(
            id = id,
            sourceItemId = id,
            author = MessageAuthor.Tool,
            text = title,
            status = status,
            type = type,
            kind = TimelineMessageKind.Artifact,
            title = kind.replaceFirstChar { it.uppercase() },
            subtitle = title,
            badge = status.statusLabel(),
            detail = path.orEmpty(),
            body = content.text("description") ?: content.text("text").orEmpty(),
            orderSeq = orderSeq,
            revision = revision,
            updatedSeq = updatedSeq,
            clientMessageId = source.text("clientMessageId"),
        ),
    )
}

private fun RemoteTimelineItem.toMarkerMessage(): TimelineMessage {
    val kind = content.text("kind") ?: return toDiagnosticMessage()
    if (kind == "compact") return toCompactMessage()
    if (kind !in setOf("system", "runtime", "notice", "error")) return toDiagnosticMessage()
    val label = content.firstText("label", "title", "text", "message") ?: kind
    return baseInformationalMessage(
        kind = if (kind == "error" || status == "failed") TimelineMessageKind.Error else TimelineMessageKind.Marker,
        title = kind,
        text = label,
    )
}

private fun RemoteTimelineItem.toCompactMessage(): TimelineMessage {
    val compactState = content.text("state")
    val active = compactState in setOf("started", "running", "inProgress") || status in setOf("pending", "running")
    val failed = compactState == "failed" || status == "failed"
    return baseInformationalMessage(
        kind = if (failed) TimelineMessageKind.Error else TimelineMessageKind.Marker,
        title = "compact",
        text = when {
            failed -> "Conversation compaction failed"
            active -> "Compacting conversation"
            else -> "Conversation compacted"
        },
    )
}

private fun RemoteTimelineItem.toDiagnosticMessage(): TimelineMessage {
    val contentKind = content.text("kind") ?: "unknown"
    return baseInformationalMessage(
        kind = TimelineMessageKind.Diagnostic,
        title = "Unknown timeline item",
        text = "${type.ifBlank { "unknown" }} / $contentKind · ${id.take(48)} · ${status.ifBlank { "unknown" }}",
    )
}

private fun RemoteTimelineItem.baseInformationalMessage(
    kind: TimelineMessageKind,
    title: String,
    text: String,
): TimelineMessage {
    return TimelineMessage(
        id = id,
        sourceItemId = id,
        author = MessageAuthor.Tool,
        text = text,
        status = status,
        type = type,
        kind = kind,
        title = title,
        badge = status.statusLabel(),
        orderSeq = orderSeq,
        revision = revision,
        updatedSeq = updatedSeq,
        clientMessageId = source.text("clientMessageId"),
    )
}

private fun RemoteTimelineItem.toCommandMessage(): TimelineMessage {
    val command = content.opt("command").commandText()
    val description = content.text("description") ?: command
    val output = content.firstText("output", "outputPreview", "outputText", "error").orEmpty()
    val exit = content.text("exitCode")?.let { "exit code $it" }.orEmpty()
    return TimelineMessage(
        id = id,
        sourceItemId = id,
        author = MessageAuthor.Tool,
        text = description.ifBlank { "command" },
        status = status,
        type = type,
        kind = TimelineMessageKind.Command,
        title = "Ran",
        subtitle = description.ifBlank { command.ifBlank { "command" } },
        badge = status.statusLabel(),
        detail = command,
        body = listOf(output, exit).filter { it.isNotBlank() }.joinToString("\n"),
        orderSeq = orderSeq,
        revision = revision,
        updatedSeq = updatedSeq,
        clientMessageId = source.text("clientMessageId"),
    )
}

private fun RemoteTimelineItem.toFileChangeMessages(): List<TimelineMessage> {
    val changes = content.records("changes")
    if (changes.isEmpty()) return listOf(toFileChangeMessage(JSONObject(), 0))
    return changes.mapIndexed { index, change -> toFileChangeMessage(change, index) }
}

private fun RemoteTimelineItem.toFileChangeMessage(change: JSONObject, index: Int): TimelineMessage {
    val targetPath = change.firstText("path", "filePath", "file", "uri").orEmpty()
    val filename = targetPath.substringAfterLast('/').ifBlank { targetPath.ifBlank { "files" } }
    val verb = change.fileChangeVerb()
    return TimelineMessage(
        id = if (index == 0) id else "$id:$index",
        sourceItemId = id,
        author = MessageAuthor.Tool,
        text = "$verb $filename",
        status = status,
        type = type,
        kind = TimelineMessageKind.FileChange,
        title = verb,
        subtitle = filename,
        badge = status.statusLabel(),
        detail = targetPath,
        body = change.text("diff").orEmpty(),
        orderSeq = orderSeq,
        revision = revision,
        updatedSeq = updatedSeq,
        clientMessageId = source.text("clientMessageId"),
    )
}

private fun RemoteTimelineItem.toToolCallMessage(title: String, subtitle: String): TimelineMessage {
    val name = title.ifBlank { "tool" }
    val inputSummary = content.opt("input").diagnosticSummary()
    val outputSummary = content.opt("output").diagnosticSummary()
    val errorSummary = content.opt("error").diagnosticSummary()
    return TimelineMessage(
        id = id,
        sourceItemId = id,
        author = MessageAuthor.Tool,
        text = name,
        status = status,
        type = type,
        kind = TimelineMessageKind.ToolCall,
        title = name,
        subtitle = subtitle,
        badge = status.statusLabel(),
        detail = inputSummary,
        body = listOf(outputSummary, errorSummary).filter(String::isNotBlank).joinToString("\n"),
        orderSeq = orderSeq,
        revision = revision,
        updatedSeq = updatedSeq,
        clientMessageId = source.text("clientMessageId"),
    )
}

private fun RemoteTimelineItem.shortToolTitle(): String {
    return content.text("function")
        ?: content.text("name")
        ?: content.text("tool")
        ?: content.text("kind")
        ?: "tool"
}

internal fun String.statusLabel(): String {
    return when (this) {
        "pending" -> "Pending"
        "running" -> "Running"
        "waiting_approval" -> "Approval"
        "done" -> "Done"
        "failed" -> "Failed"
        "cancelled" -> "Cancelled"
        "interrupted" -> "Stopped"
        else -> replace('_', ' ').replaceFirstChar { it.uppercase() }
    }
}

private fun JSONObject.text(name: String): String? {
    if (!has(name) || isNull(name)) return null
    return when (val value = opt(name)) {
        is String -> value.takeIf { it.isNotBlank() }
        is Number, is Boolean -> value.toString()
        else -> null
    }
}

private fun JSONObject.records(name: String): List<JSONObject> {
    val array = optJSONArray(name) ?: return emptyList()
    return List(array.length()) { index -> array.optJSONObject(index) }.filterNotNull()
}

private fun JSONObject.firstText(vararg names: String): String? {
    return names.firstNotNullOfOrNull { name -> text(name) }
}

private fun JSONObject.fileChangeVerb(): String {
    val kind = optJSONObject("kind")
    val type = kind?.text("type") ?: text("action")
    return when (type) {
        "add" -> "Added"
        "delete" -> "Deleted"
        "update" -> if (kind?.text("move_path") != null) "Renamed" else "Edited"
        else -> "Changed"
    }
}

private fun Any?.commandText(): String {
    return when (this) {
        is String -> this
        is JSONArray -> List(length()) { index -> opt(index).toString() }.joinToString(" ")
        else -> ""
    }
}

private fun Any?.diagnosticSummary(maxChars: Int = 512): String {
    val raw = when (this) {
        null, JSONObject.NULL -> ""
        is String -> this
        is Number, is Boolean -> toString()
        is JSONObject -> keys().asSequence().toList().sorted().joinToString(", ") { key ->
            val value = opt(key)
            "$key=${when (value) {
                is String -> value
                is Number, is Boolean -> value.toString()
                is JSONArray -> "[${value.length()} items]"
                is JSONObject -> "{${value.length()} fields}"
                else -> "null"
            }}"
        }
        is JSONArray -> "[${length()} items]"
        else -> toString()
    }
    return raw.replace(Regex("(?i)(token|secret|password|authorization)=([^,\\s]+)"), "$1=[redacted]")
        .take(maxChars)
}

private fun String.stripInjectedAttachmentMentions(): String {
    val markers = listOf(
        "\n\n[Attached file: ",
        "\n\n[Failed to load attachment ",
        "\n\n[Attachments dropped ",
    )
    val cut = markers
        .map { marker -> indexOf(marker) }
        .filter { it >= 0 }
        .minOrNull() ?: length
    return take(cut).trimEnd()
}

internal data class TimelineProjection(
    val orderingItems: List<TimelineOrderingItem>,
    val messages: List<TimelineMessage>,
)

private fun normalizeTimelineOrderingItems(
    current: List<TimelineOrderingItem>,
    incoming: List<RemoteTimelineItem>,
): List<TimelineOrderingItem> {
    val currentById = current.associateBy { it.id }
    var maxOrderSeq = maxOf(
        current.maxOfOrNull { it.orderSeq.takeIf { value -> value > 0 } ?: 0 } ?: 0,
        incoming.maxOfOrNull { it.orderSeq.takeIf { value -> value > 0 } ?: 0 } ?: 0,
    )
    return incoming.map { item ->
        val existingOrder = currentById[item.id]?.orderSeq?.takeIf { it > 0 }
        val normalizedOrder = item.orderSeq.takeIf { it > 0 }
            ?: existingOrder
            ?: (++maxOrderSeq)
        TimelineOrderingItem(
            id = item.id,
            orderSeq = normalizedOrder,
            revision = item.revision,
            updatedSeq = item.updatedSeq,
        )
    }
}

internal fun mergeTimelineOrderingItems(
    current: List<TimelineOrderingItem>,
    incoming: List<TimelineOrderingItem>,
): List<TimelineOrderingItem> {
    val byId = current.associateByTo(linkedMapOf()) { it.id }
    incoming.forEach { observed ->
        val existing = byId[observed.id]
        if (existing == null || observed.revision > existing.revision || observed.updatedSeq >= existing.updatedSeq) {
            byId[observed.id] = observed.copy(
                orderSeq = observed.orderSeq.takeIf { it > 0 }
                    ?: existing?.orderSeq?.takeIf { it > 0 }
                    ?: ((byId.values.maxOfOrNull { it.orderSeq } ?: 0) + 1),
            )
        }
    }
    return byId.values.toList()
}

internal fun sortTimelineMessages(
    messages: List<TimelineMessage>,
    orderingItems: List<TimelineOrderingItem> = emptyList(),
): List<TimelineMessage> {
    val orderingById = orderingItems.associateBy { it.id }
    return messages.sortedWith { left, right ->
        val leftOrder = orderingById[left.sourceItemId]?.orderSeq ?: left.orderSeq
        val rightOrder = orderingById[right.sourceItemId]?.orderSeq ?: right.orderSeq
        compareValues(leftOrder, rightOrder).takeIf { it != 0 }
            ?: compareValues(left.updatedSeq, right.updatedSeq).takeIf { it != 0 }
            ?: left.id.compareTo(right.id)
    }
}

internal fun mergeTimelineMessages(
    current: List<TimelineMessage>,
    incoming: List<TimelineMessage>,
    orderingItems: List<TimelineOrderingItem> = emptyList(),
): List<TimelineMessage> {
    val currentBySource = current.filterNot { it.optimistic }.groupBy { it.sourceItemId }
    val incomingBySource = incoming.filterNot { it.optimistic }.groupBy { it.sourceItemId }
    val sourceIds = currentBySource.keys + incomingBySource.keys
    return sourceIds.flatMap { sourceId ->
        val currentGroup = currentBySource[sourceId].orEmpty()
        val incomingGroup = incomingBySource[sourceId].orEmpty()
        if (incomingGroup.isEmpty()) return@flatMap currentGroup
        if (currentGroup.isEmpty()) return@flatMap incomingGroup
        val currentRevision = currentGroup.maxOf { it.revision }
        val incomingRevision = incomingGroup.maxOf { it.revision }
        val currentUpdatedSeq = currentGroup.maxOf { it.updatedSeq }
        val incomingUpdatedSeq = incomingGroup.maxOf { it.updatedSeq }
        if (incomingRevision > currentRevision || incomingUpdatedSeq >= currentUpdatedSeq) {
            incomingGroup
        } else {
            currentGroup
        }
    }.let { sortTimelineMessages(it, orderingItems) }
}

internal data class OptimisticTimelineMerge(
    val messages: List<TimelineMessage>,
    val pending: List<TimelineMessage>,
)

internal fun mergeOptimisticTimelineMessages(
    realMessages: List<TimelineMessage>,
    currentMessages: List<TimelineMessage>,
    storedMessages: List<TimelineMessage>,
    orderingItems: List<TimelineOrderingItem>,
): OptimisticTimelineMerge {
    val real = realMessages.filterNot { it.optimistic }
    val optimistic = (currentMessages.filter { it.optimistic } + storedMessages.filter { it.optimistic })
        .associateBy { it.id }
        .values
        .toList()
    val pending = optimistic.filter { optimisticMessage ->
        real.none { realMessage -> realMessage.matchesClientMessage(optimisticMessage.id) }
    }
    return OptimisticTimelineMerge(
        messages = sortTimelineMessages(real + pending, orderingItems),
        pending = pending,
    )
}

internal fun TimelineMessage.matchesClientMessage(clientMessageId: String): Boolean =
    author == MessageAuthor.User && this.clientMessageId == clientMessageId

internal fun List<TimelineMessage>.hasPendingOptimisticSend(): Boolean =
    any { it.optimistic && it.status == "pending" }
