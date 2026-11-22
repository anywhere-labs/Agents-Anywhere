package dev.agentsanywhere.v3.core.model

/** Conversations of one device grouped the way the device page lists them: Agent → project (cwd) → conversation. */
data class AgentGroup(val agent: String, val projects: List<ProjectGroup>)

data class ProjectGroup(val cwd: String, val sessions: List<SessionSummary>) {
    /** The directory's last path component, like Finder / the Web sidebar. */
    val name: String get() = projectName(cwd)
}

fun projectName(cwd: String): String = cwd.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\').ifEmpty { cwd.ifEmpty { "~" } }

fun groupByAgentAndProject(sessions: List<SessionSummary>): List<AgentGroup> =
    sessions.groupBy { it.agent }
        .map { (agent, list) ->
            AgentGroup(agent, list.groupBy { it.cwd }.map { (cwd, s) -> ProjectGroup(cwd, s) }
                .sortedByDescending { p -> p.sessions.maxOf { it.updated_at } })
        }
        .sortedByDescending { g -> g.projects.maxOf { p -> p.sessions.maxOf { it.updated_at } } }

/** Display name of an agent id ("claude" → "Claude Code"); unknown ids are title-cased. */
fun agentDisplayName(agent: String, runtimes: List<Runtime> = emptyList()): String =
    runtimes.firstOrNull { it.id == agent }?.name?.takeIf { it.isNotBlank() } ?: when (agent.lowercase()) {
        "claude", "claude-code", "claude_code" -> "Claude Code"
        "codex" -> "Codex"
        "dsh" -> "DSH"
        "pi" -> "Pi"
        "antigravity" -> "Antigravity"
        "gemini" -> "Gemini"
        else -> agent.replaceFirstChar { it.uppercase() }
    }
