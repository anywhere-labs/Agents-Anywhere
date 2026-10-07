package com.agentsanywhere.app.feature.sessiondetail

/**
 * Detailed AI-call insights carried on `SessionRuntimeState.metadata["insights"]`
 * (DSH bridge contract 1.x, additive). Every member is independently optional;
 * absent values mean the owning runtime unit is not mounted.
 */

data class SessionInsightTokenUsage(
    val uncachedInputTokens: Long = 0,
    val outputTokens: Long = 0,
    val cacheReadTokens: Long = 0,
    val cacheWriteTokens: Long = 0,
) {
    val totalTokens: Long
        get() = uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens

    /** Share of prompt tokens served from cache, mirroring the DSH status bar. */
    val cacheHitPercent: Int?
        get() {
            val prompt = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
            if (prompt <= 0) return null
            return ((cacheReadTokens * 100) / prompt).toInt()
        }
}

data class SessionInsightContextPressure(
    val pressureTokens: Long? = null,
    val projectedTokens: Long? = null,
    val contextWindow: Long? = null,
) {
    val contextPercent: Int?
        get() {
            val used = projectedTokens ?: pressureTokens ?: return null
            val window = contextWindow ?: return null
            if (window <= 0) return null
            return ((used * 100) / window).toInt()
        }
}

data class SessionInsightSessionStats(
    val turns: Long = 0,
    val steps: Long = 0,
    val llmMs: Long = 0,
    val toolMs: Long = 0,
    val decodeMs: Long = 0,
    val decodeTokens: Long = 0,
) {
    val decodeTokensPerSecond: Long?
        get() = if (decodeMs > 0 && decodeTokens > 0) decodeTokens * 1000 / decodeMs else null
}

data class SessionInsightGoal(
    val objective: String,
    val phase: String,
    val blockedMessage: String?,
    val roundsStarted: Long,
    val maxGoalRounds: Long,
)

data class SessionInsightTodo(
    val content: String,
    val status: String,
)

data class SessionInsightSubagent(
    val id: String,
    val mode: String,
    val label: String?,
)

data class SessionInsights(
    val tokenUsage: SessionInsightTokenUsage?,
    val contextPressure: SessionInsightContextPressure?,
    val sessionStats: SessionInsightSessionStats?,
    val goal: SessionInsightGoal?,
    val todos: List<SessionInsightTodo>?,
    val subagentCatalog: List<SessionInsightSubagent>?,
    val agentPreset: String?,
) {
    val hasAnyFact: Boolean
        get() = tokenUsage != null || contextPressure != null || sessionStats != null ||
            goal != null || !todos.isNullOrEmpty() || !subagentCatalog.isNullOrEmpty() || agentPreset != null

    companion object {
        fun from(metadata: Map<String, Any?>): SessionInsights? {
            val raw = metadata["insights"] as? Map<*, *> ?: return null
            val tokenUsage = (raw["tokenUsage"] as? Map<*, *>)?.let { usage ->
                SessionInsightTokenUsage(
                    uncachedInputTokens = usage.longOf("uncachedInputTokens"),
                    outputTokens = usage.longOf("outputTokens"),
                    cacheReadTokens = usage.longOf("cacheReadTokens"),
                    cacheWriteTokens = usage.longOf("cacheWriteTokens"),
                )
            }
            val pressure = (raw["contextPressure"] as? Map<*, *>)?.let { value ->
                SessionInsightContextPressure(
                    pressureTokens = value.longOrNull("pressureTokens"),
                    projectedTokens = value.longOrNull("projectedTokens"),
                    contextWindow = value.longOrNull("contextWindow"),
                )
            }
            val stats = (raw["sessionStats"] as? Map<*, *>)?.let { value ->
                SessionInsightSessionStats(
                    turns = value.longOf("turns"),
                    steps = value.longOf("steps"),
                    llmMs = value.longOf("llmMs"),
                    toolMs = value.longOf("toolMs"),
                    decodeMs = value.longOf("decodeMs"),
                    decodeTokens = value.longOf("decodeTokens"),
                )
            }
            val goal = (raw["goal"] as? Map<*, *>)?.let { value ->
                val objective = value["objective"] as? String ?: return@let null
                SessionInsightGoal(
                    objective = objective,
                    phase = value["phase"] as? String ?: "active",
                    blockedMessage = (value["blockedReason"] as? Map<*, *>)?.get("message") as? String,
                    roundsStarted = value.longOf("roundsStarted"),
                    maxGoalRounds = value.longOf("maxGoalRounds"),
                )
            }
            val todos = (raw["todos"] as? List<*>)?.mapNotNull { item ->
                val entry = item as? Map<*, *> ?: return@mapNotNull null
                val content = entry["content"] as? String ?: return@mapNotNull null
                SessionInsightTodo(
                    content = content,
                    status = entry["status"] as? String ?: "pending",
                )
            }
            val subagents = (raw["subagentCatalog"] as? List<*>)?.mapNotNull { item ->
                val entry = item as? Map<*, *> ?: return@mapNotNull null
                val id = entry["id"] as? String ?: return@mapNotNull null
                SessionInsightSubagent(
                    id = id,
                    mode = entry["mode"] as? String ?: "unknown",
                    label = entry["label"] as? String,
                )
            }
            val preset = metadata["agentPreset"] as? String
            val insights = SessionInsights(
                tokenUsage = tokenUsage,
                contextPressure = pressure,
                sessionStats = stats,
                goal = goal,
                todos = todos,
                subagentCatalog = subagents,
                agentPreset = preset?.takeIf { it.isNotBlank() },
            )
            return if (insights.hasAnyFact) insights else null
        }

        private fun Map<*, *>.longOf(key: String): Long = (this[key] as? Number)?.toLong() ?: 0L
        private fun Map<*, *>.longOrNull(key: String): Long? = (this[key] as? Number)?.toLong()
    }
}

/** Compact display: 1234 -> "1.2K", 17_900_000 -> "17.9M". */
fun formatTokenCount(value: Long): String {
    if (value < 0) return "0"
    if (value >= 1_000_000_000) return trimOne(value / 1_000_000_000.0, "B")
    if (value >= 1_000_000) return trimOne(value / 1_000_000.0, "M")
    if (value >= 1_000) return trimOne(value / 1_000.0, "K")
    return value.toString()
}

private fun trimOne(value: Double, suffix: String): String {
    val rounded = if (value >= 100) Math.round(value).toString()
    else {
        val tenth = Math.round(value * 10) / 10.0
        if (tenth == Math.floor(tenth)) tenth.toInt().toString() else tenth.toString()
    }
    return "$rounded$suffix"
}
