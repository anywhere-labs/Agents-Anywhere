package com.agentsanywhere.app.feature.sessions

import com.agentsanywhere.app.model.AgentProject
import com.agentsanywhere.app.model.AgentSession
import kotlinx.coroutines.CancellationException
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * 加密模式下按解出的工作目录给会话归属项目（contracts/e2ee/1.0「会话归属项目」）。
 *
 * Server 读不到密封的 `cwd`，设备自己发现的会话（导入、扫描）`projectId` 为空；能解开 `displayDevice` 的客户端
 * 按 `cwd` 匹配同一设备的项目，再 `PATCH /sessions/{id}/meta {projectId}`。普通模式仍由 Server 按明文 `cwd` 归属。
 */
internal data class NormalizedWorkspacePath(val key: String, val windows: Boolean) {
    private val separator: Char get() = if (windows) '\\' else '/'

    /** [child] 在这个目录下面（按路径分段：`/a/b` 不包含 `/a/bc`）。 */
    fun isAncestorOf(child: NormalizedWorkspacePath): Boolean {
        if (windows != child.windows || child.key.length <= key.length || !child.key.startsWith(key)) return false
        return key.last() == separator || child.key[key.length] == separator
    }
}

private val WINDOWS_DRIVE = Regex("^[A-Za-z]:[\\\\/]")

/**
 * 去首尾空白、去末尾的 `/` 或 `\`。只有 `X:\`（或 `X:/`）形式按 Windows 路径处理：`/` 当成 `\`、忽略大小写；
 * 其余按 POSIX 路径，区分大小写（与 Web/Desktop #762 相同）。
 */
internal fun normalizeWorkspacePath(path: String?): NormalizedWorkspacePath? {
    val trimmed = path?.trim().orEmpty()
    if (trimmed.isEmpty()) return null
    val windows = WINDOWS_DRIVE.containsMatchIn(trimmed)
    // The root keeps its separator: "/" stays "/", so it can still be an ancestor.
    val stripped = trimmed.trimEnd('/', '\\').ifEmpty { trimmed.take(1) }
    return if (windows) {
        NormalizedWorkspacePath(stripped.replace('/', '\\').lowercase(Locale.ROOT), windows = true)
    } else {
        NormalizedWorkspacePath(stripped, windows = false)
    }
}

/** 同一设备的项目里，先找路径完全相等的；没有就取能作为 [cwd] 前缀的最长项目路径；都没有返回 null（保持未归属）。 */
internal fun matchProjectForCwd(connectorId: String, cwd: String?, projects: List<AgentProject>): AgentProject? {
    val target = normalizeWorkspacePath(cwd) ?: return null
    val candidates = projects
        .filter { it.connectorId == connectorId }
        .mapNotNull { project -> normalizeWorkspacePath(project.workspacePath)?.let { project to it } }
    candidates.firstOrNull { (_, path) -> path == target }?.let { return it.first }
    return candidates
        .filter { (_, path) -> path.isAncestorOf(target) }
        .maxByOrNull { (_, path) -> path.key.length }
        ?.first
}

/** 需要客户端来归属的会话：未归属，且工作目录是从密封的信封里解出来的。 */
internal fun AgentSession.needsClientProjectAssignment(): Boolean =
    projectId == null && encryptedDisplay && !cwdLocked && !cwd.isNullOrBlank()

/**
 * 每个会话在一次运行（进程）里最多尝试一次，成功或失败都记下；所有失败都静默，只交给 [log]
 * （包括 404 `project_not_found`、422 `project_workspace_mismatch`）。
 */
class SessionProjectAutoAssigner(
    private val assign: suspend (sessionId: String, projectId: String) -> Result<AgentSession>,
    private val attempted: MutableSet<String> = PROCESS_ATTEMPTS,
    private val log: (String) -> Unit = {},
) {
    /** 现在可以尝试的 (会话, 项目)；没有匹配项目的会话不算尝试，项目列表变了以后还会再看。 */
    fun pending(sessions: Collection<AgentSession>, projects: List<AgentProject>): List<Pair<AgentSession, AgentProject>> =
        sessions.asSequence()
            .filter { it.needsClientProjectAssignment() && it.id !in attempted }
            .distinctBy { it.id }
            .mapNotNull { session -> matchProjectForCwd(session.connectorId, session.cwd, projects)?.let { session to it } }
            .toList()

    /** 依次 PATCH；返回成功后 Server 给的会话（调用方按平时更新元数据的方式刷新这一项）。 */
    suspend fun run(sessions: Collection<AgentSession>, projects: List<AgentProject>): List<AgentSession> {
        val updated = mutableListOf<AgentSession>()
        for ((session, project) in pending(sessions, projects)) {
            if (!attempted.add(session.id)) continue
            val result = try {
                assign(session.id, project.id)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Result.failure(error)
            }
            result
                .onSuccess { updated += it }
                .onFailure { log("auto-assign project failed session=${session.id} project=${project.id}: ${it.message}") }
        }
        return updated
    }

    /** 退出登录时清空（换账号后从头再来）。 */
    fun reset() = attempted.clear()

    companion object {
        private val PROCESS_ATTEMPTS: MutableSet<String> = ConcurrentHashMap.newKeySet()
    }
}
