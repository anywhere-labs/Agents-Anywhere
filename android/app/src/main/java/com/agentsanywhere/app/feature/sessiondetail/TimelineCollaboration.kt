package com.agentsanywhere.app.feature.sessiondetail

import org.json.JSONObject

/** Protocol 1.2 `MessageAuthor` of a user message that a person did not type. */
data class TimelineCollabAuthor(
    val kind: Kind,
    val sessionId: String? = null,
    val deviceId: String? = null,
    val supervisionId: String? = null,
) {
    enum class Kind(val wireValue: String) {
        /** An Agent acting for [sessionId] through the collaboration tools. */
        Agent("agent"),

        /** A supervision digest the device sent to the supervisor session. */
        Supervision("supervision"),
    }
}

/** A `system` item with `content.kind == "collab_escalation"`: a question an Agent hands to the user. */
data class TimelineEscalation(
    val question: String,
    val context: String? = null,
    val fromSessionId: String? = null,
    val targetSessionId: String? = null,
)

/** `content.collabTool` of a tool item. [tool] is null for a tool this client does not know. */
data class TimelineCollabTool(
    val tool: CollabTool?,
    val rawTool: String,
    val sessionId: String? = null,
)

enum class CollabTool(val wireValue: String) {
    Spawn("aa_spawn"),
    Send("aa_send"),
    Steer("aa_steer"),
    Interrupt("aa_interrupt"),
    Status("aa_status"),
    Read("aa_read"),
    Wait("aa_wait"),
    Respond("aa_respond"),
    PlanReview("aa_plan_review"),
    Supervise("aa_supervise"),
    Unsupervise("aa_unsupervise"),
    Escalate("aa_escalate"),
    Close("aa_close"),
    ;

    companion object {
        fun fromWire(value: String?): CollabTool? = entries.firstOrNull { it.wireValue == value }
    }
}

internal const val COLLAB_ESCALATION_KIND = "collab_escalation"

/** `content.author`; a missing object or an unknown kind reads as absent. */
internal fun JSONObject.collabAuthor(): TimelineCollabAuthor? {
    val author = optJSONObject("author") ?: return null
    val kindValue = author.nonBlank("kind")
    val kind = TimelineCollabAuthor.Kind.entries.firstOrNull { it.wireValue == kindValue } ?: return null
    return TimelineCollabAuthor(
        kind = kind,
        sessionId = author.nonBlank("sessionId"),
        deviceId = author.nonBlank("deviceId"),
        supervisionId = author.nonBlank("supervisionId"),
    )
}

/** The escalation of a `collab_escalation` system item; null when the question is missing. */
internal fun JSONObject.collabEscalation(): TimelineEscalation? {
    if (nonBlank("kind") != COLLAB_ESCALATION_KIND) return null
    return TimelineEscalation(
        question = nonBlank("question") ?: return null,
        context = nonBlank("context"),
        fromSessionId = nonBlank("fromSessionId"),
        targetSessionId = nonBlank("targetSessionId"),
    )
}

/** `content.collabTool`; null when it is missing or names no tool. */
internal fun JSONObject.collabTool(): TimelineCollabTool? {
    val value = optJSONObject("collabTool") ?: return null
    val tool = value.nonBlank("tool") ?: return null
    return TimelineCollabTool(tool = CollabTool.fromWire(tool), rawTool = tool, sessionId = value.nonBlank("sessionId"))
}

private fun JSONObject.nonBlank(name: String): String? {
    if (!has(name) || isNull(name)) return null
    return (opt(name) as? String)?.takeIf(String::isNotBlank)
}
