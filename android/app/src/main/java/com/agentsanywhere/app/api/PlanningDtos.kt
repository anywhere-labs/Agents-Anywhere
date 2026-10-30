package com.agentsanywhere.app.api

import org.json.JSONObject

data class PlanDocument(val planId: String, val revision: Int, val contentHash: String, val title: String, val markdown: String)
data class PlanReview(val reviewId: String, val planId: String, val planRevision: Int, val contentHash: String, val status: String)
data class PlanDraft(val draftId: String, val content: String, val contentState: String, val planId: String = draftId, val revision: Int = 1)
data class RemotePlanningState(
    val sessionId: String, val effectiveMode: String, val freshness: String, val epoch: String, val revision: Int,
    val draft: PlanDraft?, val proposal: PlanDocument?, val review: PlanReview?, val documents: List<PlanDocument>,
    val actions: List<String>?,
    val executionStatus: String? = null, val executionRetryable: Boolean = false,
)
internal fun JSONObject.toPlanDocument() = PlanDocument(getString("planId"), getInt("revision"), getString("contentHash"), getString("title"), getString("markdown"))
internal fun JSONObject.toRemotePlanningState(): RemotePlanningState {
    val docs = optJSONArray("proposals")
    return RemotePlanningState(getString("sessionId"), optString("effectiveMode", "unknown"), optString("freshness", "unknown"), optString("epoch", ""), optInt("revision"),
        optJSONObject("draft")?.let { PlanDraft(it.getString("draftId"), it.optString("content"), it.optString("contentState"), it.getString("planId"), it.getInt("revision")) },
        optJSONObject("proposal")?.toPlanDocument(),
        optJSONObject("review")?.let { PlanReview(it.getString("reviewId"), it.getString("planId"), it.getInt("planRevision"), it.getString("contentHash"), it.getString("status")) },
        if (docs == null) emptyList() else (0 until docs.length()).map { docs.getJSONObject(it).toPlanDocument() },
        optJSONObject("capabilities")?.optJSONArray("actions")?.let { actions -> (0 until actions.length()).map { actions.getString(it) } },
        optJSONObject("execution")?.optString("status"), optJSONObject("execution")?.optBoolean("retryable") == true)
}
