package com.agentsanywhere.app.feature.sessiondetail

data class PlanningCommand(val command: String, val content: String? = null) {
    companion object {
        fun parse(text: String): PlanningCommand? {
            val value = text.trimStart()
            if (!value.startsWith("/plan") || (value.length > 5 && !value[5].isWhitespace())) return null
            val suffix = value.drop(5)
            val content = suffix.drop(if (suffix.startsWith("\r\n")) 2 else 1)
            return when { suffix.trim() == "off" -> PlanningCommand("exit_plan"); suffix.isBlank() -> PlanningCommand("enter_plan"); else -> PlanningCommand("submit_task", content) }
        }
    }
}
