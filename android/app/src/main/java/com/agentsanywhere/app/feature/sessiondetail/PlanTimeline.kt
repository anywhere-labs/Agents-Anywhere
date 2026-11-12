package com.agentsanywhere.app.feature.sessiondetail

import androidx.annotation.StringRes
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.PlanDocument
import com.agentsanywhere.app.api.RemotePlanningState
import java.time.Instant
import java.time.OffsetDateTime

/** Plans placed by timeline group key; [end] holds plans with no later user message. */
data class PlanPlacement(val before: Map<String, List<PlanDocument>>, val end: List<PlanDocument>)

/**
 * A plan sits before the first user message that followed it. An approved plan
 * therefore lands directly above the implementation it started; one still under
 * review has no later user message and stays at the end, beside the composer.
 */
fun placePlanDocuments(documents: List<PlanDocument>, groups: List<Pair<String, List<TimelineMessage>>>): PlanPlacement {
    val userTimes = groups.map { (_, messages) ->
        messages.filter { it.author == MessageAuthor.User }.mapNotNull { parseInstant(it.createdAt) }.minOrNull()
    }
    val before = linkedMapOf<String, MutableList<PlanDocument>>()
    val end = mutableListOf<PlanDocument>()
    val ordered = documents.sortedWith(compareBy<PlanDocument, Instant?>(nullsLast()) { parseInstant(it.createdAt) }.thenBy { it.revision })
    for (document in ordered) {
        val at = parseInstant(document.createdAt)
        val index = if (at == null) -1 else userTimes.indexOfFirst { it != null && it > at }
        if (index < 0) end += document else before.getOrPut(groups[index].first) { mutableListOf() } += document
    }
    return PlanPlacement(before, end)
}

/** A system message that only repeats a plan (or its draft) is shown by the plan card instead. */
fun isPlanEcho(state: RemotePlanningState?, documents: List<PlanDocument>, message: TimelineMessage): Boolean {
    if (message.sourceRole != "system") return false
    val text = message.text.trim().ifEmpty { message.body.trim() }
    if (text.isEmpty()) return false
    val draft = state?.draft?.content?.trim().orEmpty()
    if (draft.isNotEmpty() && draft.startsWith(text)) return true
    // Earlier versions may arrive without their body; their hash still identifies the echo.
    val hash = planContentHash(message.text)
    return documents.any { it.contentHash == hash || (it.markdown.isNotBlank() && it.markdown.trim() == text) }
}

/** Same digest the Connector stores as `contentHash`. */
fun planContentHash(text: String): String =
    "sha256:" + java.security.MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

fun latestPlanRevisions(documents: List<PlanDocument>): Map<String, Int> =
    documents.groupBy { it.planId }.mapValues { (_, versions) -> versions.maxOf { it.revision } }

/** Review outcome of this exact version. */
@StringRes
fun planReviewStatus(state: RemotePlanningState?, document: PlanDocument): Int? {
    val review = state?.review ?: return null
    if (review.planId != document.planId || review.planRevision != document.revision) return null
    return when (review.status) {
        "approved" -> when (state.executionStatus) {
            "started" -> R.string.planning_status_executed
            "rejected" -> R.string.planning_status_execution_pending
            else -> R.string.planning_status_approved
        }
        "open" -> R.string.planning_status_open
        "responding" -> R.string.planning_status_responding
        "revision_requested" -> R.string.planning_status_revision_requested
        "dismissed" -> R.string.planning_status_dismissed
        "withdrawn" -> R.string.planning_status_withdrawn
        "unknown" -> R.string.planning_status_unknown
        else -> null
    }
}

// Python isoformat() writes "+00:00", which Instant.parse rejects before API 31.
private fun parseInstant(value: String?): Instant? = value?.takeIf(String::isNotBlank)?.let {
    runCatching { OffsetDateTime.parse(it).toInstant() }.getOrNull() ?: runCatching { Instant.parse(it) }.getOrNull()
}
